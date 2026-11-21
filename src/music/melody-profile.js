import { validateMelodyNotes } from './melody-contract.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function estimateTempo(notes) {
  const intervals = notes.slice(1).map((note, index) => note.start - notes[index].start);
  if (intervals.length < 3 || notes.at(-1).start - notes[0].start < 1 || intervals.some(value => value < 0.06)) {
    return { estimatedBpm: null, confidence: 0 };
  }
  // Fit measured IOIs to a sixteenth-note grid. A simple beat is preferred over
  // unnecessarily fine subdivisions, but half/double-time remain ambiguous.
  // This describes evidence only: it never quantizes or moves a source onset.
  const candidates = Array.from({ length: 161 }, (_, index) => index + 40).map(bpm => {
    const beat = 60 / bpm;
    let fit = 0;
    let simplicity = 0;
    for (const interval of intervals) {
      const beats = interval / beat;
      const distance = Math.abs(beats * 4 - Math.round(beats * 4));
      fit += 1 - clamp(distance / 0.18, 0, 1);
      simplicity += Math.exp(-Math.abs(Math.log2(beats)));
    }
    fit /= intervals.length;
    simplicity /= intervals.length;
    return { bpm, fit, score: fit * 0.84 + simplicity * 0.16 };
  }).sort((a, b) => b.score - a.score || a.bpm - b.bpm);
  const best = candidates[0];
  if (best.fit < 0.8) return { estimatedBpm: null, confidence: 0 };
  const alternative = candidates.find(candidate => Math.abs(candidate.bpm - best.bpm) / best.bpm > 0.1);
  const separation = clamp((best.score - alternative.score) / 0.2, 0, 1);
  const evidence = Math.min(1, (intervals.length - 2) / 6);
  const confidence = Math.min(0.7, best.fit * evidence * (0.4 + 0.6 * separation));
  return { estimatedBpm: best.bpm, confidence: Math.round(confidence * 1000) / 1000 };
}

/**
 * Describe fresh monophonic note evidence, independent of song references.
 * Register uses duration-weighted median MIDI pitch. Motion and energy describe
 * note movement/density, not perceived emotion, audio loudness or genre truth.
 * Tempo is an ambiguous grid suggestion; phrases are separated by measured rests.
 * Phrase noteEnd is exclusive. Source timing, pitch and contours stay untouched.
 */
export function describeMelody(notes) {
  validateMelodyNotes(notes, { allowEmpty: true });
  if (!notes.length) return {
    duration: 0, noteCount: 0, pitchRange: { min: null, max: null, semitones: 0 }, register: 'mid',
    rhythm: { estimatedBpm: null, confidence: 0, density: 0, syncopation: 0 },
    character: { motion: 'static', energy: 'low' }, phrases: [],
  };
  const duration = Math.max(...notes.map(note => note.start + note.duration));
  const pitches = notes.map(note => note.midi);
  const low = Math.min(...pitches);
  const high = Math.max(...pitches);
  const weighted = notes.map(note => ({ midi: note.midi, duration: note.duration })).sort((a, b) => a.midi - b.midi);
  const totalDuration = weighted.reduce((sum, note) => sum + note.duration, 0);
  let elapsed = 0;
  const medianPitch = weighted.find(note => (elapsed += note.duration) >= totalDuration / 2).midi;
  const density = notes.length / Math.max(Number.EPSILON, duration - notes[0].start);
  const intervals = notes.slice(1).map((note, index) => Math.abs(note.midi - notes[index].midi));
  const averageMotion = intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : 0;
  const motion = !intervals.length || intervals.every(value => value === 0) ? 'static'
    : intervals.filter(value => value <= 2).length / intervals.length >= 0.7 ? 'stepwise'
      : intervals.filter(value => value >= 5).length / intervals.length >= 0.5 ? 'leaping' : 'mixed';
  const activity = density * 0.6 + averageMotion * 0.1;
  const tempo = estimateTempo(notes);
  const beat = 60 / (tempo.estimatedBpm || 120);
  const syncopation = tempo.estimatedBpm === null || notes.length < 2 ? 0
    : notes.slice(1).filter(note => {
      const position = (note.start - notes[0].start) / beat;
      return Math.abs(position - Math.round(position)) > 0.12;
    }).length / (notes.length - 1);
  const phrases = [];
  let noteStart = 0;
  let end = notes[0].start + notes[0].duration;
  for (let index = 1; index < notes.length; index++) {
    if (notes[index].start - end >= Math.max(0.35, beat * 0.65)) {
      phrases.push({ start: notes[noteStart].start, end, noteStart, noteEnd: index });
      noteStart = index;
    }
    end = Math.max(end, notes[index].start + notes[index].duration);
  }
  phrases.push({ start: notes[noteStart].start, end, noteStart, noteEnd: notes.length });
  return {
    duration, noteCount: notes.length, pitchRange: { min: low, max: high, semitones: high - low },
    register: medianPitch < 55 ? 'low' : medianPitch >= 76 ? 'high' : 'mid',
    rhythm: { ...tempo, density, syncopation },
    character: { motion, energy: notes.length < 3 || activity < 1.2 ? 'low' : activity >= 2.5 ? 'high' : 'medium' },
    phrases,
  };
}
