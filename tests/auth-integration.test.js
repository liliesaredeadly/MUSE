import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';

async function appFixture(t) {
  const server = createApp({ dbPath: ':memory:', producerBrain: { status: () => ({ mode: 'rules', provider: null, model: null }) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, { body, headers = {}, method } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

const credentials = () => ({ email: ' Artist@example.test ', username: 'session_artist', displayName: 'Session Artist', password: 'A steady melody 24!' });

test('real account endpoints restore and revoke a session without changing the local music library', async t => {
  const request = await appFixture(t);
  const session = await request('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.user, null);
  assert.equal((await request('/api/auth/me')).status, 401);
  const melody = { id: 'existing-local-melody', title: 'Existing local idea', notes: [{ midi: 60, start: 0, duration: 0.5 }], settings: {} };
  const saved = await request('/api/projects', { body: melody });
  assert.equal(saved.status, 200);

  const registered = await request('/api/auth/register', { body: credentials() });
  assert.equal(registered.status, 200);
  assert.equal(registered.body.user.email, 'artist@example.test');
  assert.equal(registered.body.user.username, 'session_artist');
  assert.ok(registered.body.csrfToken);
  const cookieHeader = registered.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Lax/i);
  const cookie = cookieHeader.split(';')[0];
  const restored = await request('/api/auth/session', { headers: { Cookie: cookie } });
  assert.equal(restored.body.user.id, registered.body.user.id);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
  assert.deepEqual((await request('/api/projects', { headers: { Cookie: cookie } })).body.projects, [saved.body.project]);

  const logout = await request('/api/auth/logout', { body: {}, headers: { Cookie: cookie, 'X-CSRF-Token': restored.body.csrfToken } });
  assert.equal(logout.status, 200);
  assert.equal(logout.body.user, null);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.deepEqual((await request('/api/projects')).body.projects, [saved.body.project]);
});

test('account routes share the existing HTTP authority, method and JSON protections', async t => {
  const request = await appFixture(t);
  const denied = await request('/api/auth/register', { body: credentials(), headers: { Origin: 'https://foreign.example' } });
  assert.equal(denied.status, 403);
  const method = await request('/api/auth/register');
  assert.equal(method.status, 405);
  assert.match(method.headers.get('allow'), /POST/);
  const wrongType = await request('/api/auth/login', { body: { email: 'artist@example.test', password: 'A steady melody 24!' }, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  assert.equal((await request('/api/auth/unknown')).status, 404);
  assert.equal((await request('/api/auth/register', { body: credentials() })).status, 200);
});
