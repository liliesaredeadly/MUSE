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

test('explicit tempo-transform mode halves melody positions and duration when BPM doubles', () => {
  const result = buildArrangement(melody, { ...settings, bpm: 180, preserveMelodyTiming: false });
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

test('empty input cannot create a backing composition', () => {
  for (const notes of [[], null]) {
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

test('invalid source notes are rejected together instead of silently removing notes', () => {
  for (const invalid of [null, { midi: NaN, start: 0, duration: 1 }, { midi: 60, start: -1, duration: 1 },
    { midi: 70, start: 0, duration: 0 }, { midi: 200, start: 0, duration: 1 },
    { midi: 60, start: Number.MAX_VALUE, duration: Number.MAX_VALUE }]) {
    assert.throws(() => buildArrangement([melody[0], invalid], settings), /note|melody|timing/i);
  }
});

test('tempo and backing changes preserve leading rests, repeated notes, short gates and pitch contour by default', () => {
  const source = [
    { midi: 69, name: 'A4', start: 0.37, duration: 0.08, confidence: 0.92, contour: [{ time: 0, frequency: 435 }, { time: 0.04, frequency: 444 }] },
    { midi: 69, name: 'A4', start: 0.48, duration: 0.12, confidence: 0.87, contour: [{ time: 0.01, frequency: 443 }, { time: 0.1, frequency: 437 }] },
    { midi: 67, name: 'G4', start: 0.73, duration: 0.19, confidence: 0.91 },
  ];
  const before = structuredClone(source);
  const slow = buildArrangement(source, { ...settings, bpm: 60, accompaniment: true, genre: 'Electronic', percussion: true });
  const fast = buildArrangement(source, { ...settings, bpm: 180, accompaniment: true, genre: 'Electronic', percussion: true });
  for (const result of [slow, fast]) {
    const lead = result.events.filter(event => event.track === 'melody');
    assert.deepEqual(lead.map(({ midi, name, start, duration, confidence, contour }) => ({ midi, name, start, duration, confidence, ...(contour ? { contour } : {}) })), before);
    assert.ok(Math.abs(result.duration - 0.92) < 1e-9);
    assert.equal(result.settings.preserveMelodyTiming, true);
    assert.equal(result.melodyProof.engine, 'strict-note-conditioned');
    assert.equal(result.melodyProof.timingPreserved, true);
    assert.equal(result.melodyProof.noteCount, 3);
    assert.equal(result.melodyProof.contourPointCount, 4);
    assert.notEqual(lead[0].contour, source[0].contour);
  }
  assert.notDeepEqual(slow.events.filter(event => event.track !== 'melody'), fast.events.filter(event => event.track !== 'melody'));
  fast.events.find(event => event.track === 'melody').contour[0].frequency = 999;
  assert.deepEqual(source, before);
});

test('explicit tempo transformation scales relative contour time with the note gate', () => {
  const result = buildArrangement([{ midi: 69, start: 0.4, duration: 0.2, contour: [{ time: 0.1, frequency: 442 }] }], { ...settings, bpm: 180, preserveMelodyTiming: false });
  assert.equal(result.events[0].start, 0.2);
  assert.equal(result.events[0].duration, 0.1);
  assert.deepEqual(result.events[0].contour, [{ time: 0.05, frequency: 442 }]);
  assert.equal(result.melodyProof.timingPreserved, false);
});

test('unsorted source order is rejected instead of rearranging the original phrase', () => {
  assert.throws(() => buildArrangement([melody[1], melody[0]], settings), /order|chronolog/i);
});

test('malformed contour is rejected before a preservation claim can be made', () => {
  for (const contour of [null, [{ time: 0.1, frequency: 0 }], [{ time: 0.6, frequency: 440 }], [{ time: 0.2, frequency: 440 }, { time: 0.1, frequency: 441 }]]) {
    assert.throws(() => buildArrangement([{ ...melody[0], contour }], settings), /contour/i);
  }
});

test('bass can be suppressed independently while chords and the exact melody remain', () => {
  const arrangement = buildArrangement(melody, { ...settings, accompaniment: true, bass: false });
  assert.ok(arrangement.events.some(event => event.track === 'chords'));
  assert.equal(arrangement.events.some(event => event.track === 'bass'), false);
  assert.equal(arrangement.settings.bass, false);
  assert.equal(arrangement.melodyProof.preserved, true);
});

test('malformed boolean settings cannot accidentally turn percussion on', () => {
  const arrangement = buildArrangement(melody, { ...settings, accompaniment: 0, percussion: 'false' });
  assert.equal(arrangement.settings.accompaniment, true);
  assert.equal(arrangement.settings.percussion, false);
  assert.equal(arrangement.events.some(event => event.track === 'percussion'), false);
});
