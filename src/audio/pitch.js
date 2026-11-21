const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MIN_FREQUENCY = 65;
const MAX_FREQUENCY = 1400;
const MIN_RMS = 0.001;

function conditionFrame(samples, sampleRate, mean) {
  // Broadband breath and device noise can dominate YIN's squared difference.
  // A Butterworth low-pass preserves the supported fundamentals while reducing
  // that noise; the periodicity threshold still decides whether a note exists.
  const angle = 2 * Math.PI * Math.min(MAX_FREQUENCY * 1.5, sampleRate * 0.45) / sampleRate;
  const cosine = Math.cos(angle);
  const alpha = Math.sin(angle) / Math.SQRT2;
  const denominator = 1 + alpha;
  const b0 = (1 - cosine) / (2 * denominator);
  const b1 = 2 * b0;
  const a1 = -2 * cosine / denominator;
  const a2 = (1 - alpha) / denominator;
  const conditioned = new Float64Array(samples.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const input = samples[i] - mean;
    const output = b0 * input + z1;
    z1 = b1 * input - a1 * output + z2;
    z2 = b0 * input - a2 * output;
    conditioned[i] = output;
  }
  return conditioned;
}

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
 * Confidence is periodicity after noise conditioning (1 - normalized difference),
 * not a calibrated chance that a note is correct. No result means insufficient
 * usable evidence.
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
  if (Math.sqrt(energy / samples.length) < MIN_RMS) return null;
  samples = conditionFrame(samples, sampleRate, mean);

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
