import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMelody } from '../src/music/melody-profile.js';

const note = (midi, start, duration = 0.3) => ({ midi, start, duration });

test('an empty melody supplies no invented tempo, phrase or pitch evidence', () => {
  assert.deepEqual(describeMelody([]), {
    duration: 0, noteCount: 0, pitchRange: { min: null, max: null, semitones: 0 }, register: 'mid',
    rhythm: { estimatedBpm: null, confidence: 0, density: 0, syncopation: 0 },
    character: { motion: 'static', energy: 'low' }, phrases: [],
  });
});

test('measured melody evidence and rest-defined phrases do not alter source notes or contours', () => {
  const notes = [note(62, 0.2), note(64, 0.7), note(67, 1.2), note(65, 3)];
  notes[0].contour = [{ time: 0, frequency: 293 }, { time: 0.3, frequency: 295 }];
  const before = structuredClone(notes);
  const profile = describeMelody(notes);
  assert.deepEqual(notes, before);
  assert.equal(profile.duration, 3.3);
  assert.equal(profile.noteCount, 4);
  assert.deepEqual(profile.pitchRange, { min: 62, max: 67, semitones: 5 });
  assert.equal(profile.register, 'mid');
  assert.deepEqual(profile.phrases, [
    { start: 0.2, end: 1.5, noteStart: 0, noteEnd: 3 },
    { start: 3, end: 3.3, noteStart: 3, noteEnd: 4 },
  ]);
});

test('steady unfamiliar notes yield a tempo suggestion with explicit beat ambiguity', () => {
  const notes = Array.from({ length: 9 }, (_, i) => note([63, 67, 62, 70, 65, 61, 66, 72, 68][i], 0.17 + i * 0.5));
  const profile = describeMelody(notes);
  assert.equal(profile.rhythm.estimatedBpm, 120);
  assert.ok(profile.rhythm.confidence >= 0.3 && profile.rhythm.confidence <= 0.7);
  assert.ok(profile.rhythm.density > 1.9);
});

test('sparse and strongly irregular onset evidence does not claim a reliable tempo', () => {
  for (const notes of [[note(60, 0.2)], [note(60, 0), note(70, 0.3), note(66, 0.6)],
    [0, 0.37, 0.99, 1.83, 2.06, 3.31].map((start, i) => note(58 + i, start, 0.12))]) {
    const rhythm = describeMelody(notes).rhythm;
    assert.equal(rhythm.estimatedBpm, null);
    assert.equal(rhythm.confidence, 0);
  }
});

test('fresh rhythmic evidence distinguishes a sparse static phrase from a dense leaping phrase', () => {
  const sparse = describeMelody([note(55, 0, 1.1), note(55, 1.4, 1.1), note(55, 2.8, 1.1)]);
  const dense = describeMelody(Array.from({ length: 10 }, (_, i) => note(i % 2 ? 77 : 58, i * 0.18, 0.14)));
  assert.equal(sparse.character.motion, 'static');
  assert.equal(sparse.character.energy, 'low');
  assert.equal(dense.character.motion, 'leaping');
  assert.equal(dense.character.energy, 'high');
  assert.ok(dense.rhythm.density > sparse.rhythm.density * 4);
});

test('register follows sung duration rather than a single high or low outlier', () => {
  const notes = [note(48, 0, 2), note(84, 2.2, 0.1), note(82, 2.4, 0.1)];
  assert.equal(describeMelody(notes).register, 'low');
  assert.equal(describeMelody([note(78, 0, 2), note(48, 2.2, 0.1)]).register, 'high');
});

test('an isolated short note does not claim high musical energy or nonfinite density', () => {
  for (const notes of [[note(60, 0, 0.05)], [note(60, 600, Number.MIN_VALUE)]]) {
    const profile = describeMelody(notes);
    assert.equal(profile.character.energy, 'low');
    assert.ok(Number.isFinite(profile.rhythm.density));
  }
});

test('a varied subdivision phrase retains its exact unquantized timing while descriptors remain bounded', () => {
  const notes = [0.13, 0.63, 0.88, 1.255, 1.38, 2.13, 2.63, 2.88, 3.255]
    .map((start, i) => note([64, 61, 68, 65, 70, 62, 67, 60, 66][i], start, 0.09));
  const before = JSON.stringify(notes);
  const profile = describeMelody(notes);
  assert.equal(JSON.stringify(notes), before);
  assert.ok(profile.rhythm.confidence >= 0 && profile.rhythm.confidence <= 1);
  assert.ok(profile.rhythm.syncopation >= 0 && profile.rhythm.syncopation <= 1);
  assert.ok(profile.phrases.every(phrase => phrase.noteEnd > phrase.noteStart));
});

test('invalid source notes are rejected rather than silently filtered or reordered for profiling', () => {
  assert.throws(() => describeMelody([note(60, 1), note(62, 0)]), /order|chronological/i);
  assert.throws(() => describeMelody([note(128, 0)]), /pitch|MIDI/i);
});
