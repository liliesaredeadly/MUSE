import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMelodyModel, MelodyModelError } from '../server/melody-model.js';

function pcmWav(samples = [0, 8192, -16384, 32767, -32768, 4000], sampleRate = 16000, channels = 1) {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(sample, 44 + index * 2));
  return wav;
}

const input = pcmWav();
const generated = pcmWav([0, 5000, 9000, -5000], 32000);
const response = (overrides = {}) => new Response(JSON.stringify({
  audioWavBase64: generated.toString('base64'), model: 'facebook/musicgen-melody', sampleRate: 32000, ...overrides,
}), { headers: { 'Content-Type': 'application/json' } });
const request = { audioWav: input, prompt: 'Soft strings accompaniment', duration: 8 };

test('unconfigured melody generation fails explicitly without invoking inference', async () => {
  let calls = 0;
  const model = createMelodyModel({ endpoint: '', fetchImpl: async () => { calls++; } });
  assert.deepEqual(model.status(), { mode: 'unavailable', configured: false, ready: false, provider: null, model: null, reason: 'not-configured' });
  await assert.rejects(model.generate(request), error => error instanceof MelodyModelError && error.status === 503 && error.code === 'MODEL_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('only literal loopback HTTP endpoints can receive private recorded audio', async () => {
  let calls = 0;
  for (const endpoint of ['https://example.com/generate', 'http://example.com/generate', 'http://localhost/generate', 'file:///private', 'http://127.0.0.1@example.com/generate', 'http://user:pass@127.0.0.1:3002/generate']) {
    const model = createMelodyModel({ endpoint, fetchImpl: async () => { calls++; } });
    assert.equal(model.status().configured, false);
    assert.equal(model.status().reason, 'invalid-endpoint');
    await assert.rejects(model.generate(request), { status: 503, code: 'MODEL_NOT_CONFIGURED' });
  }
  assert.equal(calls, 0);
});

test('actual WAV bytes reach melody inference unchanged and receive an input fingerprint', async () => {
  let outbound;
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002', fetchImpl: async (url, options) => {
    outbound = { url, options, payload: JSON.parse(options.body) };
    return response();
  } });
  assert.deepEqual(model.status(), { mode: 'audio-melody', configured: true, ready: false, provider: 'local-audiocraft', model: 'facebook/musicgen-melody' });
  const result = await model.generate({ ...request, audioWav: new Uint8Array(input) });
  assert.equal(outbound.url, 'http://127.0.0.1:3002/generate');
  assert.equal(outbound.options.method, 'POST');
  assert.equal(outbound.options.redirect, 'error');
  assert.ok(outbound.options.signal instanceof AbortSignal);
  assert.deepEqual(outbound.payload, { audioWavBase64: input.toString('base64'), prompt: 'Soft strings accompaniment', duration: 8 });
  assert.deepEqual(Buffer.from(outbound.payload.audioWavBase64, 'base64'), input);
  assert.deepEqual(result.audioWav, generated);
  assert.equal(result.sampleRate, 32000);
  assert.equal(result.model, 'facebook/musicgen-melody');
  assert.deepEqual(result.conditioning, { audioSha256: createHash('sha256').update(input).digest('hex'), inputBytes: input.length, mode: 'audio-melody' });
  assert.equal(model.status().ready, false, 'configuration and one successful generation are not a live health check');
});

test('a 40-second 96 kHz stereo recording accepted by upload reaches inference within its 16 MiB input limit', async () => {
  const sampleRate = 96000; const channels = 2;
  const large = Buffer.alloc(44 + 40 * sampleRate * channels * 2);
  input.copy(large, 0, 0, 44);
  large.writeUInt32LE(large.length - 8, 4); large.writeUInt16LE(channels, 22);
  large.writeUInt32LE(sampleRate, 24); large.writeUInt32LE(sampleRate * channels * 2, 28);
  large.writeUInt16LE(channels * 2, 32); large.writeUInt32LE(large.length - 44, 40);
  large.writeInt16LE(8192, 44); large.writeInt16LE(-8192, large.length - 2);
  assert.ok(large.length > 12 * 1024 * 1024 && large.length < 16 * 1024 * 1024);
  let calls = 0;
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async (url, options) => {
    calls++;
    assert.deepEqual(Buffer.from(JSON.parse(options.body).audioWavBase64, 'base64'), large);
    return response();
  } });
  const result = await model.generate({ ...request, audioWav: large });
  assert.equal(calls, 1); assert.equal(result.conditioning.inputBytes, large.length);
  assert.equal(result.conditioning.audioSha256, createHash('sha256').update(large).digest('hex'));
  await assert.rejects(model.generate({ ...request, audioWav: Buffer.alloc(16 * 1024 * 1024 + 1) }), { code: 'INVALID_MELODY_INPUT' });
  assert.equal(calls, 1, 'oversized audio never reaches inference');
});

test('missing, invalid, and excessive inputs fail before contacting melody inference', async () => {
  let calls = 0;
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async () => { calls++; return response(); } });
  for (const changes of [{ audioWav: undefined }, { audioWav: new Uint8Array() }, { audioWav: Buffer.from('not a wav') }, { prompt: '' }, { duration: 0 }, { duration: 31 }, { duration: NaN }]) {
    await assert.rejects(model.generate({ ...request, ...changes }), { status: 400, code: 'INVALID_MELODY_INPUT' });
  }
  const corrupt = Buffer.from(input); corrupt.writeUInt32LE(900000, 40);
  await assert.rejects(model.generate({ ...request, audioWav: corrupt }), { status: 400 });
  assert.equal(calls, 0);
});

test('text-only model output and corrupt WAV responses are rejected without fallback', async () => {
  for (const overrides of [
    { model: 'facebook/musicgen-small' }, { sampleRate: 44100 }, { audioWavBase64: '' },
    { audioWavBase64: Buffer.from('pretend audio').toString('base64') }, { audioWavBase64: '%%%=' },
  ]) {
    const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async () => response(overrides) });
    await assert.rejects(model.generate(request), { status: 502, code: 'INVALID_MODEL_OUTPUT' });
  }
});

test('model failures and deadlines surface explicit errors without synthesized substitute audio', async () => {
  const failed = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async () => new Response('provider private traceback', { status: 500 }) });
  await assert.rejects(failed.generate(request), error => error.status === 502 && error.code === 'MODEL_FAILED' && !error.message.includes('traceback'));
  let signal;
  const timed = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', timeoutMs: 15, fetchImpl: async (url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(timed.generate(request), { status: 504, code: 'MODEL_TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('a running melody generation rejects a second request instead of queueing expensive inference', async () => {
  let finish;
  let calls = 0;
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finish = resolve; });
    return response();
  } });
  const first = model.generate(request);
  try {
    await assert.rejects(model.generate(request), { status: 503, code: 'MODEL_BUSY' });
    assert.equal(calls, 1);
  } finally { finish(response()); await first; }
  await model.generate(request);
  assert.equal(calls, 2, 'a completed generation releases the inference slot');
});

test('rejected model responses release their unread response streams', async () => {
  for (const options of [{ status: 503 }, { headers: { 'Content-Length': String(20 * 1024 * 1024) } }]) {
    let cancelled = false;
    const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), options) });
    await assert.rejects(model.generate(request), { status: 502 });
    assert.equal(cancelled, true);
  }
});

test('closing the model promptly aborts pending inference and prevents future requests', async () => {
  let signal;
  const model = createMelodyModel({ endpoint: 'http://127.0.0.1:3002/generate', fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, timeoutMs: 100 });
  assert.equal(typeof model.close, 'function');
  const pending = model.generate(request);
  const stopped = assert.rejects(pending, { status: 503, code: 'MODEL_CLOSED' });
  model.close();
  assert.equal(signal.aborted, true);
  await stopped;
  await assert.rejects(model.generate(request), { status: 503, code: 'MODEL_CLOSED' });
});
