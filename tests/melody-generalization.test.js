import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMelody } from '../src/audio/melody-analysis.js';
import { describeMelody } from '../src/music/melody-profile.js';
import { makeHum } from './fixtures/hum-fixtures.js';

// Independent, repeatable unfamiliar melodies: generated from numeric seeds,
// without reference audio, song names, song-note data or detector-derived truth.
function unfamiliarPhrase(seed, { low = 43, high = 82, vibrato = 0 } = {}) {
  let time = 0.13;
  const notes = [];
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let index = 0; index < 9; index++) {
    const midi = low + next() % (high - low + 1);
    const duration = [0.12, 0.18, 0.24, 0.3][next() >>> 24 & 3];
    notes.push({ midi, start: time, duration, vibrato });
    time += duration + [0.04, 0.07, 0.13, 0.29][next() >>> 24 & 3];
  }
  return notes;
}

function compareRecognized(result, expected) {
  assert.deepEqual(result.notes.map(note => note.midi), expected.map(note => note.midi));
  for (const [index, actual] of result.notes.entries()) {
    const truth = expected[index];
    assert.ok(Math.abs(actual.start - truth.start) <= 0.03 + 1e-8, `onset ${index}: ${actual.start} vs ${truth.start}`);
    assert.ok(Math.abs(actual.start + actual.duration - truth.start - truth.duration) <= 0.03 + 1e-8, `offset ${index}`);
    assert.ok(actual.contour.length >= 2);
  }
  const profile = describeMelody(result.notes);
  assert.equal(profile.noteCount, expected.length);
  assert.ok(profile.pitchRange.semitones > 0);
  assert.ok(profile.rhythm.confidence >= 0 && profile.rhythm.confidence <= 1);
}

for (const [seed, sampleRate, harmonics] of [
  [17, 8000, [1, 0.3, 0.12]],
  [73, 16000, [1]],
  [109, 22050, [0.18, 1, 0.45, 0.12]],
  [2027, 44100, [1, 0.3, 0.12]],
  [6449, 48000, [1, 0.3, 0.12]],
  [982451653, 96000, [1]],
]) {
  test(`unfamiliar seeded PCM melody ${seed} is recognized at ${sampleRate} Hz without song references`, () => {
    const notes = unfamiliarPhrase(seed, { vibrato: seed === 6449 ? 18 : 0 });
    const fixture = makeHum(notes, { sampleRate, harmonics, amplitude: 0.05 });
    const result = analyzeMelody(fixture.samples, fixture.sampleRate);
    compareRecognized(result, notes);
  });
}

test('unfamiliar low/high register jumps preserve pitch and rhythm across the supported singing range', () => {
  const notes = [36, 88, 41, 85, 49, 78, 38, 87].map((midi, index) => ({ midi, start: 0.17 + index * 0.39, duration: 0.27 }));
  compareRecognized(analyzeMelody(makeHum(notes, { sampleRate: 48000 }).samples, 48000), notes);
});

test('rubato and a long phrase break remain measured musical structure rather than a forced pop rhythm', () => {
  const notes = [
    { midi: 59, start: 0.23, duration: 0.42 },
    { midi: 66, start: 0.78, duration: 0.24 },
    { midi: 61, start: 1.19, duration: 0.31 },
    { midi: 68, start: 2.31, duration: 0.37 },
    { midi: 63, start: 2.84, duration: 0.29 },
  ];
  const fixture = makeHum(notes, { sampleRate: 48000, amplitude: 0.015, breath: 0.0005, seed: 881 });
  const result = analyzeMelody(fixture.samples, fixture.sampleRate);
  compareRecognized(result, notes);
  const profile = describeMelody(result.notes);
  assert.equal(profile.phrases.length, 2);
  assert.ok(profile.phrases[1].start - profile.phrases[0].end > 0.7);
});
