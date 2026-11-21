import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createAudioPipeline } from '../server/audio-pipeline.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

const wav = Buffer.from(encodePcmWav(Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * 0.2), 16000));
const hash = createHash('sha256').update(wav).digest('hex');
const post = (base, body) => fetch(`${base}/api/generation/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function setup(t, generate) {
  const pipeline = createAudioPipeline({ analyzeImpl: async () => ({ duration: 0.1, notes: [], voicedRatio: 0, warnings: [] }) });
  const take = await pipeline.analyze(wav);
  const model = { status: () => ({ configured: true }), probe: async () => ({ configured: true, reachable: true, ready: false, device: 'cpu' }), generate };
  const server = createApp({ dbPath: ':memory:', audioPipeline: pipeline, melodyModel: model });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, input: { conditioningId: take.conditioningId, requestId: 'http-job', text: 'quiet piano', duration: 0.1 } };
}

test('job HTTP submission returns quickly, replays safely, and serves only verified output', async t => {
  const { base, input } = await setup(t, async value => {
    assert.deepEqual(value.audioWav, wav); assert.match(value.prompt, /piano/i);
    return { audioWav: wav, model: 'facebook/musicgen-melody', sampleRate: 16000, conditioning: { audioSha256: hash, inputBytes: wav.length, mode: 'audio-melody' } };
  });
  const response = await post(base, input); assert.equal(response.status, 202);
  const first = (await response.json()).job; assert.equal(first.requestId, input.requestId);
  assert.equal((await (await post(base, input)).json()).job.id, first.id);
  assert.equal((await post(base, { ...input, text: 'drums' })).status, 409);
  let done;
  for (let i = 0; i < 50; i++) {
    done = (await (await fetch(`${base}/api/generation/jobs/${first.id}`)).json()).job;
    if (done.status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(done.status, 'succeeded');
  const audio = await fetch(base + done.audioUrl);
  assert.equal(audio.headers.get('x-muse-conditioning-sha256'), hash);
  assert.equal(audio.headers.get('x-muse-output-sha256'), hash);
  assert.equal(audio.headers.get('x-muse-exact-melody-verified'), 'false');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav);
  const status = await (await fetch(`${base}/api/melody/model/status`)).json(); assert.equal(status.neural.device, 'cpu');
});

test('job errors identify expired source audio and loopback checks run before generation', async t => {
  let calls = 0;
  const { base, input } = await setup(t, async () => { calls++; throw new Error('Should not run'); });
  const missing = await post(base, { ...input, conditioningId: 'expired' });
  assert.equal(missing.status, 410); assert.equal((await missing.json()).code, 'CONDITIONING_EXPIRED');
  const rejected = await new Promise((resolve, reject) => {
    const req = httpRequest(base + '/api/generation/jobs', { method: 'POST', headers: { Host: 'attacker.invalid', Origin: 'http://attacker.invalid', 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify(input));
  });
  assert.equal(rejected, 403); assert.equal(calls, 0);
});

test('HTTP cancellation withholds audio and remains idempotent', async t => {
  const { base, input } = await setup(t, async ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const first = (await (await post(base, input)).json()).job;
  const path = `${base}/api/generation/jobs/${first.id}`;
  assert.equal((await fetch(path + '/audio')).status, 409);
  const cancelled = await (await fetch(path, { method: 'DELETE' })).json(); assert.ok(['cancelling', 'cancelled'].includes(cancelled.job.status));
  const again = await (await fetch(path, { method: 'DELETE' })).json(); assert.ok(['cancelling', 'cancelled'].includes(again.job.status));
});
