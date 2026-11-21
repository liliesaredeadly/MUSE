import { makeHum } from './fixtures/hum-fixtures.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';
import { analyzeMelody } from '../src/audio/melody-analysis.js';
import { exportWav } from '../src/audio/synth.js';
import { interpretDirection } from '../src/producer/producer.js';
import { assertMelodyPreserved } from '../src/music/melody-contract.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message);
const round = number => Math.round(number * 100000) / 100000;
const settings = { bpm: 112, sourceBpm: 90, production: 'auto', instrument: 'Piano', mood: 'Energetic', genre: 'Ambient', accompaniment: true, bass: true, percussion: true, preserveMelodyTiming: true };
const references = [['Beauty and a Beat production', 'dance-pop'], ['Shape of You production', 'percussive-pop']];

function newPhrase(seed, low) {
  let time = 0.21;
  const notes = Array.from({ length: 12 }, (_, index) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const duration = [0.18, 0.26, 0.37, 0.5][seed >>> 8 & 3];
    const note = { midi: low + seed % 16, start: time, duration, vibrato: 12 };
    time += duration + (index === 5 ? 0.64 : 0.065);
    return note;
  });
  return makeHum(notes, { harmonics: [1, 0.25, 0.08], sampleRate: 48000, amplitude: 0.08 });
}

async function hash(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function request(path, body, audio = false) {
  const response = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': audio ? 'audio/wav' : 'application/json' }, body: audio ? new Blob([body], { type: 'audio/wav' }) : JSON.stringify(body) });
  const result = await response.json();
  assert(response.ok, `${path}: ${response.status} ${result.error || ''}`);
  return result;
}
function compare(actual, expected) {
  equal(actual.map(n => n.midi), expected.map(n => n.midi), 'The fresh pitch sequence or note count changed.');
  const onset = Math.max(...actual.map((n, i) => Math.abs(n.start - expected[i].start)));
  const offset = Math.max(...actual.map((n, i) => Math.abs(n.start + n.duration - expected[i].start - expected[i].duration)));
  assert(onset <= 0.031 && offset <= 0.031, `Fresh melody boundary error: ${onset}/${offset}s`);
  return { pitchErrors: 0, maxOnsetMs: round(onset * 1000), maxOffsetMs: round(offset * 1000) };
}
async function render(arrangement) {
  const bytes = await (await exportWav(arrangement)).arrayBuffer();
  const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes.slice(0));
  const left = decoded.getChannelData(0); const right = decoded.getChannelData(1);
  let peak = 0; let energy = 0; let stereo = 0; let clipped = 0;
  for (let index = 0; index < left.length; index++) {
    for (const sample of [left[index], right[index]]) {
      assert(Number.isFinite(sample), 'Rendered PCM contains a nonfinite value.');
      peak = Math.max(peak, Math.abs(sample)); energy += sample * sample;
      if (Math.abs(sample) >= 0.999) clipped++;
    }
    stereo += (left[index] - right[index]) ** 2;
  }
  return { sha256: await hash(bytes), samples: left.slice(), sampleRate: decoded.sampleRate,
    metrics: { peak: round(peak), rms: round(Math.sqrt(energy / (left.length * 2))), clippedSamples: clipped,
      stereoDifferenceRms: round(Math.sqrt(stereo / left.length)), wavBytes: bytes.byteLength } };
}
function pcmDifference(first, second) {
  assert(first.length === second.length, 'Lead renders have different sample clocks or durations.');
  let maxDifference = 0; let changedSamples = 0;
  for (let i = 0; i < first.length; i++) {
    const difference = Math.abs(first[i] - second[i]);
    maxDifference = Math.max(maxDifference, difference); if (difference) changedSamples++;
  }
  return { maxDifference, changedSamples };
}

const results = [];
const renders = new Map();
async function run() {
  const button = document.getElementById('run'); const output = document.getElementById('results');
  if (button.disabled) return; button.disabled = true; results.length = 0; renders.clear();
  const show = current => { output.textContent = JSON.stringify({ status: current ? 'running' : results.every(result => result.passed) ? 'passed' : 'failed', current,
    passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, syntheticOnly: true, results }, null, 2); };
  async function check(name, action) {
    show(name);
    try { results.push({ name, passed: true, metrics: await action() }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
    show(name);
  }
  try {
    for (const [seed, low] of [[831, 52], [1847, 58]]) {
      const fixture = newPhrase(seed, low);
      const wav = encodePcmWav(fixture.samples, fixture.sampleRate);
      let source;
      await check(`Unfamiliar hum ${seed}: actual WAV receipt and extraction`, async () => {
        source = await request('/melody/analyze', wav, true);
        equal(source.receipt.sha256, await hash(wav), 'Actual uploaded WAV hash does not match.');
        return { inputNotes: fixture.notes.length, receiptVerified: true, ...compare(source.analysis.notes, fixture.notes) };
      });
      if (!source) continue;
      for (const [direction, style] of references) {
        await check(`Unfamiliar hum ${seed}: ${style} actual lead and full-mix render`, async () => {
          const proposal = interpretDirection(direction, settings);
          assert(proposal.changes.production === style && !Object.hasOwn(proposal.changes, 'bpm'), 'Benchmark selection changed the source clock or missed the generic profile.');
          const arrangement = (await request('/arrange', { notes: source.analysis.notes, conditioningId: source.conditioningId, settings: { ...settings, ...proposal.changes } })).arrangement;
          assertMelodyPreserved(source.analysis.notes, arrangement);
          equal(arrangement.production.style, style, 'The real API ignored the production setting.');
          const lead = arrangement.events.filter(event => event.track === 'melody');
          const backing = arrangement.events.filter(event => event.track !== 'melody');
          const leadRender = await render({ ...arrangement, events: lead });
          const repeatLead = await render({ ...arrangement, events: lead });
          const repeatedSameArrangement = pcmDifference(leadRender.samples, repeatLead.samples);
          assert(repeatedSameArrangement.maxDifference <= 1 / 32767 + 1e-9, 'Identical native renders vary beyond one decoded PCM16 step.');
          const boundaries = compare(analyzeMelody(leadRender.samples, leadRender.sampleRate).notes, source.analysis.notes);
          const full = await render(arrangement);
          const backingRender = await render({ ...arrangement, events: backing });
          assert(full.metrics.rms > 0.005 && backingRender.metrics.rms > 0.001, 'Full mix or backing is effectively silent.');
          assert(full.metrics.peak < 0.98 && full.metrics.clippedSamples === 0, 'The mix clips or lacks safe peak headroom.');
          assert(full.metrics.stereoDifferenceRms > 0, 'Expected backing stereo image is missing.');
          renders.set(`${seed}:${style}`, { lead: leadRender.sha256, samples: leadRender.samples, leadNotes: lead,
            settings: arrangement.settings, full: full.sha256 });
          return { style, sourceNotesPreserved: true, backingEvents: backing.length, phrases: arrangement.melodyCharacter.phrases.length,
            tempoEvidence: arrangement.melodyCharacter.rhythm, renderedLead: boundaries, repeatedSameArrangement, fullMix: full.metrics,
            backingRms: backingRender.metrics.rms, limits: 'Exact comparison uses the lead stem; full-mix pitch transcription and subjective polish remain listening checks.' };
        });
      }
    }
    await check('Production changes full audio while the exact lead events render within one PCM16 step', async () => {
      const comparisons = [];
      for (const seed of [831, 1847]) {
        const dance = renders.get(`${seed}:dance-pop`); const percussive = renders.get(`${seed}:percussive-pop`);
        assert(dance && percussive, 'Both production renders must pass.');
        equal(dance.leadNotes, percussive.leadNotes, 'Production altered the actual source lead events.');
        const difference = pcmDifference(dance.samples, percussive.samples);
        // Repeating the identical native graph also varies by one PCM16 step
        // near rounding thresholds. Require exact notes/gates/contours above,
        // then bound waveform differences by the measured quantization step.
        assert(difference.maxDifference <= 1 / 32767 + 1e-9, `Production changed the lead waveform beyond one PCM16 step: ${JSON.stringify(difference)}`);
        comparisons.push({ seed, ...difference, byteIdentical: dance.lead === percussive.lead });
        assert(dance.full !== percussive.full, 'Profiles generated identical full audio.');
      }
      assert(renders.get('831:dance-pop').lead !== renders.get('1847:dance-pop').lead, 'Different source melodies produced the same lead.');
      return { distinctUnfamiliarMelodies: 2, originalSourceRequired: true, exactLeadEventsAcrossProduction: true,
        differentFullMixes: true, pcm16StepLimit: 1 / 32767, comparisons };
    });
  } finally { button.disabled = false; show(null); }
}
document.getElementById('run').addEventListener('click', run);
