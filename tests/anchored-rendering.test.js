import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CompositionPlayer } from '../src/audio/synth.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

// Node lacks native Web Audio; verify our scheduling/routing boundary here.
// Native rendered gap silence is checked separately in the browser.
class Graph {
  static latest;
  constructor() { Graph.latest = this; this.currentTime = 0; this.state = 'running'; this.sampleRate = 44100; this.nodes = []; this.sources = []; this.destination = {}; }
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
const event = (instrument, extra = {}) => ({ midi: 60, start: 0.2, duration: 0.2, velocity: 0.6, instrument, track: 'chords', ...extra });
const arrangement = events => ({ bpm: 120, duration: 1, harmonyScope: 'anchored', harmonyRegions: [{ start: 0.2, duration: 0.2 }], production: { style: 'dance-pop' }, events });
function reaches(node, kind, seen = new Set()) { if (node.kind === kind) return true; if (seen.has(node)) return false; seen.add(node); return node.connections?.some(next => reaches(next, kind, seen)) || false; }
function graphSnapshot(context) { return { sources: context.sources.map(source => ({ type: source.type, starts: source.starts, stops: source.stops, frequency: source.frequency?.calls, rate: source.playbackRate?.value })), envelopes: context.nodes.filter(node => node.kind === 'gain' && node.gain.calls.length).map(node => node.gain.calls) }; }
async function withPlayer(action) {
  const original = globalThis.AudioContext; globalThis.AudioContext = Graph;
  const player = new CompositionPlayer();
  try { await action(player); } finally { player.dispose(); globalThis.AudioContext = original; }
}

test('anchored pitched voices fade inside each event gate and stop without a release tail', async () => {
  for (const instrument of ['Strings', 'Violin', 'Cello', 'Piano', 'Acoustic Guitar', 'Synthesizer', 'Bass']) await withPlayer(async player => {
    const input = arrangement([event(instrument)]); const before = structuredClone(input);
    await player.play(input);
    const context = Graph.latest; const gateEnd = 0.435;
    assert.ok(context.sources.every(source => Math.abs(source.stops[0] - gateEnd) < 1e-9), `${instrument} released outside the confirmed anchor.`);
    const envelope = context.nodes.find(node => node.kind === 'gain' && node.gain.calls.some(([kind, value, time]) => kind === 'linear' && value === 0 && Math.abs(time - gateEnd) < 1e-9));
    assert.ok(envelope, `${instrument} must reach exact silence at its gate end.`);
    assert.ok(envelope.gain.calls.some(([kind, value, time]) => kind === 'set' && value > 0 && time >= gateEnd - 0.003 - 1e-9 && time < gateEnd), 'The short edge fade must fit within the anchor.');
    assert.ok(envelope.gain.calls.every(([, , time]) => time <= gateEnd + 1e-9));
    assert.deepEqual(input, before, 'Rendering must not mutate the source arrangement.');
  });
});

test('all anchored pitched layers including bass bypass delay and compressor latency while retaining individual gain', async () => {
  await withPlayer(async player => {
    const input = arrangement([event('Violin', { layerId: 'violin' }), event('Cello', { layerId: 'cello', track: 'bass' })]);
    input.layers = [{ id: 'violin', gain: 0.17, enabled: true }, { id: 'cello', gain: 0.73, enabled: true }];
    await player.play(input);
    const context = Graph.latest;
    assert.ok(context.sources.every(source => !reaches(source, 'delay') && !reaches(source, 'compressor')), 'Anchor audio must have no delayed or lookahead path into unpitched gaps.');
    for (const gain of [0.17, 0.73]) {
      const layer = context.nodes.find(node => node.kind === 'gain' && node.gain.value === gain);
      assert.ok(layer && context.sources.some(source => {
        const seen = new Set(); const includes = node => { if (node === layer) return true; if (seen.has(node)) return false; seen.add(node); return node.connections?.some(includes); }; return includes(source);
      }), 'Independent layer gain must remain in the dry anchored route.');
    }
  });
});

test('anchored resume cannot restore a release tail across the remaining gate', async () => {
  await withPlayer(async player => {
    await player.play(arrangement([event('Violin')]));
    const context = Graph.latest; context.currentTime = 0.434; player.pause();
    const previousCount = context.sources.length; context.currentTime = 10; await player.resume();
    const resumed = context.sources.slice(previousCount);
    assert.ok(resumed.length && resumed.every(source => Math.abs(source.stops[0] - 10.036) < 1e-9), 'Only the final millisecond of the anchor may remain after resume.');
    assert.ok(resumed.every(source => !reaches(source, 'delay') && !reaches(source, 'compressor')));
  });
});

test('anchored scope does not change drum gates, envelopes or routing', async () => {
  const snapshots = [];
  for (const anchored of [false, true]) await withPlayer(async player => {
    const input = arrangement([event('Drums', { midi: 38, track: 'percussion' })]);
    if (!anchored) delete input.harmonyScope;
    await player.play(input); snapshots.push(graphSnapshot(Graph.latest));
    assert.ok(Graph.latest.sources.every(source => reaches(source, 'compressor')));
  });
  assert.deepEqual(snapshots[0], snapshots[1]);
});

test('ordinary pitched arrangements retain their normal release and effects paths', async () => {
  await withPlayer(async player => {
    const input = arrangement([event('Violin')]); delete input.harmonyScope;
    await player.play(input);
    assert.ok(Graph.latest.sources.every(source => source.stops[0] > 0.8 && reaches(source, 'delay') && reaches(source, 'compressor')));
  });
});

test('original waveform buffer, source clock and envelope are unchanged by anchored harmony scope', async () => {
  const bytes = encodePcmWav(Float32Array.from({ length: 44100 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 220 * i / 44100)), 44100);
  const sha256 = createHash('sha256').update(bytes).digest('hex'); const snapshots = [];
  for (const anchored of [false, true]) await withPlayer(async player => {
    const input = { ...arrangement([]), settings: { leadSource: 'recording' }, recordingLead: { duration: 1, sha256, audioWav: new Blob([bytes]) } };
    if (!anchored) delete input.harmonyScope;
    await player.play(input);
    const source = Graph.latest.sources[0];
    snapshots.push({ samples: [...source.buffer.getChannelData(0)], starts: source.starts, stops: source.stops, rate: source.playbackRate.value, envelope: source.connections[0].gain.calls });
    assert.equal(reaches(source, 'delay'), false); assert.equal(reaches(source, 'compressor'), false);
  });
  assert.deepEqual(snapshots[0], snapshots[1]);
});
