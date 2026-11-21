import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTranscription } from '../src/audio/transcription-quality.js';

const analysis = (changes = {}) => ({ duration: 2, voicedRatio: 0.75, notes: [
  { midi: 60, start: 0.1, duration: 0.5, confidence: 0.91 },
  { midi: 64, start: 0.7, duration: 0.5, confidence: 0.9 },
  { midi: 67, start: 1.3, duration: 0.5, confidence: 0.93 },
], ...changes });

test('well-supported analysis permits harmony without claiming a verified transcription', () => {
  const source = analysis(); const before = structuredClone(source);
  const quality = assessTranscription(source);
  assert.equal(quality.status, 'estimated');
  assert.equal(quality.canHarmonize, true);
  assert.equal(quality.voicedRatio, 0.75);
  assert.match(quality.reason, /estimat|not.*verified/i);
  assert.deepEqual(source, before);
});

test('sparse actual-take coverage keeps the original hum and disables inferred harmony', () => {
  const quality = assessTranscription(analysis({ duration: 7.62, voicedRatio: 0.2611548556430448 }));
  assert.equal(quality.status, 'limited');
  assert.equal(quality.canHarmonize, false);
  assert.equal(quality.voicedRatio, 0.2611548556430448);
  assert.match(quality.reason, /26%/);
  assert.match(quality.reason, /original hum/i);
  assert.match(quality.reason, /chord.*bass.*disabled/i);
});

test('a short or nearly empty analysis cannot choose chords merely from a reported high ratio', () => {
  for (const source of [analysis({ notes: [] }), analysis({ notes: analysis().notes.slice(0, 2) }), analysis({ duration: 0.2 }), analysis({ duration: 61 })]) {
    const quality = assessTranscription(source);
    assert.equal(quality.status, 'limited');
    assert.equal(quality.canHarmonize, false);
    assert.ok(quality.reason.length > 0);
  }
});

test('coverage threshold is inclusive and inadequate evidence remains limited', () => {
  assert.equal(assessTranscription(analysis({ voicedRatio: 0.55 })).canHarmonize, true);
  assert.equal(assessTranscription(analysis({ voicedRatio: 0.5499 })).canHarmonize, false);
});

test('missing, low or invalid note confidence cannot authorize harmonic backing', () => {
  for (const confidence of [undefined, 0.79, -1, NaN, Infinity, 1.01]) {
    const source = analysis(); source.notes[1].confidence = confidence;
    assert.equal(assessTranscription(source).canHarmonize, false);
  }
  const source = analysis(); source.notes.forEach(note => { note.confidence = 0.8; });
  assert.equal(assessTranscription(source).canHarmonize, true);
});

test('malformed pitch, note order or clock never becomes usable harmony evidence', () => {
  for (const source of [null, {}, analysis({ voicedRatio: NaN }), analysis({ voicedRatio: 2 }),
    analysis({ notes: [...analysis().notes].reverse() }), analysis({ notes: [{ midi: 140, start: 0, duration: 1 }, ...analysis().notes] }),
    analysis({ duration: 1 })]) {
    const quality = assessTranscription(source);
    assert.equal(quality.status, 'limited');
    assert.equal(quality.canHarmonize, false);
    assert.ok(Number.isFinite(quality.voicedRatio));
  }
});
