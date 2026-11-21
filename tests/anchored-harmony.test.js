import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTranscription } from '../src/audio/transcription-quality.js';
import { buildArrangement } from '../src/music/arrangement.js';

const anchor = (midi, start, duration = 0.4) => ({ midi, name: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][midi % 12] + (Math.floor(midi / 12) - 1),
  start, duration, confidence: 0.95, frequency: 440 * 2 ** ((midi - 69) / 12), supportCount: 3, coverage: 0.95 });
const anchors = () => [anchor(48, 0.2), anchor(52, 0.6), anchor(55, 2.7)];
const analysis = () => ({ duration: 8, voicedRatio: 0.26, notes: [{ midi: 88, start: 0.1, duration: 0.4, confidence: 0.91 }],
  harmonicEvidence: { method: 'spectral-harmonic-consensus-v1', anchors: anchors() } });
const partial = () => ({ status: 'partial', canHarmonize: true, voicedRatio: 0.26, harmonyScope: 'anchored',
  harmonyNotes: anchors(), harmonyRegions: [{ start: 0.2, duration: 0.8 }, { start: 2.7, duration: 0.4 }], reason: 'Limited backing only in clear parts.' });
const metadata = (quality = partial()) => ({ duration: 8, sha256: 'a'.repeat(64), quality });
const settings = extra => ({ leadSource: 'recording', bpm: 120, genre: 'Ambient', production: 'auto', accompaniment: true, bass: true, percussion: true, ...extra });
const layer = (id, instrument, role, section = 'full') => ({ id, instrument, role, section, enabled: true, gain: 0.5, variant: 0 });
const blueprint = layers => ({ version: 1, prompt: '', mood: 'Dreamy', intensity: 0.5, layers });
const pitched = result => result.events.filter(event => event.instrument !== 'Drums' && event.track !== 'melody');
const within = (event, region) => event.start >= region.start - 1e-8 && event.start + event.duration <= region.start + region.duration + 1e-8;

test('independent harmonic anchors permit only explicitly scoped partial backing', () => {
  const input = analysis(); const before = structuredClone(input);
  const result = assessTranscription(input);
  assert.equal(result.status, 'partial');
  assert.equal(result.canHarmonize, true);
  assert.equal(result.harmonyScope, 'anchored');
  assert.equal(result.voicedRatio, 0.26, 'partial permission must not inflate estimated voiced coverage');
  assert.deepEqual(result.harmonyNotes, input.harmonicEvidence.anchors);
  assert.deepEqual(result.harmonyRegions, partial().harmonyRegions);
  assert.match(result.reason, /limited|clear parts|confirmed regions/i);
  assert.match(result.reason, /not.*verified/i);
  result.harmonyNotes[0].start = 7;
  assert.deepEqual(input, before, 'evidence and caller input remain immutable');
});

test('normal full-coverage approval remains unchanged when independent anchors are present', () => {
  const input = analysis(); input.voicedRatio = 0.55; input.notes = anchors();
  const result = assessTranscription(input);
  assert.equal(result.status, 'estimated');
  assert.equal(result.canHarmonize, true);
  assert.equal(result.harmonyNotes, undefined);
  assert.equal(result.harmonyRegions, undefined);
});

test('fabricated, sparse, ambiguous or invalid anchors never authorize partial harmony', () => {
  const variants = [
    input => { input.harmonicEvidence.method = 'guess'; },
    input => { input.harmonicEvidence.anchors = input.harmonicEvidence.anchors.slice(0, 2); },
    input => { input.harmonicEvidence.anchors.forEach(item => { item.duration = 0.2; }); },
    input => { input.harmonicEvidence.anchors.forEach(item => { item.midi = 48; item.frequency = 130.8127826502993; }); },
    input => { input.harmonicEvidence.anchors[0].confidence = 0.899; },
    input => { input.harmonicEvidence.anchors[0].coverage = 0.899; },
    input => { input.harmonicEvidence.anchors[0].supportCount = 2; },
    input => { input.harmonicEvidence.anchors[0].duration = 0.119; },
    input => { input.harmonicEvidence.anchors[1].start = 0.3; },
    input => { input.harmonicEvidence.anchors.reverse(); },
    input => { input.harmonicEvidence.anchors[2].start = 7.9; },
    input => { input.harmonicEvidence.anchors[0].frequency = NaN; },
    input => { input.harmonicEvidence.anchors[0].frequency *= 2; },
    input => { input.notes[0].duration = 9; },
  ];
  for (const change of variants) {
    const input = analysis(); change(input);
    const result = assessTranscription(input);
    assert.equal(result.status, 'limited', String(change));
    assert.equal(result.canHarmonize, false, String(change));
    assert.equal(result.harmonyNotes, undefined);
  }
});

test('the minimum anchor evidence is inclusive and does not fill real gaps', () => {
  const input = analysis();
  input.harmonicEvidence.anchors = [anchor(48, 0.2, 0.25), anchor(52, 0.8, 0.25), anchor(55, 1.4, 0.25)]
    .map(item => ({ ...item, confidence: 0.9, coverage: 0.9 }));
  const result = assessTranscription(input);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.harmonyRegions, input.harmonicEvidence.anchors.map(({ start, duration }) => ({ start, duration })));
});

for (const production of ['auto', 'dance-pop', 'percussive-pop']) {
  test(`${production} backing stays inside confirmed source-clock regions while drums keep their timing`, () => {
    const input = analysis(); const before = structuredClone(input);
    const chosen = settings({ production });
    const result = buildArrangement(input.notes, chosen, metadata());
    assert.ok(pitched(result).length > 0);
    assert.ok(pitched(result).every(event => partial().harmonyRegions.some(region => within(event, region))));
    assert.equal(result.harmonyScope, 'anchored');
    assert.deepEqual(result.harmonyRegions, partial().harmonyRegions);
    assert.equal(result.duration, 8);
    assert.deepEqual(result.recordingLead, { duration: 8, sha256: 'a'.repeat(64) });
    assert.equal(result.events.some(event => event.track === 'melody'), false);
    const harmonyReference = buildArrangement(anchors(), chosen, metadata({ canHarmonize: true }));
    assert.equal(result.key, harmonyReference.key, 'harmony follows confirmed anchors rather than unreliable notes');
    const rhythmReference = buildArrangement(input.notes, chosen, metadata({ canHarmonize: true }));
    assert.deepEqual(result.events.filter(event => event.instrument === 'Drums'), rhythmReference.events.filter(event => event.instrument === 'Drums'));
    assert.match(result.description, /only.*(?:clear|confirmed|anchor)|(?:clear|confirmed|anchor).*only/i);
    assert.equal(result.melodyProof.transcriptionVerified, false);
    assert.deepEqual(input, before);
  });
}

test('sustained blueprint backing is split at unsupported gaps and ending entries stay explicit', () => {
  const plan = blueprint([layer('piano', 'Piano', 'chords'), layer('violin', 'Violin', 'sustain', 'ending'), layer('drums', 'Drums', 'percussion', 'ending')]);
  const result = buildArrangement(analysis().notes, settings({ blueprint: plan }), metadata());
  assert.ok(pitched(result).length > 0);
  assert.ok(pitched(result).every(event => partial().harmonyRegions.some(region => within(event, region))));
  const violin = result.layers.find(item => item.id === 'violin');
  assert.equal(violin.section, 'ending');
  assert.equal(violin.blocked, true);
  assert.match(violin.reason, /no reliable.*anchor.*(?:section|ending)/i);
  assert.match(violin.reason, /full|cleaner/i);
  assert.equal(result.events.some(event => event.layerId === 'violin'), false);
  assert.equal(result.layers.find(item => item.id === 'drums').blocked, false);
  assert.ok(result.events.filter(event => event.layerId === 'drums').every(event => event.start >= 6));
});

test('invalid partial quality metadata cannot leak pitched backing into unsupported audio', () => {
  for (const quality of [{ ...partial(), harmonyRegions: [] }, { ...partial(), harmonyNotes: [] },
    { ...partial(), harmonyRegions: [{ start: 0, duration: 8 }] }]) {
    const result = buildArrangement(analysis().notes, settings(), metadata(quality));
    assert.deepEqual(pitched(result), []);
  }
});
