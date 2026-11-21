import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.js';
import { interpretDirection } from '../src/producer/producer.js';

const defaults = { bpm: 90, sourceBpm: 90, instrument: 'Piano', leadSource: 'instrument', mood: 'Dreamy', genre: 'Ambient', production: 'auto', accompaniment: true, bass: true, percussion: false, preserveMelodyTiming: true };
const project = () => ({ id: 'test-melody', title: 'Evening idea', notes: [{ midi: 60, name: 'C4', start: 0, duration: 0.5, confidence: 0.9 }], settings: { ...defaults }, createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:00:00.000Z' });

async function startApp(options = {}) {
  const server = createApp({ dbPath: ':memory:', producerBrain: {
    status: () => ({ mode: 'rules', provider: null, model: null }),
    propose: async ({ text, settings }) => ({ ...interpretDirection(text, settings), source: 'rules' }),
  }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function json(url, route, body) {
  const response = await fetch(`${url}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

function requestWithHeaders(url, route, headers, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(route, url), {
      method: body === undefined ? 'GET' : 'POST', headers, setHost: false, agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
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

test('generic production settings save and arrange unfamiliar notes and reject unsupported presets', async t => {
  const app = await startApp(); t.after(app.close);
  const melody = [{ midi: 57, start: 0.13, duration: 0.31 }, { midi: 66, start: 0.61, duration: 0.28 }, { midi: 63, start: 1.07, duration: 0.45 }];
  for (const production of ['auto', 'dance-pop', 'percussive-pop']) {
    const value = { ...project(), id: `production-${production}`, notes: melody, settings: { ...defaults, genre: 'Pop', production } };
    const saved = await json(app.url, '/api/projects', value);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.project.settings.production, production);
    const arranged = await json(app.url, '/api/arrange', { notes: melody, settings: value.settings });
    assert.equal(arranged.status, 200);
    assert.equal(arranged.body.arrangement.settings.production, production);
    assert.deepEqual(arranged.body.arrangement.events.filter(event => event.track === 'melody').map(({ midi, start, duration }) => ({ midi, start, duration })), melody);
  }
  for (const production of ['copy-song', null, true, {}]) {
    assert.equal((await json(app.url, '/api/arrange', { notes: melody, settings: { ...defaults, production } })).status, 400);
    assert.equal((await json(app.url, '/api/projects', { ...project(), settings: { ...defaults, production } })).status, 400);
  }
});

test('rebound websites cannot read or overwrite projects, invoke the producer, or load the app', async (t) => {
  const directory = await temporaryDirectory();
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Private MUSE app</title>');
  let producerCalls = 0;
  let statusCalls = 0;
  const app = await startApp({ serveStatic: true, staticDir: directory, producerBrain: {
    status: () => { statusCalls++; return { mode: 'rules' }; },
    propose: async () => { producerCalls++; return { message: 'Review this proposal.', changes: {}, suggestions: [], source: 'rules' }; },
  } });
  t.after(async () => { await app.close(); await removeTemporaryDirectory(directory); });
  const saved = (await json(app.url, '/api/projects', project())).body.project;
  const headers = { Host: 'rebound.attacker.test:3001', Origin: 'http://rebound.attacker.test:3001', 'Content-Type': 'application/json' };
  for (const [route, body] of [
    ['/api/projects', undefined], ['/api/projects/test-melody', undefined],
    ['/api/projects', { ...project(), title: 'Overwritten by a website' }],
    ['/api/projects', { ...project(), id: 'injected-project' }],
    ['/api/producer', { text: 'Add percussion', settings: defaults }],
    ['/api/producer/status', undefined], ['/', undefined], ['/studio', undefined],
  ]) {
    const result = await requestWithHeaders(app.url, route, headers, body);
    assert.equal(result.status, 403, route);
    assert.doesNotMatch(result.text, /Evening idea|Private MUSE app|Review this proposal/);
  }
  assert.equal(producerCalls, 0);
  assert.equal(statusCalls, 0);
  assert.deepEqual((await json(app.url, '/api/projects')).body.projects, [saved]);
});

test('foreign or malformed Host authorities are rejected without URL normalization', async (t) => {
  const app = await startApp();
  t.after(app.close);
  for (const host of [
    'attacker.test', 'localhost.attacker.test', '127.0.0.1.attacker.test', '[::1].attacker.test',
    'localhost.', '127.1', '2130706433', '0x7f000001', '0177.0.0.1', '127.0.0.2',
    'local%68ost', '127%2e0%2e0%2e1', 'user@localhost', 'http://localhost',
    'localhost:0', 'localhost:65536', 'localhost:-1', 'localhost:1e3', 'localhost:',
    'localhost:3001/', 'localhost:3001?x', 'localhost:3001#x', '[::ffff:127.0.0.1]', '[::1]:65536',
  ]) assert.equal((await requestWithHeaders(app.url, '/api/health', { Host: host })).status, 403, host);
  for (const headers of [{}, ['Host', 'localhost', 'Host', 'attacker.test'], ['Host', 'localhost', 'Host', '127.0.0.1']]) {
    const result = await requestWithHeaders(app.url, '/api/health', headers);
    assert.ok([400, 403].includes(result.status), JSON.stringify(headers));
  }
});

test('foreign or malformed browser Origins cannot spend provider requests or save changes', async (t) => {
  let producerCalls = 0;
  const app = await startApp({ producerBrain: {
    status: () => ({ mode: 'rules' }),
    propose: async () => { producerCalls++; return { message: 'Review this proposal.', changes: {}, suggestions: [], source: 'rules' }; },
  } });
  t.after(app.close);
  const host = new URL(app.url).host;
  for (const origin of [
    'null', '', 'https://attacker.test', 'http://localhost.attacker.test', 'http://127.0.0.1.attacker.test',
    'http://localhost@attacker.test', 'http://attacker.test@localhost', 'http://local%68ost',
    'http://127.1', 'http://2130706433', 'http://0x7f000001', 'file://localhost',
    'http://localhost/', 'http://localhost/path', 'http://localhost?x', 'http://localhost#x',
    'http://localhost:0', 'http://localhost:65536', 'http://localhost:', 'http://[::1]:65536',
    'http://localhost\\@attacker.test', 'http://localhost%2f.attacker.test',
    ['http://localhost', 'https://attacker.test'], ['http://localhost', 'http://localhost'],
  ]) {
    const headers = { Host: host, Origin: origin, 'Content-Type': 'application/json' };
    const result = await requestWithHeaders(app.url, '/api/producer', headers, { text: 'Add percussion', settings: defaults });
    assert.equal(result.status, 403, JSON.stringify(origin));
    assert.equal((await requestWithHeaders(app.url, '/api/projects', headers, project())).status, 403, JSON.stringify(origin));
  }
  assert.equal(producerCalls, 0);
  assert.deepEqual((await json(app.url, '/api/projects')).body.projects, []);
});

test('local CLI, Vite and production requests accept exact loopback authorities and origins', async (t) => {
  const app = await startApp();
  t.after(app.close);
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'localhost:5173', '127.0.0.1:65535', '[::1]:3001', 'LOCALHOST:3001']) {
    for (const origin of [undefined, 'http://localhost:5173', app.url, 'https://127.0.0.1', 'http://[::1]:3001', 'https://localhost:65535']) {
      const headers = { Host: host, ...(origin === undefined ? {} : { Origin: origin }) };
      assert.equal((await requestWithHeaders(app.url, '/api/health', headers)).status, 200, `${host} ${origin}`);
    }
  }
  const headers = { Host: 'localhost:5173', Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
  assert.equal((await requestWithHeaders(app.url, '/api/projects', headers, project())).status, 200);
  const proposal = await requestWithHeaders(app.url, '/api/producer', headers, { text: 'Add percussion', settings: defaults });
  assert.equal(proposal.status, 200);
  assert.equal(JSON.parse(proposal.text).changes.percussion, true);
  assert.equal((await json(app.url, '/api/projects')).body.projects.length, 1);
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

test('HTTP arrangement rejects an explicit tempo-transform slowdown beyond the render limit', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const settings = { ...defaults, sourceBpm: 200, bpm: 40, preserveMelodyTiming: false };
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

test('HTTP arrangement preserves every note during an explicit fivefold tempo transformation', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const notes = [{ midi: 60, start: 0, duration: 1 }, { midi: 64, start: 29, duration: 1 }, { midi: 67, start: 59, duration: 1 }];
  const result = await json(app.url, '/api/arrange', { notes, settings: { ...defaults, sourceBpm: 200, bpm: 40, preserveMelodyTiming: false } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.arrangement.events.filter((event) => event.track === 'melody').map((event) => event.midi), [60, 64, 67]);
  assert.equal(result.body.arrangement.duration, 300);
});

test('HTTP locked lead keeps its full timing when only the backing tempo slows down', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const notes = [{ midi: 60, start: 0.3, duration: 299.7 }, { midi: 67, start: 400, duration: 1 }];
  const result = await json(app.url, '/api/arrange', { notes, settings: { ...defaults, sourceBpm: 200, bpm: 40 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.arrangement.bpm, 40);
  assert.equal(result.body.arrangement.duration, 401);
  assert.equal(result.body.arrangement.melodyProof.timingPreserved, true);
  assert.deepEqual(result.body.arrangement.events.filter(event => event.track === 'melody').map(({ midi, start, duration }) => ({ midi, start, duration })), notes);
});

test('HTTP producer returns honest supported proposals and validates direction input', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const result = await json(app.url, '/api/producer', { text: 'cinematic strings, no drums, tempo 110', settings: defaults });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.changes, { mood: 'Cinematic', instrument: 'Strings', percussion: false, bpm: 110 });
  assert.match(result.body.message, /propos|apply/i);
  assert.equal(result.body.source, 'rules');
  assert.equal((await json(app.url, '/api/producer', { text: 'x'.repeat(4001), settings: defaults })).status, 400);
  assert.equal((await json(app.url, '/api/producer', { text: { prompt: 'drums' }, settings: defaults })).status, 400);
});

test('producer status reports configuration without credentials and retains method validation', async (t) => {
  const app = await startApp({ producerBrain: {
    status: () => ({ mode: 'ai', provider: 'openai', model: 'test-model' }),
    propose: async () => { throw new Error('Status must not request a model response.'); },
  } });
  t.after(app.close);
  const status = await json(app.url, '/api/producer/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { mode: 'ai', provider: 'openai', model: 'test-model' });
  assert.equal((await json(app.url, '/api/health')).body.ok, true);
  assert.equal((await json(app.url, '/api/producer/status', {})).status, 405);
});

test('AI proposals receive validated musical context without mutating saved projects', async (t) => {
  let received;
  const proposal = { message: 'Try a softer string lead. Select Apply to hear it.', changes: { instrument: 'Strings', mood: 'Peaceful' }, suggestions: ['Try a slower tempo'], source: 'ai' };
  const app = await startApp({ producerBrain: {
    status: () => ({ mode: 'ai', provider: 'openai', model: 'test-model' }),
    propose: async input => { received = input; return proposal; },
  } });
  t.after(app.close);
  const saved = await json(app.url, '/api/projects', project());
  const result = await json(app.url, '/api/producer', {
    text: '  Gentle strings for this phrase  ', settings: { ...defaults, apiKey: 'not-a-setting' },
    notes: [{ midi: 64, name: 'arbitrary', start: 1, duration: 0.5, originalAudio: 'private' }],
    originalAudio: 'private audio', title: 'Private project title',
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, proposal);
  assert.deepEqual(received, { text: 'Gentle strings for this phrase', settings: defaults, notes: [{ midi: 64, name: 'E4', start: 1, duration: 0.5, confidence: 1 }] });
  assert.deepEqual((await json(app.url, '/api/projects/test-melody')).body.project, saved.body.project);
  assert.equal((await json(app.url, '/api/arrange', { notes: project().notes, settings: defaults })).status, 200);
});

test('invalid producer context never reaches the AI provider and notes remain optional', async (t) => {
  const inputs = [];
  const app = await startApp({ producerBrain: {
    status: () => ({ mode: 'ai', provider: 'openai', model: 'test-model' }),
    propose: async input => { inputs.push(input); return { message: 'Review the proposal.', changes: {}, suggestions: [], source: 'ai' }; },
  } });
  t.after(app.close);
  for (const notes of [null, {}, [{ midi: 128, start: 0, duration: 1 }], [{ midi: 60, start: 0, duration: 601 }], Array.from({ length: 513 }, () => project().notes[0])]) {
    assert.equal((await json(app.url, '/api/producer', { text: 'Gentler', settings: defaults, notes })).status, 400);
  }
  assert.equal((await json(app.url, '/api/producer', { text: 'Gentler', settings: { ...defaults, bpm: 500 } })).status, 400);
  assert.equal(inputs.length, 0);
  assert.equal((await json(app.url, '/api/producer', { text: 'Gentler', settings: defaults })).status, 200);
  assert.deepEqual(inputs[0].notes, []);
});

test('the real producer adapter serves AI and provider-failure fallback through HTTP', async (t) => {
  const { createProducerBrain } = await import('../server/producer-brain.js');
  for (const available of [true, false]) {
    let calls = 0;
    const producerBrain = createProducerBrain({ apiKey: 'synthetic-test-key', fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const request = JSON.parse(options.body);
      assert.equal(request.store, false);
      if (!available) return new Response(JSON.stringify({ error: { message: 'synthetic-test-key must never be shown' } }), { status: 429 });
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({
        message: 'A restrained string lead leaves space for your phrase. Select Apply to hear it.',
        changes: { bpm: null, instrument: 'Strings', mood: 'Peaceful', genre: null, production: null, accompaniment: null, bass: null, percussion: null },
        suggestions: ['Make the lead brighter'],
      }) }] }] }), { status: 200 });
    } });
    const app = await startApp({ producerBrain });
    t.after(app.close);
    const result = await json(app.url, '/api/producer', { text: 'cinematic strings', settings: defaults, notes: project().notes });
    assert.equal(result.status, 200);
    assert.equal(result.body.source, available ? 'ai' : 'rules');
    assert.equal(result.body.changes.instrument, 'Strings');
    if (!available) assert.match(result.body.notice, /rules/i);
    assert.doesNotMatch(JSON.stringify(result.body), /synthetic-test-key/);
    assert.equal(calls, 1);
    assert.equal((await json(app.url, '/api/health')).body.ok, true);
    assert.deepEqual((await json(app.url, '/api/projects')).body.projects, []);
  }
});

test('a context-aware rules fallback keeps a long tempo-transformed melody playable after Apply', async (t) => {
  const { createProducerBrain } = await import('../server/producer-brain.js');
  const app = await startApp({ producerBrain: createProducerBrain({ apiKey: '' }) });
  t.after(app.close);
  const notes = [{ midi: 60, start: 0, duration: 300 }];
  const settings = { ...defaults, preserveMelodyTiming: false };
  const result = await json(app.url, '/api/producer', { text: 'cinematic strings at 40 BPM', settings, notes });
  assert.equal(result.status, 200);
  assert.equal(result.body.source, 'rules');
  assert.equal(Object.hasOwn(result.body.changes, 'bpm'), false);
  assert.equal(result.body.changes.instrument, 'Strings');
  assert.match(result.body.message, /600/);
  const applied = { ...settings, ...result.body.changes };
  const arranged = await json(app.url, '/api/arrange', { notes, settings: applied });
  assert.equal(arranged.status, 200);
  assert.equal(arranged.body.arrangement.bpm, 90);
  assert.equal(arranged.body.arrangement.duration, 300);
});

test('malformed, oversized and unsupported HTTP requests return JSON errors', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const malformed = await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /json/i);
  const oversized = await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(512 * 1024) }) });
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
