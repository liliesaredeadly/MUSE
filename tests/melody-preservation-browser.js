import { FIXTURES } from './fixtures/hum-fixtures.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';
import { analyzeMelody } from '../src/audio/melody-analysis.js';
import { exportWav } from '../src/audio/synth.js';

// Answers are handwritten independently of the server, arranger and renderer.
const CASES = [
  { id: 'irregular', instrument: 'Piano', bpm: 90, expected: [
    { midi: 57, start: 0.17, duration: 0.23 }, { midi: 60, start: 0.48, duration: 0.17 },
    { midi: 64, start: 0.65, duration: 0.31 }, { midi: 62, start: 1.11, duration: 0.19 },
    { midi: 55, start: 1.34, duration: 0.26 },
  ] },
  { id: 'fast', instrument: 'Synthesizer', bpm: 150, expected: [
    { midi: 60, start: 0.2, duration: 0.08 }, { midi: 62, start: 0.28, duration: 0.12 },
    { midi: 64, start: 0.4, duration: 0.08 }, { midi: 65, start: 0.48, duration: 0.12 },
    { midi: 67, start: 0.6, duration: 0.08 }, { midi: 64, start: 0.68, duration: 0.12 },
  ] },
  { id: 'repeated', instrument: 'Strings', bpm: 60, expected: [
    { midi: 60, start: 0.2, duration: 0.3 }, { midi: 60, start: 0.54, duration: 0.3 },
    { midi: 64, start: 0.9, duration: 0.3 },
  ] },
  { id: 'contour', instrument: 'Strings', bpm: 150, expected: [
    { midi: 57, start: 0.2, duration: 0.8 }, { midi: 60, start: 1.12, duration: 0.6 },
  ] },
];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: received ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
const round = value => Math.round(value * 1000) / 1000;
const frequencyOf = point => point.frequency ?? point.frequencyHz;
const settingsFor = (instrument, bpm) => ({ bpm, sourceBpm: 90, instrument, mood: 'Dreamy', genre: 'Electronic', accompaniment: true, percussion: true, preserveMelodyTiming: true });
const leadOf = arrangement => arrangement.events.filter(event => event.track === 'melody');
const contourOf = note => (note.contour ?? []).map(point => ({ time: point.time, frequency: frequencyOf(point) }));
const sourceShape = note => ({ midi: note.midi, start: note.start, duration: note.duration, ...(note.contour !== undefined ? { contour: contourOf(note) } : {}) });

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function api(path, options) {
  const response = await fetch(path, { ...options, cache: 'no-store' });
  const value = await response.json();
  assert(response.ok, `${path}: HTTP ${response.status} ${value.error ?? ''}`);
  return value;
}

function compareNotes(actual, expected, label, tolerance = 0.03) {
  equal(actual.map(note => note.midi), expected.map(note => note.midi), `${label} pitch/order/repeated-note count`);
  const errors = actual.map((note, index) => ({
    note: index + 1, midi: note.midi,
    onsetMs: round((note.start - expected[index].start) * 1000),
    offsetMs: round((note.start + note.duration - expected[index].start - expected[index].duration) * 1000),
  }));
  const maxOnsetMs = Math.max(0, ...errors.map(error => Math.abs(error.onsetMs)));
  const maxOffsetMs = Math.max(0, ...errors.map(error => Math.abs(error.offsetMs)));
  assert(maxOnsetMs <= tolerance * 1000 + 0.001, `${label} onset error ${maxOnsetMs} ms exceeds ${tolerance * 1000} ms`);
  assert(maxOffsetMs <= tolerance * 1000 + 0.001, `${label} offset error ${maxOffsetMs} ms exceeds ${tolerance * 1000} ms`);
  return { noteCount: actual.length, pitchErrors: 0, maxOnsetMs, maxOffsetMs, errors };
}

function assertExactLead(analysis, arrangement) {
  equal(leadOf(arrangement).map(sourceShape), analysis.notes.map(sourceShape), 'generated lead must preserve every captured pitch, onset, duration and contour point exactly');
  assert(arrangement.melodyProof?.preserved === true && arrangement.melodyProof.timingPreserved === true, 'arrangement must expose a passing strict melody proof');
  assert(arrangement.settings?.preserveMelodyTiming === true, 'backing BPM must not scale the captured lead');
}

async function renderAndDetect(arrangement) {
  const wav = await exportWav(arrangement);
  const bytes = await wav.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, 44100);
  const decoded = await context.decodeAudioData(bytes.slice(0));
  const samples = decoded.getChannelData(0).slice();
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  assert(energy > 0 && Number.isFinite(energy), 'real OfflineAudioContext output must contain nonzero audio');
  return { analysis: analyzeMelody(samples, decoded.sampleRate), sha256: await sha256(bytes),
    wavBytes: bytes.byteLength, sampleRate: decoded.sampleRate, rms: round(Math.sqrt(energy / samples.length)), samples };
}

async function arrange(source, settings) {
  return (await api('/api/arrange', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: source.analysis.notes, settings, conditioningId: source.conditioningId }) })).arrangement;
}

function vibratoSpan(note) {
  const frequencies = (note.contour ?? []).map(frequencyOf);
  assert(frequencies.length >= 2, 'vibrato needs a nonempty measured contour');
  return 1200 * Math.log2(Math.max(...frequencies) / Math.min(...frequencies));
}

const records = new Map();
async function fixturePipeline(spec) {
  const fixture = FIXTURES[spec.id]();
  const wav = encodePcmWav(fixture.samples, fixture.sampleRate);
  const localHash = await sha256(wav);
  // This is a real raw WAV upload, not a notes-only request or an API double.
  const source = await api('/api/melody/analyze', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Blob([wav], { type: 'audio/wav' }) });
  assert(typeof source.conditioningId === 'string' && source.conditioningId.length > 0, 'analysis must bind its actual audio source');
  equal(source.receipt.sha256, localHash, 'the server must receive the exact PCM WAV bytes');
  equal(source.receipt.bytes, wav.byteLength, 'received WAV byte count');
  equal(source.receipt.sampleRate, fixture.sampleRate, 'received original sample clock');
  equal(source.receipt.channels, 1, 'received source channel count');
  assert(Math.abs(source.receipt.duration - fixture.samples.length / fixture.sampleRate) < 1 / fixture.sampleRate, 'received duration must follow the original sample clock');
  const inputMetrics = compareNotes(source.analysis.notes, spec.expected, `${spec.id} uploaded hum`);
  assert(source.analysis.contour?.length > 0 && source.analysis.voicedRatio > 0, 'analysis must include an actual voiced contour');
  equal(source.analysis.rhythm.onsets, source.analysis.notes.map(note => note.start), 'rhythm must retain measured onsets');
  const arrangement = await arrange(source, settingsFor(spec.instrument, spec.bpm));
  assertExactLead(source.analysis, arrangement);
  const backingCount = arrangement.events.filter(event => event.track !== 'melody').length;
  assert(backingCount > 0, 'optional backing must coexist with the unchanged lead');
  const leadRender = await renderAndDetect({ ...arrangement, events: leadOf(arrangement) });
  const renderedVsHum = compareNotes(leadRender.analysis.notes, source.analysis.notes, `${spec.id} actual rendered lead vs uploaded hum`);
  const renderedVsTruth = compareNotes(leadRender.analysis.notes, spec.expected, `${spec.id} actual rendered lead vs handwritten truth`);
  const metrics = { sourceSha256: localHash, inputBytes: wav.byteLength, inputSampleRate: fixture.sampleRate,
    instrument: spec.instrument, backingBpm: spec.bpm, backingEvents: backingCount, input: inputMetrics,
    renderedLead: { wavBytes: leadRender.wavBytes, sampleRate: leadRender.sampleRate, rms: leadRender.rms,
      sha256: leadRender.sha256, vsUploadedHum: renderedVsHum, vsHandwrittenTruth: renderedVsTruth } };
  if (spec.id === 'repeated') {
    const gap = leadRender.analysis.notes[1].start - leadRender.analysis.notes[0].start - leadRender.analysis.notes[0].duration;
    assert(Math.abs(gap - 0.04) <= 0.025, `the repeated-note 40 ms rest must remain audible; measured ${round(gap * 1000)} ms`);
    metrics.renderedLead.repeatedGapMs = round(gap * 1000);
  }
  if (spec.id === 'contour') {
    const inputSpan = vibratoSpan(source.analysis.notes[0]);
    const renderedSpan = vibratoSpan(leadRender.analysis.notes[0]);
    assert(inputSpan >= 30 && renderedSpan >= 25, `vibrato must survive the actual audio render: input ${inputSpan}, output ${renderedSpan} cents`);
    metrics.renderedLead.vibrato = { inputSpanCents: round(inputSpan), renderedSpanCents: round(renderedSpan) };
  }
  records.set(spec.id, { source, arrangement, leadRender, metrics });
  return metrics;
}

async function backingBpmCheck() {
  const original = records.get('irregular');
  assert(original, 'the irregular source pipeline must pass before the backing comparison');
  const changed = await arrange(original.source, settingsFor('Piano', 150));
  const repeated = await arrange(original.source, settingsFor('Piano', 150));
  assertExactLead(original.source.analysis, changed);
  equal(changed, repeated, 'identical audio-bound requests must create the same deterministic arrangement');
  const baseBacking = original.arrangement.events.filter(event => event.track !== 'melody');
  const changedBacking = changed.events.filter(event => event.track !== 'melody');
  assert(changedBacking.length > 0 && JSON.stringify(baseBacking) !== JSON.stringify(changedBacking), 'changing BPM must actually change the optional backing');
  const changedLead = await renderAndDetect({ ...changed, events: leadOf(changed) });
  equal(changedLead.sha256, original.leadRender.sha256, 'backing BPM must leave the real lead-stem WAV byte-for-byte unchanged');
  const fullBase = await renderAndDetect(original.arrangement);
  const fullChanged = await renderAndDetect(changed);
  assert(fullBase.sha256 !== fullChanged.sha256, 'the real full-mix WAV must change when its backing changes');
  return { backingBpm: [90, 150], backingEvents: [baseBacking.length, changedBacking.length],
    identicalLeadWavSha256: changedLead.sha256, deterministicArrangement: true,
    fullMix: { wavBytes: [fullBase.wavBytes, fullChanged.wavBytes], rms: [fullBase.rms, fullChanged.rms],
      changedAudio: true, detectedNoteCounts: [fullBase.analysis.notes.length, fullChanged.analysis.notes.length],
      limitation: 'Polyphonic full-mix detections are reported only; exact melody acceptance uses the independently decoded lead stem.' } };
}

async function bindingCheck() {
  const source = records.get('irregular')?.source;
  assert(source, 'the irregular audio source must be available');
  const notes = structuredClone(source.analysis.notes);
  notes[0].midi += 1;
  const response = await fetch('/api/arrange', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes, settings: settingsFor('Piano', 90), conditioningId: source.conditioningId }) });
  const body = await response.json();
  assert(response.status >= 400 && response.status < 500 && !body.arrangement, 'a substituted lead must be rejected against the original audio binding');
  assert(records.size === 4 && new Set([...records.values()].map(record => record.metrics.sourceSha256)).size === 4, 'four different uploaded melodies must retain four distinct audio fingerprints');
  return { changedSourcePitchRejected: true, status: response.status, distinctAudioSources: records.size };
}

async function run() {
  const button = document.getElementById('run');
  const output = document.getElementById('results');
  if (button.disabled) return;
  button.disabled = true;
  records.clear();
  const started = performance.now();
  const state = { status: 'running', passed: 0, failed: 0, syntheticAudioOnly: true, tests: [] };
  window.__melodyResults = state;
  const cases = [...CASES.map(spec => ({ name: `${spec.id}: real PCM upload → bound arrange → ${spec.instrument} WAV → redetection`, action: () => fixturePipeline(spec) })),
    { name: 'Changed backing BPM preserves byte-identical lead audio and changes real full-mix audio', action: backingBpmCheck },
    { name: 'Audio source binding rejects substituted notes and distinguishes all four recordings', action: bindingCheck }];
  for (const item of cases) {
    output.textContent = JSON.stringify({ ...state, current: item.name }, null, 2);
    await new Promise(resolve => setTimeout(resolve, 0));
    const began = performance.now();
    try {
      const metrics = await item.action();
      state.tests.push({ name: item.name, passed: true, milliseconds: round(performance.now() - began), metrics });
      state.passed++;
    } catch (error) {
      state.tests.push({ name: item.name, passed: false, milliseconds: round(performance.now() - began), error: error.message });
      state.failed++;
    }
    output.textContent = JSON.stringify(state, null, 2);
  }
  state.status = state.failed ? 'failed' : 'passed';
  state.milliseconds = round(performance.now() - started);
  output.textContent = JSON.stringify(state, null, 2);
  button.disabled = false;
}

document.getElementById('run').addEventListener('click', run);
window.runMelodyPreservationTests = run;
