import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, frequencyToNote, midiToFrequency } from '../src/audio/pitch.js';
import { MicrophoneRecorder } from '../src/audio/recorder.js';

// These are generated DSP fixtures, not recordings of a human or microphone.
function tone(frequency, { sampleRate = 48000, amplitude = 0.3, harmonics = [1], dc = 0 } = {}) {
  return Float32Array.from({ length: 4096 }, (_, i) => dc + amplitude * harmonics.reduce(
    (sum, strength, harmonic) => sum + strength * Math.sin(2 * Math.PI * frequency * (harmonic + 1) * i / sampleRate), 0,
  ));
}

function noise() {
  let seed = 42;
  return Float32Array.from({ length: 4096 }, () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return (seed / 4294967296 - 0.5) * 0.5;
  });
}

test('A4 maps to 440 Hz and middle C maps to its note name', () => {
  assert.equal(midiToFrequency(69), 440);
  assert.deepEqual(frequencyToNote(261.625565), { midi: 60, name: 'C4' });
  assert.deepEqual(frequencyToNote(440), { midi: 69, name: 'A4' });
  assert.equal(frequencyToNote(0), null);
  assert.equal(frequencyToNote(Number.NaN), null);
});

for (const [frequency, midi, name] of [[65.406, 36, 'C2'], [146.832, 50, 'D3'], [440, 69, 'A4'], [1046.502, 84, 'C6'], [1396.913, 89, 'F6']]) {
  test(`generated sine ${frequency} Hz is detected without an octave shift`, () => {
    const pitch = detectPitch(tone(frequency), 48000);
    assert.ok(pitch, 'a periodic signal should be recognised');
    assert.equal(pitch.midi, midi);
    assert.equal(pitch.name, name);
    assert.ok(Math.abs(pitch.frequency - frequency) / frequency < 0.01);
    assert.ok(pitch.confidence >= 0.85 && pitch.confidence <= 1);
  });
}

test('a humming-like harmonic signal retains the weak fundamental', () => {
  const pitch = detectPitch(tone(196, { harmonics: [0.4, 1, 0.6, 0.2] }), 48000);
  assert.ok(pitch);
  assert.equal(pitch.midi, 55);
  assert.ok(Math.abs(pitch.frequency - 196) < 2);
});

test('DC offset does not shift a 44.1 kHz sampled note', () => {
  const pitch = detectPitch(tone(329.628, { sampleRate: 44100, dc: 0.2 }), 44100);
  assert.equal(pitch?.name, 'E4');
});

test('silence, inaudible input and unpitched white noise produce no note', () => {
  assert.equal(detectPitch(new Float32Array(4096), 48000), null);
  assert.equal(detectPitch(tone(220, { amplitude: 0.0001 }), 48000), null);
  assert.equal(detectPitch(noise(), 48000), null);
  assert.equal(detectPitch(new Float32Array(4096).fill(0.3), 48000), null);
});

test('invalid, short and out-of-range input is rejected', () => {
  assert.equal(detectPitch([], 48000), null);
  assert.equal(detectPitch(tone(440), 0), null);
  assert.equal(detectPitch(Float32Array.from({ length: 4096 }, () => NaN), 48000), null);
  assert.equal(detectPitch(tone(40), 48000), null);
  assert.equal(detectPitch(tone(2100), 48000), null);
});

// Browser dependencies are replaced because Node has no microphone. The detector,
// active-time clock, note grouping and recorder lifecycle remain real code.
function browserHarness({ request } = {}) {
  const originals = new Map();
  function replace(name, value) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const state = { context: null, frames: new Map(), timers: new Map(), nextId: 0, streams: [], media: [], signal: new Float32Array(4096), analyserError: false };
  function stream() {
    const track = { label: 'QA microphone', readyState: 'live', getSettings: () => ({ channelCount: 1 }), stop() { this.readyState = 'ended'; } };
    const value = { getTracks: () => [track], getAudioTracks: () => [track] };
    state.streams.push(value);
    return value;
  }
  class AudioContext {
    constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; state.context = this; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return { fftSize: 4096, smoothingTimeConstant: 0, getFloatTimeDomainData(out) {
        if (state.analyserError) throw new Error('The audio device disconnected');
        out.set(state.signal);
      }, disconnect() {} };
    }
  }
  class MediaRecorder {
    static isTypeSupported() { return true; }
    constructor(_stream, options) { this.state = 'inactive'; this.mimeType = options?.mimeType || 'audio/webm'; state.media.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['actual captured bytes'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  replace('navigator', { mediaDevices: { getUserMedia: request || (async () => stream()) } });
  replace('AudioContext', AudioContext);
  replace('MediaRecorder', MediaRecorder);
  replace('requestAnimationFrame', (callback) => { const id = ++state.nextId; state.frames.set(id, callback); return id; });
  replace('cancelAnimationFrame', (id) => state.frames.delete(id));
  replace('setTimeout', (callback, delay) => { const id = ++state.nextId; state.timers.set(id, { callback, delay }); return id; });
  replace('clearTimeout', (id) => state.timers.delete(id));
  return {
    state, stream,
    frame(time, signal = tone(220)) {
      state.context.currentTime = time;
      state.signal = signal;
      const pending = [...state.frames.values()];
      state.frames.clear();
      for (const callback of pending) callback(time * 1000);
    },
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test('stable microphone frames become a timed note and captured audio; stop releases the microphone', async () => {
  const browser = browserHarness();
  const frames = [];
  let liveNotes = [];
  const recorder = new MicrophoneRecorder({ onFrame: (frame) => frames.push(frame), onNotes: (notes) => { liveNotes = notes; } });
  try {
    await recorder.start();
    for (let time = 0.04; time <= 0.64; time += 0.04) browser.frame(time);
    assert.equal(liveNotes.length, 1);
    assert.equal(liveNotes[0].name, 'A3');
    assert.ok(liveNotes[0].duration > 0.4);
    assert.ok(frames[0].waveform instanceof Float32Array);
    assert.ok(frames[0].level > 0);
    const result = await recorder.stop();
    assert.equal(result.notes.length, 1);
    assert.ok(result.blob.size > 0);
    assert.ok(result.duration >= 0.6 && result.duration <= 0.65);
    assert.equal(browser.state.streams[0].getTracks()[0].readyState, 'ended');
    assert.equal(browser.state.context.state, 'closed');
    assert.equal(browser.state.frames.size, 0);
    assert.equal(browser.state.timers.size, 0);
    assert.deepEqual(await recorder.stop(), result);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('capture reports the actual microphone and measured signal without inventing notes', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    browser.frame(0.04, new Float32Array(4096));
    browser.frame(0.08, noise());
    const result = await recorder.stop();
    assert.deepEqual(result.input, { label: 'QA microphone', channelCount: 1 });
    assert.equal(result.signal.frames, 2);
    assert.ok(result.signal.peakLevel > 0.05);
    assert.equal(result.signal.pitchedFrames, 0);
    assert.deepEqual(result.notes, []);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('pause excludes elapsed paused time and splits notes across the pause', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    for (let time = 0.04; time <= 0.4; time += 0.04) browser.frame(time);
    recorder.pause();
    browser.frame(9);
    recorder.resume();
    for (let time = 9.04; time <= 9.44; time += 0.04) browser.frame(time);
    const result = await recorder.stop();
    assert.ok(result.duration > 0.7 && result.duration < 0.9);
    assert.equal(result.notes.length, 2);
    assert.ok(result.notes[1].start < 0.5);
    assert.ok(result.notes.every((note) => note.duration > 0.2 && note.duration < 0.6));
  } finally { await recorder.dispose(); browser.restore(); }
});

test('brief missing pitch frames do not erase a steady hummed note', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    for (let index = 1; index <= 25; index++) {
      browser.frame(index * 0.04, index % 3 === 0 ? new Float32Array(4096) : tone(220));
    }
    const { notes } = await recorder.stop();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].midi, 57);
    assert.ok(notes[0].duration > 0.85 && notes[0].duration < 1);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('an analysis stall cannot stretch a note across unobserved seconds', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    for (let index = 1; index <= 10; index++) browser.frame(index * 0.04);
    for (let index = 0; index <= 10; index++) browser.frame(5 + index * 0.04);
    const { notes } = await recorder.stop();
    assert.equal(notes.length, 2);
    assert.ok(notes.every(note => note.midi === 57 && note.duration < 0.45));
    assert.equal(notes[1].start, 5);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('isolated pitch frames separated by silence cannot accumulate into a note', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    for (let index = 1; index <= 25; index++) {
      browser.frame(index * 0.04, index % 4 === 1 ? tone(220) : new Float32Array(4096));
    }
    assert.deepEqual((await recorder.stop()).notes, []);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('a steady detuned hum wobbling across a semitone boundary remains one note', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    for (let index = 1; index <= 25; index++) {
      const midi = index % 2 ? 62.42 : 62.58;
      browser.frame(index * 0.04, tone(440 * 2 ** ((midi - 69) / 12)));
    }
    const { notes } = await recorder.stop();
    assert.equal(notes.length, 1);
    assert.ok([62, 63].includes(notes[0].midi));
    assert.ok(notes[0].duration > 0.85 && notes[0].duration < 1);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('a real semitone change creates a separate note', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    for (let index = 1; index <= 12; index++) browser.frame(index * 0.04, tone(midiToFrequency(62)));
    browser.frame(0.52, new Float32Array(4096));
    for (let index = 14; index <= 25; index++) browser.frame(index * 0.04, tone(midiToFrequency(63)));
    const { notes } = await recorder.stop();
    assert.deepEqual(notes.map(note => note.midi), [62, 63]);
    assert.ok(notes.every(note => note.duration >= 0.35 && note.duration <= 0.5));
  } finally { await recorder.dispose(); browser.restore(); }
});

test('silence and brief pitch transients do not fabricate recorded notes', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    browser.frame(0.04, tone(440));
    browser.frame(0.08, tone(440));
    for (let time = 0.12; time < 0.6; time += 0.04) browser.frame(time, new Float32Array(4096));
    assert.deepEqual((await recorder.stop()).notes, []);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('a refused permission can be retried without leaking resources', async () => {
  let attempts = 0;
  let browser;
  browser = browserHarness({ request: async () => {
    if (++attempts === 1) throw new DOMException('Microphone permission denied', 'NotAllowedError');
    return browser.stream();
  } });
  const recorder = new MicrophoneRecorder();
  try {
    await assert.rejects(recorder.start(), { name: 'NotAllowedError' });
    await recorder.start();
    await recorder.stop();
    assert.ok(browser.state.streams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')));
  } finally { await recorder.dispose(); browser.restore(); }
});

test('disposing during a pending permission request releases a late stream', async () => {
  let resolveRequest;
  const browser = browserHarness({ request: () => new Promise((resolve) => { resolveRequest = resolve; }) });
  const recorder = new MicrophoneRecorder();
  try {
    const pending = recorder.start();
    await recorder.dispose();
    resolveRequest(browser.stream());
    await pending.catch((error) => assert.equal(error.name, 'AbortError'));
    assert.equal(browser.state.streams[0].getTracks()[0].readyState, 'ended');
    assert.equal(browser.state.frames.size, 0);
  } finally { browser.restore(); }
});

test('60 active seconds auto-stop once and return the completed capture', async () => {
  const browser = browserHarness();
  const results = [];
  const recorder = new MicrophoneRecorder({ onAutoStop: (result) => results.push(result) });
  try {
    await recorder.start();
    browser.frame(60.1, new Float32Array(4096));
    await new Promise(setImmediate);
    assert.equal(results.length, 1);
    assert.equal(results[0].duration, 60);
    assert.equal(browser.state.streams[0].getTracks()[0].readyState, 'ended');
  } finally { await recorder.dispose(); browser.restore(); }
});

test('an asynchronous recording error releases the microphone and returns partial capture', async () => {
  const browser = browserHarness();
  const results = [];
  const recorder = new MicrophoneRecorder({ onAutoStop: (result) => results.push(result) });
  try {
    await recorder.start();
    browser.frame(0.04);
    browser.state.media[0].onerror?.({ error: new DOMException('The microphone disconnected', 'NotReadableError') });
    await new Promise(setImmediate);
    assert.equal(browser.state.streams[0].getTracks()[0].readyState, 'ended');
    assert.equal(browser.state.context.state, 'closed');
    assert.equal(results.length, 1);
    assert.equal(results[0].error.name, 'NotReadableError');
  } finally { await recorder.dispose(); browser.restore(); }
});

test('an inactive encoder error preserves the final audio delivered before its stop event', async () => {
  const browser = browserHarness();
  const results = [];
  const recorder = new MicrophoneRecorder({ onAutoStop: (result) => results.push(result) });
  try {
    await recorder.start();
    for (let time = 0.04; time <= 0.4; time += 0.04) browser.frame(time);
    const media = browser.state.media[0];
    // Browsers deactivate the encoder before firing error, final data, then stop.
    media.state = 'inactive';
    media.onerror?.({ error: new DOMException('Encoder failed', 'UnknownError') });
    media.ondataavailable?.({ data: new Blob(['last captured audio'], { type: media.mimeType }) });
    media.onstop?.();
    await new Promise(setImmediate);
    assert.equal(results.length, 1);
    assert.equal(results[0].error.name, 'UnknownError');
    assert.equal(results[0].notes.length, 1);
    assert.equal(await results[0].blob.text(), 'last captured audio');
    assert.equal(browser.state.streams[0].getTracks()[0].readyState, 'ended');
  } finally { await recorder.dispose(); browser.restore(); }
});

test('an encoder that stops when its input ends completes the capture immediately', async () => {
  const browser = browserHarness();
  const results = [];
  const recorder = new MicrophoneRecorder({ onAutoStop: (result) => results.push(result) });
  try {
    await recorder.start();
    browser.frame(0.4);
    const media = browser.state.media[0];
    media.state = 'inactive';
    media.ondataavailable?.({ data: new Blob(['partial capture'], { type: media.mimeType }) });
    media.onstop?.();
    await new Promise(setImmediate);
    assert.equal(results.length, 1);
    assert.equal(results[0].duration, 0.4);
    assert.ok(results[0].error instanceof Error);
    assert.equal(await results[0].blob.text(), 'partial capture');
    assert.equal(recorder.state, 'idle');
    assert.equal(browser.state.streams[0].getTracks()[0].readyState, 'ended');
    assert.equal(browser.state.frames.size, 0);
    assert.equal(browser.state.timers.size, 0);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('a failed analyser frame stops capture instead of leaking the microphone', async () => {
  const browser = browserHarness();
  const results = [];
  const recorder = new MicrophoneRecorder({ onAutoStop: (result) => results.push(result) });
  try {
    await recorder.start();
    browser.state.analyserError = true;
    browser.frame(0.04);
    await new Promise(setImmediate);
    assert.equal(browser.state.streams[0].getTracks()[0].readyState, 'ended');
    assert.equal(results.length, 1);
    assert.ok(results[0].error instanceof Error);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('recording can restart after a completed session with fresh notes and audio', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    for (let time = 0.04; time < 0.5; time += 0.04) browser.frame(time);
    assert.equal((await recorder.stop()).notes.length, 1);
    await recorder.start();
    browser.frame(0.3, new Float32Array(4096));
    const second = await recorder.stop();
    assert.deepEqual(second.notes, []);
    assert.equal(second.duration, 0.3);
    assert.ok(second.blob.size > 0);
    assert.ok(browser.state.streams.every((stream) => stream.getTracks()[0].readyState === 'ended'));
  } finally { await recorder.dispose(); browser.restore(); }
});

test('disposing while a restart waits for the previous encoder prevents a new microphone session', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    const pendingStop = recorder.stop();
    const pendingRestart = recorder.start();
    const disposed = recorder.dispose();
    await assert.rejects(pendingRestart, /disposed/i);
    await Promise.all([pendingStop, disposed]);
    assert.equal(recorder.state, 'disposed');
    assert.equal(browser.state.streams.length, 1);
    assert.ok(browser.state.streams.every(stream => stream.getTracks()[0].readyState === 'ended'));
    assert.equal(browser.state.frames.size, 0);
    assert.equal(browser.state.timers.size, 0);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('concurrent restarts waiting for an encoder share one new microphone session', async () => {
  const browser = browserHarness();
  const recorder = new MicrophoneRecorder();
  try {
    await recorder.start();
    const pendingStop = recorder.stop();
    const results = await Promise.allSettled([recorder.start(), recorder.start()]);
    await pendingStop;
    assert.ok(results.every(result => result.status === 'fulfilled'));
    assert.equal(recorder.state, 'recording');
    assert.equal(browser.state.streams.length, 2);
    assert.equal(browser.state.streams.filter(stream => stream.getTracks()[0].readyState === 'live').length, 1);
  } finally { await recorder.dispose(); browser.restore(); }
});

test('a failed pause releases the microphone and reports the partial recording', async () => {
  const browser = browserHarness();
  const results = [];
  const recorder = new MicrophoneRecorder({ onAutoStop: (result) => results.push(result) });
  try {
    await recorder.start();
    browser.state.media[0].pause = () => { throw new DOMException('Recording interrupted', 'InvalidStateError'); };
    recorder.pause();
    await new Promise(setImmediate);
    assert.equal(browser.state.streams[0].getTracks()[0].readyState, 'ended');
    assert.equal(results[0].error.name, 'InvalidStateError');
  } finally { await recorder.dispose(); browser.restore(); }
});

test('a failed resume retains the active duration recorded before the pause', async () => {
  const browser = browserHarness();
  const results = [];
  const recorder = new MicrophoneRecorder({ onAutoStop: (result) => results.push(result) });
  try {
    await recorder.start();
    browser.frame(0.4);
    recorder.pause();
    browser.frame(9);
    browser.state.media[0].resume = () => { throw new DOMException('Device unavailable', 'InvalidStateError'); };
    recorder.resume();
    await new Promise(setImmediate);
    assert.equal(results[0].duration, 0.4);
    assert.equal(browser.state.streams[0].getTracks()[0].readyState, 'ended');
  } finally { await recorder.dispose(); browser.restore(); }
});
