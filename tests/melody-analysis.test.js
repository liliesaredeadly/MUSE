import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch } from '../src/audio/pitch.js';
import { MicrophoneRecorder } from '../src/audio/recorder.js';
import { FIXTURES, makeHum, frequency } from './fixtures/hum-fixtures.js';
import { analyzeMelody } from '../src/audio/melody-analysis.js';

function analyze(fixture) {
  return analyzeMelody(fixture.samples, fixture.sampleRate);
}

function compareMelody(actual, expected, tolerance = 0.03) {
  assert.deepEqual(actual.map(note => note.midi), expected.map(note => note.midi), 'lead pitches and repeated-note count');
  actual.forEach((note, index) => {
    const truth = expected[index];
    assert.ok(Math.abs(note.start - truth.start) <= tolerance + 1e-8, `note ${index} onset ${note.start} vs ${truth.start}`);
    assert.ok(Math.abs(note.start + note.duration - truth.start - truth.duration) <= tolerance + 1e-8,
      `note ${index} offset ${note.start + note.duration} vs ${truth.start + truth.duration}`);
    assert.ok(note.confidence >= 0.8 && note.confidence <= 1);
  });
}

for (const name of ['irregular', 'fast', 'repeated', 'breathy', 'contour', 'weakFundamental']) {
  test(`offline analysis follows contiguous PCM: ${name}`, () => {
    const fixture = FIXTURES[name]();
    const result = analyze(fixture);
    compareMelody(result.notes, fixture.notes);
    assert.equal(result.duration, fixture.samples.length / fixture.sampleRate);
    assert.equal(result.sampleRate, fixture.sampleRate);
    assert.match(result.method, /offline/i);
    assert.ok(result.voicedRatio > 0 && result.voicedRatio <= 1);
    assert.deepEqual(result.rhythm.onsets, result.notes.map(note => note.start));
    assert.equal(result.rhythm.intervals.length, result.notes.length - 1);
    assert.ok(result.rhythm.rests.every(rest => rest.start >= 0 && rest.duration > 0));
  });
}

test('same-pitch articulation retains the 40 ms rest as a separate rhythm event', () => {
  const result = analyze(FIXTURES.repeated());
  const rest = result.rhythm.rests.find(value => value.start > 0.45 && value.start < 0.55);
  assert.ok(rest, 'rest between repeated notes');
  assert.ok(Math.abs(rest.duration - 0.04) <= 0.02);
});

test('vibrato and a sub-semitone glide survive in bounded, note-relative Hz contours', () => {
  const fixture = FIXTURES.contour();
  const result = analyze(fixture);
  const vibrato = result.notes[0].contour;
  const cents = vibrato.map(point => 1200 * Math.log2(point.frequency / frequency(57)));
  assert.ok(Math.max(...cents) - Math.min(...cents) >= 30, 'do not flatten vibrato to integer MIDI');
  const glide = result.notes[1].contour;
  assert.ok(1200 * Math.log2(glide.at(-1).frequency / glide[0].frequency) >= 18, 'retain rising contour');
  assert.ok(result.contour.length <= 4000);
  for (const note of result.notes) {
    assert.ok(note.contour.length >= 2 && note.contour.length <= 2000);
    assert.ok(note.contour.every(point => point.time >= 0 && point.time <= note.duration && point.frequency > 0));
    assert.ok(note.contour.every((point, index) => index === 0 || point.time > note.contour[index - 1].time));
  }
});

test('a detuned vibrato crossing the rounded semitone boundary remains one sung note', () => {
  const fixture = makeHum([{ midi: 60.4, start: 0.2, duration: 0.9, vibrato: 25 }]);
  const result = analyze(fixture);
  assert.equal(result.notes.length, 1, 'natural tuning wobble must not invent repeated semitone notes');
  assert.equal(result.notes[0].midi, 60);
  const cents = result.notes[0].contour.map(point => 1200 * Math.log2(point.frequency / frequency(60)));
  assert.ok(Math.max(...cents) > 55 && Math.min(...cents) < 25);
});

test('high supported notes do not become subharmonics when their period falls between samples', () => {
  for (const harmonics of [[1], [1, 0.3, 0.12], [0.18, 1, 0.45, 0.12]]) {
    for (const midi of [72, 78, 84, 85, 86, 87, 88]) {
      const fixture = makeHum([{ midi, start: 0.1, duration: 0.3 }], { sampleRate: 16000, harmonics });
      const result = analyze(fixture);
      assert.deepEqual(result.notes.map(note => note.midi), [midi], `${midi} with harmonics ${harmonics}`);
    }
  }
});

test('inclusive 65–1400 Hz analysis boundaries tolerate bounded fractional-period estimation error', () => {
  for (const sampleRate of [16000, 48000, 96000]) {
    for (const hz of [65, 1400]) {
      for (const harmonics of [[1], [1, 0.3, 0.12], [0.18, 1, 0.45, 0.12]]) {
        const midi = 69 + 12 * Math.log2(hz / 440);
        const fixture = makeHum([{ midi, start: 0.2, duration: 0.45 }], { sampleRate, harmonics });
        const result = analyze(fixture);
        assert.deepEqual(result.notes.map(note => note.midi), [Math.round(midi)], `${hz} Hz / ${sampleRate} Hz / ${harmonics}`);
        assert.ok(result.notes[0].start <= 0.23 + 1e-8);
        assert.ok(result.notes[0].start + result.notes[0].duration >= 0.62 - 1e-8);
        assert.ok(result.notes[0].contour.every(point => point.frequency >= 65 && point.frequency <= 1400));
      }
    }
  }
});

test('frequency-boundary tolerance does not accept genuinely out-of-range pure tones', () => {
  for (const hz of [64, 1408, 1500]) {
    const midi = 69 + 12 * Math.log2(hz / 440);
    const fixture = makeHum([{ midi, start: 0.2, duration: 0.45 }], { sampleRate: 48000, harmonics: [1] });
    assert.deepEqual(analyze(fixture).notes, [], `${hz} Hz must not be clipped into a recognized melody`);
  }
});

test('actual trailing-window live baseline loses fast notes and repeated articulation', () => {
  for (const name of ['fast', 'repeated']) {
    const fixture = FIXTURES[name]();
    const recorder = new MicrophoneRecorder();
    for (let time = 0; time < fixture.duration; time += 0.04) {
      const stop = Math.round(time * fixture.sampleRate);
      const window = new Float32Array(4096);
      for (let index = 0; index < window.length; index++) window[index] = fixture.samples[stop - window.length + index] || 0;
      recorder._groupPitch(detectPitch(window, fixture.sampleRate), time);
    }
    recorder._finishNote();
    assert.notDeepEqual(recorder._notes.map(note => note.midi), fixture.notes.map(note => note.midi));
    compareMelody(analyze(fixture).notes, fixture.notes);
  }
});

test('silence, DC and broadband noise cannot create a melody', () => {
  for (const fixture of [
    makeHum([], { duration: 0.6 }),
    ...[1, 7, 42, 1337, 982451653].map(seed => makeHum([], { duration: 0.6, breath: 0.2, seed })),
    { samples: new Float32Array(16000).fill(0.3), sampleRate: 16000 },
  ]) {
    const result = analyze(fixture);
    assert.deepEqual(result.notes, []);
    assert.deepEqual(result.contour, []);
    assert.equal(result.voicedRatio, 0);
    assert.equal(result.rhythm.estimatedBpm, null);
    assert.ok(result.warnings.length > 0);
  }
});

test('sparse voiced evidence reports limited coverage honestly', () => {
  const result = analyze(makeHum([{ midi: 57, start: 0.2, duration: 0.15 }], { duration: 2 }));
  assert.equal(result.notes.length, 1);
  assert.ok(result.voicedRatio < 0.1);
  assert.ok(result.warnings.some(warning => /small part|coverage|sparse|limited/i.test(warning)));
});

test('sample timestamps remain consistent across supported rates without mutating PCM', () => {
  const notes = [{ midi: 57, start: 0.2, duration: 0.2 }, { midi: 64, start: 0.46, duration: 0.12 }];
  for (const sampleRate of [8000, 16000, 22050, 44100, 96000]) {
    const fixture = makeHum(notes, { sampleRate });
    const copy = fixture.samples.slice();
    compareMelody(analyze(fixture).notes, notes);
    assert.deepEqual(fixture.samples, copy);
  }
});

test('downsampling rejects ultrasonic aliases instead of fabricating an audible lead', () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    for (const tone of [12000, 15000]) {
      const samples = Float32Array.from({ length: Math.round(sampleRate * 0.5) }, (_, index) =>
        0.3 * Math.sin(2 * Math.PI * tone * index / sampleRate));
      const result = analyze({ samples, sampleRate });
      assert.deepEqual(result.notes, [], `${tone} Hz at ${sampleRate} Hz must not fold into a melody note`);
    }
  }
});

test('invalid PCM, rates and duration fail explicitly rather than inventing a result', () => {
  assert.equal(typeof analyzeMelody, 'function');
  for (const [samples, sampleRate] of [[null, 16000], [[], 16000], [new Float32Array(), 16000],
    [new Float32Array([NaN]), 16000], [new Float32Array([Infinity]), 16000],
    [new Float32Array(100), 7999], [new Float32Array(100), 96001],
    [new Float32Array(100), NaN], [new Float32Array(16000 * 60 + 1), 16000]]) {
    assert.throws(() => analyzeMelody(samples, sampleRate), /PCM|sample|duration|60|rate/i);
  }
});
