import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePcmWav, encodePcmWav } from '../src/audio/pcm-wav.js';

function fixture() {
  const bytes = new Uint8Array(52);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 44, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, 8, true);
  [-32768, -16384, 0, 16384].forEach((value, i) => view.setInt16(44 + i * 2, value, true));
  return bytes;
}

test('actual PCM WAV bytes decode to their signed samples and clock', () => {
  const decoded = decodePcmWav(fixture());
  assert.equal(decoded.sampleRate, 16000);
  assert.equal(decoded.channels, 1);
  assert.deepEqual([...decoded.samples], [-1, -0.5, 0, 0.5]);
  assert.equal(decoded.duration, 4 / 16000);
});

test('encoding produces a standard PCM16 WAV without changing sample count', () => {
  const bytes = encodePcmWav(Float32Array.from([-1, -0.5, 0, 0.5, 1]), 16000);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  const decoded = decodePcmWav(bytes);
  assert.equal(decoded.samples.length, 5);
  assert.equal(decoded.samples[0], -1);
  assert.ok(Math.abs(decoded.samples[4] - 1) < 1 / 32767);
});

test('truncated or inconsistent audio cannot be treated as a successful recording', () => {
  assert.throws(() => decodePcmWav(fixture().slice(0, 49)), /truncat|length|RIFF/i);
  const invalid = fixture(); new DataView(invalid.buffer).setUint16(32, 4, true);
  assert.throws(() => decodePcmWav(invalid), /format|align|PCM/i);
  assert.throws(() => encodePcmWav(Float32Array.of(NaN), 16000), /finite|sample/i);
});

test('trailing partial RIFF chunks and missing odd-chunk padding cannot be decoded', () => {
  for (const suffix of [new Uint8Array([1]), new Uint8Array(7), Uint8Array.from([74, 85, 78, 75, 1, 0, 0, 0, 9])]) {
    const bytes = new Uint8Array(52 + suffix.length);
    bytes.set(fixture()); bytes.set(suffix, 52);
    new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
    assert.throws(() => decodePcmWav(bytes), /truncat|chunk|padding|length/i);
  }
});
