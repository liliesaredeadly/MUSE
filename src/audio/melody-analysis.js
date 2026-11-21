import { extractHarmonicAnchors } from './harmonic-anchors.js';

const ANALYSIS_RATE = 16000;
const HOP = 160;
const WINDOW = 1024;
const MIN_FREQUENCY = 65;
const MAX_FREQUENCY = 1400;
// Sub-sample YIN interpolation can overshoot an inclusive range endpoint by a
// few cents. Allow only the same five-cent resolution used by contour reduction
// and clamp those boundary estimates, rather than losing an otherwise clear note.
const BOUNDARY_RATIO = 2 ** (5 / 1200);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const toMidi = frequency => 69 + 12 * Math.log2(frequency / 440);
const toFrequency = midi => 440 * 2 ** ((midi - 69) / 12);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function resample(samples, sampleRate) {
  const ratio = sampleRate / ANALYSIS_RATE;
  const result = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= samples.length;
  // A phase-table windowed-sinc low-pass runs BEFORE decimation. A box average
  // alone would fold e.g. 15 kHz at 48 kHz into a very convincing 1 kHz note.
  const halfWidth = Math.ceil(12 * ratio);
  const phases = 256;
  const kernels = ratio > 1 ? Array.from({ length: phases }, (_, phase) => {
    const fraction = phase / phases;
    const cutoff = 3200 / sampleRate;
    const kernel = new Float64Array(2 * halfWidth + 1);
    let sum = 0;
    for (let tap = -halfWidth; tap <= halfWidth; tap++) {
      const distance = tap - fraction;
      const x = 2 * cutoff * distance;
      const sinc = Math.abs(x) < 1e-10 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = Math.abs(distance) > halfWidth ? 0
        : 0.42 + 0.5 * Math.cos(Math.PI * distance / halfWidth) + 0.08 * Math.cos(2 * Math.PI * distance / halfWidth);
      const value = 2 * cutoff * sinc * window;
      kernel[tap + halfWidth] = value;
      sum += value;
    }
    return kernel.map(value => value / sum);
  }) : null;
  for (let index = 0; index < result.length; index++) {
    if (ratio <= 1) {
      const position = index * ratio;
      const left = Math.min(samples.length - 1, Math.floor(position));
      const right = Math.min(samples.length - 1, left + 1);
      result[index] = samples[left] + (samples[right] - samples[left]) * (position - left) - mean;
    } else {
      const position = index * ratio;
      const center = Math.floor(position);
      const kernel = kernels[Math.min(phases - 1, Math.floor((position - center) * phases))];
      let sum = 0;
      for (let tap = 0; tap < kernel.length; tap++) {
        const source = center + tap - halfWidth;
        if (source >= 0 && source < samples.length) sum += samples[source] * kernel[tap];
      }
      result[index] = sum - mean;
    }
  }
  // One continuous Butterworth filter avoids a fresh filter transient at every
  // pitch window. It suppresses breath noise without quantizing the contour.
  const angle = 2 * Math.PI * 2100 / ANALYSIS_RATE;
  const alpha = Math.sin(angle) / Math.SQRT2;
  const denominator = 1 + alpha;
  const b0 = (1 - Math.cos(angle)) / (2 * denominator);
  const b1 = 2 * b0;
  const a1 = -2 * Math.cos(angle) / denominator;
  const a2 = (1 - alpha) / denominator;
  let z1 = 0;
  let z2 = 0;
  for (let index = 0; index < result.length; index++) {
    const input = result[index];
    const output = b0 * input + z1;
    z1 = b1 * input - a1 * output + z2;
    z2 = b0 * input - a2 * output;
    result[index] = output;
  }
  return result;
}

function estimatePitch(samples, center) {
  const minLag = Math.floor(ANALYSIS_RATE / MAX_FREQUENCY);
  const maxLag = Math.ceil(ANALYSIS_RATE / MIN_FREQUENCY);
  const difference = new Float64Array(maxLag + 1);
  const rawDifference = new Float64Array(maxLag + 1);
  let cumulative = 0;
  // Each lag is centered at the SAME audio sample. Unlike a trailing analyser
  // snapshot, changing the period cannot move the observation's timestamp.
  const comparisonLength = WINDOW - maxLag;
  for (let lag = 1; lag <= maxLag; lag++) {
    const begin = Math.round(center - (comparisonLength + lag) / 2);
    let sum = 0;
    for (let index = 0; index < comparisonLength; index++) {
      const first = samples[begin + index] || 0;
      const second = samples[begin + index + lag] || 0;
      sum += (first - second) ** 2;
    }
    rawDifference[lag] = sum;
    cumulative += sum;
    difference[lag] = cumulative > 0 ? sum * lag / cumulative : 1;
  }
  let best = -1;
  const depths = new Map();
  const troughDepth = lag => {
    if (depths.has(lag)) return depths.get(lag);
    const curvature = difference[lag - 1] - 2 * difference[lag] + difference[lag + 1];
    const slope = difference[lag - 1] - difference[lag + 1];
    const period = lag + (curvature > 0 ? Math.max(-1, Math.min(1, slope / (2 * curvature))) : 0);
    const begin = Math.round(center - (comparisonLength + period) / 2);
    let error = 0;
    let energy = 0;
    for (let index = 0; index < comparisonLength; index++) {
      const first = samples[begin + index] || 0;
      const position = begin + index + period;
      const left = Math.floor(position);
      const fraction = position - left;
      const a = samples[left - 1] || 0;
      const b = samples[left] || 0;
      const c = samples[left + 1] || 0;
      const d = samples[left + 2] || 0;
      const second = b + 0.5 * fraction * (c - a + fraction * (2 * a - 5 * b + 4 * c - d + fraction * (3 * (b - c) + d - a)));
      error += (first - second) ** 2;
      energy += first ** 2 + second ** 2;
    }
    const depth = energy > 0 ? error / energy : 1;
    depths.set(lag, depth);
    return depth;
  };
  for (let lag = 2; lag < maxLag; lag++) {
    if (difference[lag] >= 0.15 || difference[lag] > difference[lag - 1] || difference[lag] > difference[lag + 1]) continue;
    if (best < 0) { best = lag; continue; }
    const ratio = lag / best;
    // A stronger second harmonic can produce a shallow half-period trough.
    // Prefer a substantially better doubled/tripled period, while a pure tone's
    // already excellent first period keeps its octave.
    // Compare the interpolated troughs: a short period between integer samples
    // has a shallower sampled minimum even for a pure tone. That sampling error
    // must not make an octave or twelfth look like a stronger fundamental.
    if (ratio < 3.1 && Math.abs(ratio - Math.round(ratio)) < 0.12
      && troughDepth(best) > 0.015 && troughDepth(lag) < troughDepth(best) * 0.2) best = lag;
  }
  if (best < minLag || best >= maxLag) return null;
  const previous = difference[best - 1];
  const current = difference[best];
  const next = difference[best + 1];
  const curvature = previous - 2 * current + next;
  const correction = curvature ? Math.max(-1, Math.min(1, (previous - next) / (2 * curvature))) : 0;
  let estimated = ANALYSIS_RATE / (best + correction);
  if (estimated < MIN_FREQUENCY || estimated > MAX_FREQUENCY) {
    // CMND normalization introduces a small asymmetric interpolation bias. At
    // a range edge, refine the SAME selected period using its raw residual
    // trough; the normalized difference still defines periodicity confidence.
    const rawCurvature = rawDifference[best - 1] - 2 * rawDifference[best] + rawDifference[best + 1];
    const rawCorrection = rawCurvature > 0 ? Math.max(-1, Math.min(1,
      (rawDifference[best - 1] - rawDifference[best + 1]) / (2 * rawCurvature))) : correction;
    estimated = ANALYSIS_RATE / (best + rawCorrection);
  }
  if (estimated < MIN_FREQUENCY / BOUNDARY_RATIO || estimated > MAX_FREQUENCY * BOUNDARY_RATIO) return null;
  const frequency = Math.max(MIN_FREQUENCY, Math.min(MAX_FREQUENCY, estimated));
  return { frequency, midi: toMidi(frequency), confidence: 1 - current };
}

function smoothFrames(frames) {
  const original = frames.map(frame => frame.pitch);
  for (let index = 1; index < frames.length - 1; index++) {
    const [previous, current, next] = original.slice(index - 1, index + 2);
    if (!previous || !current || !next) continue;
    if (Math.abs(previous.midi - next.midi) < 0.45 && Math.abs(current.midi - (previous.midi + next.midi) / 2) > 0.75) {
      const midi = (previous.midi + next.midi) / 2;
      frames[index].pitch = { midi, frequency: toFrequency(midi), confidence: Math.min(previous.confidence, next.confidence) };
    }
  }
  // Mixed-pitch windows can fail periodicity near a genuine transition. Bridge
  // at most 30 ms ONLY when independent central-hop energy says audio exists;
  // a quiet 40 ms articulation remains a rest even if the pitch window overlaps it.
  for (let index = 1; index < frames.length - 1; index++) {
    if (frames[index].pitch || !frames[index].active) continue;
    const first = index;
    while (index < frames.length && !frames[index].pitch && frames[index].active) index++;
    const before = frames[first - 1]?.pitch;
    const after = frames[index]?.pitch;
    if (!before || !after || index - first > 3) continue;
    for (let gap = first; gap < index; gap++) {
      frames[gap].pitch = gap - first < (index - first) / 2 ? { ...before } : { ...after };
    }
  }
}

function simplifyContour(points, tolerance = 5) {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const a = points[first];
    const b = points[last];
    const startCents = 1200 * Math.log2(a.frequency);
    const endCents = 1200 * Math.log2(b.frequency);
    let largest = tolerance;
    let selected = -1;
    for (let index = first + 1; index < last; index++) {
      const fraction = (points[index].time - a.time) / (b.time - a.time);
      const error = Math.abs(1200 * Math.log2(points[index].frequency) - startCents - (endCents - startCents) * fraction);
      if (error > largest) { largest = error; selected = index; }
    }
    if (selected >= 0) { keep.add(selected); stack.push([first, selected], [selected, last]); }
  }
  return [...keep].sort((a, b) => a - b).map(index => points[index]);
}

function noteFromFrames(frames, first, last, duration) {
  const selected = frames.slice(first, last);
  const pitches = selected.filter(frame => frame.pitch).map(frame => frame.pitch);
  const midi = Math.round(median(pitches.map(pitch => pitch.midi)));
  const start = first * HOP / ANALYSIS_RATE;
  const end = Math.min(duration, last * HOP / ANALYSIS_RATE);
  const points = selected.filter(frame => frame.pitch).map(frame => ({
    time: Math.min(end - start, Math.max(0, frame.time - start)), frequency: frame.pitch.frequency,
  }));
  if (points[0].time > 0) points.unshift({ time: 0, frequency: points[0].frequency });
  if (points.at(-1).time < end - start) points.push({ time: end - start, frequency: points.at(-1).frequency });
  return { midi, name: `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`, start, duration: end - start,
    confidence: pitches.reduce((sum, pitch) => sum + pitch.confidence, 0) / pitches.length,
    contour: simplifyContour(points) };
}

function segmentNotes(frames, duration) {
  const labels = frames.map(frame => frame.pitch ? Math.round(frame.pitch.midi) : null);
  // Remove a single rounded-boundary outlier without flattening the actual Hz
  // contour. Stable adjacent semitones remain separate lead notes.
  for (let index = 1; index < labels.length - 1; index++) {
    if (labels[index - 1] !== null && labels[index - 1] === labels[index + 1] && labels[index] !== null) labels[index] = labels[index - 1];
  }
  const runs = [];
  for (let first = 0; first < frames.length;) {
    if (labels[first] === null) { first++; continue; }
    let last = first + 1;
    while (last < frames.length && labels[last] === labels[first]) last++;
    const center = median(frames.slice(first, last).filter(frame => frame.pitch).map(frame => frame.pitch.midi));
    const previous = runs.at(-1);
    // Rounded labels alone would split a slightly detuned vibrato each time it
    // crosses 50 cents. Merge neighboring runs whose actual central frequencies
    // remain within natural tuning wobble; a stable semitone step still differs
    // by approximately one MIDI unit and survives.
    if (previous && previous.last === first && Math.abs(previous.center - center) <= 0.65) {
      previous.last = last;
      previous.center = median(frames.slice(previous.first, last).filter(frame => frame.pitch).map(frame => frame.pitch.midi));
    } else runs.push({ first, last, center });
    first = last;
  }
  return runs.filter(run => (run.last - run.first) * HOP / ANALYSIS_RATE >= 0.05)
    .map(run => noteFromFrames(frames, run.first, run.last, duration));
}

function rhythmFromNotes(notes, duration) {
  const onsets = notes.map(note => note.start);
  const intervals = onsets.slice(1).map((onset, index) => onset - onsets[index]);
  const rests = [];
  let end = 0;
  for (const note of notes) {
    if (note.start - end > 0.005) rests.push({ start: end, duration: note.start - end });
    end = Math.max(end, note.start + note.duration);
  }
  if (duration - end > 0.005) rests.push({ start: end, duration: duration - end });
  // IOIs may be subdivisions, syncopation or rubato. This is a tempo suggestion,
  // never a grid used to move notes or replace their measured rhythm.
  let estimatedBpm = null;
  if (intervals.length >= 3) {
    let beat = median(intervals);
    while (beat < 0.3) beat *= 2;
    while (beat > 1.0) beat /= 2;
    estimatedBpm = Math.round(60 / beat);
  }
  return { onsets, rests, intervals, estimatedBpm };
}

/**
 * Analyze a complete mono PCM take on a sample clock, independently of browser
 * animation callbacks. Intended for one hummed/sung lead, not polyphonic songs.
 * Contour times inside notes are relative seconds; top-level times are absolute.
 * Periodicity confidence is evidence, not a calibrated transcription probability.
 */
export function analyzeMelody(samples, sampleRate) {
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new TypeError('PCM samples must be a nonempty mono Float32Array.');
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new RangeError('PCM sample rate must be between 8000 and 96000 Hz.');
  const duration = samples.length / sampleRate;
  if (duration > 60) throw new RangeError('PCM duration must not exceed 60 seconds.');
  for (const sample of samples) if (!Number.isFinite(sample)) throw new TypeError('PCM samples must contain only finite values.');
  const audio = resample(samples, sampleRate);
  const levels = [];
  for (let start = 0; start < audio.length; start += HOP) {
    const end = Math.min(audio.length, start + HOP);
    let energy = 0;
    for (let index = start; index < end; index++) energy += audio[index] ** 2;
    levels.push(Math.sqrt(energy / (end - start)));
  }
  const sortedLevels = [...levels].sort((a, b) => a - b);
  const peak = sortedLevels.at(-1) || 0;
  const floor = sortedLevels[Math.floor(sortedLevels.length * 0.1)] || 0;
  const energyGate = Math.max(0.00025, floor < peak * 0.45 ? Math.min(peak * 0.4, floor * 1.6) : peak * 0.1);
  const frames = levels.map((level, index) => {
    const center = index * HOP + HOP / 2;
    const active = level >= energyGate;
    return { time: center / ANALYSIS_RATE, active, pitch: active ? estimatePitch(audio, center) : null };
  });
  smoothFrames(frames);
  let notes = segmentNotes(frames, duration);
  let harmonicEvidence;
  // Periodicity alone can reject a weak human fundamental underneath changing
  // formants. Supplement sparse results with independently supported harmonic
  // families, retaining silence and every unsupported gap. This analysis never
  // changes the retained recording used for the audible lead.
  const strictVoicedSeconds = notes.reduce((sum, note) => sum + note.duration, 0);
  if (strictVoicedSeconds / duration < 0.55) {
    const evidence = extractHarmonicAnchors(audio, ANALYSIS_RATE);
    if (evidence.anchors.length) {
      harmonicEvidence = { method: evidence.method, anchors: evidence.anchors.slice(0, 512).map(
        ({ midi, name, start, duration, frequency, confidence, supportCount, coverage }) =>
          ({ midi, name, start, duration, frequency, confidence, supportCount, coverage })) };
      for (const frame of frames) {
        if (!frame.active) continue;
        const anchor = evidence.anchors.find(item => frame.time >= item.start && frame.time < item.start + item.duration);
        if (!anchor || frame.pitch && Math.abs(1200 * Math.log2(frame.pitch.frequency / anchor.frequency)) < 50) continue;
        frame.pitch = { frequency: anchor.frequency, midi: toMidi(anchor.frequency), confidence: anchor.confidence };
      }
      smoothFrames(frames);
      notes = segmentNotes(frames, duration);
    }
  }
  const warnings = [];
  if (notes.length > 512) { notes = notes.slice(0, 512); warnings.push('Only the first 512 recognized notes are retained.'); }
  // RDP normally reduces steady tones to two points. When a highly variable
  // minute exceeds the wire-format budget, increase tolerance explicitly and
  // report the reduction instead of silently slicing off its final contour.
  let tolerance = 5;
  while (notes.some(note => note.contour.length > 2000) || notes.reduce((sum, note) => sum + note.contour.length, 0) > 4000) {
    tolerance *= 1.5;
    notes = notes.map(note => ({ ...note, contour: simplifyContour(note.contour, tolerance) }));
  }
  if (tolerance > 5) warnings.push(`Dense pitch contour simplified to a ${Math.ceil(tolerance)}-cent tolerance to fit storage limits.`);
  if (!notes.length) warnings.push('No reliable monophonic pitched melody was found. Try a clear solo hum without music or speech.');
  const contour = notes.flatMap(note => note.contour.map(point => ({ time: note.start + point.time, frequency: point.frequency,
    midi: toMidi(point.frequency), confidence: note.confidence })));
  const voicedSeconds = notes.reduce((sum, note) => sum + note.duration, 0);
  if (notes.length && voicedSeconds / duration < 0.2) warnings.push('Only a small part of this take contains reliable pitched evidence. The transcription may omit unclear portions; compare it with the original take.');
  return { notes, contour, rhythm: rhythmFromNotes(notes, duration), duration, sampleRate,
    voicedRatio: Math.min(1, voicedSeconds / duration), method: harmonicEvidence ? 'offline-yin-harmonic-consensus-16k-v2' : 'offline-centered-yin-16k-10ms-v1',
    ...(harmonicEvidence ? { harmonicEvidence } : {}), warnings };
}
