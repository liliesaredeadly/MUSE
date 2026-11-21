import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const DAY = 24 * 60 * 60 * 1000;
const SESSION_AGE = 30 * DAY;
const IDLE_AGE = 7 * DAY;
const RATE_WINDOW = 15 * 60 * 1000;
const COOKIE_NAME = 'muse_session';
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const digest = value => createHash('sha256').update(value).digest('hex');
const csrfFor = token => createHash('sha256').update(`csrf:${token}`).digest('base64url');

function safeEqual(left, right) {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function sessionToken(request) {
  const cookies = (request.headers.cookie ?? '').split(';')
    .map(part => part.trim()).filter(part => part.split('=', 1)[0] === COOKIE_NAME);
  if (cookies.length !== 1) return null;
  const token = cookies[0].slice(COOKIE_NAME.length + 1);
  return /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : null;
}

function publicUser(user) {
  return { id: user.id, email: user.email, username: user.username, displayName: user.display_name, createdAt: user.created_at };
}

/** Server-side accounts and opaque sessions; no provider credentials are used. */
export function createAuthService({ db, readJson, sendJson, HttpError, secureCookies = false, now = Date.now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      key_hash TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_rate_limits_window ON auth_rate_limits(window_start);
  `);

  const findUser = db.prepare('SELECT * FROM users WHERE email = ?');
  const conflictingUser = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?');
  const insertUser = db.prepare('INSERT INTO users (id, email, username, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const findSession = db.prepare(`SELECT users.*, auth_sessions.expires_at AS session_expires_at,
    auth_sessions.last_seen_at AS session_last_seen_at FROM auth_sessions
    JOIN users ON users.id = auth_sessions.user_id WHERE auth_sessions.token_hash = ?`);
  const insertSession = db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)');
  const deleteSession = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?');
  const touchSession = db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?');
  const pruneSessions = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ?');
  const findRate = db.prepare('SELECT window_start, attempts FROM auth_rate_limits WHERE key_hash = ?');
  const saveRate = db.prepare(`INSERT INTO auth_rate_limits (key_hash, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(key_hash) DO UPDATE SET attempts = auth_rate_limits.attempts + 1`);
  const pruneRates = db.prepare('DELETE FROM auth_rate_limits WHERE window_start <= ?');
  const dummySalt = randomBytes(16).toString('hex');
  const dummyHash = randomBytes(64);
  let activeHashes = 0;

  function validateEmail(value) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const parts = email.split('@');
    const local = /^[a-z0-9!#$%&'*+/=?^_\x60{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_\x60{|}~-]+)*$/;
    const domain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (email.length > 254 || parts.length !== 2 || parts[0].length > 64 || !local.test(parts[0]) || !domain.test(parts[1])) {
      throw new HttpError(400, 'Enter a valid email address of at most 254 characters.');
    }
    return email;
  }

  function validatePassword(value, registration) {
    const length = typeof value === 'string' ? [...value].length : 0;
    if (length < (registration ? 12 : 1) || length > 128 || Buffer.byteLength(value, 'utf8') > 512) {
      throw new HttpError(400, registration ? 'Use a password between 12 and 128 characters.' : 'Enter a valid password.');
    }
    return value;
  }

  function validateIdentity(body) {
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new HttpError(400, 'Use 3–24 letters, numbers or underscores for your username.');
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (![...displayName].length || [...displayName].length > 60 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new HttpError(400, 'Use a display name between 1 and 60 characters without control characters.');
    }
    return { username, displayName };
  }

  function rejectBusy(response, seconds = 1) {
    response.setHeader('Retry-After', String(seconds));
    throw new HttpError(429, 'Too many authentication attempts. Please wait and try again.');
  }

  function consumeRate(request, response, kind, email) {
    const timestamp = now();
    pruneRates.run(timestamp - RATE_WINDOW);
    const limits = [
      { key: digest(`${kind}:ip:${request.socket.remoteAddress ?? 'unknown'}`), limit: kind === 'login' ? 20 : 10 },
      { key: digest(`${kind}:email:${email}`), limit: 5 },
    ];
    for (const { key, limit } of limits) {
      const row = findRate.get(key);
      if (row && row.attempts >= limit) rejectBusy(response, Math.max(1, Math.ceil((row.window_start + RATE_WINDOW - timestamp) / 1000)));
    }
    for (const { key } of limits) saveRate.run(key, timestamp);
  }

  async function passwordHash(password, salt, response) {
    if (activeHashes >= 2) rejectBusy(response);
    activeHashes++;
    try { return await deriveKey(password, salt, 64, SCRYPT_OPTIONS); }
    finally { activeHashes--; }
  }

  function setCookie(response, token, maxAge = SESSION_AGE / 1000) {
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`);
  }

  function currentSession(request, response) {
    const token = sessionToken(request);
    if (!token) return null;
    const tokenHash = digest(token);
    const user = findSession.get(tokenHash);
    if (!user) return null;
    const timestamp = now();
    if (user.session_expires_at <= timestamp || user.session_last_seen_at <= timestamp - IDLE_AGE) {
      deleteSession.run(tokenHash);
      setCookie(response, '', 0);
      return null;
    }
    touchSession.run(timestamp, tokenHash);
    return { token, user: publicUser(user), csrfToken: csrfFor(token) };
  }

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function newSession(request, user, timestamp) {
    const previous = sessionToken(request);
    if (previous) deleteSession.run(digest(previous));
    pruneSessions.run(timestamp, timestamp - IDLE_AGE);
    const token = randomBytes(32).toString('base64url');
    insertSession.run(digest(token), user.id, timestamp, timestamp, timestamp + SESSION_AGE);
    return { token, user: publicUser(user), csrfToken: csrfFor(token) };
  }

  return {
    async handle(request, response, pathname) {
      if (!pathname.startsWith('/api/auth/')) return false;
      const methods = {
        '/api/auth/session': 'GET', '/api/auth/me': 'GET',
        '/api/auth/register': 'POST', '/api/auth/login': 'POST', '/api/auth/logout': 'POST',
      };
      const method = methods[pathname];
      if (!method) throw new HttpError(404, 'Authentication route not found.');
      if (request.method !== method) {
        response.setHeader('Allow', method);
        throw new HttpError(405, `This route supports ${method}.`);
      }
      if (method === 'GET') {
        const session = currentSession(request, response);
        if (pathname === '/api/auth/me' && !session) throw new HttpError(401, 'Sign in to view your account.');
        sendJson(response, 200, pathname === '/api/auth/me'
          ? { user: session.user } : { user: session?.user ?? null, csrfToken: session?.csrfToken ?? null });
        return true;
      }
      const body = await readJson(request);
      if (pathname === '/api/auth/logout') {
        const session = currentSession(request, response);
        if (session) {
          const csrf = request.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrfToken)) throw new HttpError(403, 'The session security token is missing or invalid.');
          deleteSession.run(digest(session.token));
        }
        setCookie(response, '', 0);
        sendJson(response, 200, { user: null, csrfToken: null });
        return true;
      }
      const email = validateEmail(body.email);
      const registration = pathname === '/api/auth/register';
      const password = validatePassword(body.password, registration);
      const identity = registration ? validateIdentity(body) : null;
      consumeRate(request, response, registration ? 'register' : 'login', email);
      let session;
      if (registration) {
        const salt = randomBytes(16).toString('hex');
        const hash = await passwordHash(password, salt, response);
        const timestamp = now();
        const user = { id: randomUUID(), email, username: identity.username, display_name: identity.displayName,
          password_hash: hash.toString('hex'), password_salt: salt, created_at: new Date(timestamp).toISOString() };
        try {
          session = transaction(() => {
            insertUser.run(user.id, user.email, user.username, user.display_name, user.password_hash, user.password_salt, user.created_at);
            return newSession(request, user, timestamp);
          });
        } catch (error) {
          if (conflictingUser.get(email, identity.username)) throw new HttpError(409, 'An account with those details already exists.');
          throw error;
        }
      } else {
        const user = findUser.get(email);
        const validHash = user && /^[a-f0-9]{32}$/.test(user.password_salt) && /^[a-f0-9]{128}$/.test(user.password_hash);
        const hash = await passwordHash(password, validHash ? user.password_salt : dummySalt, response);
        const matches = safeEqual(hash, validHash ? Buffer.from(user.password_hash, 'hex') : dummyHash);
        if (!validHash || !matches) throw new HttpError(401, 'Email or password is incorrect.');
        session = transaction(() => newSession(request, user, now()));
      }
      setCookie(response, session.token);
      sendJson(response, 200, { user: session.user, csrfToken: session.csrfToken });
      return true;
    },
  };
}
