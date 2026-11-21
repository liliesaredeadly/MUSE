import test from 'node:test';
import assert from 'node:assert/strict';
import { planProduction } from '../src/producer/production-blueprint.js';
import { createProductionDirector } from '../server/production-director.js';
import { buildArrangement } from '../src/music/arrangement.js';

const base = () => planProduction('Use only guitar, piano and drums');
const layer = (blueprint, id) => blueprint.layers.find(item => item.id === id);

test('trailing off and negated removal respect the requested drum state', () => {
  const blueprint = base();
  assert.equal(layer(planProduction('Drums off', { blueprint }), 'drums').enabled, false);
  assert.deepEqual(layer(planProduction('Do not remove drums', { blueprint }), 'drums'), layer(blueprint, 'drums'));
});

test('soft piano does not reduce adjacent guitar and light percussion reduces its own level', () => {
  const blueprint = base();
  const result = planProduction('Use acoustic guitar with soft piano. Add light drums.', { blueprint });
  assert.deepEqual(layer(result, 'guitar'), layer(blueprint, 'guitar'));
  assert.ok(layer(result, 'piano').gain < layer(blueprint, 'piano').gain);
  assert.ok(layer(result, 'drums').gain < layer(blueprint, 'drums').gain);
  const strings = planProduction('Add strings to the final section', { blueprint });
  assert.equal(layer(strings, 'violin').section, 'ending');
  assert.equal(layer(strings, 'cello').section, 'ending');
});

test('scoped AI refinement cannot change global controls, unrelated additions or target roles', async () => {
  const blueprint = base();
  const planned = planProduction('Make guitar louder', { blueprint });
  const changes = [
    candidate => { candidate.mood = 'Energetic'; },
    candidate => { candidate.intensity = .9; },
    candidate => { layer(candidate, 'guitar').section = 'ending'; },
    candidate => { layer(candidate, 'guitar').role = 'arpeggio'; },
    candidate => { candidate.layers.push({ id: 'cello', instrument: 'Cello', role: 'sustain', gain: .4, enabled: true, section: 'full', variant: 0 }); },
  ];
  for (const change of changes) {
    const candidate = structuredClone(planned); change(candidate);
    const director = createProductionDirector({ env: { OPENAI_API_KEY: 'test-only' }, fetchImpl: async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ blueprint: candidate, summary: 'Review the refinement.' }) }] }] }) });
    const result = await director.propose({ text: 'Make guitar louder', settings: { blueprint }, notes: [] });
    assert.equal(result.source, 'rules');
    assert.deepEqual(result.blueprint, planned);
  }
});

test('production styles change blueprint backing while retaining every lead pitch and gate', () => {
  const notes = [{ midi: 60, start: .1, duration: .7 }, { midi: 67, start: 1, duration: .6 }, { midi: 64, start: 2, duration: .8 }, { midi: 62, start: 3, duration: 1 }];
  const blueprint = base();
  const versions = ['dance-pop', 'percussive-pop', 'auto'].map(production => buildArrangement(notes, { blueprint, bpm: 100, sourceBpm: 100, production, genre: 'Ambient' }));
  const backing = versions.map(arrangement => JSON.stringify(arrangement.events.filter(event => event.layerId)));
  assert.equal(new Set(backing).size, 3);
  for (const arrangement of versions) assert.deepEqual(arrangement.events.filter(event => event.track === 'melody').map(({ midi, start, duration }) => ({ midi, start, duration })), notes);
});
