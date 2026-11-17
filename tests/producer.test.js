import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretDirection } from '../src/producer/producer.js';
import { buildArrangement } from '../src/music/arrangement.js';

const settings = { bpm: 90, sourceBpm: 90, instrument: 'Piano', mood: 'Dreamy', genre: 'Ambient', accompaniment: true, percussion: false };

test('proposes supported creative settings without changing the current settings', () => {
  const current = { ...settings };
  const result = interpretDirection('Make it cinematic with strings, electronic, and add drums at 112 bpm.', current);
  assert.deepEqual(result.changes, { mood: 'Cinematic', instrument: 'Strings', genre: 'Electronic', percussion: true, bpm: 112 });
  assert.deepEqual(current, settings);
  assert.match(result.message, /propos|suggest|apply/i);
  assert.doesNotMatch(result.message, /\b(applied|trained|generated|uploaded)\b/i);
});

test('all supported moods, instruments and genres produce actual settings', () => {
  for (const [request, changes] of [
    ['dreamy', { mood: 'Dreamy' }],
    ['melancholic', { mood: 'Melancholic' }],
    ['energetic', { mood: 'Energetic' }],
    ['peaceful', { mood: 'Peaceful' }],
    ['use piano', { instrument: 'Piano' }],
    ['use synth', { instrument: 'Synthesizer' }],
    ['use synthesizer', { instrument: 'Synthesizer' }],
    ['use bass', { instrument: 'Bass' }],
    ['ambient', { genre: 'Ambient' }],
    ['classical', { genre: 'Classical' }],
    ['pop', { genre: 'Pop' }],
    ['experimental', { genre: 'Experimental' }],
    ['add percussion', { percussion: true }],
  ]) assert.deepEqual(interpretDirection(request, settings).changes, changes, request);
});

test('relative tempo requests respect current tempo and musical bounds', () => {
  assert.equal(interpretDirection('slower please', settings).changes.bpm, 80);
  assert.equal(interpretDirection('faster please', settings).changes.bpm, 100);
  assert.equal(interpretDirection('much faster', { ...settings, bpm: 198 }).changes.bpm, 200);
  assert.equal(interpretDirection('slower', { ...settings, bpm: 41 }).changes.bpm, 40);
  assert.equal(interpretDirection('tempo 240', settings).changes.bpm, 200);
  assert.equal(interpretDirection('28 BPM', settings).changes.bpm, 40);
  assert.equal(interpretDirection('set BPM to 123', settings).changes.bpm, 123);
  assert.equal(interpretDirection('tempo 96.5', settings).changes.bpm, 97);
});

test('negative directions remove musical layers without selecting forbidden sounds', () => {
  assert.deepEqual(interpretDirection('No drums, without piano, less energetic', settings).changes, { percussion: false, mood: 'Peaceful' });
  assert.deepEqual(interpretDirection('remove accompaniment', settings).changes, { accompaniment: false });
  assert.deepEqual(interpretDirection('without percussion and no accompaniment', settings).changes, { percussion: false, accompaniment: false });
  assert.deepEqual(interpretDirection('not cinematic; no synth; not pop', settings).changes, {});
  assert.deepEqual(interpretDirection("don't add drums", settings).changes, { percussion: false });
  assert.deepEqual(interpretDirection('no piano, use strings', settings).changes, { instrument: 'Strings' });
});

test('adding chords enables the supported accompaniment layer', () => {
  assert.deepEqual(interpretDirection('give it a chord progression', settings).changes, { accompaniment: true });
  assert.deepEqual(interpretDirection('add accompaniment', settings).changes, { accompaniment: true });
  assert.deepEqual(interpretDirection('no chord progression', settings).changes, { accompaniment: false });
});

test('piano accompaniment requests select actual piano backing and explain the lead', () => {
  for (const text of ['Add piano accompaniment', 'Add piano chords']) {
    const result = interpretDirection(text, settings);
    assert.deepEqual(result.changes, { instrument: 'Piano', accompaniment: true, genre: 'Classical' });
    const arrangement = buildArrangement([{ midi: 60, start: 0, duration: 2 }], { ...settings, ...result.changes });
    assert.ok(arrangement.events.some((event) => event.track === 'chords' && event.instrument === 'Piano'));
    assert.ok(arrangement.events.filter((event) => event.track === 'chords').every((event) => event.instrument === 'Piano'));
    assert.match(result.message, /piano lead|piano.*captured melody/i);
    assert.match(result.message, /piano.*(backing|arpeggio)/i);
  }
});

test('piano backing inference respects explicit genre choices and negative requests', () => {
  assert.deepEqual(interpretDirection('Add piano accompaniment in ambient', settings).changes, { instrument: 'Piano', accompaniment: true, genre: 'Ambient' });
  assert.match(interpretDirection('Add piano accompaniment in ambient', settings).message, /string backing/i);
  assert.deepEqual(interpretDirection('electronic, add piano chords', settings).changes, { genre: 'Electronic', instrument: 'Piano', accompaniment: true });
  assert.deepEqual(interpretDirection('without piano accompaniment', settings).changes, { accompaniment: false });
  assert.deepEqual(interpretDirection('Add piano accompaniment, not classical', settings).changes, { instrument: 'Piano', accompaniment: true });
  assert.deepEqual(interpretDirection('Use piano, remove accompaniment', settings).changes, { instrument: 'Piano', accompaniment: false });
});

test('direction explanations describe the implemented mood, lead and tempo behavior', () => {
  for (const [text, explanation] of [
    ['dreamy', /echo.*soft|soft.*echo/i],
    ['cinematic', /fuller.*echo|echo.*fuller/i],
    ['energetic', /bright.*loud|loud.*bright/i],
    ['peaceful', /gentl|quiet/i],
    ['melancholic', /dark/i],
    ['use strings', /strings.*(lead|captured melody)/i],
    ['slower', /80 BPM.*slower.*pitch/i],
    ['faster', /100 BPM.*faster.*pitch/i],
  ]) {
    const result = interpretDirection(text, settings);
    assert.match(result.message, explanation, text);
    assert.match(result.message, /propos|apply/i);
    assert.doesNotMatch(result.message, /\b(applied|trained|uploaded)\b/i);
  }
});

test('unrecognised requests stay honest and suggestions can be interpreted', () => {
  for (const request of ['train my AI voice', 'popular synthesizing screenshots', '', null, { text: 'drums' }]) {
    const result = interpretDirection(request, settings);
    assert.deepEqual(result.changes, {}, String(request));
    assert.match(result.message, /rule|support|recogniz|understand/i);
    assert.doesNotMatch(result.message, /\b(applied|trained|generated|uploaded)\b/i);
    assert.ok(result.suggestions.length > 0);
    for (const suggestion of result.suggestions) {
      assert.equal(typeof suggestion, 'string');
      assert.ok(Object.keys(interpretDirection(suggestion, settings).changes).length > 0, suggestion);
    }
  }
});

test('words containing recognised words do not cause accidental changes', () => {
  assert.deepEqual(interpretDirection('pianola synthesize bassoon dreaminess drumming popularity', settings).changes, {});
});
