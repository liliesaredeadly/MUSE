import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArrangement } from '../src/music/arrangement.js';
import { assertMelodyPreserved } from '../src/music/melody-contract.js';

const notes = [
  { midi: 60, start: 0.23, duration: 0.42, contour: [{ time: 0, frequency: 260 }, { time: 0.35, frequency: 263 }] },
  { midi: 64, start: 0.91, duration: 0.3 },
  { midi: 67, start: 1.61, duration: 0.56 },
  { midi: 65, start: 3.8, duration: 0.4 },
  { midi: 62, start: 5.4, duration: 0.6 },
  { midi: 60, start: 7.7, duration: 0.3 },
];
const layer = (id, instrument, role, extra = {}) => ({ id, instrument, role, enabled: true, gain: 0.6, section: 'full', variant: 0, ...extra });
const blueprint = () => ({ version: 1, prompt: 'A guitar rhythm, warm piano, and strings entering at the end.', mood: 'Dreamy', intensity: 0.6, layers: [
  layer('guitar', 'Acoustic Guitar', 'rhythm'), layer('piano', 'Piano', 'chords'),
  layer('violin', 'Violin', 'sustain', { section: 'ending' }), layer('cello', 'Cello', 'bass'),
  layer('synth', 'Synthesizer', 'texture'), layer('bass', 'Bass', 'bass'), layer('drums', 'Drums', 'percussion'),
] });
const settings = plan => ({ bpm: 120, mood: 'Dreamy', genre: 'Pop', production: 'dance-pop', accompaniment: false, bass: false, percussion: false, blueprint: plan });
const backing = arrangement => arrangement.events.filter(event => event.track !== 'melody');

test('blueprint replaces legacy backing with independent catalog layers and leaves the lead exact', () => {
  const input = structuredClone(notes); const plan = blueprint();
  const result = buildArrangement(notes, settings(plan));
  assertMelodyPreserved(notes, result);
  assert.deepEqual(notes, input);
  assert.deepEqual(result.settings.blueprint, plan);
  assert.deepEqual(new Set(backing(result).map(event => event.layerId)), new Set(['guitar', 'piano', 'violin', 'cello', 'synth', 'bass', 'drums']));
  assert.ok(backing(result).every(event => event.start >= 0 && event.start + event.duration <= 8 + 1e-9));
  assert.equal(result.layers.length, 7);
  assert.ok(result.layers.every(item => item.enabled && item.blocked === false && item.reason === null));
});

test('regenerating a guitar changes only that layer while every other event remains byte-equal', () => {
  const plan = blueprint(); const base = buildArrangement(notes, settings(plan));
  plan.layers[0].variant++;
  const changed = buildArrangement(notes, settings(plan));
  assert.notDeepEqual(backing(base).filter(event => event.layerId === 'guitar'), backing(changed).filter(event => event.layerId === 'guitar'));
  for (const id of ['piano', 'violin', 'cello', 'synth', 'bass', 'drums']) {
    assert.equal(JSON.stringify(backing(base).filter(event => event.layerId === id)), JSON.stringify(backing(changed).filter(event => event.layerId === id)));
  }
  assert.deepEqual(base.events.filter(event => event.track === 'melody'), changed.events.filter(event => event.track === 'melody'));
  assert.deepEqual(base.chords, changed.chords);
});

test('layer gains are mix metadata and disabled layers do not generate events', () => {
  const plan = blueprint(); const base = buildArrangement(notes, settings(plan));
  plan.layers[0].gain = 0.1;
  assert.deepEqual(buildArrangement(notes, settings(plan)).events, base.events, 'Changing mix gain must not rewrite the generated MIDI notes.');
  plan.layers[0].enabled = false;
  const result = buildArrangement(notes, settings(plan));
  assert.ok(backing(result).every(event => event.layerId !== 'guitar'));
  assert.equal(result.layers.find(item => item.id === 'guitar').enabled, false);
});

test('ending strings begin in the final quarter without changing the original source clock', () => {
  const result = buildArrangement(notes, settings(blueprint()));
  const violin = backing(result).filter(event => event.layerId === 'violin');
  assert.ok(violin.length > 0);
  assert.ok(violin.every(event => event.start >= 6 && event.start + event.duration <= 8));
  assert.equal(result.duration, 8);
});

test('blueprint mood and intensity affect only backing and low intensity remains audible', () => {
  const plan = blueprint(); plan.intensity = 0;
  const quiet = buildArrangement(notes, settings(plan));
  plan.intensity = 1; plan.mood = 'Energetic';
  const loud = buildArrangement(notes, settings(plan));
  assert.deepEqual(quiet.events.filter(event => event.track === 'melody'), loud.events.filter(event => event.track === 'melody'));
  const sum = result => backing(result).reduce((value, event) => value + event.velocity, 0);
  assert.ok(sum(quiet) > 0 && sum(loud) > sum(quiet));
});

test('unreliable transcription blocks all pitched layers while preserving the full recorded lead', () => {
  const source = { duration: 12, sha256: 'a'.repeat(64), quality: { canHarmonize: false } };
  const result = buildArrangement(notes, { ...settings(blueprint()), leadSource: 'recording', preserveMelodyTiming: false }, source);
  assert.equal(result.duration, 12);
  assert.deepEqual(result.recordingLead, { duration: 12, sha256: 'a'.repeat(64) });
  assert.deepEqual(result.chords, []);
  assert.ok(result.events.length > 0 && result.events.every(event => event.layerId === 'drums' && event.track === 'percussion'));
  assert.ok(result.layers.filter(item => item.id !== 'drums').every(item => item.blocked && /pitch|harmon/i.test(item.reason)));
  assert.equal(result.layers.find(item => item.id === 'drums').blocked, false);
  assert.equal(result.melodyProof.engine, 'original-waveform');
});

test('silent note input does not invent blueprint music and invalid plans fail instead of being ignored', () => {
  assert.deepEqual(buildArrangement([], settings(blueprint())).events, []);
  const plan = blueprint(); plan.layers[0].gain = NaN;
  assert.throws(() => buildArrangement(notes, settings(plan)), /gain|blueprint|layer/i);
});
