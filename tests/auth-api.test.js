import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthApi } from '../src/lib/auth-api.js';

const user = { id: 'account-id', username: 'music_maker', displayName: 'Music Maker',
  email: 'creator@example.com', createdAt: '2026-11-21T00:00:00.000Z' };
const reply = body => ({ ok: true, status: 200, json: async () => body });

test('logout refreshes a rotated cookie session once and does not retry persistent rejection indefinitely', async t => {
  let token = 'first'; let sessionRequests = 0; let logoutRequests = 0; let rejectAll = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/session')) { sessionRequests++; return reply({ user, csrfToken: token }); }
    logoutRequests++;
    if (rejectAll || options.headers['X-CSRF-Token'] !== token) return { ok: false, status: 403, json: async () => ({ error: 'Session changed.' }) };
    return reply({ user: null, csrfToken: null });
  });
  const api = createAuthApi(); await api.session(); token = 'rotated';
  assert.deepEqual(await api.signOut(), { user: null, csrfToken: null });
  assert.equal(sessionRequests, 2); assert.equal(logoutRequests, 2);
  await api.session(); rejectAll = true;
  await assert.rejects(api.signOut(), /Session changed/);
  assert.equal(logoutRequests, 4);
});

test('account API rejects malformed successful responses before they enter application state', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async () => reply(body));
  for (body of [[], {}, { user: {} }, { user: { ...user, displayName: 42 }, csrfToken: 'csrf' },
    { user, csrfToken: null }, { user: null, csrfToken: 'csrf' }]) {
    await assert.rejects(createAuthApi().session(), /invalid response/i);
  }
  body = { user: null, csrfToken: null };
  await assert.rejects(createAuthApi().signIn({}), /invalid response/i);
});

test('account API restores valid sessions and sends their CSRF token when signing out', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return reply(url.endsWith('/logout') ? { user: null, csrfToken: null } : { user, csrfToken: 'csrf' });
  });
  const api = createAuthApi();
  assert.deepEqual(await api.session(), { user, csrfToken: 'csrf' });
  assert.deepEqual(await api.signOut(), { user: null, csrfToken: null });
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'csrf');
  assert.equal(calls[1].options.credentials, 'same-origin');
});
