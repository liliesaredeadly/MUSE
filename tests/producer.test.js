import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretDirection } from '../src/producer/producer.js';
import { buildArrangement } from '../src/music/arrangement.js';

const settings = { bpm: 90, sourceBpm: 90, instrument: 'Piano', mood: 'Dreamy', genre: 'Ambient', accompaniment: true, percussion: false };

test('instrument preferences keep the recorded hum as the stated lead without claiming voice conversion', () => {
  const current = { ...settings, leadSource: 'recording' };
  for (const text of ['Make it cinematic with strings', 'Add piano accompaniment']) {
    const result = interpretDirection(text, current);
    assert.deepEqual(result.changes, interpretDirection(text, settings).changes, 'The wording fix must not change proposed layers or settings.');
    assert.match(result.message, /original hum.*remain.*lead/i);
    assert.match(result.message, /instrumental preference/i);
    assert.doesNotMatch(result.message, /(?:strings|piano) lead for the captured melody/i);
    assert.equal(Object.hasOwn(result.changes, 'leadSource'), false);
  }
  assert.deepEqual(current, { ...settings, leadSource: 'recording' });
});

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

test('a later exclusion cancels a matching lead or mood proposal', () => {
  for (const [text, expected] of [
    ['Use piano, not piano', {}],
    ['Make it cinematic, not cinematic', {}],
    ['Use synth, avoid synthesizer', {}],
    ['Cinematic strings, not cinematic', { instrument: 'Strings' }],
    ['Use piano, not strings', { instrument: 'Piano' }],
    ['Make it cinematic, not dreamy', { mood: 'Cinematic' }],
    ['Use piano, not piano, use strings', { instrument: 'Strings' }],
  ]) assert.deepEqual(interpretDirection(text, settings).changes, expected, text);
});

test('removing drums also removes the rhythm implied by the Drums lead', () => {
  const current = { ...settings, instrument: 'Drums', percussion: true };
  const result = interpretDirection('Remove drums', current);
  const arrangement = buildArrangement([{ midi: 60, start: 0, duration: 2 }], { ...current, ...result.changes });
  assert.deepEqual(result.changes, { percussion: false, instrument: 'Synthesizer' });
  assert.ok(arrangement.events.some(event => event.track === 'melody' && event.midi === 60 && event.instrument === 'Synthesizer'));
  assert.equal(arrangement.events.some(event => event.track === 'percussion'), false);
  assert.equal(current.instrument, 'Drums');
  assert.deepEqual(interpretDirection('Remove drums, use piano', current).changes, { percussion: false, instrument: 'Piano' });
  assert.deepEqual(interpretDirection('Remove drums, add percussion', current).changes, { percussion: true });
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

test('only-piano directions actually remove strings, bass and percussion', () => {
  for (const text of ['only piano', 'use just piano', 'piano only']) {
    const result = interpretDirection(text, { ...settings, percussion: true });
    const arrangement = buildArrangement([{ midi: 60, start: 0, duration: 2 }], { ...settings, percussion: true, ...result.changes });
    assert.deepEqual([...new Set(arrangement.events.map(event => event.instrument))], ['Piano'], text);
    assert.match(result.message, /accompaniment off/i);
  }
});

test('piano and strings directions produce both requested sounds without automatic bass or drums', () => {
  for (const text of ['piano and strings', 'only piano and strings', 'strings and piano']) {
    const result = interpretDirection(text, { ...settings, percussion: true });
    const arrangement = buildArrangement([{ midi: 60, start: 0.25, duration: 2 }], { ...settings, percussion: true, ...result.changes });
    assert.deepEqual([...new Set(arrangement.events.map(event => event.instrument))].sort(), ['Piano', 'Strings'], text);
    assert.equal(arrangement.melodyProof.preserved, true);
    assert.equal(result.changes.bass, false);
  }
});

test('negative and contradictory restricted-instrument requests are not presented as supported pairs', () => {
  assert.deepEqual(interpretDirection('not only piano', settings).changes, {});
  assert.deepEqual(interpretDirection('piano and strings, no strings', settings).changes, {});
  assert.equal(interpretDirection('piano and strings, remove accompaniment', settings).changes.accompaniment, false);
  assert.notEqual(interpretDirection('piano and strings, not ambient', settings).changes.genre, 'Ambient');
});

test('explicitly removing bass suppresses automatic bass and a current Bass lead', () => {
  for (const instrument of ['Piano', 'Bass']) for (const text of ['remove bass', 'no bass']) {
    const current = { ...settings, instrument };
    const result = interpretDirection(text, current);
    const arrangement = buildArrangement([{ midi: 60, start: 0, duration: 2 }], { ...current, ...result.changes });
    assert.equal(result.changes.bass, false);
    assert.equal(arrangement.events.some(event => event.instrument === 'Bass'), false, `${text} with ${instrument} lead`);
    assert.equal(arrangement.melodyProof.preserved, true);
  }
});

test('piano and strings preserve compatible explicit backing genres and explain incompatible ones', () => {
  for (const genre of ['Pop', 'Classical', 'Experimental']) {
    const result = interpretDirection(`piano and strings in ${genre}`, settings);
    const arrangement = buildArrangement([{ midi: 60, start: 0, duration: 2 }], { ...settings, ...result.changes });
    assert.equal(result.changes.genre, genre);
    assert.deepEqual([...new Set(arrangement.events.map(event => event.instrument))].sort(), ['Piano', 'Strings']);
  }
  const electronic = interpretDirection('piano and strings electronic', settings);
  assert.match(electronic.message, /electronic.*synth|synth.*electronic/i);
  assert.match(electronic.message, /ambient.*both|both.*ambient/i);
});

test('restricted pitched sounds retain explicitly requested percussion', () => {
  for (const text of ['piano and strings, add drums', 'only piano, add percussion']) {
    const result = interpretDirection(text, settings);
    const arrangement = buildArrangement([{ midi: 60, start: 0, duration: 2 }], { ...settings, ...result.changes });
    assert.equal(result.changes.percussion, true, text);
    assert.ok(arrangement.events.some(event => event.track === 'percussion'), text);
  }
});

test('production benchmarks choose generic backing styles without changing the user melody clock', () => {
  for (const [text, production, genre] of [
    ['Use Beauty and a Beat production', 'dance-pop', 'Electronic'],
    ['a dance-pop arrangement', 'dance-pop', 'Electronic'],
    ['Shape of You production', 'percussive-pop', 'Pop'],
    ['tropical pop', 'percussive-pop', 'Pop'],
    ['deep rhythmic pop', 'percussive-pop', 'Pop'],
  ]) {
    const result = interpretDirection(text, settings);
    assert.equal(result.changes.production, production, text);
    assert.equal(result.changes.genre, genre, text);
    assert.equal(result.changes.accompaniment, true, text);
    assert.equal(result.changes.bass, true, text);
    assert.equal(result.changes.percussion, true, text);
    for (const key of ['bpm', 'sourceBpm', 'preserveMelodyTiming', 'notes']) assert.equal(Object.hasOwn(result.changes, key), false, key);
    assert.match(result.message, /production.*(only|traits)|original.*melody|your.*melody/i);
  }
});

test('production references respect explicit layer and instrument restrictions', () => {
  const result = interpretDirection('Shape of You production, no drums and no bass', settings);
  assert.equal(result.changes.production, 'percussive-pop');
  assert.equal(result.changes.bass, false);
  assert.equal(result.changes.percussion, false);
  const solo = interpretDirection('Beauty and a Beat production, only piano', settings);
  assert.equal(solo.changes.production, 'auto');
  assert.equal(solo.changes.instrument, 'Piano');
  assert.equal(solo.changes.accompaniment, false);
  assert.equal(solo.changes.percussion, false);
  const pair = interpretDirection('Shape of You production, piano and strings', settings);
  assert.equal(pair.changes.production, 'auto');
  assert.equal(pair.changes.bass, false);
  assert.equal(pair.changes.percussion, false);
});

test('negative production references do not activate a benchmark', () => {
  for (const text of ['not Shape of You', 'avoid dance-pop', 'without Beauty and a Beat', 'Shape of You, but not Shape of You']) {
    assert.equal(Object.hasOwn(interpretDirection(text, settings).changes, 'production'), false, text);
  }
});
