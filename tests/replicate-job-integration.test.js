import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createAudioPipeline } from '../server/audio-pipeline.js';
import { createReplicateMelodyModel } from '../server/replicate-melody-model.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

// All provider traffic is intercepted. These are generated test signals, not
// generated-music claims, and the marker below is not a real API credential.
const privateMarker = `r8_${'x'.repeat(37)}`;
const inputWav = Buffer.from(encodePcmWav(Float32Array.from({ length: 16000 }, (_, i) => 0.18 * Math.sin(i * Math.PI * 440 / 16000)), 16000));
const outputWav = Buffer.from(encodePcmWav(Float32Array.from({ length: 32000 }, (_, i) => 0.14 * Math.sin(i * Math.PI * 660 / 32000)), 32000));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const post = (base, body) => fetch(`${base}/api/generation/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function fixture(t, { failure = false, cancellable = false } = {}) {
  const calls = [];
  let submitBody;
  let cancelled = false;
  const model = createReplicateMelodyModel({ token: privateMarker, pollIntervalMs: 1, timeoutMs: 5000,
    fetchImpl: async (target, options = {}) => {
      const url = String(target);
      const method = options.method || 'GET';
      calls.push({ url, method });
      if (url.startsWith('https://api.replicate.com/')) {
        assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${privateMarker}`);
      }
      if (url === 'https://api.replicate.com/v1/account') return json({ username: 'test-account' });
      if (url === 'https://api.replicate.com/v1/predictions' && method === 'POST') {
        submitBody = JSON.parse(options.body);
        return json({ id: 'hostedtest123', status: 'starting' }, 201);
      }
      if (url === 'https://api.replicate.com/v1/predictions/hostedtest123/cancel' && method === 'POST') {
        cancelled = true;
        return json({ id: 'hostedtest123', status: 'canceled' });
      }
      if (url === 'https://api.replicate.com/v1/predictions/hostedtest123') {
        if (cancelled) return json({ id: 'hostedtest123', status: 'canceled' });
        if (failure) return json({ id: 'hostedtest123', status: 'failed', error: `Untrusted upstream diagnostic ${privateMarker}` });
        if (cancellable) return json({ id: 'hostedtest123', status: 'processing' });
        return json({ id: 'hostedtest123', status: 'succeeded', output: 'https://replicate.delivery/test-fixture/output.wav' });
      }
      if (url === 'https://replicate.delivery/test-fixture/output.wav') {
        assert.equal(new Headers(options.headers).has('authorization'), false, 'Credentials must not follow output downloads');
        return new Response(outputWav, { headers: { 'content-type': 'audio/wav' } });
      }
      assert.fail(`Unexpected fixture request: ${method} ${url}`);
    } });
  const pipeline = createAudioPipeline({ analyzeImpl: async () => ({ duration: 1, notes: [], voicedRatio: 0, warnings: [] }) });
  const take = await pipeline.analyze(inputWav);
  const server = createApp({ dbPath: ':memory:', audioPipeline: pipeline, melodyModel: model });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, pipeline, take, get body() { return submitBody; }, get cancelled() { return cancelled; },
    input: { conditioningId: take.conditioningId, requestId: 'hosted-node-integration', text: 'Warm acoustic guitar with soft piano, no percussion.', duration: 1 } };
}

async function waitFor(base, id, predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await fetch(`${base}/api/generation/jobs/${id}`);
    assert.equal(response.status, 200);
    const { job } = await response.json();
    if (predicate(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The fixture generation did not reach the expected status');
}

test('hosted adapter keeps one provider prediction across Node replay and returns the actual validated WAV', async t => {
  const state = await fixture(t);
  const accepted = await post(state.base, state.input);
  assert.equal(accepted.status, 202);
  const first = (await accepted.json()).job;
  const duplicate = (await (await post(state.base, state.input)).json()).job;
  assert.equal(duplicate.id, first.id);
  const done = await waitFor(state.base, first.id, job => ['succeeded', 'failed'].includes(job.status));
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.equal(done.model, 'facebook/musicgen-melody-large');
  assert.equal(state.calls.filter(call => call.url === 'https://api.replicate.com/v1/predictions' && call.method === 'POST').length, 1);
  const conditioning = state.body.input.input_audio;
  assert.ok(conditioning.startsWith('data:audio/wav;base64,'));
  assert.deepEqual(Buffer.from(conditioning.slice(conditioning.indexOf(',') + 1), 'base64'), inputWav);
  assert.match(state.body.input.prompt, /acoustic guitar/i);
  assert.match(state.body.input.prompt, /piano/i);
  assert.equal(state.body.input.continuation, false);
  assert.match(state.body.input.model_version, /melody/);
  assert.equal(state.body.input.output_format, 'wav');
  assert.equal(done.conditioning.audioSha256, sha(inputWav));
  const audio = await fetch(state.base + done.audioUrl);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('x-muse-conditioning-sha256'), sha(inputWav));
  assert.equal(audio.headers.get('x-muse-output-sha256'), sha(outputWav));
  assert.equal(audio.headers.get('x-muse-exact-melody-verified'), 'false');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), outputWav);
  const status = await (await fetch(`${state.base}/api/melody/model/status`)).json();
  assert.equal(status.neural.provider, 'replicate');
  assert.equal(status.neural.model, 'facebook/musicgen-melody-large');
  assert.equal(status.neural.ready, true);
  assert.doesNotMatch(JSON.stringify({ done, status }), new RegExp(privateMarker));
  assert.deepEqual(state.pipeline.snapshot(state.take.conditioningId).audioWav, inputWav);
});

test('a hosted failure withholds output, sanitizes provider diagnostics and retains the original take', async t => {
  const state = await fixture(t, { failure: true });
  const first = (await (await post(state.base, state.input)).json()).job;
  const failed = await waitFor(state.base, first.id, job => ['succeeded', 'failed'].includes(job.status));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.audioUrl, null);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(`${privateMarker}|Untrusted upstream diagnostic|replicate\\.delivery`));
  assert.equal((await fetch(`${state.base}/api/generation/jobs/${first.id}/audio`)).status, 409);
  const retained = state.pipeline.snapshot(state.take.conditioningId);
  assert.deepEqual(retained.audioWav, inputWav);
  assert.equal(retained.receipt.sha256, sha(inputWav));
  assert.equal(state.calls.filter(call => call.method === 'POST' && call.url.endsWith('/v1/predictions')).length, 1);
});

test('cancelling a hosted Node job cancels the provider prediction and never exposes an output', async t => {
  const state = await fixture(t, { cancellable: true });
  const first = (await (await post(state.base, state.input)).json()).job;
  await waitFor(state.base, first.id, job => job.stage === 'generating');
  const response = await fetch(`${state.base}/api/generation/jobs/${first.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  const done = await waitFor(state.base, first.id, job => ['cancelled', 'failed', 'succeeded'].includes(job.status));
  assert.equal(done.status, 'cancelled');
  assert.equal(done.audioUrl, null);
  assert.equal(state.cancelled, true);
  assert.equal(state.calls.some(call => call.url.startsWith('https://replicate.delivery/')), false);
  assert.deepEqual(state.pipeline.snapshot(state.take.conditioningId).audioWav, inputWav);
});
