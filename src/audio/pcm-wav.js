const MAX_BYTES = 16 * 1024 * 1024;
const textAt = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));

/** Decode the actual PCM file, including optional RIFF chunks. No generated audio fallback. */
export function decodePcmWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 44 || bytes.length > MAX_BYTES || textAt(bytes, 0, 4) !== 'RIFF' || textAt(bytes, 8, 4) !== 'WAVE') throw new Error('A bounded PCM WAV audio file is required.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = view.getUint32(4, true) + 8;
  if (end !== bytes.length || end < 44) throw new Error('Truncated or inconsistent RIFF audio length.');
  let format;
  let data;
  let offset = 12;
  for (; offset + 8 <= end;) {
    const kind = textAt(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > end) throw new Error('Truncated WAV chunk.');
    if (kind === 'fmt ') {
      if (format || size < 16) throw new Error('Invalid or duplicate WAV format.');
      format = { code: view.getUint16(start, true), channels: view.getUint16(start + 2, true), sampleRate: view.getUint32(start + 4, true), byteRate: view.getUint32(start + 8, true), align: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true) };
    }
    if (kind === 'data') {
      if (data) throw new Error('Multiple WAV data chunks are unsupported.');
      data = { start, size };
    }
    offset = start + size + (size % 2);
  }
  if (offset !== end) throw new Error('Truncated WAV chunk or missing chunk padding.');
  if (!format || !data || format.code !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels)
    || format.sampleRate < 8000 || format.sampleRate > 96000 || format.align !== format.channels * 2
    || format.byteRate !== format.sampleRate * format.align || data.size % format.align) throw new Error('Use mono or stereo PCM16 WAV with a valid sample clock and block alignment.');
  const count = data.size / format.align;
  const duration = count / format.sampleRate;
  if (!count || duration > 60) throw new Error('Audio must contain samples and be at most 60 seconds.');
  // Select the strongest channel instead of cancelling opposite-phase stereo
  // microphone channels. The original file remains the conditioning source.
  const energy = Array(format.channels).fill(0);
  for (let i = 0; i < count; i++) for (let channel = 0; channel < format.channels; channel++) {
    const value = view.getInt16(data.start + i * format.align + channel * 2, true);
    energy[channel] += value * value;
  }
  const selectedChannel = energy.indexOf(Math.max(...energy));
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(data.start + i * format.align + selectedChannel * 2, true) / 32768;
  return { samples, sampleRate: format.sampleRate, channels: format.channels, selectedChannel, duration };
}

export function encodePcmWav(samples, sampleRate) {
  if (!samples?.length || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || samples.length / sampleRate > 60) throw new Error('Audio samples need a valid clock and a duration up to 60 seconds.');
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new Error('Audio samples must be finite.');
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true);
  }
  return bytes;
}
