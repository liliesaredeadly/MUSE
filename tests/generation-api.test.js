import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/lib/api.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

test('generation jobs preserve idempotency, read status and cancel with DELETE', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    return Response.json({ job: { id: 'job-a', status: options.method === 'DELETE' ? 'cancelled' : 'queued' } });
  });
  const source = { conditioningId: 'take-a', receipt: { sha256: 'hash-a' } };
  assert.equal((await api.createGenerationJob({ text: 'Warm piano', duration: 8, requestId: 'request-a' }, source)).id, 'job-a');
  await api.generationJob('job-a');
  assert.equal((await api.cancelGenerationJob('job-a')).status, 'cancelled');
  assert.deepEqual(calls, [
    { url: '/api/generation/jobs', method: 'POST', body: { conditioningId: 'take-a', text: 'Warm piano', duration: 8, requestId: 'request-a' } },
    { url: '/api/generation/jobs/job-a', method: 'GET', body: undefined },
    { url: '/api/generation/jobs/job-a', method: 'DELETE', body: undefined },
  ]);
});

test('generation preserves server error codes and retry advice', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Model is occupied', code: 'MODEL_BUSY', retryable: true }, { status: 503 }));
  await assert.rejects(api.generationJob('job-a'), error => error.status === 503 && error.code === 'MODEL_BUSY' && error.retryable === true);
});

test('generation audio accepts real PCM WAV and rejects unreadable or empty output', async t => {
  const wav = encodePcmWav(new Float32Array(800).fill(.1), 8000);
  t.mock.method(globalThis, 'fetch', async () => new Response(wav, { headers: { 'Content-Type': 'audio/wav' } }));
  const result = await api.generationAudio('job-a');
  assert.equal(result.duration, .1);
  assert.equal(result.blob.size, wav.length);
  t.mock.method(globalThis, 'fetch', async () => new Response('not music'));
  await assert.rejects(api.generationAudio('job-a'), /WAV|audio/i);
});

test('caller cancellation stays cancellation instead of reporting a server outage', async t => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => { signal.throwIfAborted(); });
  await assert.rejects(api.generationJob('job-a', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('a stalled completed-audio body has a normalized 60-second deadline and only one safe GET retry', async t => {
  const deadlines = []; const milliseconds = []; const calls = [];
  t.mock.method(AbortSignal, 'timeout', duration => { const deadline = new AbortController(); deadlines.push(deadline); milliseconds.push(duration); return deadline.signal; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options.method]);
    const deadline = deadlines.at(-1);
    return { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
      read() { deadline.abort(new DOMException('Body deadline', 'TimeoutError')); return new Promise(() => {}); },
      cancel: async () => {}, releaseLock() {},
    }) } };
  });
  await assert.rejects(api.generationAudio('job-a'), error => error.code === 'AUDIO_DOWNLOAD_TIMEOUT' && /finished preview download timed out/i.test(error.message));
  assert.deepEqual(milliseconds, [60000, 60000]);
  assert.deepEqual(calls, [['/api/generation/jobs/job-a/audio', 'GET'], ['/api/generation/jobs/job-a/audio', 'GET']]);
});

test('a temporary binary body interruption retries the same completed audio without regeneration', async t => {
  const wav = encodePcmWav(new Float32Array(800).fill(.1), 8000);
  for (const interruption of [new TypeError('Connection interrupted'), new DOMException('Stream interrupted', 'AbortError')]) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push([url, options.method]);
      return calls.length === 1 ? new Response(new ReadableStream({ start(controller) { controller.error(interruption); } })) : new Response(wav);
    });
    const result = await api.generationAudio('job-a');
    assert.equal(result.blob.size, wav.length);
    assert.deepEqual(calls, [['/api/generation/jobs/job-a/audio', 'GET'], ['/api/generation/jobs/job-a/audio', 'GET']]);
  }
});

test('invalid completed WAV does not trigger another download attempt', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('invalid audio'); });
  await assert.rejects(api.generationAudio('job-a'), error => error.code === 'INVALID_AUDIO_WAV' && error.retryable === false);
  assert.equal(calls, 1);
});

test('oversized declared or streamed audio is rejected at the 12 MiB bound without retry', { timeout: 2000 }, async t => {
  const limit = 12 * 1024 * 1024;
  for (const declared of [false, true]) {
    let calls = 0; let cancelled = false;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        if (!declared) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); }
      }, cancel() { cancelled = true; } }), { headers: declared ? { 'Content-Length': String(limit + 1) } : {} });
    });
    await assert.rejects(api.generationAudio('job-a'), error => error.code === 'AUDIO_TOO_LARGE' && error.retryable === false);
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
});

test('caller cancellation during completed-audio reading is never retried', { timeout: 2000 }, async t => {
  const caller = new AbortController(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(new ReadableStream({ start() { queueMicrotask(() => caller.abort()); } }));
  });
  await assert.rejects(api.generationAudio('job-a', { signal: caller.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});

for (const changedSource of [false, true]) {
  test(`expired generation source renews the retained take without substitution (${changedSource ? 'mismatch rejected' : 'matching source'})`, async t => {
    const notes = [{ midi: 60, start: 0, duration: .5 }];
    const source = { conditioningId: 'expired', blob: new Blob(['original audio']), duration: .5,
      receipt: { sha256: 'original-hash' }, notes: structuredClone(notes) };
    t.mock.method(api, 'analyzeRecording', async blob => {
      assert.equal(blob, source.blob);
      return { conditioningId: 'renewed', receipt: { sha256: changedSource ? 'other-hash' : 'original-hash' }, analysis: { notes } };
    });
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body);
      if (body.conditioningId === 'expired') return Response.json({ error: 'Expired', code: 'CONDITIONING_EXPIRED' }, { status: 410 });
      return Response.json({ job: { id: 'job-a', status: 'queued' } });
    });
    const payload = { text: 'Piano', requestId: 'stable-request', duration: 5 };
    if (changedSource) {
      await assert.rejects(api.createGenerationJob(payload, source), /match|original/i);
      assert.equal(bodies.length, 1);
    } else {
      await api.createGenerationJob(payload, source);
      assert.deepEqual(bodies.map(body => [body.requestId, body.conditioningId]), [['stable-request', 'expired'], ['stable-request', 'renewed']]);
    }
  });
}
