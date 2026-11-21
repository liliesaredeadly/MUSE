import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as synth from '../src/audio/synth.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

// Web Audio is not available in Node. This double records the native scheduling
// boundary; director-audio-browser.js separately verifies real rendered PCM.
class AudioGraph {
  static latest;
  constructor() { AudioGraph.latest = this; this.currentTime = 0; this.state = 'running'; this.sampleRate = 44100; this.nodes = []; this.sources = []; this.destination = {}; }
  resume() { return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  param() { return { value: 0, calls: [], setValueAtTime(value, time) { this.calls.push(['set', value, time]); }, linearRampToValueAtTime(value, time) { this.calls.push(['linear', value, time]); }, exponentialRampToValueAtTime(value, time) { this.calls.push(['exponential', value, time]); } }; }
  node(kind, fields = {}) { const node = { kind, connections: [], connect(target) { this.connections.push(target); }, disconnect() {}, ...fields }; this.nodes.push(node); return node; }
  createGain() { return this.node('gain', { gain: this.param() }); }
  createBiquadFilter() { return this.node('filter', { frequency: this.param(), Q: this.param() }); }
  createDynamicsCompressor() { return this.node('compressor', Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(key => [key, this.param()]))); }
  createStereoPanner() { return this.node('panner', { pan: this.param() }); }
  createDelay() { return this.node('delay', { delayTime: this.param() }); }
  createBuffer(channels, length, sampleRate = 44100) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { numberOfChannels: channels, length, sampleRate, getChannelData: i => data[i] }; }
  source(fields = {}) { const source = this.node('source', { ...fields, starts: [], stops: [], start(...args) { this.starts.push(args); }, stop(time) { this.stops.push(time); } }); this.sources.push(source); return source; }
  createOscillator() { return this.source({ frequency: this.param(), detune: this.param() }); }
  createBufferSource() { return this.source({ playbackRate: this.param() }); }
}
const event = (instrument, layerId, extra = {}) => ({ midi: 60, start: 0, duration: 0.6, velocity: 0.6, instrument, layerId, track: 'chords', ...extra });
const mix = gain => ({ bpm: 100, duration: 0.6, layers: [{ id: 'guitar', enabled: true, blocked: false, gain }], events: [event('Acoustic Guitar', 'guitar')] });
function reaches(node, target, seen = new Set()) { if (node === target) return true; if (seen.has(node)) return false; seen.add(node); return node.connections?.some(next => reaches(next, target, seen)) || false; }

test('each editable layer has a separate gain path and cannot alter the dry lead', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = AudioGraph;
  const player = new synth.CompositionPlayer();
  try {
    await player.play({ ...mix(0.17), layers: [...mix(0.17).layers, { id: 'piano', enabled: true, blocked: false, gain: 0.73 }], events: [
      event('Piano', undefined, { track: 'melody' }), event('Acoustic Guitar', 'guitar'), event('Piano', 'piano'),
    ] });
    const context = AudioGraph.latest;
    const guitar = context.nodes.find(node => node.kind === 'gain' && node.gain.value === 0.17);
    const piano = context.nodes.find(node => node.kind === 'gain' && node.gain.value === 0.73);
    assert.ok(guitar && piano && guitar !== piano, 'Both isolated layer levels must exist in the rendered graph.');
    assert.equal(reaches(context.sources[0], guitar), false);
    assert.equal(reaches(context.sources[0], piano), false);
    assert.ok(context.sources.some(source => reaches(source, guitar)));
    assert.ok(context.sources.some(source => reaches(source, piano)));
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('muted and disabled layer events cannot create voices', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = AudioGraph;
  const player = new synth.CompositionPlayer();
  try {
    for (const layer of [{ id: 'guitar', enabled: true, gain: 0 }, { id: 'guitar', enabled: false, gain: 1 }, { id: 'guitar', enabled: true, gain: 1, blocked: true }]) {
      await player.play({ ...mix(1), layers: [layer] });
      assert.equal(AudioGraph.latest.sources.filter(source => source.starts.length).length, 0);
    }
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('a muted drum layer cannot duck audible backing', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = AudioGraph;
  const player = new synth.CompositionPlayer();
  try {
    await player.play({ ...mix(0.6), production: { style: 'dance-pop' },
      layers: [...mix(0.6).layers, { id: 'drums', enabled: true, gain: 0 }],
      events: [event('Acoustic Guitar', 'guitar'), event('Drums', 'drums', { midi: 36, duration: 0.17, track: 'percussion' })],
    });
    assert.ok(AudioGraph.latest.nodes.filter(node => node.kind === 'gain').every(node => !node.gain.calls.some(call => call[1] === 0.48)), 'Silent kicks must not leave phantom pumping in the harmonic mix.');
  } finally { player.dispose(); globalThis.AudioContext = original; }
});

test('layer routing rejects nonfinite gains instead of ignoring a damaged mix', async () => {
  const player = new synth.CompositionPlayer();
  try { await assert.rejects(player.play(mix(NaN)), /layer|gain/i); }
  finally { player.dispose(); }
});

test('guitar, violin and cello create distinguishable synthesized voices', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = AudioGraph;
  const descriptors = [];
  try {
    for (const instrument of ['Piano', 'Acoustic Guitar', 'Violin', 'Cello']) {
      const player = new synth.CompositionPlayer();
      try {
        await player.play({ bpm: 100, duration: 0.6, events: [event(instrument)] });
        const context = AudioGraph.latest;
        descriptors.push(JSON.stringify({ types: context.sources.map(source => source.type), filters: context.nodes.filter(node => node.kind === 'filter').map(node => node.frequency.value), envelopes: context.nodes.filter(node => node.kind === 'gain' && node.gain.calls.length).map(node => node.gain.calls) }));
      } finally { player.dispose(); }
    }
    assert.equal(new Set(descriptors).size, 4, 'New instruments must not silently fall through to Piano or generic Strings.');
  } finally { globalThis.AudioContext = original; }
});

function readMidi(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'MThd');
  const division = view.getUint16(12); let offset = 22; let tick = 0; const events = [];
  const vlq = () => { let value = 0; let byte; do { byte = bytes[offset++]; value = value * 128 + (byte & 127); } while (byte & 128); return value; };
  while (offset < bytes.length) {
    tick += vlq(); const status = bytes[offset++];
    if (status === 0xff) { const type = bytes[offset++]; const length = vlq(); const data = [...bytes.subarray(offset, offset + length)]; offset += length; events.push({ tick, status, type, data }); }
    else { const length = [0xc0, 0xd0].includes(status & 0xf0) ? 1 : 2; const data = [...bytes.subarray(offset, offset + length)]; offset += length; events.push({ tick, status, data }); }
  }
  return { division, events };
}

test('MIDI gives all six pitched backing instruments and the lead separate programmed channels', async () => {
  const instruments = ['Acoustic Guitar', 'Piano', 'Violin', 'Cello', 'Synthesizer', 'Bass'];
  const input = { bpm: 120, duration: 1, events: [
    event('Piano', undefined, { track: 'melody' }), ...instruments.map((instrument, index) => event(instrument, `layer-${index}`)),
    event('Drums', 'drums', { midi: 36, track: 'percussion' }),
  ] };
  const parsed = readMidi(new Uint8Array(await synth.exportMidi(input).arrayBuffer()));
  const ons = parsed.events.filter(item => (item.status & 0xf0) === 0x90);
  assert.equal(new Set(ons.map(item => item.status & 15)).size, 8);
  assert.equal(ons.at(-1).status & 15, 9);
  const programs = parsed.events.filter(item => (item.status & 0xf0) === 0xc0);
  assert.deepEqual(programs.map(item => item.data[0]), [0, 24, 0, 40, 42, 80, 32]);
});

test('estimated melody MIDI exports original detected gates without changing recording settings', async () => {
  assert.equal(typeof synth.exportMelodyMidi, 'function', 'Estimated transcription export must not require replacing the audible recording lead.');
  const notes = [{ midi: 61, start: 0.25, duration: 0.125 }, { midi: 61, start: 0.625, duration: 0.375 }];
  const before = structuredClone(notes);
  const parsed = readMidi(new Uint8Array(await synth.exportMelodyMidi(notes, 120).arrayBuffer()));
  const messages = parsed.events.filter(item => [0x80, 0x90].includes(item.status & 0xf0));
  assert.deepEqual(messages.map(item => [item.tick, item.status & 0xf0, item.data[0]]), [[240, 0x90, 61], [360, 0x80, 61], [600, 0x90, 61], [960, 0x80, 61]]);
  assert.deepEqual(notes, before);
  assert.throws(() => synth.exportMelodyMidi([], 120), /notes|melody/i);
});

test('original recording buffer, gain and clock survive backing gain changes', async () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = AudioGraph;
  const samples = Float32Array.from({ length: 44100 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 220 * i / 44100));
  const bytes = encodePcmWav(samples, 44100); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const player = new synth.CompositionPlayer(); const recordings = [];
  try {
    for (const gain of [0.1, 1]) {
      await player.play({ ...mix(gain), duration: 1, settings: { leadSource: 'recording' }, recordingLead: { duration: 1, sha256, audioWav: new Blob([bytes]) } });
      const source = AudioGraph.latest.sources.filter(item => item.buffer).at(-1);
      recordings.push({ data: [...source.buffer.getChannelData(0)], starts: source.starts, envelope: source.connections[0].gain.calls, rate: source.playbackRate.value });
    }
    assert.deepEqual(recordings[0], recordings[1]);
    assert.equal(recordings[0].rate, 1);
    assert.deepEqual(recordings[0].starts, [[0.035, 0, 1]]);
  } finally { player.dispose(); globalThis.AudioContext = original; }
});
