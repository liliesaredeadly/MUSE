import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArrangement } from '../src/music/arrangement.js';

const notes = [
  { midi: 60, start: 0.3, duration: 0.4, confidence: 0.95 },
  { midi: 64, start: 1, duration: 0.3, confidence: 0.95 },
  { midi: 67, start: 1.6, duration: 0.4, confidence: 0.95 },
];
const settings = { leadSource: 'recording', production: 'dance-pop', genre: 'Electronic', bpm: 130,
  sourceBpm: 90, accompaniment: true, bass: true, percussion: true, preserveMelodyTiming: false };
const source = (quality = { canHarmonize: true }) => ({ duration: 8, sha256: 'a'.repeat(64), quality });

test('recording mode retains the full waveform clock without synthesizing or doubling its extracted melody', () => {
  const result = buildArrangement(notes, settings, source());
  assert.equal(result.duration, 8);
  assert.deepEqual(result.recordingLead, { duration: 8, sha256: 'a'.repeat(64) });
  assert.equal(result.settings.leadSource, 'recording');
  assert.equal(result.settings.preserveMelodyTiming, true);
  assert.equal(result.events.some(event => event.track === 'melody'), false);
  assert.equal(result.melodyProof.engine, 'original-waveform');
  assert.equal(result.melodyProof.transcriptionVerified, false);
  assert.ok(result.events.every(event => event.start + event.duration <= 8 + 1e-8));
});

test('unreliable pitch evidence cannot create wrong chords or bass around the original hum', () => {
  for (const production of ['auto', 'dance-pop', 'percussive-pop']) {
    const result = buildArrangement(notes, { ...settings, production }, source({ canHarmonize: false }));
    assert.deepEqual(result.chords, []);
    assert.ok(result.events.length > 0);
    assert.ok(result.events.every(event => event.track === 'percussion' && event.instrument === 'Drums'));
    assert.equal(result.duration, 8);
    assert.match(result.description, /original|recording/i);
  }
});

test('a real recording with no detected notes still supports its original waveform and requested unpitched groove', () => {
  for (const production of ['auto', 'dance-pop', 'percussive-pop']) {
    const result = buildArrangement([], { ...settings, production }, source({ canHarmonize: false }));
    assert.equal(result.duration, 8);
    assert.equal(result.recordingLead.sha256, 'a'.repeat(64));
    assert.deepEqual(result.chords, []);
    assert.ok(result.events.every(event => event.instrument === 'Drums'));
    const solo = buildArrangement([], { ...settings, production, percussion: false }, source({ canHarmonize: false }));
    assert.deepEqual(solo.events, []);
    assert.equal(solo.recordingLead.duration, 8);
  }
});

test('recording mode cannot invent a missing source or accept a contradictory source clock', () => {
  for (const meta of [undefined, {}, { ...source(), sha256: 'unverified' }, { ...source(), duration: 0 },
    { ...source(), duration: 60.01 }, { ...source(), duration: 1 }]) {
    assert.throws(() => buildArrangement(notes, settings, meta), /source|record|clock|duration/i);
  }
});

test('existing note-only compositions retain the strict instrument path', () => {
  const result = buildArrangement(notes, { bpm: 90, accompaniment: false, percussion: false });
  assert.equal(result.settings.leadSource, 'instrument');
  assert.equal(result.events.filter(event => event.track === 'melody').length, notes.length);
  assert.equal(result.recordingLead, undefined);
  assert.equal(result.melodyProof.engine, 'strict-note-conditioned');
});
