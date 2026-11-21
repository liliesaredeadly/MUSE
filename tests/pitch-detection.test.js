import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch } from '../src/audio/pitch.js';

// Generated harmonic tones and deterministic broadband noise; no recorded audio.
function hum(frequency, { amplitude = 0.02, breath = 0, sampleRate = 48000, seed = 42, dc = 0 } = {}) {
  return Float32Array.from({ length: 4096 }, (_, index) => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const phase = 2 * Math.PI * frequency * index / sampleRate;
    return dc + amplitude * (Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase))
      + breath * (seed / 4294967296 - 0.5) * 2;
  });
}

test('a quiet steady hum below the old volume gate retains its pitch', () => {
  const pitch = detectPitch(hum(220, { amplitude: 0.003 }), 48000);
  assert.ok(pitch, 'quiet periodic input should remain usable');
  assert.equal(pitch.name, 'A3');
  assert.ok(Math.abs(pitch.frequency - 220) < 2);
  assert.ok(pitch.confidence >= 0.85);
});

for (const [frequency, name, sampleRate] of [[146.832, 'D3', 48000], [220, 'A3', 48000], [440, 'A4', 44100]]) {
  test(`breath noise does not hide a steady ${name} hum at ${sampleRate} Hz`, () => {
    const pitch = detectPitch(hum(frequency, { amplitude: 0.02, breath: 0.02, sampleRate }), sampleRate);
    assert.ok(pitch, 'a periodic fundamental with broadband breath noise should be recognised');
    assert.equal(pitch.name, name);
    assert.ok(Math.abs(pitch.frequency - frequency) / frequency < 0.02);
    assert.ok(pitch.confidence >= 0.85);
  });
}

test('a quiet breathy hum still supplies a confident fundamental', () => {
  const pitch = detectPitch(hum(146.832, { amplitude: 0.003, breath: 0.003, dc: 0.1 }), 48000);
  assert.ok(pitch);
  assert.equal(pitch.name, 'D3');
  assert.ok(Math.abs(pitch.frequency - 146.832) < 2);
  assert.ok(pitch.confidence >= 0.85);
});

test('conditioning preserves both ends of the supported pitch range', () => {
  for (const [frequency, name] of [[65.406, 'C2'], [1396.913, 'F6']]) {
    const pitch = detectPitch(hum(frequency, { amplitude: 0.003 }), 48000);
    assert.equal(pitch?.name, name);
    assert.ok(Math.abs(pitch.frequency - frequency) / frequency < 0.01);
  }
});

test('conditioning cannot turn broadband noise, silence or inaudible input into notes', () => {
  assert.equal(detectPitch(new Float32Array(4096), 48000), null);
  assert.equal(detectPitch(new Float32Array(4096).fill(0.2), 48000), null);
  assert.equal(detectPitch(hum(220, { amplitude: 0.0001 }), 48000), null);
  for (const seed of [1, 7, 42, 1337, 982451653]) {
    for (const breath of [0.003, 0.02, 0.2]) {
      assert.equal(detectPitch(hum(220, { amplitude: 0, breath, seed }), 48000), null, `noise seed ${seed}, level ${breath}`);
    }
  }
});

test('out-of-range tones do not become false octaves after conditioning', () => {
  for (const frequency of [40, 1405, 2100]) {
    assert.equal(detectPitch(hum(frequency), 48000), null, `${frequency} Hz is outside the supported range`);
  }
});
