import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingFinalizer, recordingToWav } from '../src/audio/recording-file.js';
import { decodePcmWav } from '../src/audio/pcm-wav.js';

test('automatic and manual completion of one take share exactly one analysis promise', async () => {
  let calls = 0; let complete;
  const finish = createRecordingFinalizer(async result => { calls++; await new Promise(resolve => { complete = resolve; }); return result.duration; });
  const take = { duration: 1 };
  const auto = finish(take); const manual = finish(take);
  assert.equal(auto, manual);
  await Promise.resolve(); assert.equal(calls, 1);
  complete(); assert.equal(await auto, 1); assert.equal(await finish(take), 1);
});

test('encoder padding is trimmed to the actual capture boundary, not rejected as a lost take', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioContext');
  const samples = new Float32Array(Math.round(60.04 * 16000)).fill(0.1);
  globalThis.OfflineAudioContext = class { async decodeAudioData() { return { sampleRate: 16000, duration: 60.04, length: samples.length, numberOfChannels: 1, getChannelData: () => samples }; } };
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'OfflineAudioContext', descriptor) : delete globalThis.OfflineAudioContext);
  const wav = await recordingToWav(new Blob(['encoded fixture']), { durationLimit: 60 });
  const decoded = decodePcmWav(new Uint8Array(await wav.arrayBuffer()));
  assert.equal(decoded.duration, 60);
  assert.equal(decoded.samples.length, 960000);
});

test('channel selection uses captured audio rather than louder encoder padding', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioContext');
  const voice = new Float32Array(16000 + 640).fill(0.01, 0, 16000);
  const padding = new Float32Array(voice.length).fill(0.5, 16000);
  globalThis.OfflineAudioContext = class { async decodeAudioData() { return {
    sampleRate: 16000, length: voice.length, numberOfChannels: 2,
    getChannelData: channel => channel === 0 ? voice : padding,
  }; } };
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'OfflineAudioContext', descriptor) : delete globalThis.OfflineAudioContext);
  const wav = await recordingToWav(new Blob(['encoded stereo fixture']), { durationLimit: 1 });
  const decoded = decodePcmWav(new Uint8Array(await wav.arrayBuffer()));
  assert.equal(decoded.samples.length, 16000);
  assert.ok(decoded.samples.every(sample => sample > 0.009), 'The complete captured channel must survive conversion.');
});
