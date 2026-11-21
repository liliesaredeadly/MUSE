// Account fixtures stay in this developer-only harness; no real users are created.
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/auth.css';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const fixtureUser = { id: 'auth-qa-user', email: 'melody@example.test', username: 'melody_qa', displayName: 'Melody QA', createdAt: '2026-11-20T10:00:00.000Z' };
async function waitFor(check, message) {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) { if (check()) return; await sleep(20); }
  throw new Error(message);
}
function edit(input, value) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function button(host, name) {
  const found = [...host.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') || item.textContent.trim()) === name);
  assert(found, `Missing account action: ${name}`); return found;
}
async function withFetch(handler, action) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => handler(new URL(input, location.href).pathname, options);
  try { return await action(); } finally { globalThis.fetch = original; }
}
async function withAccount(action, { busy = false } = {}) {
  const [{ useAuth }, { default: AuthPanel }] = await Promise.all([import('../src/hooks/useAuth.js'), import('../src/components/AuthPanel.jsx')]);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let latest;
  function Harness() {
    const auth = useAuth(); const [open, setOpen] = useState(false);
    useLayoutEffect(() => { latest = auth; });
    return <><button data-account-trigger onClick={() => setOpen(true)}>Open account fixture</button>{open && <AuthPanel auth={auth} busy={busy} onClose={() => setOpen(false)} />}</>;
  }
  root.render(<Harness />);
  try { await waitFor(() => latest, 'The account hook did not mount.'); return await action(() => latest, host); }
  finally { root.unmount(); host.remove(); await sleep(20); }
}
const checks = [
  {
    id: 'account-unicode-registration', title: 'Signup uses Unicode character limits for musical names and passwords',
    async run() {
      const musicalPassword = '🎵'.repeat(128); const musicalName = '🎵'.repeat(60);
      let registrations = 0;
      return withFetch((path, options) => {
        if (path === '/api/auth/session') return response({ user: null, csrfToken: null });
        if (path === '/api/auth/register') {
          registrations++;
          const body = JSON.parse(options.body);
          assert(body.password === musicalPassword && body.displayName === musicalName, 'The musical characters were changed or truncated before signup.');
          return response({ user: { ...fixtureUser, displayName: musicalName }, csrfToken: 'unicode-csrf' }, 201);
        }
        throw new Error(`Unexpected Unicode account request: ${path}`);
      }, () => withAccount(async (get, host) => {
        await waitFor(() => get().status === 'anonymous', 'The Unicode signup fixture did not load.');
        host.querySelector('[data-account-trigger]').click();
        await waitFor(() => host.querySelector('dialog[open]'), 'The Unicode signup dialog did not open.');
        const dialog = host.querySelector('dialog'); button(dialog, 'Create an account').click();
        await waitFor(() => dialog.querySelector('[name="displayName"]'), 'The Unicode signup form did not open.');
        edit(dialog.querySelector('[name="displayName"]'), musicalName);
        edit(dialog.querySelector('[name="username"]'), fixtureUser.username);
        edit(dialog.querySelector('[name="email"]'), fixtureUser.email);
        edit(dialog.querySelector('[name="password"]'), musicalPassword);
        button(dialog, 'Create account').click();
        await waitFor(() => get().status === 'authenticated' || dialog.querySelector('[aria-invalid="true"]'), 'Unicode signup did not settle.');
        assert(registrations === 1 && get().status === 'authenticated', 'A valid 128-character musical password or 60-character name was rejected as UTF-16 units.');
      }));
    },
  },
  {
    id: 'account-logout-refreshes-cross-tab-csrf', title: 'Logout recovers when another tab rotates the shared session cookie',
    async run() {
      let token = 'first-tab-csrf'; let sessionRequests = 0; let logoutRequests = 0;
      return withFetch((path, options) => {
        if (path === '/api/auth/session') { sessionRequests++; return response({ user: fixtureUser, csrfToken: token }); }
        if (path === '/api/auth/logout') {
          logoutRequests++;
          if (options.headers['X-CSRF-Token'] !== token) return response({ error: 'The session changed in another tab.' }, 403);
          return response({ user: null, csrfToken: null });
        }
        throw new Error(`Unexpected cross-tab account request: ${path}`);
      }, () => withAccount(async get => {
        await waitFor(() => get().status === 'authenticated', 'The first-tab account did not restore.');
        token = 'second-tab-rotated-csrf';
        await get().signOut();
        await waitFor(() => get().status === 'anonymous' && !get().pending, 'Logout could not recover the rotated shared cookie session.');
        assert(sessionRequests === 2 && logoutRequests <= 2, 'Logout did not refresh the changed session once or retried without a bound.');
      }));
    },
  },
  {
    id: 'account-session-roundtrip', title: 'The account hook restores a cookie session and signs out with its CSRF token',
    async run() {
      let loggedIn = false; const requests = [];
      return withFetch((path, options) => {
        requests.push({ path, options });
        assert(options.credentials === 'same-origin' && options.cache === 'no-store', 'Account requests omitted cookie or cache isolation.');
        if (path === '/api/auth/session') return response({ user: loggedIn ? fixtureUser : null, csrfToken: loggedIn ? 'qa-memory-csrf' : null });
        if (path === '/api/auth/login') { loggedIn = true; return response({ user: fixtureUser, csrfToken: 'qa-memory-csrf' }); }
        if (path === '/api/auth/logout') {
          assert(options.headers['X-CSRF-Token'] === 'qa-memory-csrf', 'Logout omitted the server-issued in-memory CSRF token.');
          assert(options.body === '{}', 'Logout did not send its explicit empty JSON body.');
          loggedIn = false; return response({ user: null, csrfToken: null });
        }
        throw new Error(`Unexpected account request: ${path}`);
      }, async () => {
        await withAccount(async get => {
          await waitFor(() => get().status === 'anonymous', 'The initial anonymous cookie session did not settle.');
          await get().signIn({ email: fixtureUser.email, password: 'correct QA password' });
          await waitFor(() => get().user?.id === fixtureUser.id && !get().pending, 'Successful login did not establish the account.');
        });
        await withAccount(async get => {
          await waitFor(() => get().status === 'authenticated', 'A new hook did not restore the existing cookie session.');
          await get().signOut();
          await waitFor(() => get().status === 'anonymous' && !get().user, 'Logout did not clear the authenticated account.');
        });
        assert(requests.filter(item => item.path === '/api/auth/session').length === 2, 'The persisted session was not checked on both mounts.');
      });
    },
  },
  {
    id: 'account-form-errors', title: 'Account forms validate signup, mask passwords and preserve email after generic login errors',
    async run() {
      let loginRequests = 0; let registrations = 0;
      return withFetch((path, options) => {
        if (path === '/api/auth/session') return response({ user: null, csrfToken: null });
        if (path === '/api/auth/login') { loginRequests++; return response({ error: 'Private server detail must not leak' }, 401); }
        if (path === '/api/auth/register') { registrations++; return response({ user: fixtureUser, csrfToken: 'qa-signup-csrf' }, 201); }
        throw new Error(`Unexpected account request: ${path}`);
      }, () => withAccount(async (get, host) => {
        await waitFor(() => get().status === 'anonymous', 'Anonymous session did not settle.');
        const trigger = host.querySelector('[data-account-trigger]'); trigger.focus(); trigger.click();
        await waitFor(() => host.querySelector('dialog[open]'), 'The account dialog did not open.');
        const dialog = host.querySelector('dialog');
        edit(dialog.querySelector('[name="email"]'), fixtureUser.email);
        const password = dialog.querySelector('[name="password"]');
        assert(password.type === 'password' && password.autocomplete === 'current-password', 'Sign-in password semantics are incorrect.');
        edit(password, 'incorrect QA password');
        button(dialog, 'Show password').click(); await waitFor(() => password.type === 'text', 'Show password did not reveal the typed password.');
        button(dialog, 'Hide password').click();
        button(dialog, 'Sign in').click();
        await waitFor(() => dialog.querySelector('[role="alert"]'), 'An incorrect password produced no inline error.');
        assert(loginRequests === 1 && !dialog.textContent.includes('Private server detail'), 'Login leaked a private error or sent duplicate requests.');
        assert(dialog.querySelector('[name="email"]').value === fixtureUser.email && dialog.querySelector('[name="password"]').value === '', 'A login error erased the email or retained the incorrect password.');
        button(dialog, 'Create an account').click();
        await waitFor(() => dialog.querySelector('[name="username"]'), 'Create account did not show registration fields.');
        button(dialog, 'Create account').click();
        await waitFor(() => dialog.querySelector('[aria-invalid="true"]'), 'Signup errors were not associated with fields.');
        assert(registrations === 0, 'An invalid registration reached the server.');
        edit(dialog.querySelector('[name="displayName"]'), fixtureUser.displayName);
        edit(dialog.querySelector('[name="username"]'), fixtureUser.username);
        edit(dialog.querySelector('[name="password"]'), 'correct QA password');
        button(dialog, 'Create account').click();
        await waitFor(() => dialog.textContent.includes(fixtureUser.displayName) && get().status === 'authenticated', 'Valid registration did not show the new signed-in account.');
        assert(registrations === 1, 'Valid signup was not submitted exactly once.');
        button(dialog, 'Close account').click();
        await waitFor(() => !host.querySelector('dialog'), 'The account dialog did not close.');
        assert(document.activeElement === trigger, 'Closing the account dialog did not restore trigger focus.');
      }));
    },
  },
  {
    id: 'account-offline-retry-and-busy', title: 'Session failures are recoverable and capture busy prevents account mutations',
    async run() {
      let available = false; let mutations = 0;
      return withFetch((path, options) => {
        if (path === '/api/auth/session') { if (!available) throw new TypeError('Synthetic disconnected server'); return response({ user: fixtureUser, csrfToken: 'qa-csrf' }); }
        mutations++; throw new Error('Account mutation must remain blocked while capturing.');
      }, () => withAccount(async (get, host) => {
        await waitFor(() => get().status === 'error' && !get().pending, 'The initial session failure did not become a recoverable state.');
        host.querySelector('[data-account-trigger]').click();
        await waitFor(() => host.querySelector('dialog[open]'), 'The offline account dialog did not open.');
        const dialog = host.querySelector('dialog');
        available = true;
        button(dialog, 'Check session').click();
        await waitFor(() => get().status === 'authenticated', 'Checking the session did not recover the signed-in account.');
        assert(button(dialog, 'Sign out').disabled, 'Capture busy left Sign out enabled.');
        assert(mutations === 0, 'Checking the session submitted a mutation.');
      }, { busy: true }));
    },
  },
];

function Checks() {
  const [results, setResults] = useState([]); const [status, setStatus] = useState('idle');
  async function run() {
    setStatus('running'); const next = [];
    for (const check of checks) {
      try { await check.run(); next.push({ id: check.id, title: check.title, status: 'passed' }); }
      catch (error) { next.push({ id: check.id, title: check.title, status: 'failed', error: error.message }); }
      setResults([...next]);
    }
    setStatus(next.some(item => item.status === 'failed') ? 'failed' : 'passed');
  }
  return <main><h1>MUSE account browser checks</h1><p>Isolated synthetic account fixtures; no real users are created.</p><button id="run-auth-checks" disabled={status === 'running'} onClick={run}>Run account checks</button><output id="auth-summary" data-status={status}>{status}</output><ol>{results.map(item => <li key={item.id} data-test-id={item.id} data-status={item.status}>{item.title}{item.error && <pre>{item.error}</pre>}</li>)}</ol><pre id="auth-machine-results">{JSON.stringify({ status, results }, null, 2)}</pre></main>;
}
createRoot(document.getElementById('root')).render(<Checks />);
