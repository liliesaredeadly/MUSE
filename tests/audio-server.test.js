import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createMelodyModel } from '../server/melody-model.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';
import { FIXTURES } from './fixtures/hum-fixtures.js';

async function app(t, options = {}) {
  const server = createApp({ dbPath: ':memory:', melodyModel: createMelodyModel({ endpoint: '' }), ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, path, value) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('recorded-hum arrangements bind the original waveform and retain its full duration without a synthetic lead', async t => {
  const base = await app(t);
  const fixture = FIXTURES.irregular();
  const bytes = encodePcmWav(fixture.samples, fixture.sampleRate);
  const take = await (await fetch(base + '/api/melody/analyze', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: bytes })).json();
  const settings = { leadSource: 'recording', bpm: 160, sourceBpm: 90, production: 'dance-pop', accompaniment: true, percussion: true, preserveMelodyTiming: false };
  const response = await post(base, '/api/arrange', { notes: take.analysis.notes, settings, conditioningId: take.conditioningId });
  assert.equal(response.status, 200);
  const { arrangement } = await response.json();
  assert.equal(arrangement.duration, take.receipt.duration);
  assert.equal(arrangement.recordingLead.sha256, take.receipt.sha256);
  assert.equal(arrangement.melodyProof.engine, 'original-waveform');
  assert.equal(arrangement.settings.preserveMelodyTiming, true);
  assert.equal(arrangement.events.some(event => event.track === 'melody'), false);
  assert.equal(arrangement.conditioning.quality.canHarmonize, take.analysis.quality.canHarmonize);
  assert.equal((await post(base, '/api/arrange', { notes: take.analysis.notes, settings })).status, 400);
  assert.equal((await post(base, '/api/arrange', { notes: [], settings, conditioningId: take.conditioningId })).status, 409);
});

test('an untranscribed real WAV can remain the lead while unreliable harmony and bass stay absent', async t => {
  const base = await app(t);
  const wav = encodePcmWav(new Float32Array(16000), 16000);
  const take = await (await fetch(base + '/api/melody/analyze', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })).json();
  assert.equal(typeof take.conditioningId, 'string');
  assert.deepEqual(take.analysis.notes, []);
  assert.equal(take.analysis.quality.canHarmonize, false);
  const settings = { leadSource: 'recording', production: 'percussive-pop', accompaniment: true, bass: true, percussion: true };
  const response = await post(base, '/api/arrange', { notes: [], settings, conditioningId: take.conditioningId });
  assert.equal(response.status, 200);
  const { arrangement } = await response.json();
  assert.equal(arrangement.duration, 1);
  assert.equal(arrangement.recordingLead.sha256, take.receipt.sha256);
  assert.deepEqual(arrangement.chords, []);
  assert.ok(arrangement.events.every(event => event.track === 'percussion'));
  const saved = await post(base, '/api/projects', { id: 'recorded-empty-notes', title: 'Original audio required', notes: [], settings });
  assert.equal(saved.status, 200);
  const reopened = await (await fetch(base + '/api/projects/recorded-empty-notes')).json();
  assert.equal(reopened.project.settings.leadSource, 'recording');
  assert.equal((await post(base, '/api/arrange', reopened.project)).status, 400, 'Reopen cannot silently replace unavailable original audio.');
});

test('real audio upload reaches the worker, stays bound to its notes and survives save/reopen', async t => {
  const base = await app(t);
  const original = FIXTURES.irregular();
  const wav = encodePcmWav(original.samples, original.sampleRate);
  const upload = await fetch(base + '/api/melody/analyze', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  assert.equal(upload.status, 200);
  const take = await upload.json();
  assert.equal(take.receipt.sha256, createHash('sha256').update(wav).digest('hex'));
  assert.equal(take.receipt.bytes, wav.length);
  assert.deepEqual(take.analysis.notes.map(note => note.midi), [57, 60, 64, 62, 55]);
  assert.ok(take.analysis.notes.every(note => note.contour.length > 0));
  const arranged = await post(base, '/api/arrange', { notes: take.analysis.notes, settings: { bpm: 160, sourceBpm: 90, instrument: 'Strings', accompaniment: true, percussion: true }, conditioningId: take.conditioningId });
  assert.equal(arranged.status, 200);
  const { arrangement } = await arranged.json();
  assert.equal(arrangement.melodyProof.timingPreserved, true);
  assert.equal(arrangement.conditioning.receipt.sha256, take.receipt.sha256);
  assert.deepEqual(arrangement.events.filter(event => event.track === 'melody').map(({ midi, start, duration, contour }) => ({ midi, start, duration, contour })),
    take.analysis.notes.map(({ midi, start, duration, contour }) => ({ midi, start, duration, contour })));
  const substituted = structuredClone(take.analysis.notes); substituted[0].midi++;
  assert.equal((await post(base, '/api/arrange', { notes: substituted, conditioningId: take.conditioningId })).status, 409);
  const saved = await post(base, '/api/projects', { id: 'audio-roundtrip', title: 'Generated QA only', notes: take.analysis.notes, settings: arrangement.settings });
  assert.equal(saved.status, 200);
  const reopened = await (await fetch(base + '/api/projects/audio-roundtrip')).json();
  assert.deepEqual(reopened.project.notes.map(note => note.contour), take.analysis.notes.map(note => note.contour));
  assert.equal(reopened.project.settings.preserveMelodyTiming, true);
});

test('audio boundaries reject invalid files and missing neural models without substitute output', async t => {
  const base = await app(t);
  assert.equal((await post(base, '/api/melody/analyze', { text: 'hum' })).status, 415);
  assert.equal((await fetch(base + '/api/melody/analyze', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: 'not a recording' })).status, 400);
  const original = FIXTURES.repeated();
  const take = await (await fetch(base + '/api/melody/analyze', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodePcmWav(original.samples, original.sampleRate) })).json();
  const generated = await post(base, '/api/melody/generate', { conditioningId: take.conditioningId, prompt: 'Piano accompaniment', duration: 2 });
  assert.equal(generated.status, 503);
  assert.match(generated.headers.get('content-type'), /application\/json/);
  assert.match((await generated.json()).error, /not configured/i);
  assert.equal((await post(base, '/api/arrange', { notes: [{ midi: 60, start: 0, duration: 1, contour: [{ time: 2, frequency: 220 }] }] })).status, 400);
});

test('the optional audio-melody provider receives the exact recorded WAV and is labelled unverified', async t => {
  let received;
  const model = { status: () => ({ configured: true, model: 'test-double' }), async generate(value) {
    received = Buffer.from(value.audioWav);
    return { audioWav: received, model: 'test-double', conditioning: { audioSha256: createHash('sha256').update(received).digest('hex') } };
  } };
  const base = await app(t, { melodyModel: model });
  const original = FIXTURES.fast(); const wav = encodePcmWav(original.samples, original.sampleRate);
  const take = await (await fetch(base + '/api/melody/analyze', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })).json();
  const result = await post(base, '/api/melody/generate', { conditioningId: take.conditioningId, prompt: 'Test boundary only', duration: 2 });
  assert.equal(result.status, 200);
  assert.deepEqual(received, Buffer.from(wav));
  assert.equal(result.headers.get('x-muse-conditioning-sha256'), take.receipt.sha256);
  assert.equal(result.headers.get('x-muse-exact-melody-verified'), 'false');
});

test('a valid dense melody contour fits the bounded save/arrange transport', async t => {
  const base = await app(t);
  const duration = 0.0812345678912345;
  const notes = Array.from({ length: 400 }, (_, index) => ({ midi: 60, start: index * 0.123456789123456, duration, confidence: 0.9876543210987654,
    contour: Array.from({ length: 10 }, (_, point) => ({ time: point === 9 ? duration : point * duration / 9, frequency: 261.6261234567891 + Math.sin(index + point) * 0.01 })) }));
  const project = { id: 'dense-contour', title: 'Generated transport fixture', notes, settings: { preserveMelodyTiming: true } };
  assert.ok(Buffer.byteLength(JSON.stringify(project)) > 256 * 1024);
  const response = await post(base, '/api/projects', project);
  assert.equal(response.status, 200);
  const saved = (await response.json()).project;
  assert.equal(saved.notes.reduce((count, note) => count + note.contour.length, 0), 4000);
  assert.deepEqual(saved.notes[399].contour, notes[399].contour);
});
