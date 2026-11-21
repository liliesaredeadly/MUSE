const METHOD = 'spectral-harmonic-consensus-v1';
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MIN_FREQUENCY = 65;
const MAX_FREQUENCY = 1400;
const MAX_HARMONIC = 12;
const MATCH_CENTS = 35;

function centsBetween(a, b) {
  return Math.abs(1200 * Math.log2(a / b));
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// A radix-two FFT is kept local to this offline helper; no browser audio node or
// source PCM is modified. The plan and scratch arrays are reused across frames.
function createSpectrum(frameSize) {
  let size = 1;
  while (size < frameSize * 4) size *= 2;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  const power = new Float64Array(size / 2 + 1);
  const reversed = new Uint32Array(size);
  const window = Float64Array.from({ length: frameSize }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frameSize - 1)));
  for (let i = 1; i < size; i++) reversed[i] = (reversed[i >> 1] >> 1) | ((i & 1) ? size >> 1 : 0);
  const stages = [];
  for (let length = 2; length <= size; length *= 2) {
    const half = length / 2;
    stages.push({ length, half,
      cos: Float64Array.from({ length: half }, (_, i) => Math.cos(-2 * Math.PI * i / length)),
      sin: Float64Array.from({ length: half }, (_, i) => Math.sin(-2 * Math.PI * i / length)),
    });
  }
  return {
    size,
    calculate(samples, offset, mean) {
      real.fill(0);
      imaginary.fill(0);
      for (let i = 0; i < frameSize; i++) real[reversed[i]] = (samples[offset + i] - mean) * window[i];
      for (const { length, half, cos, sin } of stages) {
        for (let start = 0; start < size; start += length) {
          for (let i = 0; i < half; i++) {
            const left = start + i;
            const right = left + half;
            const re = cos[i] * real[right] - sin[i] * imaginary[right];
            const im = sin[i] * real[right] + cos[i] * imaginary[right];
            real[right] = real[left] - re;
            imaginary[right] = imaginary[left] - im;
            real[left] += re;
            imaginary[left] += im;
          }
        }
      }
      for (let i = 0; i < power.length; i++) power[i] = real[i] ** 2 + imaginary[i] ** 2;
      return power;
    },
  };
}

function spectralPeaks(power, sampleRate, fftSize, frameSize) {
  const resolution = sampleRate / fftSize;
  const low = Math.ceil(MIN_FREQUENCY / resolution);
  // Upper partials are evidence, including partials above the supported F0 range.
  // Counting the upper band also prevents an out-of-range tone being hidden.
  const high = Math.min(power.length - 2, Math.floor(Math.min(6000, sampleRate * 0.475) / resolution));
  const background = Array.from(power.subarray(low, high + 1)).sort((a, b) => a - b);
  const floor = background[Math.floor(background.length / 2)] || 1e-20;
  const maxima = [];
  for (let i = low; i <= high; i++) {
    if (power[i] > power[i - 1] && power[i] > power[i + 1]) maxima.push(i);
  }
  maxima.sort((a, b) => power[b] - power[a]);
  if (!maxima.length || power[maxima[0]] / floor < 10 ** 1.8) return [];
  const strongest = power[maxima[0]];
  const peaks = [];
  for (const i of maxima) {
    if (power[i] / strongest < 10 ** -2.5 || power[i] / floor < 10 ** 1.2) continue;
    const previous = Math.log(Math.max(power[i - 1], 1e-30));
    const current = Math.log(Math.max(power[i], 1e-30));
    const next = Math.log(Math.max(power[i + 1], 1e-30));
    const curvature = previous - 2 * current + next;
    const shift = curvature ? Math.max(-0.5, Math.min(0.5, 0.5 * (previous - next) / curvature)) : 0;
    const frequency = (i + shift) * resolution;
    if (peaks.some(peak => Math.abs(peak.frequency - frequency) < 2 * sampleRate / frameSize)) continue;
    peaks.push({ frequency, power: power[i] / strongest,
      energy: 8 * power[i] / frameSize ** 2 });
    if (peaks.length === 12) break;
  }
  return peaks;
}

function matchHarmonics(peaks, frequency) {
  const support = [];
  const used = new Set();
  // Peaks are strongest first: a broad lobe or adjacent noise maximum cannot
  // contribute twice to one harmonic number.
  for (const peak of peaks) {
    const harmonic = Math.round(peak.frequency / frequency);
    if (harmonic < 1 || harmonic > MAX_HARMONIC || used.has(harmonic)) continue;
    if (centsBetween(peak.frequency, harmonic * frequency) > MATCH_CENTS) continue;
    used.add(harmonic);
    support.push({ ...peak, harmonic });
  }
  return support;
}

function harmonicCandidates(peaks) {
  const totalPower = peaks.reduce((sum, peak) => sum + peak.power, 0);
  const candidates = [];
  for (const peak of peaks) {
    for (let harmonic = 1; harmonic <= MAX_HARMONIC; harmonic++) {
      let frequency = peak.frequency / harmonic;
      if (frequency < MIN_FREQUENCY || frequency > MAX_FREQUENCY) continue;
      let support = matchHarmonics(peaks, frequency);
      if (support.length < 3) continue;
      let matchedPower = support.reduce((sum, hit) => sum + hit.power, 0);
      frequency = support.reduce((sum, hit) => sum + hit.power * hit.frequency / hit.harmonic, 0) / matchedPower;
      support = matchHarmonics(peaks, frequency);
      if (support.length < 3 || support.reduce((value, hit) => gcd(value, hit.harmonic), 0) !== 1) continue;
      if (frequency < MIN_FREQUENCY || frequency > MAX_FREQUENCY) continue;
      matchedPower = support.reduce((sum, hit) => sum + hit.power, 0);
      const coverage = matchedPower / totalPower;
      const candidate = { frequency, coverage, support };
      const equivalent = candidates.findIndex(old => centsBetween(old.frequency, frequency) < 20);
      if (equivalent < 0) candidates.push(candidate);
      else if (coverage > candidates[equivalent].coverage) candidates[equivalent] = candidate;
    }
  }
  return candidates.sort((a, b) => b.coverage - a.coverage || b.frequency - a.frequency);
}

function hasCentralSupport(samples, offset, frameSize, hop, sampleRate, mean, candidate) {
  const start = offset + Math.floor((frameSize - hop) / 2);
  const expectedEnergy = candidate.support.reduce((sum, hit) => sum + hit.energy, 0);
  const quarters = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  let rawEnergy = 0;
  let windowSum = 0;
  const windowed = new Float64Array(hop);
  for (let i = 0; i < hop; i++) {
    const sample = samples[start + i] - mean;
    const quarter = Math.min(3, Math.floor(i * 4 / hop));
    rawEnergy += sample ** 2;
    quarters[quarter] += sample ** 2;
    counts[quarter]++;
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (hop - 1));
    windowed[i] = sample * weight;
    windowSum += weight;
  }
  rawEnergy /= hop;
  // The long FFT establishes a harmonic family, but cannot prove when it was
  // present. Each 10 ms quarter must contain energy inside the reported hop.
  if (quarters.some((energy, i) => energy / counts[i] < 0.08 * expectedEnergy)) return false;
  let matchedEnergy = 0;
  for (const hit of candidate.support) {
    const angle = 2 * Math.PI * candidate.frequency * hit.harmonic / sampleRate;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    let oscillatorReal = 1;
    let oscillatorImaginary = 0;
    let real = 0;
    let imaginary = 0;
    for (let i = 0; i < hop; i++) {
      real += windowed[i] * oscillatorReal;
      imaginary += windowed[i] * oscillatorImaginary;
      const next = oscillatorReal * cosine - oscillatorImaginary * sine;
      oscillatorImaginary = oscillatorReal * sine + oscillatorImaginary * cosine;
      oscillatorReal = next;
    }
    // A real sinusoid's complex projection has amplitude A * windowSum / 2.
    matchedEnergy += 2 * (real ** 2 + imaginary ** 2) / windowSum ** 2;
  }
  return matchedEnergy >= 0.35 * expectedEnergy && matchedEnergy >= 0.25 * rawEnergy;
}

function makeAnchor(run, hopSeconds, duration) {
  const first = run[0];
  const start = Math.max(0, first.time - hopSeconds / 2);
  const end = Math.min(duration, run.at(-1).time + hopSeconds / 2);
  if (end - start < 0.12 - 1e-8) return null;
  const frequencies = run.map(frame => frame.frequency).sort((a, b) => a - b);
  const frequency = frequencies[Math.floor(frequencies.length / 2)];
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  const coverage = Math.min(...run.map(frame => frame.coverage));
  return { midi, name: `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`,
    start, duration: end - start, confidence: coverage, frequency,
    supportCount: Math.min(...run.map(frame => frame.supportCount)), coverage, frameCount: run.length };
}

/**
 * Sparse, verified harmonic anchors from mono PCM. These supplement pitch
 * analysis; absence of an anchor is not evidence for silence or a different note.
 * Confidence is the fraction of narrow-peak power explained by one harmonic
 * family, not a calibrated probability. supportCount counts distinct harmonics.
 * Tone presence is checked in the central 40 ms hop, including its 10 ms
 * quarters. Rejected frames break runs; the helper never fills uncertain gaps.
 */
export function extractHarmonicAnchors(samples, sampleRate = 16000) {
  const result = { anchors: [], frames: [], method: METHOD };
  if (!samples || !Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 192000) return result;
  const frameSize = Math.round(sampleRate * 0.128);
  const hop = Math.round(sampleRate * 0.04);
  if (!Number.isInteger(samples.length) || samples.length < frameSize || samples.length > sampleRate * 60) return result;
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) return result;
  const spectrum = createSpectrum(frameSize);
  for (let offset = 0; offset + frameSize <= samples.length; offset += hop) {
    const frame = { time: (offset + frameSize / 2) / sampleRate, accepted: false };
    let mean = 0;
    for (let i = 0; i < frameSize; i++) mean += samples[offset + i];
    mean /= frameSize;
    let energy = 0;
    for (let i = 0; i < frameSize; i++) energy += (samples[offset + i] - mean) ** 2;
    if (Math.sqrt(energy / frameSize) >= 0.001) {
      const peaks = spectralPeaks(spectrum.calculate(samples, offset, mean), sampleRate, spectrum.size, frameSize);
      const candidates = harmonicCandidates(peaks);
      const best = candidates[0];
      if (best && best.coverage >= 0.9 && best.coverage - (candidates[1]?.coverage || 0) >= 0.03
        && hasCentralSupport(samples, offset, frameSize, hop, sampleRate, mean, best)) {
        Object.assign(frame, { accepted: true, frequency: best.frequency,
          midi: Math.round(69 + 12 * Math.log2(best.frequency / 440)), confidence: best.coverage,
          coverage: best.coverage, supportCount: best.support.length, support: best.support });
      }
    }
    result.frames.push(frame);
  }
  let run = [];
  const finish = () => {
    if (run.length) {
      const anchor = makeAnchor(run, hop / sampleRate, samples.length / sampleRate);
      if (anchor) result.anchors.push(anchor);
    }
    run = [];
  };
  for (const frame of result.frames) {
    if (!frame.accepted || (run.length && frame.midi !== run[0].midi)) finish();
    if (frame.accepted) run.push(frame);
  }
  finish();
  return result;
}
