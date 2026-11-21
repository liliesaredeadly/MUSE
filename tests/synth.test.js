import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CompositionPlayer, encodeWav, exportWav, exportMidi } from '../src/audio/synth.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

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
  constructor() { this.currentTime = 0; this.state = 'suspended'; this.sampleRate = 44100; this.destination = {}; this.sources = []; this.nodes = []; FakeAudioContext.latest = this; }
  resume() { this.state = 'running'; return FakeAudioContext.resumeGate || Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  parameter() { return { value: 0, calls: [], setValueAtTime(value, time) { this.calls.push(['set', value, time]); }, linearRampToValueAtTime(value, time) { this.calls.push(['linear', value, time]); }, exponentialRampToValueAtTime(value, time) { this.calls.push(['exponential', value, time]); } }; }
  node() { return { connections: [], connect(target) { this.connections.push(target); }, disconnect() {} }; }
  record(type, node) { node.kind = type; this.nodes.push(node); return node; }
  createGain() { return this.record('gain', { ...this.node(), gain: this.parameter() }); }
  createDelay() { return this.record('delay', { ...this.node(), delayTime: this.parameter() }); }
  createBiquadFilter() { return this.record('filter', { ...this.node(), frequency: this.parameter(), Q: this.parameter() }); }
  createDynamicsCompressor() { return this.record('compressor', { ...this.node(), threshold: this.parameter(), knee: this.parameter(), ratio: this.parameter(), attack: this.parameter(), release: this.parameter() }); }
  createStereoPanner() { return this.record('panner', { ...this.node(), pan: this.parameter() }); }
  createBuffer(channels, length, sampleRate = 44100) { const samples = Array.from({ length: channels }, () => new Float32Array(length)); return { numberOfChannels: channels, length, sampleRate, getChannelData: channel => samples[channel] }; }
  createBufferSource() {
    const source = { ...this.node(), playbackRate: this.parameter(), starts: [], startArguments: [], stops: [], start(time, offset, duration) { this.starts.push(time); this.startArguments.push([time, offset, duration]); }, stop(time) { this.stops.push(time); } };
    this.sources.push(source); return source;
  }
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

test('short repeated melody notes schedule their contour and stop at the original gates', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  try {
    await player.play({ bpm: 180, duration: 0.62, settings: { mood: 'Dreamy' }, events: [
      { midi: 69, start: 0.3, duration: 0.08, instrument: 'Strings', track: 'melody', contour: [{ time: 0, frequency: 435 }, { time: 0.04, frequency: 445 }] },
      { midi: 69, start: 0.5, duration: 0.12, instrument: 'Strings', track: 'melody', contour: [{ time: 0, frequency: 444 }, { time: 0.1, frequency: 438 }] },
    ] });
    const context = FakeAudioContext.latest;
    const first = context.sources[0];
    assert.ok(Math.abs(first.starts[0] - 0.335) < 1e-9);
    assert.deepEqual(first.frequency.calls.slice(0, 2).map(([kind, value]) => [kind, value]), [['set', 435], ['linear', 445]]);
    assert.ok(Math.abs(first.frequency.calls[0][2] - 0.335) < 1e-9);
    assert.ok(Math.abs(first.frequency.calls[1][2] - 0.375) < 1e-9);
    assert.ok(context.sources.slice(0, 3).every(source => source.stops[0] <= 0.416));
    assert.ok(context.sources.slice(3).every(source => Math.abs(source.starts[0] - 0.535) < 1e-9 && source.stops[0] <= 0.656));
    const filter = first.connections[0].connections[0];
    const envelope = filter.connections[0];
    const attackEnd = envelope.gain.calls.find(call => call[0] === 'linear');
    assert.ok(attackEnd[2] - 0.335 <= 0.008, 'slow Strings attack hides short source notes');
    assert.ok(envelope.gain.calls.some(([, value, time]) => value === 0 && Math.abs(time - 0.415) < 1e-9), 'melody must be silent at the original gate end');
    const bus = envelope.connections[0];
    assert.ok(bus.connections.every(node => node.kind !== 'delay'), 'melody echo fills the original rests');
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('each piano harmonic follows the continuous source contour in its frequency ratio', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  try {
    await player.play({ duration: 0.2, events: [{ midi: 69, start: 0, duration: 0.2, instrument: 'Piano', track: 'melody', contour: [{ time: 0, frequency: 430 }, { time: 0.15, frequency: 450 }] }] });
    const sources = FakeAudioContext.latest.sources;
    assert.equal(sources[0].frequency.calls[0][1], 430);
    assert.ok(Math.abs(sources[1].frequency.calls[0][1] - 860.86) < 1e-9);
    assert.ok(Math.abs(sources[1].frequency.calls[1][1] - 900.9) < 1e-9);
    assert.ok(Math.abs(sources[2].frequency.calls[1][1] - 1802.7) < 1e-9);
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('resume interpolates the source contour at the paused offset without replaying its onset pitch', async () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  try {
    await player.play({ duration: 1, events: [{ midi: 69, start: 0, duration: 1, instrument: 'Piano', track: 'melody', contour: [{ time: 0, frequency: 400 }, { time: 1, frequency: 500 }] }] });
    const context = FakeAudioContext.latest;
    context.currentTime = 0.535;
    player.pause();
    const previousCount = context.sources.length;
    context.currentTime = 10;
    await player.resume();
    const resumed = context.sources[previousCount];
    assert.ok(Math.abs(resumed.frequency.calls[0][1] - 450) < 1e-9);
    assert.deepEqual(resumed.frequency.calls[1], ['linear', 500, 10.535]);
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('rendering refuses partial malformed arrangements instead of dropping a melody event', async () => {
  const input = { ...phrase, events: [...phrase.events, { midi: NaN, start: 0.1, duration: 0.1, track: 'melody' }] };
  assert.throws(() => exportMidi(input), /invalid|melody|note/i);
  const player = new CompositionPlayer();
  await assert.rejects(player.play(input), /invalid|melody|note/i);
  player.dispose();
});

test('MIDI backing cannot release the same-pitch captured melody on its channel', async () => {
  const bytes = new Uint8Array(await exportMidi({ bpm: 120, duration: 2, events: [
    { midi: 60, start: 0, duration: 2, instrument: 'Piano', track: 'melody' },
    { midi: 60, start: 0, duration: 0.5, instrument: 'Piano', track: 'chords' },
  ] }).arrayBuffer());
  const onChannels = [];
  for (let index = 22; index < bytes.length - 2; index++) {
    if ((bytes[index] & 0xf0) === 0x90 && bytes[index + 1] === 60) onChannels.push(bytes[index] & 0x0f);
  }
  assert.equal(onChannels.length, 2);
  assert.notEqual(onChannels[0], onChannels[1]);
  assert.ok(bytes.some((value, index) => value === 0xc0 + onChannels[1] && bytes[index + 1] === 0), 'backing channel needs the same Piano program');
});

test('production plucks have a struck sine tone and bounded stereo position while the lead ignores backing metadata', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  try {
    await player.play({ duration: 0.5, production: { style: 'percussive-pop' }, events: [
      { midi: 60, start: 0, duration: 0.5, instrument: 'Synthesizer', track: 'melody', timbre: 'pluck', pan: 0.9 },
      { midi: 72, start: 0, duration: 0.3, instrument: 'Synthesizer', track: 'chords', timbre: 'pluck', pan: 9 },
    ] });
    const context = FakeAudioContext.latest;
    assert.equal(context.sources[0].type, 'sawtooth', 'Backing timbre metadata must not replace the lead voice.');
    assert.equal(context.sources[2].type, 'sine', 'The pluck should have a distinct struck tone.');
    assert.deepEqual(context.nodes.filter(node => node.kind === 'panner').map(node => node.pan.value), [0.65]);
    const filter = context.sources[2].connections[0].connections[0];
    assert.ok(filter.frequency.calls.some(call => call[0] === 'exponential'), 'A pluck needs a decaying brightness envelope.');
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('production low end and drums stay dry while kick ducking affects only harmonic backing', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  try {
    await player.play({ duration: 1, production: { style: 'dance-pop' }, events: [
      { midi: 60, start: 0, duration: 1, instrument: 'Piano', track: 'melody' },
      { midi: 36, start: 0, duration: 0.18, instrument: 'Drums', track: 'percussion' },
      { midi: 36, start: 0.5, duration: 0.18, instrument: 'Drums', track: 'percussion' },
      { midi: 36, start: 0, duration: 0.4, instrument: 'Bass', track: 'bass', pan: 0.6 },
      { midi: 64, start: 0, duration: 1, instrument: 'Strings', track: 'chords', pan: -0.2 },
    ] });
    const context = FakeAudioContext.latest;
    const ducks = context.nodes.filter(node => node.kind === 'gain' && node.gain.calls.some(([, value]) => value === 0.48));
    assert.equal(ducks.length, 1, 'A single backing duck bus should follow the kick rhythm.');
    assert.ok(ducks[0].gain.calls.every(([, , time], index, calls) => index === 0 || time >= calls[index - 1][2]));
    const envelope = context.sources[0].connections[0].connections[0].connections[0];
    assert.ok(envelope.connections[0].connections.every(node => node !== ducks[0] && node.kind !== 'delay'), 'The captured lead must bypass ducking and delay.');
    assert.deepEqual(context.nodes.filter(node => node.kind === 'panner').map(node => node.pan.value), [-0.2], 'Bass and kick must stay centered.');
    const delayed = context.nodes.find(node => node.kind === 'gain' && node.connections.some(target => target.kind === 'delay'));
    const noise = context.sources.filter(source => source.buffer);
    assert.equal(noise.length, 0);
    const bass = context.sources.find(source => source.type === 'triangle');
    const bassBus = bass.connections[0].connections[0].connections[0].connections[0];
    assert.notEqual(bassBus, delayed, 'Bass cannot feed the shared harmonic delay.');
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('snare, clap and hi-hats have distinct tone filters and decay envelopes', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  try {
    await player.play({ duration: 0.5, production: { style: 'percussive-pop' }, events: [38, 39, 42, 46].map(midi =>
      ({ midi, start: 0, duration: midi === 46 ? 0.3 : 0.12, instrument: 'Drums', track: 'percussion' })) });
    const context = FakeAudioContext.latest;
    const noiseFilters = context.sources.filter(source => source.buffer).map(source => source.connections[0]);
    assert.equal(noiseFilters.length, 4);
    assert.deepEqual(noiseFilters.map(filter => filter.type), ['bandpass', 'bandpass', 'highpass', 'highpass']);
    assert.notEqual(noiseFilters[0].frequency.value, noiseFilters[1].frequency.value);
    assert.ok(context.sources.some(source => source.type === 'triangle'), 'Snare should retain a tonal body beneath noise.');
    const clapEnvelope = noiseFilters[1].connections[0];
    assert.ok(clapEnvelope.gain.calls.filter(call => call[0] === 'linear').length >= 3, 'Clap needs its distinct short flam envelope.');
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('production backing resumes within the existing kick envelope without ducking or replaying the lead', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  try {
    await player.play({ duration: 1, production: { style: 'dance-pop' }, events: [
      { midi: 60, start: 0, duration: 1, instrument: 'Piano', track: 'melody' },
      { midi: 36, start: 0.5, duration: 0.18, instrument: 'Drums', track: 'percussion' },
    ] });
    const context = FakeAudioContext.latest;
    context.currentTime = 0.605; player.pause(); // Musical offset 0.57: halfway through recovery.
    context.currentTime = 10; await player.resume();
    const ducks = context.nodes.filter(node => node.kind === 'gain' && node.gain.calls.length &&
      node.gain.calls[0][0] === 'set' && node.gain.calls[0][1] > 0.48 && node.gain.calls[0][1] < 1);
    assert.equal(ducks.length, 1);
    assert.ok(Math.abs(ducks[0].gain.calls[0][1] - (0.48 + 0.52 * 0.067 / 0.137)) < 1e-9);
    assert.deepEqual(ducks[0].gain.calls.at(-1).slice(0, 2), ['linear', 1]);
    assert.ok(Math.abs(ducks[0].gain.calls.at(-1)[2] - 10.105) < 1e-9);
    assert.ok(context.sources.slice(0, 3).every(source => source.starts.length === 1), 'The stopped lead sources cannot be restarted.');
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

function recordedPhrase(changes = {}) {
  const samples = Float32Array.from({ length: 8000 }, (_, index) => 0.2 * Math.sin(2 * Math.PI * 220 * index / 16000));
  const bytes = encodePcmWav(samples, 16000);
  return { arrangement: { bpm: 90, duration: 0.5, events: [], settings: { leadSource: 'recording', production: 'dance-pop' },
    recordingLead: { audioWav: new Blob([bytes], { type: 'audio/wav' }), sha256: createHash('sha256').update(bytes).digest('hex'), duration: 0.5 }, ...changes }, samples };
}

test('a protected recording-only arrangement plays the actual complete PCM without synthetic melody voices', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer(); const { arrangement, samples } = recordedPhrase();
  try {
    await player.play(arrangement);
    const context = FakeAudioContext.latest;
    assert.equal(context.sources.length, 1);
    const source = context.sources[0];
    assert.ok(source.buffer);
    assert.equal(source.buffer.sampleRate, 16000);
    assert.equal(source.buffer.length, samples.length);
    assert.equal(source.playbackRate.value, 1, 'Original pitch and source clock must not be stretched.');
    assert.deepEqual(source.startArguments, [[0.035, 0, 0.5]]);
    assert.equal(source.stops[0], 0.535);
    const decoded = source.buffer.getChannelData(0);
    assert.ok(decoded.every((value, index) => Math.abs(value - samples[index]) < 1 / 16384), 'The source buffer must contain the actual received waveform.');
    const envelope = source.connections[0];
    const levels = envelope.gain.calls.map(([, value]) => value);
    const gain = Math.max(...levels);
    assert.ok(gain > 0 && gain <= 8 && 0.2 * gain <= 0.65);
    assert.ok(envelope.gain.calls.some(([kind, value, time]) => kind === 'set' && value === gain && time >= 0.035 + 0.497 - 1e-9));
    assert.ok(envelope.connections[0].connections.every(node => node.kind !== 'delay'), 'The recording must use the dry lead path.');
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('recording mode ignores synthetic lead events and keeps generated backing separate', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer();
  const { arrangement } = recordedPhrase({ events: [
    { midi: 40, start: 0, duration: 0.5, instrument: 'Piano', track: 'melody' },
    { midi: 64, start: 0.2, duration: 0.1, instrument: 'Piano', track: 'chords' },
  ] });
  try {
    await player.play(arrangement);
    const sources = FakeAudioContext.latest.sources;
    assert.equal(sources.filter(source => source.buffer).length, 1);
    assert.equal(sources.filter(source => source.frequency).length, 3, 'Only the backing Piano should create oscillators.');
    assert.ok(sources.filter(source => source.frequency).every(source => source.frequency.calls[0][1] > 300));
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('recording metadata without verified WAV bytes fails instead of falling back to instruments', async () => {
  const { arrangement } = recordedPhrase(); delete arrangement.recordingLead.audioWav;
  const player = new CompositionPlayer();
  try {
    await assert.rejects(player.play(arrangement), /original|recording|WAV/i);
    await assert.rejects(exportWav(arrangement), /original|recording|WAV/i);
  } finally { player.dispose(); }
});

test('changed recording bytes, incompatible clocks and oversized sources are rejected before playback', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  try {
    for (const change of [
      { sha256: '0'.repeat(64) }, { duration: 0.6 }, { duration: 61 },
      { audioWav: new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]) },
    ]) {
      const { arrangement } = recordedPhrase(); Object.assign(arrangement.recordingLead, change);
      const player = new CompositionPlayer();
      try { await assert.rejects(player.play(arrangement), /recording|WAV|audio|clock|source|fingerprint/i); }
      finally { player.dispose(); }
    }
  } finally { globalThis.AudioContext = original; }
});

test('stopping while the original WAV is being read prevents late playback', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer(); const { arrangement } = recordedPhrase();
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; }); const reading = new Promise(resolve => { started = resolve; });
  const blob = arrangement.recordingLead.audioWav;
  arrangement.recordingLead.audioWav = new class extends Blob { async arrayBuffer() { started(); await gate; return blob.arrayBuffer(); } }([blob]);
  try {
    const pending = player.play(arrangement);
    await Promise.race([reading, pending]); player.stop(); release(); await pending;
    assert.equal(player.status, 'stopped');
    assert.equal(FakeAudioContext.latest.sources.length, 0);
  } finally { release(); player.dispose(); globalThis.AudioContext = original; }
});

test('pausing during source preparation can resume the original and later uses the exact source offset', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer(); const { arrangement } = recordedPhrase();
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; }); const reading = new Promise(resolve => { started = resolve; });
  const blob = arrangement.recordingLead.audioWav;
  arrangement.recordingLead.audioWav = new class extends Blob { async arrayBuffer() { started(); await gate; return blob.arrayBuffer(); } }([blob]);
  try {
    const pending = player.play(arrangement);
    await Promise.race([reading, pending]); player.pause(); release(); await pending;
    assert.equal(player.status, 'paused'); assert.equal(FakeAudioContext.latest.sources.length, 0);
    await player.resume();
    const context = FakeAudioContext.latest; context.currentTime = 0.235; player.pause();
    const first = context.sources[0]; context.currentTime = 10; await player.resume();
    const resumed = context.sources[1];
    assert.equal(resumed.buffer, first.buffer);
    assert.ok(Math.abs(resumed.startArguments[0][0] - 10.035) < 1e-9);
    assert.ok(Math.abs(resumed.startArguments[0][1] - 0.2) < 1e-9);
    assert.ok(Math.abs(resumed.startArguments[0][2] - 0.3) < 1e-9);
    assert.equal(resumed.playbackRate.value, 1);
  } finally { release(); player.dispose(); globalThis.AudioContext = original; }
});

test('recording-only WAV export schedules the whole source and MIDI refuses an unrepresentable waveform', async () => {
  const original = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class extends FakeAudioContext {
    constructor(channels, length, sampleRate) { super(); this.length = length; this.numberOfChannels = channels; this.sampleRate = sampleRate; }
    async startRendering() { return this.createBuffer(this.numberOfChannels, this.length, this.sampleRate); }
  };
  try {
    const { arrangement } = recordedPhrase();
    const wav = await exportWav(arrangement);
    assert.equal(wav.type, 'audio/wav');
    assert.deepEqual(FakeAudioContext.latest.sources[0].startArguments, [[0, 0, 0.5]]);
    assert.throws(() => exportMidi(arrangement), /MIDI|recording|waveform/i);
  } finally { globalThis.OfflineAudioContext = original; }
});

test('resuming inside the original take edge fade keeps its absolute source envelope', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = FakeAudioContext;
  const player = new CompositionPlayer(); const { arrangement } = recordedPhrase();
  try {
    await player.play(arrangement);
    const context = FakeAudioContext.latest;
    const gain = Math.max(...context.sources[0].connections[0].gain.calls.map(([, value]) => value));
    context.currentTime = 0.534; player.pause(); context.currentTime = 10; await player.resume();
    const envelope = context.sources[1].connections[0];
    assert.ok(Math.abs(envelope.gain.calls[0][1] - gain / 3) < 1e-8, 'Resuming the last millisecond must not restore full gain inside the existing three-millisecond fade.');
  } finally { player.dispose(); globalThis.AudioContext = original; }
});
