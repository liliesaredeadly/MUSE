import { buildArrangement } from '../src/music/arrangement.js';
import { exportWav } from '../src/audio/synth.js';
import { decodePcmWav, encodePcmWav } from '../src/audio/pcm-wav.js';
import { assertMelodyPreserved } from '../src/music/melody-contract.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const round = value => Math.round(value * 1e6) / 1e6;
const layer = (id, instrument, role, extra = {}) => ({ id, instrument, role, enabled: true, gain: 0.6, section: 'full', variant: 0, ...extra });
const blueprint = () => ({ version: 1, prompt: 'Guitar and piano, sustained violin, cello bass and drums.', mood: 'Cinematic', intensity: 0.8, layers: [
  layer('guitar', 'Acoustic Guitar', 'rhythm'), layer('piano', 'Piano', 'arpeggio'),
  layer('violin', 'Violin', 'sustain', { section: 'ending' }), layer('cello', 'Cello', 'bass'),
  layer('synth', 'Synthesizer', 'texture'), layer('bass', 'Bass', 'bass'), layer('drums', 'Drums', 'percussion'),
] });
const notes = [{ midi: 60, start: 0.2, duration: 0.4 }, { midi: 64, start: 0.8, duration: 0.3 },
  { midi: 67, start: 1.4, duration: 0.45 }, { midi: 65, start: 2.3, duration: 0.5 },
  { midi: 62, start: 3.2, duration: 0.3 }, { midi: 60, start: 3.7, duration: 0.3 }];
const settings = plan => ({ bpm: 120, sourceBpm: 90, instrument: 'Piano', genre: 'Pop', production: 'percussive-pop', mood: 'Dreamy', preserveMelodyTiming: true, blueprint: plan });

async function render(arrangement) {
  const bytes = await (await exportWav(arrangement)).arrayBuffer();
  return new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes);
}
function metrics(buffer) {
  let peak = 0; let energy = 0; let clipped = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) for (const value of buffer.getChannelData(channel)) {
    assert(Number.isFinite(value), 'Rendered PCM contains a nonfinite sample.');
    peak = Math.max(peak, Math.abs(value)); energy += value * value;
    if (Math.abs(value) >= 0.999) clipped++;
  }
  return { peak: round(peak), rms: round(Math.sqrt(energy / (buffer.length * buffer.numberOfChannels))), clipped,
    duration: round(buffer.length / buffer.sampleRate) };
}
function normalizedDifference(first, second) {
  const left = first.getChannelData(0); const right = second.getChannelData(0);
  const leftRms = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0) / left.length);
  const rightRms = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0) / right.length);
  let energy = 0;
  for (let i = 0; i < left.length; i++) energy += (left[i] / leftRms - right[i] / rightRms) ** 2;
  return Math.sqrt(energy / left.length);
}
async function fingerprint(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function sourceFixture(rate, seed) {
  const samples = new Float32Array(rate * 4); let phase = 0;
  for (let i = 0; i < samples.length; i++) {
    const time = i / rate;
    phase += 2 * Math.PI * (180 + seed * 7 + 25 * Math.sin(time * 3.7) + 7 * Math.sin(time * 23)) / rate;
    samples[i] = 0.06 * (0.7 + 0.3 * Math.sin(time * 4.1) ** 2) * (Math.sin(phase) + 0.19 * Math.sin(phase * 2));
  }
  return encodePcmWav(samples, rate);
}
async function independentSource(decoded) {
  const context = new OfflineAudioContext(1, Math.ceil(decoded.duration * 44100), 44100);
  const buffer = context.createBuffer(1, decoded.samples.length, decoded.sampleRate); buffer.getChannelData(0).set(decoded.samples);
  const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = 1;
  source.connect(context.destination); source.start(0);
  return context.startRendering();
}
function sourceMatch(reference, actual) {
  const input = reference.getChannelData(0); const output = actual.getChannelData(0);
  const first = Math.ceil(0.01 * reference.sampleRate); const last = input.length - first;
  let dot = 0; let energy = 0; let outputEnergy = 0;
  for (let i = first; i < last; i++) { dot += input[i] * output[i]; energy += input[i] ** 2; outputEnergy += output[i] ** 2; }
  const correlation = dot / Math.sqrt(energy * outputEnergy);
  const gain = dot / energy;
  assert(correlation > 0.999, `Original waveform changed: zero-lag correlation ${correlation}.`);
  assert(gain > 0 && gain <= 8 * 0.74 + 1e-6, 'The source normalization exceeded its bounded fixed gain.');
  return { zeroLagCorrelation: round(correlation), constantGainIncludingMaster: round(gain) };
}

export async function runDirectorAudioTests() {
  const button = document.getElementById('run'); const output = document.getElementById('results');
  if (button.disabled) return; button.disabled = true;
  const results = [];
  const show = current => { output.textContent = JSON.stringify({ status: current ? 'running' : results.every(result => result.passed) ? 'passed' : 'failed',
    current, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length,
    syntheticFixturesOnly: true, results }, null, 2); };
  async function check(name, action) {
    show(name);
    try { results.push({ name, passed: true, metrics: await action() }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  }
  try {
    await check('Piano, guitar, violin and cello produce distinct native PCM beyond simple volume differences', async () => {
      const renders = [];
      for (const instrument of ['Piano', 'Acoustic Guitar', 'Violin', 'Cello']) {
        const rendered = await render({ bpm: 100, duration: 0.8, events: [{ midi: 60, start: 0, duration: 0.8, velocity: 0.7, instrument, track: 'chords' }] });
        const measure = metrics(rendered); assert(measure.rms > 0.0005 && measure.clipped === 0, `${instrument} is silent or clips.`);
        renders.push({ instrument, rendered, measure });
      }
      const differences = [];
      for (let i = 0; i < renders.length; i++) for (let j = i + 1; j < renders.length; j++) {
        const difference = normalizedDifference(renders[i].rendered, renders[j].rendered);
        assert(difference > 0.05, `${renders[i].instrument} and ${renders[j].instrument} still share an indistinguishable voice.`);
        differences.push({ instruments: [renders[i].instrument, renders[j].instrument], normalizedPcmDifferenceRms: round(difference) });
      }
      return { voices: renders.map(({ instrument, measure }) => ({ instrument, ...measure })), differences,
        limitation: 'Native synthesized timbre differences do not prove sampled-instrument realism or subjective polish.' };
    });
    await check('Guitar gain changes audible backing level and zero gain is silent', async () => {
      const levels = [];
      for (const gain of [0, 0.2, 0.8]) {
        const arrangement = { bpm: 120, duration: 0.8, layers: [{ id: 'guitar', gain, enabled: true, blocked: false }],
          events: [{ midi: 60, start: 0, duration: 0.8, velocity: 0.7, instrument: 'Acoustic Guitar', layerId: 'guitar', track: 'chords' }] };
        levels.push({ gain, ...metrics(await render(arrangement)) });
      }
      assert(levels[0].peak === 0 && levels[1].rms > 0 && levels[2].rms > levels[1].rms * 2, 'Layer gain failed to change native audio energy.');
      return levels;
    });
    await check('Seven independent layers render with headroom, final-only strings and unchanged note lead', async () => {
      const plan = blueprint(); plan.layers.forEach(item => { item.gain = 1; }); plan.intensity = 1;
      const arrangement = buildArrangement(notes, settings(plan)); assertMelodyPreserved(notes, arrangement);
      const strings = arrangement.events.filter(event => event.layerId === 'violin');
      assert(strings.length && strings.every(event => event.start >= 3), 'Final-only strings entered before the final quarter.');
      const result = metrics(await render(arrangement));
      assert(result.rms > 0.005 && result.peak < 0.98 && result.clipped === 0, 'The full seven-layer mix is silent or clips.');
      return { ...result, exactSourceNotes: true, layers: arrangement.layers.length, endingStartSeconds: 3 };
    });
    for (const [rate, seed] of [[44100, 3], [16000, 11]]) await check(`Whole-wave fixture ${rate} Hz: original lead survives independent regeneration and gain changes`, async () => {
      const bytes = sourceFixture(rate, seed); const decoded = decodePcmWav(new Uint8Array(bytes));
      const sha256 = await fingerprint(bytes); const reference = await independentSource(decoded);
      const plan = blueprint(); const original = buildArrangement(notes, { ...settings(plan), leadSource: 'recording' }, { duration: 4, sha256, quality: { canHarmonize: true } });
      original.recordingLead.audioWav = new Blob([bytes], { type: 'audio/wav' });
      const solo = await render({ ...original, events: [] }); const source = sourceMatch(reference, solo);
      plan.layers[0].variant++; plan.layers[0].gain = 0.1; plan.intensity = 0.3;
      const refined = buildArrangement(notes, { ...settings(plan), leadSource: 'recording' }, { duration: 4, sha256, quality: { canHarmonize: true } });
      refined.recordingLead.audioWav = original.recordingLead.audioWav;
      const changedSolo = await render({ ...refined, events: [] });
      let maxDifference = 0;
      for (let i = 0; i < solo.length; i++) maxDifference = Math.max(maxDifference, Math.abs(solo.getChannelData(0)[i] - changedSolo.getChannelData(0)[i]));
      assert(maxDifference <= 1 / 32767 + 1e-9, 'Refinement changed the actual original lead stem.');
      const full = metrics(await render(refined)); assert(full.peak < 0.98 && full.clipped === 0, 'The original-voice full mix clips.');
      return { sourceRate: rate, sourceSha256: sha256, ...source, maxLeadPcmDifference: round(maxDifference), sourceDuration: 4,
        unchangedPlaybackRate: 1, noSyntheticMelody: refined.events.every(event => event.track !== 'melody'), fullMix: full,
        limitation: 'Handwritten synthetic source/harmony fixtures verify rendering, not human-transcription accuracy.' };
    });
  } finally { button.disabled = false; show(null); }
  return results;
}
document.getElementById('run').addEventListener('click', runDirectorAudioTests);
window.runDirectorAudioTests = runDirectorAudioTests;
