import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHarmonicAnchors } from '../src/audio/harmonic-anchors.js';

const SAMPLE_RATE = 16000;

function fixture(frequency, harmonics, { seconds = 1.2, noise = 0.001, detuning = [], formant = false, jitter = 0.018, seed = 79 } = {}) {
  return Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, index) => {
    const time = index / SAMPLE_RATE;
    seed = (1664525 * seed + 1013904223) >>> 0;
    let value = noise * (seed / 2147483648 - 1);
    for (const [partial, amplitude] of harmonics) {
      const cents = detuning[partial] || 0;
      const phase = 2 * Math.PI * partial * frequency * 2 ** (cents / 1200) * time
        + partial * jitter * Math.sin(2 * Math.PI * 5.3 * time);
      const envelope = formant ? 0.7 + 0.3 * Math.sin(2 * Math.PI * 1.3 * time + partial) : 1;
      value += 0.02 * amplitude * envelope * Math.sin(phase + partial * 0.37);
    }
    return value;
  });
}

function assertPitch(samples, frequency) {
  const result = extractHarmonicAnchors(samples);
  assert.equal(result.method, 'spectral-harmonic-consensus-v1');
  assert.ok(result.anchors.length > 0, `expected supported ${frequency} Hz anchors`);
  assert.ok(result.anchors.reduce((sum, anchor) => sum + anchor.duration, 0) > samples.length / SAMPLE_RATE * 0.65);
  for (const anchor of result.anchors) {
    assert.equal(anchor.midi, Math.round(69 + 12 * Math.log2(frequency / 440)));
    assert.ok(Math.abs(1200 * Math.log2(anchor.frequency / frequency)) < 30, `${anchor.frequency} Hz vs ${frequency}`);
    assert.ok(anchor.coverage >= 0.9 && anchor.confidence >= 0.9);
    assert.ok(anchor.supportCount >= 3);
    assert.ok(anchor.duration >= 0.12 - 1e-8);
    assert.ok(anchor.start >= 0 && anchor.start + anchor.duration <= samples.length / SAMPLE_RATE + 1e-8);
  }
  return result;
}

test('harmonic anchors identify the fundamental rather than the strongest third or fifth partial', () => {
  for (const [frequency, harmonics] of [
    [220, [[1, 0.12], [2, 0.25], [3, 1]]],
    [110, [[2, 0.1], [4, 0.5], [5, 1]]],
    [123, [[2, 0.1], [3, 0.25], [5, 1], [10, 0.08]]],
    [183, [[2, 0.55], [3, 1], [4, 0.1]]],
    [166, [[3, 0.25], [4, 0.3], [6, 0.4], [7, 0.8], [8, 1]]],
  ]) assertPitch(fixture(frequency, harmonics), frequency);
});

test('noise, mild independent partial detuning, and changing formants retain supported anchors', () => {
  assertPitch(fixture(137, [[2, 0.16], [3, 0.3], [4, 1]], {
    noise: 0.002, detuning: { 2: -13, 3: 4, 4: 9 }, formant: true,
  }), 137);
  assertPitch(fixture(523.251, [[1, 1], [2, 0.4], [3, 0.2]], { noise: 0.002, formant: true }), 523.251);
});

test('two tones and incompatible harmonic families never become a stable invented subharmonic', () => {
  for (const tones of [[[657, 1], [414, 0.5]], [[657, 1], [414, 0.5], [275, 0.17]], [[523.251, 1], [659.255, 1]]]) {
    const samples = fixture(1, tones, { noise: 0.001, jitter: 0 });
    assert.deepEqual(extractHarmonicAnchors(samples).anchors, [], JSON.stringify(tones));
  }
});

test('white noise and low-pass colored noise cannot certify harmonic anchors', () => {
  for (const seed of [7, 79, 1337]) {
    const white = fixture(220, [], { noise: 0.03, seed });
    const colored = new Float32Array(white.length);
    let state = 0;
    for (let i = 0; i < white.length; i++) colored[i] = state = 0.97 * state + white[i];
    assert.deepEqual(extractHarmonicAnchors(white).anchors, []);
    assert.deepEqual(extractHarmonicAnchors(colored).anchors, []);
  }
});

test('an out-of-range tone cannot be divided into a supported in-range pitch', () => {
  assert.deepEqual(extractHarmonicAnchors(fixture(1800, [[1, 1]], { noise: 0 })).anchors, []);
  assert.deepEqual(extractHarmonicAnchors(fixture(1800, [[1, 1], [2, 0.4], [3, 0.2]])).anchors, []);
});

test('verified runs end at a weak gap and do not fill it to join the same pitch', () => {
  const voiced = fixture(220, [[1, 0.2], [2, 0.4], [3, 1]], { seconds: 0.6 });
  const gap = 0.24;
  const samples = new Float32Array(voiced.length * 2 + gap * SAMPLE_RATE);
  samples.set(voiced);
  samples.set(voiced, voiced.length + gap * SAMPLE_RATE);
  const result = extractHarmonicAnchors(samples);
  assert.equal(result.anchors.length, 2);
  assert.ok(result.anchors[0].start + result.anchors[0].duration < 0.66);
  assert.ok(result.anchors[1].start > 0.78);
  assert.ok(result.frames.some(frame => !frame.accepted && frame.time > 0.66 && frame.time < 0.78));
});

test('brief tonal evidence and invalid input cannot produce anchors or mutate PCM', () => {
  const samples = fixture(220, [[1, 0.2], [2, 0.4], [3, 1]], { seconds: 0.16 });
  const original = samples.slice();
  assert.deepEqual(extractHarmonicAnchors(samples).anchors, []);
  assert.deepEqual(samples, original);
  for (const input of [null, [], new Float32Array(4096), Float32Array.of(NaN, 0, 1)]) {
    assert.deepEqual(extractHarmonicAnchors(input).anchors, []);
  }
  assert.deepEqual(extractHarmonicAnchors(samples, 0).anchors, []);
});

test('separated 60 ms bursts cannot become 120 ms anchors through FFT window overlap', () => {
  const samples = new Float32Array(Math.round(3.2 * SAMPLE_RATE));
  for (let burst = 0; burst < 6; burst++) {
    const frequency = 220 * 2 ** ((burst % 3) * 2 / 12);
    const start = Math.round((0.5 + 0.4 * burst) * SAMPLE_RATE);
    for (let i = 0; i < 0.06 * SAMPLE_RATE; i++) {
      const phase = 2 * Math.PI * frequency * i / SAMPLE_RATE;
      samples[start + i] = 0.03 * (Math.sin(phase) + 0.6 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase));
    }
  }
  assert.deepEqual(extractHarmonicAnchors(samples).anchors, [], 'FFT support must not outlast the actual tonal intervals');
});
