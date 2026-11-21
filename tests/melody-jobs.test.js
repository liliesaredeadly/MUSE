import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMelodyModel } from '../server/melody-model.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

const wav = Buffer.from(encodePcmWav(Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * 0.2), 16000));
const hash = createHash('sha256').update(wav).digest('hex');
const result = (changes = {}) => ({ audioWavBase64: wav.toString('base64'), model: 'facebook/musicgen-melody', sampleRate: 16000,
  conditioning: { audioSha256: hash, inputBytes: wav.length, mode: 'audio-melody' }, ...changes });
const health = { model: 'facebook/musicgen-melody', loaded: false, ready: false, status: 'idle', backend: 'audiocraft', device: 'cpu', capabilities: ['jobs', 'progress', 'cancel'] };

test('a live health probe reports reachability separately from weights readiness', async () => {
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async () => Response.json(health) });
  assert.equal(typeof model.probe, 'function');
  const status = await model.probe();
  assert.equal(status.configured, true); assert.equal(status.reachable, true); assert.equal(status.ready, false);
  assert.equal(status.device, 'cpu'); assert.deepEqual(status.capabilities, ['jobs', 'progress', 'cancel']);
});

test('a live Transformers service replaces the legacy configuration-only provider label', async () => {
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async () => Response.json({ ...health, backend: 'transformers' }) });
  assert.equal(model.status().provider, 'local-audiocraft');
  const status = await model.probe();
  assert.equal(status.backend, 'transformers'); assert.equal(status.provider, 'local-transformers');
  assert.equal(model.status().provider, 'local-transformers');
});

test('advertised jobs submit exact audio once and validate the provider input receipt', async () => {
  const calls = []; const progress = [];
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', pollIntervalMs: 1, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) return Response.json(health);
    if (url.endsWith('/jobs') && options.method === 'POST') {
      const sent = JSON.parse(options.body);
      assert.equal(sent.requestId, 'request-1'); assert.equal(sent.audioWavBase64, wav.toString('base64'));
      return Response.json({ id: 'request-1', status: 'running', stage: 'generating', progress: { completed: 1, total: 5 } }, { status: 202 });
    }
    return Response.json({ id: 'request-1', status: 'succeeded', stage: 'ready', result: result() });
  } });
  assert.equal(typeof model.probe, 'function');
  await model.probe();
  const audio = await model.generate({ audioWav: wav, prompt: 'quiet piano', duration: 0.1, requestId: 'request-1', requireReceipt: true, onProgress: value => progress.push(value) });
  assert.deepEqual(audio.audioWav, wav); assert.equal(audio.conditioning.audioSha256, hash);
  assert.equal(calls.filter(item => item.options.method === 'POST').length, 1);
  assert.ok(progress.some(item => item.stage === 'generating' && item.progress.completed === 1));
});

test('provider jobs with another conditioning fingerprint cannot succeed', async () => {
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async url => url.endsWith('/health') ? Response.json(health)
    : Response.json({ id: 'mismatch', status: 'succeeded', result: result({ conditioning: { audioSha256: '0'.repeat(64), inputBytes: wav.length, mode: 'audio-melody' } }) }) });
  assert.equal(typeof model.probe, 'function'); await model.probe();
  await assert.rejects(model.generate({ audioWav: wav, prompt: 'piano', duration: 0.1, requestId: 'mismatch', requireReceipt: true }), { code: 'INVALID_MODEL_OUTPUT' });
});

test('cancelling an active provider job sends DELETE and never returns late audio', async () => {
  const controller = new AbortController(); const calls = [];
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', pollIntervalMs: 1, fetchImpl: async (url, options = {}) => {
    calls.push([url, options.method || 'GET']);
    if (url.endsWith('/health')) return Response.json(health);
    if (options.method === 'DELETE') return Response.json({ id: 'cancel-me', status: 'cancelled' });
    if (options.method === 'POST') { queueMicrotask(() => controller.abort()); return Response.json({ id: 'cancel-me', status: 'running', stage: 'generating' }, { status: 202 }); }
    return new Promise(() => {});
  } });
  assert.equal(typeof model.probe, 'function'); await model.probe();
  await assert.rejects(model.generate({ audioWav: wav, prompt: 'piano', duration: 0.1, requestId: 'cancel-me', signal: controller.signal }), { code: 'MODEL_CANCELLED' });
  assert.ok(calls.some(([url, method]) => url.endsWith('/jobs/cancel-me') && method === 'DELETE'));
});

test('a lost provider acknowledgement retries with the same id and a bounded attempt count', async () => {
  const ids = [];
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async (url, options = {}) => {
    if (url.endsWith('/health')) return Response.json(health);
    ids.push(JSON.parse(options.body).requestId);
    if (ids.length === 1) throw new Error('Lost acknowledgement');
    return Response.json({ id: 'retry-once', status: 'succeeded', result: result() });
  } });
  await model.probe();
  await model.generate({ audioWav: wav, prompt: 'piano', duration: 0.1, requestId: 'retry-once' });
  assert.deepEqual(ids, ['retry-once', 'retry-once']);
});

test('legacy callers remain usable after a jobs-capable health probe', async () => {
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async (url, options = {}) => {
    if (url.endsWith('/health')) return Response.json(health);
    const request = JSON.parse(options.body);
    return Response.json({ id: request.requestId, status: 'succeeded', result: result() });
  } });
  await model.probe();
  const generated = await model.generate({ audioWav: wav, prompt: 'piano', duration: 0.1 });
  assert.deepEqual(generated.audioWav, wav);
});

test('cancellation keeps the inference slot until the provider confirms it stopped', async () => {
  const controller = new AbortController(); let stopped; let cancellationRead = false;
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', pollIntervalMs: 1, fetchImpl: async (url, options = {}) => {
    if (url.endsWith('/health')) return Response.json(health);
    if (options.method === 'POST') { queueMicrotask(() => controller.abort()); return Response.json({ id: 'wait-cancel', status: 'running', stage: 'generating' }); }
    if (options.method === 'DELETE') return Response.json({ id: 'wait-cancel', status: 'cancelling' });
    cancellationRead = true; return new Promise(resolve => { stopped = () => resolve(Response.json({ id: 'wait-cancel', status: 'cancelled' })); });
  } });
  await model.probe();
  const first = model.generate({ audioWav: wav, prompt: 'piano', duration: 0.1, requestId: 'wait-cancel', signal: controller.signal });
  const finished = assert.rejects(first, { code: 'MODEL_CANCELLED' });
  for (let i = 0; i < 100 && !cancellationRead; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(cancellationRead, true);
  await assert.rejects(model.generate({ audioWav: wav, prompt: 'piano', duration: 0.1, requestId: 'second' }), { code: 'MODEL_BUSY' });
  stopped(); await finished;
});
