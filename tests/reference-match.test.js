import test from 'node:test';
import assert from 'node:assert/strict';
import { matchReference } from '../src/music/reference-match.js';

// An invented phrase: fixtures contain no transcription of the linked song.
const pitches = [60, 64, 62, 67, 65, 69, 62, 64, 71, 67, 65, 60];
const phrase = () => pitches.map((midi, index) => ({ midi, start: index * 0.5, duration: 0.45, confidence: 0.95 }));

function fixture() {
  const chroma = Array.from({ length: 220 }, () => Array(12).fill(0));
  pitches.forEach((pitch, index) => {
    for (let frame = 60 + index * 5; frame < 65 + index * 5; frame++) {
      const values = Array(12).fill(0.025);
      values[pitch % 12] = 1;
      values[(pitch + 7) % 12] = 0.18;
      const norm = Math.hypot(...values);
      chroma[frame] = values.map(value => value / norm);
    }
  });
  return { frameSeconds: 0.1, duration: 22, chroma };
}

test('matches the actual ordered phrase inside a longer reference', () => {
  const result = matchReference(phrase(), fixture());
  assert.equal(result.status, 'candidate');
  assert.ok(Math.abs(result.start - 6) <= 0.2);
  assert.ok(Math.abs(result.end - 12) <= 0.3);
  assert.equal(result.transpose, 0);
  assert.ok(result.similarity >= 0.8 && result.similarity <= 1);
});

test('matches a transposed, slower and octave-shifted hum', () => {
  const notes = phrase().map(note => ({ ...note, midi: note.midi + 14, start: note.start * 1.25 + 1.7, duration: note.duration * 1.25 }));
  const result = matchReference(notes, fixture());
  assert.equal(result.status, 'candidate');
  assert.equal(result.transpose, -2);
  assert.ok(Math.abs(result.start - 6) <= 0.3);
});

test('rejects silent, constant, short and overlapping evidence', () => {
  const cases = [[], phrase().map(note => ({ ...note, midi: 60 })), phrase().slice(0, 4), phrase().map(note => ({ ...note, confidence: 0.2 })), phrase().map(note => ({ ...note, start: 0 }))];
  for (const notes of cases) {
    const result = matchReference(notes, fixture());
    assert.equal(result.status, 'no-match');
    assert.equal(Object.hasOwn(result, 'start'), false);
  }
});

test('rejects reordered notes and unrelated invented melodies', () => {
  const reference = fixture();
  const reversed = phrase().map((note, index) => ({ ...note, midi: pitches[pitches.length - index - 1] }));
  assert.equal(matchReference(reversed, reference).status, 'no-match');
  let seed = 917;
  for (let trial = 0; trial < 30; trial++) {
    const notes = phrase().map(note => {
      seed = (seed * 16807) % 2147483647;
      return { ...note, midi: 60 + seed % 12 };
    });
    assert.equal(matchReference(notes, reference).status, 'no-match', `unrelated fixture ${trial}`);
  }
});

test('does not claim a match from a flat spectrum or static chord', () => {
  for (const values of [Array(12).fill(1 / Math.sqrt(12)), [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]]) {
    const reference = { frameSeconds: 0.1, duration: 22, chroma: Array.from({ length: 220 }, () => [...values]) };
    assert.equal(matchReference(phrase(), reference).status, 'no-match');
  }
});

test('rejects a static four-tone chord even when every query pitch belongs to it', () => {
  const chordPitches = [60, 64, 67, 71, 64, 60, 71, 67, 60, 64, 67, 71];
  const notes = chordPitches.map((midi, index) => ({ midi, start: index * 0.5, duration: 0.45 }));
  const chord = Array.from({ length: 12 }, (_, pitch) => [0, 4, 7, 11].includes(pitch) ? 0.5 : 0);
  const reference = { frameSeconds: 0.1, duration: 22, chroma: Array.from({ length: 220 }, () => [...chord]) };
  assert.equal(matchReference(notes, reference).status, 'no-match');
});

test('rejects a pulsing static chord whose silence follows the query rhythm', () => {
  const chordPitches = [60, 64, 67, 71, 64, 60, 71, 67, 60, 64, 67, 71];
  const notes = chordPitches.map((midi, index) => ({ midi, start: index * 0.5, duration: 0.3 }));
  const chroma = Array.from({ length: 220 }, (_, frame) => Array.from({ length: 12 }, (_, pitch) =>
    frame >= 60 && frame < 120 && (frame - 60) % 5 < 3 && [0, 4, 7, 11].includes(pitch) ? 0.5 : 0));
  assert.equal(matchReference(notes, { frameSeconds: 0.1, duration: 22, chroma }).status, 'no-match');
});

test('rejects over-budget searches before inspecting reference spectra', () => {
  const notes = Array.from({ length: 96 }, (_, index) => ({ midi: pitches[index % 12], start: index * 0.3, duration: 0.27 }));
  const reference = { frameSeconds: 0.05, duration: 600, chroma: Array(12000).fill(Array(12).fill(0)) };
  const result = matchReference(notes, reference);
  assert.equal(result.status, 'no-match');
  assert.match(result.reason, /shorten/i);
});

test('asks for a shorter phrase when capture spans more than thirty seconds', () => {
  const notes = phrase().map(note => ({ ...note, start: note.start * 6, duration: note.duration * 6 }));
  const result = matchReference(notes, fixture());
  assert.equal(result.status, 'no-match');
  assert.match(result.reason, /30/);
});

test('invalid reference metadata and spectral frames cannot produce a candidate or throw', () => {
  const valid = fixture();
  for (const reference of [
    { ...valid, duration: undefined }, { ...valid, duration: NaN }, { ...valid, duration: 0 },
    { ...valid, frameSeconds: Infinity }, { ...valid, frameSeconds: '0.1' },
    { ...valid, chroma: valid.chroma.map(() => null) },
    { ...valid, chroma: valid.chroma.map(() => Array(12).fill(Infinity)) },
    { ...valid, chroma: valid.chroma.map(() => [1, 0]) },
    { ...valid, duration: 1 },
  ]) {
    assert.equal(matchReference(phrase(), reference).status, 'no-match');
  }
});

test('nonfinite confidence cannot count as clear reference-match evidence', () => {
  assert.equal(matchReference(phrase().map(note => ({ ...note, confidence: Infinity })), fixture()).status, 'no-match');
});
