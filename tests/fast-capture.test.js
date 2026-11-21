import test from 'node:test';
import assert from 'node:assert/strict';
import { MicrophoneRecorder } from '../src/audio/recorder.js';

// Synthetic detector outputs isolate note grouping from microphone hardware.
function pitch(midi) {
  return { midi, name: `note-${midi}`, frequency: 440 * 2 ** ((midi - 69) / 12), confidence: 0.98 };
}

async function stopAt(t, recorder, duration) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value() {} });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'cancelAnimationFrame', original);
    else delete globalThis.cancelAnimationFrame;
  });
  recorder.state = 'recording';
  recorder._startedAt = 0;
  recorder._pausedSeconds = 0;
  recorder._context = { currentTime: duration, async close() {} };
  return recorder.stop();
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should equal ${expected}`);
}

function frameCapture() {
  const samples = new Map(Array.from({ length: 10 }, (_, index) => {
    const midi = 60 + index;
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    return [midi, Float32Array.from({ length: 4096 }, (_, sample) => 0.3 * Math.sin(2 * Math.PI * frequency * sample / 48000))];
  }));
  const frames = [];
  const recorder = new MicrophoneRecorder({ onFrame: frame => frames.push(frame) });
  recorder.state = 'recording';
  recorder._startedAt = 0;
  recorder._pausedSeconds = 0;
  recorder._nextFrame = 0;
  recorder._signal = { frames: 0, pitchedFrames: 0, peakLevel: 0 };
  recorder._context = { currentTime: 0, sampleRate: 48000, async close() {} };
  recorder._samples = new Float32Array(4096);
  let currentMidi = 60;
  recorder._analyser = { getFloatTimeDomainData(out) { out.set(samples.get(currentMidi)); } };
  // The browser callback clock is supplied by each fixture below; keep the real
  // analysis gate, pitch detector, grouping and stop path.
  recorder._scheduleFrame = () => {};
  return {
    recorder, frames,
    frame(time, midi = 60 + Math.min(9, Math.floor((time + 0.000001) / 0.12))) {
      currentMidi = midi;
      recorder._context.currentTime = time;
      recorder._frame();
    },
  };
}

for (const jitter of [false, true]) {
  test(`60Hz browser callbacks retain all 120ms notes${jitter ? ' with callback jitter' : ''}`, async (t) => {
    const capture = frameCapture();
    const offsets = jitter ? [0, 0.002, -0.001, 0.003, -0.002] : [0];
    for (let frame = 0; frame < 72; frame++) capture.frame(frame / 60 + offsets[frame % offsets.length]);
    const { notes } = await stopAt(t, capture.recorder, 1.2);
    assert.equal(capture.frames.length, 30, 'callback rounding must not reduce 25Hz analysis to 20Hz');
    assert.deepEqual(notes.map(note => note.midi), [60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
    for (let index = 0; index < notes.length; index++) {
      closeTo(notes[index].start, index * 0.12);
      closeTo(notes[index].duration, 0.12);
    }
  });
}

test('the browser scheduler skips missed deadlines without creating catch-up pitch frames', async (t) => {
  const capture = frameCapture();
  for (let frame = 0; frame < 8; frame++) capture.frame(frame / 60, 60);
  for (let frame = 0; frame < 8; frame++) capture.frame(5 + frame / 60, 60);
  const { notes } = await stopAt(t, capture.recorder, 5.12);
  assert.equal(capture.frames.length, 6);
  assert.equal(notes.length, 2);
  closeTo(notes[0].duration, 0.12);
  closeTo(notes[1].start, 5);
  closeTo(notes[1].duration, 0.12);
});

test('ten adjacent 120ms notes survive three detector frames each', async (t) => {
  const recorder = new MicrophoneRecorder();
  for (let index = 0; index < 30; index++) recorder._groupPitch(pitch(60 + Math.floor(index / 3)), index * 0.04);
  const { notes } = await stopAt(t, recorder, 1.2);
  assert.deepEqual(notes.map(note => note.midi), [60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
  for (let index = 0; index < notes.length; index++) {
    closeTo(notes[index].start, index * 0.12);
    closeTo(notes[index].duration, 0.12);
  }
});

test('a final 120ms note is included when capture stops after its third frame', async (t) => {
  const recorder = new MicrophoneRecorder();
  for (const time of [0, 0.04, 0.08]) recorder._groupPitch(pitch(60), time);
  const { notes } = await stopAt(t, recorder, 0.12);
  assert.equal(notes.length, 1);
  closeTo(notes[0].duration, 0.12);
});

test('silence closes a 120ms note at its last supported frame', async (t) => {
  const recorder = new MicrophoneRecorder();
  for (const time of [0, 0.04, 0.08]) recorder._groupPitch(pitch(60), time);
  for (const time of [0.12, 0.16, 0.2, 0.8]) recorder._groupPitch(null, time);
  const { notes } = await stopAt(t, recorder, 1);
  assert.equal(notes.length, 1);
  closeTo(notes[0].duration, 0.12);
});

test('one-frame pitch blips cannot become fast notes', async (t) => {
  const recorder = new MicrophoneRecorder();
  for (let index = 0; index < 12; index++) recorder._groupPitch(pitch(60 + index), index * 0.04);
  recorder._groupPitch(null, 0.6);
  assert.deepEqual((await stopAt(t, recorder, 0.8)).notes, []);
});

test('missed analysis intervals split matching fast notes without filling the gap', async (t) => {
  const recorder = new MicrophoneRecorder();
  for (const time of [0, 0.04, 0.08, 5, 5.04, 5.08]) recorder._groupPitch(pitch(60), time);
  const { notes } = await stopAt(t, recorder, 5.12);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map(note => note.start), [0, 5]);
  for (const note of notes) closeTo(note.duration, 0.12);
});

test('sparse isolated frames do not accumulate stability across analysis stalls', async (t) => {
  const recorder = new MicrophoneRecorder();
  for (const time of [0, 0.12, 0.24, 2]) recorder._groupPitch(pitch(60), time);
  assert.deepEqual((await stopAt(t, recorder, 2.04)).notes, []);
});

test('slower varying analysis cadence retains stable notes with only a bounded final frame', async (t) => {
  const recorder = new MicrophoneRecorder();
  for (const time of [0, 0.055, 0.12]) recorder._groupPitch(pitch(60), time);
  for (const time of [0.17, 0.23, 0.3]) recorder._groupPitch(pitch(64), time);
  const { notes } = await stopAt(t, recorder, 1);
  assert.deepEqual(notes.map(note => note.midi), [60, 64]);
  closeTo(notes[0].duration, 0.16);
  closeTo(notes[1].start, 0.17);
  closeTo(notes[1].duration, 0.17);
});

test('stopping before a full supported note cannot extend it beyond capture time', async (t) => {
  const recorder = new MicrophoneRecorder();
  for (const time of [0, 0.04, 0.08]) recorder._groupPitch(pitch(60), time);
  assert.deepEqual((await stopAt(t, recorder, 0.1)).notes, []);
});
