import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_CATALOG, validateBlueprint, createBlueprint, planProduction } from '../src/producer/production-blueprint.js';

const layer = (id, instrument, role, changes = {}) => ({ id, instrument, role, enabled: true, gain: 0.5, section: 'full', variant: 0, ...changes });
const base = () => ({ version: 1, prompt: '', mood: 'Dreamy', intensity: 0.5, layers: [layer('guitar', 'Acoustic Guitar', 'rhythm'), layer('piano', 'Piano', 'chords'), layer('drums', 'Drums', 'percussion')] });

test('blueprints reject unsupported controls, mismatched instruments, duplicate layers and unsafe bounds', () => {
  const good = base();
  const invalid = [
    { ...good, leadSource: 'instrument' }, { ...good, version: 2 }, { ...good, prompt: 'x'.repeat(4001) },
    { ...good, mood: 'Angry' }, { ...good, intensity: NaN }, { ...good, intensity: 1.01 },
    { ...good, layers: [...good.layers, good.layers[0]] },
    ...[{ instrument: 'Trumpet' }, { role: 'melody' }, { gain: Infinity }, { gain: -0.1 }, { enabled: 1 },
      { section: 'chorus' }, { variant: 1000 }, { variant: 0.5 }, { notes: [] }, { id: '__proto__' }]
      .map(change => ({ ...good, layers: [{ ...good.layers[0], ...change }] })),
  ];
  for (const value of invalid) assert.throws(() => validateBlueprint(value), undefined, JSON.stringify(value));
  const copy = validateBlueprint(good);
  copy.layers[0].gain = 0.1;
  assert.equal(good.layers[0].gain, 0.5);
  assert.equal(LAYER_CATALOG.find(item => item.id === 'cello').roles.includes('bass'), true);
});

test('legacy settings produce only requested real backing layers without editing the lead', () => {
  const settings = Object.freeze({ instrument: 'Piano', leadSource: 'recording', mood: 'Peaceful', genre: 'Ambient', accompaniment: true, bass: false, percussion: false });
  const result = createBlueprint(settings);
  assert.equal(result.mood, 'Peaceful');
  assert.ok(result.layers.some(item => ['violin', 'cello'].includes(item.id)));
  assert.equal(result.layers.some(item => item.id === 'drums' || item.id === 'bass'), false);
  assert.equal(Object.hasOwn(result, 'leadSource'), false);
  assert.deepEqual(validateBlueprint(result), result);
});

test('natural language creates independent requested instruments and obeys exclusions', () => {
  const result = planProduction('Only acoustic guitar, piano and violin. No drums or bass. Keep my original melody.', {});
  assert.deepEqual(result.layers.filter(item => item.enabled).map(item => item.id).sort(), ['guitar', 'piano', 'violin']);
  assert.equal(result.layers.find(item => item.id === 'guitar').instrument, 'Acoustic Guitar');
  assert.equal(Object.hasOwn(result, 'notes'), false);
  assert.equal(Object.hasOwn(result, 'leadSource'), false);
});

test('targeted volume refinements retain unrelated layers and disabled percussion', () => {
  const original = base();
  original.layers[2].enabled = false;
  const snapshot = structuredClone(original);
  const louder = planProduction('Make guitar louder', { blueprint: original });
  assert.ok(louder.layers[0].gain > 0.5);
  assert.deepEqual(louder.layers.slice(1), original.layers.slice(1));
  const softer = planProduction('Softer piano', { blueprint: louder });
  assert.ok(softer.layers.find(item => item.id === 'piano').gain < 0.5);
  assert.deepEqual(softer.layers.find(item => item.id === 'guitar'), louder.layers[0]);
  assert.equal(softer.layers.find(item => item.id === 'drums').enabled, false);
  assert.deepEqual(original, snapshot);
});

test('negation scope, later additions, reductions and ending entries refine distinct layers', () => {
  const result = planProduction('No drums or bass, add guitar and piano, strings only in the ending', { blueprint: base() });
  assert.equal(result.layers.find(item => item.id === 'drums').enabled, false);
  assert.ok(result.layers.filter(item => ['violin', 'cello'].includes(item.id)).every(item => item.enabled && item.section === 'ending'));
  assert.equal(result.layers.find(item => item.id === 'guitar').enabled, true);
  const reduced = planProduction('Less drums, not louder guitar', { blueprint: base() });
  assert.equal(reduced.layers.find(item => item.id === 'drums').enabled, true);
  assert.ok(reduced.layers.find(item => item.id === 'drums').gain < 0.5);
  assert.equal(reduced.layers.find(item => item.id === 'guitar').gain, 0.5);
});

test('mood, intensity and arpeggios support refinements without resetting layer identity', () => {
  const result = planProduction('Make it cinematic and more intense, piano arpeggios, add cello bass', { blueprint: base() });
  assert.equal(result.mood, 'Cinematic');
  assert.ok(result.intensity > 0.5);
  assert.equal(result.layers.find(item => item.id === 'piano').role, 'arpeggio');
  assert.equal(result.layers.find(item => item.id === 'cello').role, 'bass');
  assert.equal(result.layers.find(item => item.id === 'guitar').gain, 0.5);
});

test('opposing adjacent refinements do not apply one instrument modifier to the next', () => {
  const result = planProduction('Make piano softer and guitar louder', { blueprint: base() });
  assert.ok(result.layers.find(item => item.id === 'piano').gain < 0.5);
  assert.ok(result.layers.find(item => item.id === 'guitar').gain > 0.5);
  const roles = planProduction('Piano arpeggios and synth texture', { blueprint: base() });
  assert.equal(roles.layers.find(item => item.id === 'piano').role, 'arpeggio');
  assert.equal(roles.layers.find(item => item.id === 'synth').role, 'texture');
});

test('mute, turn off and negated increases never add or amplify a layer', () => {
  for (const text of ['Mute drums', 'Turn off drums']) {
    const result = planProduction(text, { blueprint: base() });
    assert.equal(result.layers.find(item => item.id === 'drums').enabled, false);
  }
  const result = planProduction('Guitar not louder', { blueprint: base() });
  assert.equal(result.layers.find(item => item.id === 'guitar').gain, 0.5);
});
