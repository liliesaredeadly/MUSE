import test from 'node:test';
import assert from 'node:assert/strict';
import { CompositionPlayer, encodeWav, exportWav, exportMidi } from '../src/audio/synth.js';

test('WAV encoder interleaves stereo signed PCM with a valid header and clamps peaks', async () => {
  const channels = [new Float32Array([0, 1, -1, 2]), new Float32Array([0.5, -0.5, 0.25, -2])];
  const blob = encodeWav({ numberOfChannels: 2, sampleRate: 48000, length: 4, getChannelData: channel => channels[channel] });
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(new TextDecoder().decode(buffer.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(buffer.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(40, true), 16);
  assert.deepEqual(Array.from({ length: 8 }, (_, index) => view.getInt16(44 + index * 2, true)), [0, 16383, 32767, -16384, -32768, 8191, 32767, -32768]);
});

test('MIDI export contains the captured pitches and a tempo event in a standard file', async () => {
  const blob = exportMidi({ bpm: 120, duration: 1, events: [
    { midi: 60, start: 0, duration: 0.5, velocity: 0.8, instrument: 'Piano', track: 'melody' },
    { midi: 67, start: 0.5, duration: 0.5, velocity: 0.8, instrument: 'Piano', track: 'melody' },
  ] });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'MThd');
  assert.equal(new TextDecoder().decode(bytes.slice(14, 18)), 'MTrk');
  assert.ok(bytes.some((value, index) => value === 0x90 && bytes[index + 1] === 60));
  assert.ok(bytes.some((value, index) => value === 0x90 && bytes[index + 1] === 67));
  assert.ok(bytes.some((value, index) => value === 0xff && bytes[index + 1] === 0x51));
});

test('play rejects empty music without changing transport or firing completion', async () => {
  let ended = 0;
  const player = new CompositionPlayer();
  await assert.rejects(player.play({ events: [], duration: 0 }, { onEnded: () => ended++ }), /notes|empty/i);
  assert.equal(player.status, 'stopped');
  assert.equal(ended, 0);
  player.dispose();
});

test('browser-only playback and rendering fail clearly when Web Audio is unavailable', async () => {
  const arrangement = { bpm: 90, duration: 1, events: [{ midi: 60, start: 0, duration: 1, velocity: 0.7, instrument: 'Piano', track: 'melody' }] };
  const player = new CompositionPlayer();
  await assert.rejects(player.play(arrangement), /Web Audio|browser/i);
  await assert.rejects(exportWav(arrangement), /Web Audio|browser/i);
  assert.equal(player.status, 'stopped');
  player.dispose();
});

// Node has no Web Audio device: this double covers the browser scheduling boundary.
class FakeAudioContext {
  static resumeGate = null;
  static latest = null;
  constructor() { this.currentTime = 0; this.state = 'suspended'; this.destination = {}; this.sources = []; FakeAudioContext.latest = this; }
  resume() { this.state = 'running'; return FakeAudioContext.resumeGate || Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  parameter() { return { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
  node() { return { connect() {}, disconnect() {} }; }
  createGain() { return { ...this.node(), gain: this.parameter() }; }
  createDelay() { return { ...this.node(), delayTime: this.parameter() }; }
  createBiquadFilter() { return { ...this.node(), frequency: this.parameter(), Q: this.parameter() }; }
  createDynamicsCompressor() { return { ...this.node(), threshold: this.parameter(), knee: this.parameter(), ratio: this.parameter() }; }
  createOscillator() {
    const source = { ...this.node(), frequency: this.parameter(), detune: this.parameter(), starts: [], stops: [], start(time) { this.starts.push(time); }, stop(time) { this.stops.push(time); } };
    this.sources.push(source);
    return source;
  }
}
const phrase = { bpm: 90, duration: 4, events: [{ midi: 60, start: 0, duration: 4, velocity: 0.7, instrument: 'Piano', track: 'melody' }] };

test('pause freezes musical progress, cancels old voices and resume excludes paused wall time', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  let ended = 0;
  const progress = [];
  try {
    await player.play(phrase, { onEnded: () => ended++, onProgress: value => progress.push(value) });
    const context = FakeAudioContext.latest;
    context.currentTime = 1.035;
    player.pause();
    assert.equal(player.status, 'paused');
    assert.ok(Math.abs(progress.at(-1) - 1) < 0.00001);
    assert.ok(context.sources.every(source => source.stops.at(-1) === 1.035));
    const previousSourceCount = context.sources.length;
    context.currentTime = 100;
    await player.resume();
    assert.equal(player.status, 'playing');
    assert.ok(Math.abs(progress.at(-1) - 1) < 0.00001);
    assert.equal(context.sources.length, previousSourceCount * 2);
    player.stop();
    assert.equal(player.status, 'stopped');
    assert.equal(ended, 0);
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('pause while audio is unlocking prevents late playback and can be resumed', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  let unlock;
  FakeAudioContext.resumeGate = new Promise(resolve => { unlock = resolve; });
  const player = new CompositionPlayer();
  try {
    const pending = player.play(phrase);
    player.pause();
    unlock();
    await pending;
    assert.equal(player.status, 'paused');
    assert.equal(FakeAudioContext.latest.sources.length, 0);
    FakeAudioContext.resumeGate = null;
    await player.resume();
    assert.equal(player.status, 'playing');
  } finally { player.dispose(); FakeAudioContext.resumeGate = null; globalThis.AudioContext = original; }
});

test('a stopped pending play cannot start voices after audio unlock', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  let unlock;
  FakeAudioContext.resumeGate = new Promise(resolve => { unlock = resolve; });
  const player = new CompositionPlayer();
  try {
    const pending = player.play(phrase);
    player.stop();
    unlock();
    await pending;
    assert.equal(player.status, 'stopped');
    assert.equal(FakeAudioContext.latest.sources.length, 0);
  } finally { player.dispose(); FakeAudioContext.resumeGate = null; globalThis.AudioContext = original; }
});

test('stopping from a progress callback suppresses the natural completion callback', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  let ended = 0;
  try {
    await player.play(phrase, { onProgress: value => { if (value > 0) player.stop(); }, onEnded: () => ended++ });
    FakeAudioContext.latest.currentTime = 10;
    await new Promise(resolve => setTimeout(resolve, 85));
    assert.equal(player.status, 'stopped');
    assert.equal(ended, 0);
  } finally { player.dispose(); globalThis.AudioContext = original; }
});
