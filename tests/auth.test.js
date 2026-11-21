import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthService } from '../server/auth.js';

const account = (changes = {}) => ({ email: 'Creator@Example.com', password: 'twelve good notes', username: 'music_maker', displayName: 'Music Maker', ...changes });
const jsonHeaders = { 'Content-Type': 'application/json' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON.');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected an object.');
  return value;
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function startAuth(options = {}) {
  const db = new DatabaseSync(options.dbPath ?? ':memory:');
  const auth = createAuthService({ db, readJson, sendJson, HttpError, ...options });
  const server = createServer(async (request, response) => {
    try {
      if (!await auth.handle(request, response, new URL(request.url, 'http://localhost').pathname)) sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      sendJson(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Unexpected error.' });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    db, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => {
      db.close();
      if (error) reject(error); else resolve();
    })),
  };
}

async function request(app, route, { body, cookie, csrfToken, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(`${app.url}${route}`, {
    method, headers: { ...(body === undefined ? {} : jsonHeaders), ...(cookie ? { Cookie: cookie } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie'), headers: response.headers };
}

const cookieValue = result => result.cookie?.split(';', 1)[0];

async function temporaryDatabase(t, close) {
  const directory = await mkdtemp(path.join(tmpdir(), 'muse-auth-'));
  t.after(async () => {
    await close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('muse-auth-'));
    await rm(directory, { recursive: true, force: true });
  });
  return path.join(directory, 'auth.sqlite');
}

test('registration creates a real account, a private persistent cookie and a protected current user', async (t) => {
  const app = await startAuth();
  t.after(app.close);
  assert.deepEqual((await request(app, '/api/auth/session')).body, { user: null, csrfToken: null });
  assert.equal((await request(app, '/api/auth/me')).status, 401);
  const registered = await request(app, '/api/auth/register', { body: account() });
  assert.equal(registered.status, 200);
  assert.deepEqual(Object.keys(registered.body).sort(), ['csrfToken', 'user']);
  assert.deepEqual(Object.keys(registered.body.user).sort(), ['createdAt', 'displayName', 'email', 'id', 'username']);
  assert.equal(registered.body.user.email, 'creator@example.com');
  assert.equal(registered.body.user.username, 'music_maker');
  assert.equal(registered.body.user.displayName, 'Music Maker');
  assert.ok(Number.isFinite(Date.parse(registered.body.user.createdAt)));
  assert.ok(registered.body.csrfToken.length >= 32);
  for (const flag of [/HttpOnly/i, /SameSite=Lax/i, /Path=\//i, /Max-Age=2592000/i]) assert.match(registered.cookie, flag);
  assert.doesNotMatch(registered.cookie, /;\s*Secure/i);
  const cookie = cookieValue(registered);
  const current = await request(app, '/api/auth/me', { cookie });
  assert.equal(current.status, 200);
  assert.deepEqual(current.body, { user: registered.body.user });
  assert.deepEqual((await request(app, '/api/auth/session', { cookie })).body, registered.body);
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const storedSession = app.db.prepare('SELECT * FROM auth_sessions').get();
  assert.equal(storedSession.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.doesNotMatch(JSON.stringify(storedSession), new RegExp(token));
  const storedUser = app.db.prepare('SELECT * FROM users').get();
  assert.notEqual(storedUser.password_hash, account().password);
  assert.ok(storedUser.password_salt.length >= 32);
  assert.doesNotMatch(JSON.stringify(registered.body), /password|salt|token_hash/);
});

test('registration validates identities and password bounds before creating users', async (t) => {
  const app = await startAuth();
  t.after(app.close);
  for (const body of [
    account({ email: 'invalid' }), account({ email: `${'a'.repeat(250)}@example.com` }),
    account({ username: 'ab' }), account({ username: 'a'.repeat(25) }), account({ username: 'bad name' }),
    account({ displayName: '' }), account({ displayName: 'a'.repeat(61) }), account({ displayName: 'two\nlines' }),
    account({ password: 'short' }), account({ password: 'a'.repeat(129) }), account({ password: 123456789012 }),
    account({ email: null }), account({ username: null }), account({ displayName: null }),
  ]) assert.equal((await request(app, '/api/auth/register', { body })).status, 400);
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  const unicode = await request(app, '/api/auth/register', { body: account({ password: '🎵'.repeat(128), username: 'UPPER_CASE', email: '  Creator@EXAMPLE.COM  ' }) });
  assert.equal(unicode.status, 200);
  assert.equal(unicode.body.user.username, 'upper_case');
  assert.equal(unicode.body.user.email, 'creator@example.com');
});

test('duplicate email and username do not overwrite the original account', async (t) => {
  const app = await startAuth();
  t.after(app.close);
  const registered = await request(app, '/api/auth/register', { body: account() });
  assert.equal(registered.status, 200);
  for (const body of [account({ username: 'different_name', email: 'CREATOR@EXAMPLE.COM' }), account({ email: 'other@example.com', username: 'MUSIC_MAKER' })]) {
    assert.equal((await request(app, '/api/auth/register', { body })).status, 409);
  }
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM users').get().count, 1);
  assert.equal((await request(app, '/api/auth/login', { body: { email: 'creator@example.com', password: account().password } })).body.user.id, registered.body.user.id);
});

test('login rotates the previous cookie and wrong or unknown credentials have the same error', async (t) => {
  const app = await startAuth();
  t.after(app.close);
  const registered = await request(app, '/api/auth/register', { body: account() });
  const cookie = cookieValue(registered);
  const wrong = await request(app, '/api/auth/login', { body: { email: 'creator@example.com', password: 'a different long password' } });
  const unknown = await request(app, '/api/auth/login', { body: { email: 'missing@example.com', password: 'a different long password' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.cookie, null);
  const loggedIn = await request(app, '/api/auth/login', { cookie, body: { email: 'CREATOR@example.com', password: account().password } });
  assert.equal(loggedIn.status, 200);
  assert.notEqual(cookieValue(loggedIn), cookie);
  assert.notEqual(loggedIn.body.csrfToken, registered.body.csrfToken);
  assert.equal((await request(app, '/api/auth/me', { cookie })).status, 401);
  assert.equal((await request(app, '/api/auth/me', { cookie: cookieValue(loggedIn) })).status, 200);
});

test('accounts and sessions survive closing and reopening SQLite', async (t) => {
  let app;
  const dbPath = await temporaryDatabase(t, async () => { if (app) await app.close(); });
  app = await startAuth({ dbPath });
  const registered = await request(app, '/api/auth/register', { body: account() });
  await app.close();
  app = null;
  app = await startAuth({ dbPath });
  const current = await request(app, '/api/auth/session', { cookie: cookieValue(registered) });
  assert.equal(current.status, 200);
  assert.deepEqual(current.body, registered.body);
});

test('server enforces seven-day idle expiry and thirty-day absolute expiry', async (t) => {
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.parse('2026-11-20T00:00:00.000Z');
  const app = await startAuth({ now: () => clock });
  t.after(app.close);
  const idle = await request(app, '/api/auth/register', { body: account() });
  clock += 7 * day;
  assert.equal((await request(app, '/api/auth/me', { cookie: cookieValue(idle) })).status, 401);
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM auth_sessions').get().count, 0);
  const active = await request(app, '/api/auth/login', { body: { email: 'creator@example.com', password: account().password } });
  const cookie = cookieValue(active);
  for (let step = 0; step < 4; step++) {
    clock += 6 * day;
    assert.equal((await request(app, '/api/auth/me', { cookie })).status, 200);
  }
  clock += 6 * day;
  assert.equal((await request(app, '/api/auth/me', { cookie })).status, 401);
  assert.deepEqual((await request(app, '/api/auth/session', { cookie })).body, { user: null, csrfToken: null });
});

test('logout requires the session CSRF token and revokes the cookie in SQLite', async (t) => {
  const app = await startAuth();
  t.after(app.close);
  const registered = await request(app, '/api/auth/register', { body: account() });
  const cookie = cookieValue(registered);
  for (const csrfToken of [undefined, 'incorrect']) assert.equal((await request(app, '/api/auth/logout', { cookie, csrfToken, body: {} })).status, 403);
  assert.equal((await request(app, '/api/auth/me', { cookie })).status, 200);
  const loggedOut = await request(app, '/api/auth/logout', { cookie, csrfToken: registered.body.csrfToken, body: {} });
  assert.equal(loggedOut.status, 200);
  assert.deepEqual(loggedOut.body, { user: null, csrfToken: null });
  assert.match(loggedOut.cookie, /Max-Age=0/i);
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM auth_sessions').get().count, 0);
  assert.equal((await request(app, '/api/auth/me', { cookie })).status, 401);
  assert.equal((await request(app, '/api/auth/logout', { cookie, body: {} })).status, 200);
});

test('ambiguous or invalid session cookies never authenticate a request', async (t) => {
  const app = await startAuth();
  t.after(app.close);
  const registered = await request(app, '/api/auth/register', { body: account() });
  const cookie = cookieValue(registered);
  for (const value of [`${cookie}; ${cookie}`, `${cookie}; muse_session=invalid`, 'muse_session=not-a-token', 'muse_session=%00']) {
    assert.equal((await request(app, '/api/auth/me', { cookie: value })).status, 401);
    assert.deepEqual((await request(app, '/api/auth/session', { cookie: value })).body, { user: null, csrfToken: null });
  }
  assert.equal((await request(app, '/api/auth/me', { cookie })).status, 200);
});

test('failed-login limits persist across restart and expire with the retry window', async (t) => {
  let app;
  const dbPath = await temporaryDatabase(t, async () => { if (app) await app.close(); });
  let clock = Date.parse('2026-11-20T00:00:00.000Z');
  app = await startAuth({ dbPath, now: () => clock });
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await request(app, '/api/auth/login', { body: { email: 'missing@example.com', password: account().password } })).status, 401);
  }
  const limited = await request(app, '/api/auth/login', { body: { email: 'missing@example.com', password: account().password } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.doesNotMatch(JSON.stringify(app.db.prepare('SELECT * FROM auth_rate_limits').all()), /missing@example\.com|127\.0\.0\.1/);
  await app.close();
  app = null;
  app = await startAuth({ dbPath, now: () => clock });
  assert.equal((await request(app, '/api/auth/login', { body: { email: 'missing@example.com', password: account().password } })).status, 429);
  clock += 15 * 60 * 1000 + 1;
  assert.equal((await request(app, '/api/auth/login', { body: { email: 'missing@example.com', password: account().password } })).status, 401);
});

test('concurrent password work is bounded and overload does not create accounts', async (t) => {
  const app = await startAuth();
  t.after(app.close);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => request(app, '/api/auth/login', { body: { email: `missing${index}@example.com`, password: account().password } })));
  assert.ok(results.some(result => result.status === 429));
  assert.ok(results.some(result => result.status === 401));
  assert.ok(results.every(result => [401, 429].includes(result.status)));
  assert.equal(app.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
});

test('auth routes preserve method validation and leave unrelated routes to the app', async (t) => {
  const app = await startAuth({ secureCookies: true });
  t.after(app.close);
  const method = await request(app, '/api/auth/login');
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await request(app, '/api/auth/unknown')).status, 404);
  assert.equal((await request(app, '/api/projects')).status, 404);
  const registered = await request(app, '/api/auth/register', { body: account() });
  assert.match(registered.cookie, /;\s*Secure/i);
});
