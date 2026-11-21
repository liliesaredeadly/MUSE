import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGenerationJobs } from '../server/generation-jobs.js';
import { createAudioPipeline } from '../server/audio-pipeline.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

const wav = Buffer.from(encodePcmWav(Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * 0.2), 16000));
const hash = createHash('sha256').update(wav).digest('hex');
const analysis = { notes: [], duration: 0.1, voicedRatio: 0, warnings: [] };
const compile = () => ({ prompt: 'Soft piano and quiet strings.', analysis: {}, techniques: [], sources: [], warnings: [] });
const output = () => ({ audioWav: Buffer.from(wav), model: 'facebook/musicgen-melody', sampleRate: 16000,
  conditioning: { audioSha256: hash, inputBytes: wav.length, mode: 'audio-melody' } });

async function setup(t, generate, options = {}) {
  const audioPipeline = createAudioPipeline({ analyzeImpl: async () => analysis });
  const take = await audioPipeline.analyze(wav);
  const model = { status: () => ({ configured: true }), generate };
  const jobs = createGenerationJobs({ audioPipeline, melodyModel: model, compile, ...options });
  t.after(() => { jobs.close(); audioPipeline.close(); });
  return { jobs, take, input: { conditioningId: take.conditioningId, text: 'quiet piano', duration: 0.1, requestId: 'request-1', settings: {} } };
}
async function terminal(jobs, id) {
  for (let i = 0; i < 100; i++) {
    const job = jobs.get(id);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Job did not finish');
}

test('jobs bind real audio, deduplicate requests, and expose validated downloadable output', async t => {
  let calls = 0;
  const { jobs, take, input } = await setup(t, async value => {
    calls++; assert.deepEqual(value.audioWav, wav); assert.equal(value.prompt, compile().prompt);
    value.onProgress({ stage: 'generating', progress: { completed: 1, total: 2 } });
    return output();
  });
  const first = jobs.start(input); const duplicate = jobs.start(input);
  assert.equal(first.id, duplicate.id); assert.equal(first.conditioning.audioSha256, take.receipt.sha256);
  assert.throws(() => jobs.start({ ...input, text: 'different direction' }), { status: 409 });
  const done = await terminal(jobs, first.id);
  assert.equal(calls, 1); assert.equal(done.status, 'succeeded'); assert.equal(done.stage, 'ready');
  assert.equal(done.audioUrl, `/api/generation/jobs/${first.id}/audio`);
  const audio = jobs.audio(first.id); assert.deepEqual(audio.audioWav, wav); assert.equal(audio.audioSha256, hash);
  done.production.prompt = 'mutated'; assert.equal(jobs.get(first.id).production.prompt, compile().prompt);
});

test('a cancelled queued job never reaches expensive inference and queue size is bounded', async t => {
  let finish; let calls = 0;
  const { jobs, input } = await setup(t, async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, { maxQueued: 1 });
  const first = jobs.start(input);
  await new Promise(resolve => setImmediate(resolve));
  const second = jobs.start({ ...input, requestId: 'request-2' });
  assert.throws(() => jobs.start({ ...input, requestId: 'request-3' }), { status: 429 });
  assert.equal(jobs.cancel(second.id).status, 'cancelled');
  finish(output()); await terminal(jobs, first.id);
  assert.equal(calls, 1); assert.equal(jobs.get(second.id).audioUrl, null);
});

test('active cancellation aborts inference and cannot publish a late successful result', async t => {
  let finish; let aborted = false;
  const { jobs, input } = await setup(t, async ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve(output()); }, { once: true }); finish = resolve;
  }));
  const first = jobs.start(input); await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.cancel(first.id).status, 'cancelling');
  const done = await terminal(jobs, first.id); assert.equal(aborted, true); assert.equal(done.status, 'cancelled');
  assert.throws(() => jobs.audio(first.id), { status: 409 }); finish(output());
});

test('timeouts, invalid conditioning, and expiry never leave downloadable fake audio', async t => {
  const { jobs, input } = await setup(t, async ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), { timeoutMs: 10, ttlMs: 15 });
  const first = jobs.start(input); const done = await terminal(jobs, first.id);
  assert.equal(done.status, 'failed'); assert.equal(done.error.code, 'MODEL_TIMEOUT'); assert.equal(done.audioUrl, null);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.throws(() => jobs.get(first.id), { status: 404 });
  assert.throws(() => jobs.start({ ...input, conditioningId: 'missing', requestId: 'missing-take' }), { status: 410 });
});

test('a mismatched model receipt and a wrong duration fail before publishing audio', async t => {
  for (const mutate of [value => { value.conditioning.audioSha256 = '0'.repeat(64); }, value => { value.audioWav = Buffer.from(encodePcmWav(new Float32Array(16000), 16000)); }]) {
    const { jobs, input } = await setup(t, async () => { const value = output(); mutate(value); return value; });
    const done = await terminal(jobs, jobs.start(input).id);
    assert.equal(done.status, 'failed'); assert.equal(done.error.code, 'INVALID_MODEL_OUTPUT');
  }
});
