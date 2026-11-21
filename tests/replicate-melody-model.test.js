import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReplicateMelodyModel } from '../server/replicate-melody-model.js';

const token = 'r8_test_secret_never_return';
const outputUrl = 'https://replicate.delivery/pbxt/test/output.wav';
function wav(seconds = 1, sampleRate = 16000) {
  const bytes = Buffer.alloc(44 + Math.round(seconds * sampleRate) * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(Math.round(10000 * Math.sin(i / 17)), i);
  return bytes;
}
const input = wav();
const output = wav(1, 32000);
const request = { audioWav: input, prompt: 'Soft piano surrounding the hummed melody', duration: 1, requestId: 'demo-request' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const success = { id: 'prediction1', status: 'succeeded', output: outputUrl };
const modelWith = (fetchImpl, changes = {}) => createReplicateMelodyModel({ token, fetchImpl, pollIntervalMs: 1, timeoutMs: 1000, ...changes });

test('missing or malformed tokens fail closed and are never exposed in public status', async () => {
  for (const value of ['', 'paste_your_actual_token_here', 'wrong-key\nheader']) {
    let calls = 0;
    const model = modelWith(async () => { calls++; }, { token: value });
    assert.equal(model.status().configured, false);
    assert.equal(JSON.stringify(model.status()).includes(value || 'never'), false);
    await assert.rejects(model.generate(request), { code: 'MODEL_NOT_CONFIGURED' });
    await model.probe(); assert.equal(calls, 0);
  }
});

test('safe non-billable account probe checks credentials without creating predictions', async () => {
  const calls = [];
  const model = modelWith(async (url, options) => { calls.push({ url, options }); return json({ username: 'private-account' }); });
  const status = await model.probe();
  assert.equal(status.configured, true); assert.equal(status.ready, true); assert.equal(status.provider, 'replicate');
  assert.deepEqual(calls.map(c => [c.url, c.options.method]), [['https://api.replicate.com/v1/account', 'GET']]);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.ok(!JSON.stringify(status).includes(token)); assert.ok(!JSON.stringify(status).includes('private-account'));
});

test('actual hum bytes and direction condition a fixed hosted melody model and WAV is validated', async () => {
  const calls = []; const stages = []; let polls = 0;
  const model = modelWith(async (url, options) => {
    calls.push({ url, options });
    if (url === outputUrl) return new Response(output);
    if (options.method === 'POST') return json({ id: 'prediction1', status: 'starting' }, 201);
    return json(++polls === 1 ? { id: 'prediction1', status: 'processing' } : success);
  });
  const result = await model.generate({ ...request, onProgress: value => stages.push(value) });
  const submitted = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/predictions');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.match(calls[0].options.headers['Cancel-After'], /^\d+s$/);
  assert.equal(submitted.version, '671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb');
  assert.equal(submitted.input.model_version, 'melody-large');
  assert.equal(submitted.input.prompt, request.prompt);
  assert.equal(submitted.input.continuation, false); assert.equal(submitted.input.output_format, 'wav');
  assert.equal(submitted.input.duration, 1);
  assert.deepEqual(Buffer.from(submitted.input.input_audio.split(',')[1], 'base64'), input);
  assert.deepEqual(result.audioWav, output); assert.equal(result.sampleRate, 32000);
  assert.equal(result.conditioning.audioSha256, createHash('sha256').update(input).digest('hex'));
  assert.equal(result.conditioning.inputBytes, input.length);
  assert.equal(result.conditioning.mode, 'audio-melody');
  assert.equal(result.conditioning.verification, 'adapter-submitted');
  assert.equal(result.audioSha256, createHash('sha256').update(output).digest('hex'));
  assert.equal(result.checkpoint, 'facebook/musicgen-melody-large');
  assert.equal(result.model, 'facebook/musicgen-melody-large');
  assert.ok(stages.some(s => s.stage === 'generating' && s.progress === null));
  const download = calls.find(c => c.url === outputUrl);
  assert.equal(download.options.headers?.Authorization, undefined);
  assert.equal(download.options.redirect, 'error');
  assert.ok(!JSON.stringify(result).includes(token));
});

test('replaying an adapter request id cannot submit a second billable prediction', async () => {
  let posts = 0;
  const model = modelWith(async (url, options) => {
    if (url === outputUrl) return new Response(output);
    if (options.method === 'POST') { posts++; return json(success, 201); }
    return json(success);
  });
  await model.generate(request); await model.generate(request);
  assert.equal(posts, 1);
  await assert.rejects(model.generate({ ...request, prompt: 'Different prompt' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(posts, 1);
});

test('invalid WAV, silence, excessive or fractional duration never creates a paid request', async () => {
  let calls = 0; const model = modelWith(async () => { calls++; });
  const silent = Buffer.from(input); silent.fill(0, 44);
  for (const changes of [{ audioWav: Buffer.from('fake') }, { audioWav: silent }, { audioWav: Buffer.alloc(16 * 1024 * 1024 + 1) }, { duration: 0 }, { duration: 31 }, { duration: 1.5 }, { prompt: '' }]) {
    await assert.rejects(model.generate({ ...request, ...changes }), { code: 'INVALID_MELODY_INPUT' });
  }
  assert.equal(calls, 0);
});

test('ambiguous prediction creation failures are not retried or resubmitted under the same id', async () => {
  let posts = 0;
  const model = modelWith(async () => { posts++; throw new Error(`private failure ${token}`); });
  for (let i = 0; i < 2; i++) await assert.rejects(model.generate(request), e => e.code === 'MODEL_SUBMISSION_UNCERTAIN' && !e.message.includes(token));
  assert.equal(posts, 1);
});

test('temporary prediction GET errors retry finitely without repeating prediction creation', async () => {
  let posts = 0; let polls = 0;
  const model = modelWith(async (url, options) => {
    if (url === outputUrl) return new Response(output);
    if (options.method === 'POST') { posts++; return json({ id: 'prediction1', status: 'starting' }, 201); }
    if (++polls === 1) return json({ detail: token }, 503);
    return json(success);
  });
  await model.generate(request); assert.equal(posts, 1); assert.equal(polls, 2);
});

test('provider auth and billing failures remain clear without leaking response bodies', async () => {
  for (const [status, code] of [[401, 'MODEL_AUTH_FAILED'], [402, 'MODEL_BILLING_REQUIRED'], [422, 'INVALID_MELODY_INPUT'], [429, 'MODEL_RATE_LIMITED']]) {
    let calls = 0;
    const model = modelWith(async () => { calls++; return json({ detail: `private ${token}` }, status); });
    await assert.rejects(model.generate(request), e => e.code === code && !e.message.includes(token));
    assert.equal(calls, 1);
  }
});

test('failed or cancelled provider jobs produce no substitute audio and keep raw logs private', async () => {
  for (const [status, code] of [['failed', 'MODEL_FAILED'], ['canceled', 'MODEL_CANCELLED']]) {
    const model = modelWith(async () => json({ id: 'prediction1', status, error: `logs ${token}` }, 201));
    await assert.rejects(model.generate(request), e => e.code === code && !e.message.includes(token));
  }
});

test('untrusted output destinations are rejected before any download', async () => {
  for (const url of ['http://replicate.delivery/output.wav', 'https://replicate.delivery.evil.test/output.wav', 'https://user:pass@replicate.delivery/output.wav', 'http://127.0.0.1/audio', 'https://evil.test/audio', 'https://replicate.delivery:444/output.wav']) {
    let calls = 0; const model = modelWith(async () => { calls++; return json({ ...success, output: url }, 201); });
    await assert.rejects(model.generate(request), { code: 'INVALID_MODEL_OUTPUT' }); assert.equal(calls, 1);
  }
});

test('truncated, wrong-duration, silent, or oversized generated audio is rejected', async () => {
  const silent = Buffer.from(output); silent.fill(0, 44);
  for (const body of [Buffer.from('badwav'), wav(2, 32000), silent]) {
    const model = modelWith(async url => url === outputUrl ? new Response(body) : json(success, 201));
    await assert.rejects(model.generate(request), { code: 'INVALID_MODEL_OUTPUT' });
  }
  let cancelled = false;
  const model = modelWith(async url => url === outputUrl ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': String(13 * 1024 * 1024) } }) : json(success, 201));
  await assert.rejects(model.generate(request), { code: 'INVALID_MODEL_OUTPUT' }); assert.equal(cancelled, true);
});

test('invalid provider prediction ids never become API paths or downloads', async () => {
  let calls = 0; const model = modelWith(async () => { calls++; return json({ id: '../../private', status: 'starting' }, 201); });
  await assert.rejects(model.generate(request), { code: 'INVALID_MODEL_OUTPUT' }); assert.equal(calls, 1);
});

test('caller cancellation sends a single provider cancellation and aborts output waiting', async () => {
  const controller = new AbortController(); const calls = [];
  let acknowledgeCancel;
  const cancellation = new Promise(resolve => { acknowledgeCancel = resolve; });
  const model = modelWith(async (url, options) => {
    calls.push([url, options.method]);
    if (url.endsWith('/cancel')) { acknowledgeCancel(); return json({ id: 'prediction1', status: 'canceled' }); }
    if (options.method === 'POST') { queueMicrotask(() => controller.abort()); return json({ id: 'prediction1', status: 'processing' }, 201); }
    return json({ id: 'prediction1', status: 'processing' });
  });
  await assert.rejects(model.generate({ ...request, signal: controller.signal }), { code: 'MODEL_CANCELLED' });
  await cancellation;
  assert.equal(calls.filter(([url]) => url.endsWith('/cancel')).length, 1);
});

test('overall deadline bounds a fetch that never resolves and prevents unbounded duplicate submissions', async () => {
  let signal; let calls = 0;
  const model = modelWith(async (url, options) => { signal = options.signal; calls++; return new Promise(() => {}); }, { timeoutMs: 15 });
  await assert.rejects(model.generate(request), { code: 'MODEL_TIMEOUT' });
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
});

test('only one billable inference runs at once and closed adapters reject future work', async () => {
  let settle;
  const model = modelWith(async url => url === outputUrl ? new Response(output) : new Promise(resolve => { settle = resolve; }));
  const first = model.generate(request);
  await assert.rejects(model.generate({ ...request, requestId: 'another' }), { code: 'MODEL_BUSY' });
  settle(json(success, 201)); await first;
  model.close(); await assert.rejects(model.generate(request), { code: 'MODEL_CLOSED' });
});

test('prediction responses can echo a complete recording data URI above 128 KiB', async () => {
  const longer = wav(5, 16000); let polls = 0;
  const echo = { input_audio: `data:audio/wav;base64,${longer.toString('base64')}` };
  assert.ok(JSON.stringify(echo).length > 128 * 1024);
  const model = modelWith(async (url, options) => {
    if (url === outputUrl) return new Response(output);
    if (options.method === 'POST') return json({ id: 'prediction1', status: 'starting', input: echo }, 201);
    polls++; return json({ ...success, input: echo });
  });
  const result = await model.generate({ ...request, audioWav: longer });
  assert.equal(result.conditioning.inputBytes, longer.length); assert.equal(polls, 1);
});

test('auth probe distinguishes rejected credentials from an unreachable API', async () => {
  const rejected = modelWith(async () => json({ detail: `private ${token}` }, 401));
  const auth = await rejected.probe();
  assert.equal(auth.ready, false); assert.equal(auth.reachable, true);
  assert.equal(auth.reason, 'invalid-token'); assert.equal(auth.errorCode, 'MODEL_AUTH_FAILED');
  const unreachable = modelWith(async () => { throw new Error(token); });
  const network = await unreachable.probe();
  assert.equal(network.reachable, false); assert.equal(network.errorCode, 'MODEL_UNAVAILABLE');
  assert.ok(!JSON.stringify([auth, network]).includes(token));
});

test('a server error during paid submission remains uncertain and never automatically retries', async () => {
  let calls = 0;
  const model = modelWith(async () => { calls++; return json({ private: token }, 503); });
  await assert.rejects(model.generate(request), { code: 'MODEL_SUBMISSION_UNCERTAIN' });
  assert.equal(calls, 1);
  await assert.rejects(model.generate(request), { code: 'MODEL_SUBMISSION_UNCERTAIN' });
  assert.equal(calls, 1);
});
