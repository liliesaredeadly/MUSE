import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAudioPipeline } from '../server/audio-pipeline.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

const notes = [
  { midi: 60, start: 0.1, duration: 0.2, confidence: 0.95, contour: [{ time: 0, frequency: 261.626 }, { time: 0.2, frequency: 262 }] },
  { midi: 64, start: 0.4, duration: 0.3, confidence: 0.96, contour: [{ time: 0, frequency: 329.628 }] },
];
const analysis = () => ({ notes: structuredClone(notes), contour: [], rhythm: { onsets: [0.1, 0.4], rests: [{ start: 0.3, duration: 0.1 }], intervals: [0.3], estimatedBpm: null }, duration: 1, voicedRatio: 0.5, method: 'test-extractor', warnings: [] });

test('the actual WAV reaches extraction and receipt hashes the received file', async t => {
  const samples = Float32Array.from({ length: 16000 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / 16000));
  const wav = encodePcmWav(samples, 16000);
  let received;
  const pipeline = createAudioPipeline({ analyzeImpl: async (pcm, rate) => { received = { pcm, rate }; return analysis(); } });
  t.after(() => pipeline.close());
  const result = await pipeline.analyze(wav);
  assert.equal(received.rate, 16000);
  assert.equal(received.pcm.length, samples.length);
  assert.ok(Math.abs(received.pcm[18] - samples[18]) < 1 / 16384);
  assert.equal(result.receipt.sha256, createHash('sha256').update(wav).digest('hex'));
  assert.equal(result.receipt.bytes, wav.length);
  assert.equal(result.receipt.duration, 1);
  assert.ok(result.conditioningId);
  assert.deepEqual(pipeline.condition(result.conditioningId, notes).receipt, result.receipt);
  assert.throws(() => pipeline.condition(result.conditioningId, [{ ...notes[0], midi: 61 }, notes[1]]), /melody|notes|condition/i);
});

test('valid audio stays available even without extracted notes and never invents a melody', async t => {
  const pipeline = createAudioPipeline({ analyzeImpl: async samples => ({ ...analysis(), duration: samples.length / 16000, notes: [], voicedRatio: 0 }) });
  t.after(() => pipeline.close());
  await assert.rejects(pipeline.analyze(new Uint8Array()), /WAV|audio/i);
  const result = await pipeline.analyze(encodePcmWav(new Float32Array(1600), 16000));
  assert.equal(typeof result.conditioningId, 'string');
  assert.deepEqual(result.analysis.notes, []);
  assert.equal(result.analysis.quality.canHarmonize, false);
  const bound = pipeline.condition(result.conditioningId, []);
  assert.equal(bound.receipt.duration, 0.1);
  assert.equal(bound.quality.canHarmonize, false);
});

test('retained conditioning audio is bounded and caller mutation cannot change its melody', async t => {
  const wav = encodePcmWav(new Float32Array(16000), 16000);
  const pipeline = createAudioPipeline({ analyzeImpl: async () => analysis(), maxTakes: 1 });
  t.after(() => pipeline.close());
  const first = await pipeline.analyze(wav);
  first.analysis.notes[0].midi = 1;
  assert.doesNotThrow(() => pipeline.condition(first.conditioningId, notes));
  await pipeline.analyze(wav);
  assert.throws(() => pipeline.condition(first.conditioningId, notes), /expired|available|record/i);
});

test('conditioning expiry disposes the take while idle and a clock correction cannot revive it', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const pipeline = createAudioPipeline({ analyzeImpl: async () => analysis(), ttlMs: 100 });
  t.after(() => pipeline.close());
  const take = await pipeline.analyze(encodePcmWav(new Float32Array(16000), 16000));
  t.mock.timers.tick(100);
  t.mock.timers.setTime(1000);
  assert.throws(() => pipeline.condition(take.conditioningId, notes), { status: 410 });
});

test('extraction cannot bind notes extending beyond the received recording clock', async t => {
  const pipeline = createAudioPipeline({ analyzeImpl: async () => ({ ...analysis(), notes: [{ midi: 60, start: 0.9, duration: 0.2 }] }) });
  t.after(() => pipeline.close());
  await assert.rejects(pipeline.analyze(encodePcmWav(new Float32Array(16000), 16000)), /clock|recording|extracted/i);
});

test('generation snapshots retain the original audio and analysis independently of cache eviction and callers', async t => {
  const wav = encodePcmWav(new Float32Array(16000), 16000);
  const pipeline = createAudioPipeline({ analyzeImpl: async () => analysis(), maxTakes: 1 });
  t.after(() => pipeline.close());
  const take = await pipeline.analyze(wav);
  assert.equal(typeof pipeline.snapshot, 'function');
  const snapshot = pipeline.snapshot(take.conditioningId);
  assert.deepEqual(snapshot.audioWav, Buffer.from(wav));
  snapshot.analysis.notes[0].midi = 1; snapshot.audioWav.fill(0);
  assert.equal(pipeline.snapshot(take.conditioningId).analysis.notes[0].midi, 60);
  assert.deepEqual(pipeline.snapshot(take.conditioningId).audioWav, Buffer.from(wav));
  const retained = pipeline.snapshot(take.conditioningId);
  await pipeline.analyze(wav);
  assert.deepEqual(retained.audioWav, Buffer.from(wav));
});
