import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMelody } from '../src/audio/melody-analysis.js';
import { assessTranscription } from '../src/audio/transcription-quality.js';
import { buildArrangement } from '../src/music/arrangement.js';
import { planProduction } from '../src/producer/production-blueprint.js';

function noisyFormantVoice() {
  const sampleRate = 16000;
  const schedule = [
    { midi: 45, start: .18, duration: .75 },
    { midi: 47, start: 1.06, duration: .75 },
    { midi: 49, start: 1.94, duration: .75 },
  ];
  const samples = new Float32Array(sampleRate * 3);
  let phase = 0; let seed = 761;
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 4294967296 * 2 - 1) * .065;
    const note = schedule.find(item => time >= item.start && time < item.start + item.duration);
    samples[i] = noise;
    if (!note) continue;
    const local = time - note.start;
    const hz = 440 * 2 ** ((note.midi - 69) / 12) * 2 ** (10 * Math.sin(time * 29) / 1200);
    phase += 2 * Math.PI * hz / sampleRate;
    const edge = Math.min(1, local / .008, (note.duration - local) / .008);
    // A weak fundamental under shifting resonances and broadband microphone
    // noise. The handwritten schedule, not either detector, is the reference.
    const voice = .04 * Math.sin(phase) + .7 * Math.sin(phase * 2)
      + (.7 + .15 * Math.sin(time * 3)) * Math.sin(phase * 3)
      + .55 * Math.sin(phase * 4) + .45 * Math.sin(phase * 5);
    samples[i] += voice * .028 * edge;
  }
  return { samples, sampleRate, schedule };
}

test('weak fundamentals under changing formants recover independent harmonic evidence', () => {
  const fixture = noisyFormantVoice();
  const result = analyzeMelody(fixture.samples, fixture.sampleRate);
  assert.equal(result.harmonicEvidence?.method, 'spectral-harmonic-consensus-v1');
  assert.ok(result.harmonicEvidence.anchors.length >= 3);
  for (const anchor of result.harmonicEvidence.anchors) {
    const center = anchor.start + anchor.duration / 2;
    const expected = fixture.schedule.find(note => center >= note.start && center < note.start + note.duration);
    assert.ok(expected, 'No supported pitch may be invented in a noisy rest.');
    assert.equal(anchor.midi, expected.midi, 'An overtone cannot replace the fundamental.');
  }
  const quality = assessTranscription(result);
  assert.equal(quality.canHarmonize, true);
  assert.ok(['partial', 'estimated'].includes(quality.status));
  const blueprint = planProduction('Use only acoustic guitar, piano and strings', { accompaniment: false, bass: false });
  const arrangement = buildArrangement(result.notes, { leadSource: 'recording', blueprint }, {
    duration: result.duration, sha256: 'a'.repeat(64), quality,
  });
  for (const id of ['guitar', 'piano', 'violin', 'cello']) {
    assert.ok(arrangement.events.some(event => event.layerId === id), `${id} must have real supported backing events.`);
  }
  assert.equal(arrangement.recordingLead.duration, fixture.samples.length / fixture.sampleRate);
  assert.equal(arrangement.recordingLead.sha256, 'a'.repeat(64));
  assert.ok(arrangement.events.every(event => event.track !== 'melody'));
});

test('noise and incompatible competing pitches cannot gain harmony permission from spectral rescue', () => {
  for (const frequencies of [[], [657, 414], [657, 414, 275]]) {
    const samples = new Float32Array(16000); let seed = 419;
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] = (seed / 4294967296 * 2 - 1) * .03
        + frequencies.reduce((sum, hz) => sum + .04 * Math.sin(2 * Math.PI * hz * i / 16000), 0);
    }
    const result = analyzeMelody(samples, 16000);
    assert.equal(result.harmonicEvidence?.anchors?.length || 0, 0);
    assert.equal(assessTranscription(result).canHarmonize, false);
  }
});
