import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArrangement } from '../src/music/arrangement.js';

const melody = [
  { midi: 60, name: 'C4', start: 0.25, duration: 0.5, confidence: 0.95 },
  { midi: 64, name: 'E4', start: 1, duration: 0.75, confidence: 0.9 },
  { midi: 67, name: 'G4', start: 2, duration: 1, confidence: 0.9 },
];
const settings = { bpm: 90, sourceBpm: 90, instrument: 'Piano', mood: 'Dreamy', genre: 'Ambient', accompaniment: false, percussion: false };

test('captured pitches and exact phrase timing survive arrangement without invented melody', () => {
  const result = buildArrangement(melody, settings);
  assert.deepEqual(result.events.map(({ midi, start, duration, track }) => ({ midi, start, duration, track })), [
    { midi: 60, start: 0.25, duration: 0.5, track: 'melody' },
    { midi: 64, start: 1, duration: 0.75, track: 'melody' },
    { midi: 67, start: 2, duration: 1, track: 'melody' },
  ]);
  assert.equal(result.duration, 3);
  assert.equal(melody[0].start, 0.25);
});

test('doubling BPM halves melody positions and duration', () => {
  const result = buildArrangement(melody, { ...settings, bpm: 180 });
  assert.equal(result.bpm, 180);
  assert.equal(result.duration, 1.5);
  assert.deepEqual(result.events.map(event => [event.start, event.duration]), [[0.125, 0.25], [0.5, 0.375], [1, 0.5]]);
});

test('chord labels have time spans and accompaniment harmonizes with the captured phrase', () => {
  const result = buildArrangement(melody, { ...settings, accompaniment: true });
  assert.match(result.key, /C major.*estimate/i);
  assert.equal(result.chords[0].name, 'C');
  assert.equal(result.chords[0].start, 0);
  assert.ok(result.chords.every(chord => chord.duration > 0 && chord.notes.length >= 3));
  assert.ok(result.events.some(event => event.track === 'chords'));
  assert.deepEqual(result.events.filter(event => event.track === 'melody').map(event => event.midi), [60, 64, 67]);
  assert.ok(result.events.every(event => event.start >= 0 && event.start + event.duration <= result.duration + 0.00001));
});

test('empty and wholly invalid input cannot create a backing composition', () => {
  for (const notes of [[], null, [null, { midi: NaN, start: 0, duration: 1 }, { midi: 60, start: -1, duration: 1 }, { midi: 70, start: 0, duration: 0 }, { midi: 200, start: 0, duration: 1 }]]) {
    const result = buildArrangement(notes, { ...settings, accompaniment: true, percussion: true });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.chords, []);
    assert.equal(result.duration, 0);
    assert.match(result.key, /undetermined/i);
  }
});

test('instrument and mood controls change audible event parameters without changing pitches', () => {
  const piano = buildArrangement(melody, settings);
  const strings = buildArrangement(melody, { ...settings, instrument: 'Strings', mood: 'Energetic' });
  assert.equal(strings.events[0].instrument, 'Strings');
  assert.notEqual(piano.events[0].velocity, strings.events[0].velocity);
  assert.deepEqual(strings.events.map(event => event.midi), [60, 64, 67]);
});

test('genre controls alter backing rhythm and percussion toggle creates actual drum events', () => {
  const ambient = buildArrangement(melody, { ...settings, accompaniment: true });
  const electronic = buildArrangement(melody, { ...settings, accompaniment: true, genre: 'Electronic', percussion: true });
  assert.ok(electronic.events.some(event => event.track === 'percussion' && event.instrument === 'Drums'));
  assert.notDeepEqual(ambient.events.filter(event => event.track !== 'melody'), electronic.events.filter(event => event.track !== 'melody'));
});

test('drum instrument retains pitched melody and adds percussion', () => {
  const result = buildArrangement(melody, { ...settings, instrument: 'Drums' });
  assert.deepEqual(result.events.filter(event => event.track === 'melody').map(event => event.midi), [60, 64, 67]);
  assert.equal(result.events.find(event => event.track === 'melody').instrument, 'Synthesizer');
  assert.ok(result.events.some(event => event.track === 'percussion'));
  assert.match(result.description, /pitched melody/i);
});

test('malformed settings fall back to safe timing and recognized instrument', () => {
  const result = buildArrangement(melody, { bpm: 0, sourceBpm: NaN, instrument: 'Unknown' });
  assert.equal(result.bpm, 90);
  assert.equal(result.duration, 3);
  assert.equal(result.events.find(event => event.track === 'melody').instrument, 'Piano');
});

test('unbounded time values cannot create an infinite accompaniment loop', () => {
  const result = buildArrangement([{ midi: 60, start: Number.MAX_VALUE, duration: Number.MAX_VALUE }], { ...settings, accompaniment: false });
  assert.deepEqual(result.events, []);
  assert.equal(result.duration, 0);
});
