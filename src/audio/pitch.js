const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MIN_FREQUENCY = 65;
const MAX_FREQUENCY = 1400;

export function midiToFrequency(midi) {
  return Number.isFinite(midi) ? 440 * 2 ** ((midi - 69) / 12) : NaN;
}

export function frequencyToNote(frequency) {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  if (midi < 0 || midi > 127) return null;
  return { midi, name: `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}` };
}

/**
 * Monophonic YIN pitch estimate for a raw time-domain frame, usually 4096 samples.
 * Confidence is periodicity (1 - normalized difference), not a calibrated chance
 * that a musical note is correct. No result means insufficient usable evidence.
 */
export function detectPitch(samples, sampleRate) {
  if (!samples || samples.length < 256 || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const maxLag = Math.ceil(sampleRate / MIN_FREQUENCY);
  if (samples.length < maxLag * 2 + 2) return null;

  let mean = 0;
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) return null;
    mean += samples[i];
  }
  mean /= samples.length;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += (samples[i] - mean) ** 2;
  if (Math.sqrt(energy / samples.length) < 0.008) return null;

  const windowSize = Math.min(2048, samples.length - maxLag - 1);
  const difference = new Float64Array(maxLag + 1);
  difference[0] = 1;
  let cumulative = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < windowSize; i++) sum += (samples[i] - samples[i + lag]) ** 2;
    cumulative += sum;
    difference[lag] = cumulative > 0 ? sum * lag / cumulative : 1;
  }

  // Find the first sufficiently periodic trough, including frequencies above our
  // allowed range: skipping those troughs would turn a high tone into a false octave.
  let lag = 2;
  for (; lag < maxLag; lag++) {
    if (difference[lag] < 0.15) {
      while (lag + 1 <= maxLag && difference[lag + 1] < difference[lag]) lag++;
      break;
    }
  }
  if (lag >= maxLag) return null;
  const previous = difference[lag - 1];
  const current = difference[lag];
  const next = difference[lag + 1];
  const curvature = previous - 2 * current + next;
  const adjustment = curvature ? Math.max(-1, Math.min(1, (previous - next) / (2 * curvature))) : 0;
  const frequency = sampleRate / (lag + adjustment);
  const confidence = Math.max(0, Math.min(1, 1 - current));
  if (frequency < MIN_FREQUENCY || frequency > MAX_FREQUENCY || confidence < 0.85) return null;
  const note = frequencyToNote(frequency);
  return note ? { frequency, ...note, confidence } : null;
}
