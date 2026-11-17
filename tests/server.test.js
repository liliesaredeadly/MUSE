import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';

const defaults = { bpm: 90, sourceBpm: 90, instrument: 'Piano', mood: 'Dreamy', genre: 'Ambient', accompaniment: true, percussion: false };
const project = () => ({ id: 'test-melody', title: 'Evening idea', notes: [{ midi: 60, name: 'C4', start: 0, duration: 0.5, confidence: 0.9 }], settings: { ...defaults }, createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:00:00.000Z' });

async function startApp(options = {}) {
  const server = createApp({ dbPath: ':memory:', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function json(url, route, body) {
  const response = await fetch(`${url}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function temporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), 'muse-http-'));
}

async function removeTemporaryDirectory(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  assert.ok(path.basename(directory).startsWith('muse-http-'));
  await rm(directory, { recursive: true, force: true });
}

test('health reports a working SQLite backend and the empty library is real', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const health = await json(app.url, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.storage, 'sqlite');
  assert.deepEqual((await json(app.url, '/api/projects')).body, { projects: [] });
});

test('HTTP projects save, list, reopen and update through the database', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const source = { ...project(), originalAudio: 'private audio', blob: 'private audio' };
  const saved = await json(app.url, '/api/projects', source);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.project.title, 'Evening idea');
  assert.equal(saved.body.project.notes[0].midi, 60);
  assert.deepEqual(saved.body.project.settings, defaults);
  assert.equal(Object.hasOwn(saved.body.project, 'originalAudio'), false);
  const reopened = await json(app.url, '/api/projects/test-melody');
  assert.deepEqual(reopened.body.project, saved.body.project);
  const updated = await json(app.url, '/api/projects', { ...source, title: 'Revised idea', createdAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(updated.body.project.createdAt, '2026-11-17T10:00:00.000Z');
  const listing = await json(app.url, '/api/projects');
  assert.equal(listing.body.projects.length, 1);
  assert.equal(listing.body.projects[0].title, 'Revised idea');
});

test('a saved project survives closing and restarting the server', async (t) => {
  const directory = await temporaryDirectory();
  const dbPath = path.join(directory, 'muse.sqlite');
  let active = await startApp({ dbPath });
  t.after(async () => { if (active.server.listening) await active.close(); await removeTemporaryDirectory(directory); });
  const saved = await json(active.url, '/api/projects', project());
  await active.close();
  active = await startApp({ dbPath });
  const reopened = await json(active.url, '/api/projects/test-melody');
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.body.project, saved.body.project);
});

test('invalid musical data and unsafe project values receive useful 400 errors', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const source = project();
  const invalid = [
    null,
    { ...source, id: '../../outside' },
    { ...source, title: 'x'.repeat(101) },
    { ...source, title: 'bad\u0000title' },
    { ...source, notes: [{ midi: 128, start: 0, duration: 1 }] },
    { ...source, notes: [{ midi: 60.5, start: 0, duration: 1 }] },
    { ...source, notes: [{ midi: 60, start: -1, duration: 1 }] },
    { ...source, notes: [{ midi: 60, start: 0, duration: 0 }] },
    { ...source, notes: [{ midi: 60, start: 0, duration: 1e300 }] },
    { ...source, notes: [{ midi: 60, start: 0, duration: 1, confidence: 2 }] },
    { ...source, notes: Array.from({ length: 513 }, () => source.notes[0]) },
    { ...source, settings: { ...defaults, bpm: '90' } },
    { ...source, settings: { ...defaults, bpm: 250 } },
    { ...source, settings: { ...defaults, instrument: 'Unknown' } },
    { ...source, settings: { ...defaults, accompaniment: 'true' } },
    { ...source, createdAt: 'yesterday' },
  ];
  for (const value of invalid) {
    const result = await json(app.url, '/api/projects', value);
    assert.equal(result.status, 400, JSON.stringify(value)?.slice(0, 100));
    assert.equal(typeof result.body.error, 'string');
    assert.ok(result.body.error.length > 5);
  }
  assert.deepEqual((await json(app.url, '/api/projects')).body.projects, []);
});

test('HTTP arrangement invokes the music engine and rejects absent or invalid melody', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const result = await json(app.url, '/api/arrange', { notes: project().notes, settings: defaults });
  assert.equal(result.status, 200);
  assert.equal(result.body.arrangement.bpm, 90);
  assert.ok(result.body.arrangement.events.some((event) => event.track === 'melody' && event.midi === 60));
  assert.ok(result.body.arrangement.duration > 0);
  assert.equal((await json(app.url, '/api/arrange', { notes: [], settings: defaults })).status, 400);
  assert.equal((await json(app.url, '/api/arrange', { notes: [{ midi: null, start: 0, duration: 1 }], settings: defaults })).status, 400);
});

test('HTTP arrangement rejects a slowdown that would drop notes beyond the render limit', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const settings = { ...defaults, sourceBpm: 200, bpm: 40 };
  const mixedNotes = [{ midi: 60, start: 0, duration: 1 }, { midi: 67, start: 119, duration: 2 }];
  const partial = await json(app.url, '/api/arrange', { notes: mixedNotes, settings });
  assert.equal(partial.status, 400);
  assert.match(partial.body.error, /600.*second|second.*600/i);
  const empty = await json(app.url, '/api/arrange', { notes: [{ midi: 64, start: 0, duration: 600 }], settings });
  assert.equal(empty.status, 400);
  // The same long phrase remains a valid stored project; only rendering is limited.
  const stored = await json(app.url, '/api/projects', { ...project(), notes: [{ midi: 64, start: 0, duration: 600 }], settings });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.project.notes[0].duration, 600);
});

test('HTTP arrangement preserves a normal 60-second take at the maximum fivefold slowdown', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const notes = [{ midi: 60, start: 0, duration: 1 }, { midi: 64, start: 29, duration: 1 }, { midi: 67, start: 59, duration: 1 }];
  const result = await json(app.url, '/api/arrange', { notes, settings: { ...defaults, sourceBpm: 200, bpm: 40 } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.arrangement.events.filter((event) => event.track === 'melody').map((event) => event.midi), [60, 64, 67]);
  assert.equal(result.body.arrangement.duration, 300);
});

test('HTTP producer returns honest supported proposals and validates direction input', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const result = await json(app.url, '/api/producer', { text: 'cinematic strings, no drums, tempo 110', settings: defaults });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.changes, { mood: 'Cinematic', instrument: 'Strings', percussion: false, bpm: 110 });
  assert.match(result.body.message, /propos|apply/i);
  assert.equal((await json(app.url, '/api/producer', { text: 'x'.repeat(4001), settings: defaults })).status, 400);
  assert.equal((await json(app.url, '/api/producer', { text: { prompt: 'drums' }, settings: defaults })).status, 400);
});

test('malformed, oversized and unsupported HTTP requests return JSON errors', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const malformed = await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /json/i);
  const oversized = await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(256 * 1024) }) });
  assert.equal(oversized.status, 413);
  assert.equal(typeof (await oversized.json()).error, 'string');
  assert.equal((await json(app.url, '/api/missing')).status, 404);
  assert.equal((await json(app.url, '/api/projects/missing')).status, 404);
  const wrongMethod = await fetch(`${app.url}/api/projects`, { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(typeof (await wrongMethod.json()).error, 'string');
  const plain = await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 415);
});

test('production static serving supports SPA routes and protects files outside dist', async (t) => {
  const directory = await temporaryDirectory();
  const staticDir = path.join(directory, 'dist');
  await mkdir(path.join(staticDir, 'assets'), { recursive: true });
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>MUSE</title>');
  await writeFile(path.join(staticDir, 'assets', 'app-123.js'), 'window.muse = true;');
  await writeFile(path.join(directory, 'private.txt'), 'private database content');
  const app = await startApp({ serveStatic: true, staticDir });
  t.after(async () => { await app.close(); await removeTemporaryDirectory(directory); });
  const index = await fetch(`${app.url}/studio`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<title>MUSE<\/title>/);
  const script = await fetch(`${app.url}/assets/app-123.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.match(script.headers.get('cache-control'), /immutable/);
  const traversal = await fetch(`${app.url}/%2e%2e%2fprivate.txt`);
  assert.ok([400, 403, 404].includes(traversal.status));
  assert.doesNotMatch(await traversal.text(), /private database content/);
  assert.equal((await fetch(`${app.url}/assets/missing.js`)).status, 404);
});
