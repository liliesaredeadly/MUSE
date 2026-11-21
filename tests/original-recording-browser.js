import { api } from '../src/lib/api.js';
import { decodePcmWav, encodePcmWav } from '../src/audio/pcm-wav.js';
import { exportWav } from '../src/audio/synth.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const round = value => Math.round(value * 1000000) / 1000000;
const settings = { bpm: 90, sourceBpm: 90, production: 'dance-pop', leadSource: 'recording',
  instrument: 'Piano', mood: 'Dreamy', genre: 'Electronic', accompaniment: true, bass: true, percussion: true, preserveMelodyTiming: true };

function syntheticWholeWave() {
  const rate = 16000; const samples = new Float32Array(rate * 3); let phase = 0; let seed = 481;
  for (let index = 0; index < samples.length; index++) {
    const time = index / rate;
    const frequency = 245 + 58 * Math.sin(time * 2.2) + 14 * Math.sin(time * 9.7);
    phase += 2 * Math.PI * frequency / rate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 4294967296 * 2 - 1) * 0.0015;
    samples[index] = (0.025 + 0.01 * Math.sin(time * 4.3) ** 2) * Math.sin(phase) + noise;
  }
  return new Blob([encodePcmWav(samples, rate)], { type: 'audio/wav' });
}

async function fingerprint(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function decodeNative(blob) {
  return new OfflineAudioContext(2, 1, 44100).decodeAudioData(await blob.arrayBuffer());
}

function pcmMetrics(buffer) {
  let energy = 0; let peak = 0; let clipped = 0; let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    for (const value of buffer.getChannelData(channel)) {
      assert(Number.isFinite(value), 'The real audio renderer returned nonfinite samples.');
      energy += value * value; peak = Math.max(peak, Math.abs(value)); count++;
      if (Math.abs(value) >= 0.999) clipped++;
    }
  }
  return { duration: buffer.length / buffer.sampleRate, rms: Math.sqrt(energy / count), peak, clipped };
}

async function resampleSource(decoded) {
  // An independent native baseline: only the actual normalized PCM connected
  // straight to a destination. No arranger, voice/envelope or pitch estimator.
  const context = new OfflineAudioContext(1, Math.ceil(decoded.duration * 44100), 44100);
  const buffer = context.createBuffer(1, decoded.samples.length, decoded.sampleRate);
  buffer.getChannelData(0).set(decoded.samples);
  const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = 1;
  source.connect(context.destination); source.start(0);
  return context.startRendering();
}

function correlateOriginal(reference, lead) {
  assert(lead.sampleRate === reference.sampleRate, 'The source and rendered lead clocks differ.');
  const first = Math.ceil(0.01 * reference.sampleRate);
  const last = reference.length - first;
  assert(last > first, 'The take is too short for an interior waveform comparison.');
  const input = reference.getChannelData(0); const output = lead.getChannelData(0);
  let dot = 0; let inputEnergy = 0; let outputEnergy = 0;
  for (let index = first; index < last; index++) {
    dot += input[index] * output[index]; inputEnergy += input[index] ** 2; outputEnergy += output[index] ** 2;
  }
  const correlation = dot / Math.sqrt(inputEnergy * outputEnergy);
  const gain = dot / inputEnergy;
  let residual = 0;
  for (let index = first; index < last; index++) residual += (output[index] - input[index] * gain) ** 2;
  assert(Number.isFinite(correlation) && correlation >= 0.99, `The original waveform changed: zero-lag correlation ${correlation}.`);
  assert(gain > 0 && gain <= 8 * 0.74 + 1e-6, `Original gain ${gain} exceeds its bounded constant normalization.`);
  return { zeroLagCorrelation: round(correlation), measuredConstantGainIncludingMaster: round(gain),
    residualRmsAfterConstantGain: round(Math.sqrt(residual / (last - first))),
    excludedOuterEdgeSeconds: 0.01, sourceResampledByNativeBufferSource: true };
}

async function run() {
  const button = document.getElementById('run'); const output = document.getElementById('results');
  if (button.disabled) return; button.disabled = true;
  const results = []; const file = document.getElementById('take').files[0]; const blob = file || syntheticWholeWave();
  let extracted; let source; let decoded; let reference;
  const show = current => { output.textContent = JSON.stringify({ status: current ? 'running' : results.every(result => result.passed) ? 'passed' : 'failed',
    current, input: file ? 'chosen local take (audio not published)' : 'synthetic whole-wave fixture',
    passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, results }, null, 2); };
  async function check(name, action) {
    show(name);
    try { results.push({ name, passed: true, metrics: await action() }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  }
  try {
    await check('Actual normalized PCM arrives with a matching receipt and complete source clock', async () => {
      extracted = await api.analyzeRecording(blob, 60);
      const bytes = await extracted.audioWav.arrayBuffer(); decoded = decodePcmWav(new Uint8Array(bytes));
      assert(await fingerprint(bytes) === extracted.receipt.sha256, 'The retained original WAV does not match the received audio fingerprint.');
      assert(Math.abs(decoded.duration - extracted.receipt.duration) <= 1 / decoded.sampleRate, 'The source clock changed.');
      source = { blob, duration: 60, notes: structuredClone(extracted.analysis.notes), receipt: extracted.receipt,
        audioWav: extracted.audioWav, conditioningId: extracted.conditioningId };
      reference = await resampleSource(decoded);
      return { actualWavHashVerified: true, sourceDuration: decoded.duration, sourceSampleRate: decoded.sampleRate,
        extractedNotes: extracted.analysis.notes.length, voicedCoverage: extracted.analysis.voicedRatio,
        sparseExtractionDoesNotDefineRecordingLead: true };
    });
    if (source) {
      for (const production of ['dance-pop', 'percussive-pop']) {
        await check(`${production}: complete actual source waveform survives native lead and mix rendering`, async () => {
          const arrangement = await api.arrange(source.notes, { ...settings, production,
            genre: production === 'dance-pop' ? 'Electronic' : 'Pop' }, source.conditioningId, source);
          assert(arrangement.recordingLead?.audioWav instanceof Blob, 'The actual recording Blob was not attached to its source-bound arrangement.');
          assert(arrangement.recordingLead.sha256 === extracted.receipt.sha256, 'The arrangement attached a different recording.');
          assert(arrangement.events.every(event => event.track !== 'melody'), 'A synthetic melody still competes with the protected original.');
          assert(Math.abs(arrangement.duration - decoded.duration) <= 1 / decoded.sampleRate, 'The arrangement was truncated at its last detected note.');
          const solo = await decodeNative(await exportWav({ ...arrangement, events: [] }));
          const sourceMatch = correlateOriginal(reference, solo);
          const soloMetrics = pcmMetrics(solo);
          assert(soloMetrics.duration >= decoded.duration && soloMetrics.duration <= decoded.duration + 1.601, 'The full source clock or fixed output tail changed.');
          const full = await decodeNative(await exportWav(arrangement)); const fullMetrics = pcmMetrics(full);
          assert(fullMetrics.clipped === 0 && fullMetrics.peak < 0.98, 'The recording arrangement clips.');
          let backingMetrics = { rms: 0, peak: 0, clipped: 0 };
          if (arrangement.events.length) {
            const backing = await decodeNative(await exportWav({ ...arrangement, settings: { ...arrangement.settings, leadSource: 'instrument' } }));
            backingMetrics = pcmMetrics(backing);
          }
          const ratio = backingMetrics.rms > 0 ? soloMetrics.rms / backingMetrics.rms : null;
          return { sourceMatch, originalWholeDuration: decoded.duration, noSynthesizedLead: true,
            leadRms: round(soloMetrics.rms), backingRms: round(backingMetrics.rms), leadToBackingRmsRatio: ratio === null ? null : round(ratio),
            foregroundTargetRatio: 1.5, foregroundTargetMet: ratio === null || ratio >= 1.5,
            fullMixPeak: round(fullMetrics.peak), fullMixRms: round(fullMetrics.rms), clippedSamples: fullMetrics.clipped,
            limitation: 'Waveform correlation proves this original lead survives a fixed gain and native resampling. Mix RMS is not subjective listening or a new transcription-accuracy claim.' };
        });
      }
      await check('Missing original WAV cannot silently fall back to instrument notes', async () => {
        let failure;
        try { await exportWav({ duration: extracted.receipt.duration, events: [], settings: { leadSource: 'recording' },
          recordingLead: { duration: extracted.receipt.duration, sha256: extracted.receipt.sha256 } }); }
        catch (error) { failure = error; }
        assert(failure && /recording|original|WAV/i.test(failure.message), 'The missing original was silently replaced.');
        return { rejectedMissingWav: true, instrumentFallback: false };
      });
    }
  } finally { button.disabled = false; show(null); }
}
document.getElementById('run').addEventListener('click', run);
