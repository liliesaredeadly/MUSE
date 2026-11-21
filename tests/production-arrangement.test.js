import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArrangement } from '../src/music/arrangement.js';
import { assertMelodyPreserved } from '../src/music/melody-contract.js';

const settings = { bpm: 112, sourceBpm: 90, instrument: 'Piano', mood: 'Energetic', genre: 'Pop', accompaniment: true, bass: true, percussion: true };
function unfamiliar(seed, count = 12) {
  let start = 0.23;
  return Array.from({ length: count }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const midi = 51 + seed % 25;
    const duration = [0.16, 0.27, 0.42, 0.61][seed >>> 8 & 3];
    const note = { midi, start, duration, contour: [{ time: 0, frequency: 440 * 2 ** ((midi - 69) / 12) }, { time: duration * 0.7, frequency: 440 * 2 ** ((midi - 69) / 12) * 1.002 }] };
    start += duration + (i % 5 === 4 ? 0.58 : 0.07);
    return note;
  });
}

test('both original pop production modes preserve unfamiliar melodies without reference lookup', () => {
  for (const seed of [3, 41, 173, 2027, 8191, 65537]) {
    const notes = unfamiliar(seed); const original = structuredClone(notes);
    for (const production of ['auto', 'dance-pop', 'percussive-pop']) {
      const result = buildArrangement(notes, { ...settings, production });
      assertMelodyPreserved(notes, result);
      assert.equal(result.production.style, production === 'auto' ? 'percussive-pop' : production);
      assert.equal(result.melodyCharacter.noteCount, notes.length);
      assert.deepEqual(notes, original);
      assert.ok(result.events.length < 20000);
      assert.ok(result.events.every(event => Number.isFinite(event.velocity) && event.start >= 0 && event.start + event.duration <= result.duration + 1e-8));
    }
  }
});

test('dance and percussive pop create distinct grooves and articulation around the same melody', () => {
  const notes = unfamiliar(19, 28);
  const dance = buildArrangement(notes, { ...settings, production: 'dance-pop' });
  const sparse = buildArrangement(notes, { ...settings, production: 'percussive-pop' });
  assert.notDeepEqual(dance.events.filter(e => e.track === 'percussion'), sparse.events.filter(e => e.track === 'percussion'));
  assert.ok(sparse.events.some(e => e.track === 'chords' && e.timbre === 'pluck'));
  assert.ok(dance.structure.length > 1);
  assert.ok(new Set(dance.structure.map(part => part.intensity)).size > 1);
  for (const result of [dance, sparse]) {
    assert.ok(result.events.filter(e => e.track !== 'melody').every(e => e.start >= notes[0].start));
    assert.equal(result.duration, notes.at(-1).start + notes.at(-1).duration);
  }
});

test('profiles obey explicit instrument restrictions, layer exclusions and silence', () => {
  const notes = unfamiliar(331);
  const solo = buildArrangement(notes, { ...settings, production: 'dance-pop', accompaniment: false, percussion: false });
  assert.ok(solo.events.every(e => e.track === 'melody'));
  const noBass = buildArrangement(notes, { ...settings, production: 'percussive-pop', bass: false });
  assert.equal(noBass.events.some(e => e.instrument === 'Bass'), false);
  const quiet = buildArrangement([], { ...settings, production: 'dance-pop' });
  assert.deepEqual(quiet.events, []);
});

test('auto production honors non-pop genres and the supported instrument set', () => {
  const notes = unfamiliar(777);
  for (const [genre, instrument] of [['Ambient', 'Strings'], ['Classical', 'Piano'], ['Pop', 'Piano']]) {
    const result = buildArrangement(notes, { ...settings, production: 'auto', genre, bass: false, percussion: false });
    assert.ok(result.events.filter(e => e.track === 'chords').every(e => e.instrument === instrument));
    assertMelodyPreserved(notes, result);
  }
});

test('backing register and density respond to the input rather than a stored hook', () => {
  const slow = Array.from({ length: 8 }, (_, i) => ({ midi: 48 + i % 3 * 2, start: 0.2 + i, duration: 0.8 }));
  const high = slow.map(note => ({ ...note, midi: note.midi + 36 }));
  const dense = Array.from({ length: 36 }, (_, i) => ({ midi: 60 + i % 7, start: 0.2 + i * 0.2, duration: 0.16 }));
  const build = notes => buildArrangement(notes, { ...settings, production: 'percussive-pop' });
  const lowResult = build(slow); const highResult = build(high); const denseResult = build(dense);
  const chordPitches = result => result.events.filter(e => e.track === 'chords').map(e => e.midi);
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(chordPitches(lowResult)) > mean(chordPitches(highResult)), 'low leads need space below a higher chord texture');
  assert.ok(chordPitches(denseResult).length / denseResult.duration < chordPitches(highResult).length / highResult.duration, 'busy leads need fewer competing chord attacks');
});

test('measured phrase breaks are reflected in backing development metadata', () => {
  const notes = [0.2, 0.7, 1.2, 1.7, 4.2, 4.7, 5.2, 5.7, 8.2, 8.7, 9.2, 9.7]
    .map((start, i) => ({ midi: 60 + i % 5, start, duration: 0.3 }));
  const result = buildArrangement(notes, { ...settings, bpm: 120, production: 'dance-pop' });
  assert.equal(result.melodyCharacter.phrases.length, 3);
  assert.ok(new Set(result.structure.map(part => part.phrase)).size >= 3);
});

test('low-register melodies keep bass in an audible useful range', () => {
  const result = buildArrangement([{ midi: 45, start: 0.2, duration: 8 }], { ...settings, production: 'percussive-pop' });
  const bass = result.events.filter(event => event.track === 'bass');
  assert.ok(bass.length > 0);
  assert.ok(bass.every(event => event.midi >= 32 && event.midi <= 47));
});
