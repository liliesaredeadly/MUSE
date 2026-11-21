import { validateMelodyNotes } from '../music/melody-contract.js';

const HARMONIC_METHOD = 'spectral-harmonic-consensus-v1';
const CLOCK_TOLERANCE = 1e-6;

/** Validate independent anchors without extending their measured source spans. */
export function validateHarmonicAnchors(anchors, duration) {
  if (!Number.isFinite(duration) || duration < 0.3 || duration > 60 || !Array.isArray(anchors) || anchors.length < 3) return null;
  try { validateMelodyNotes(anchors); } catch { return null; }
  let previousEnd = 0;
  let supportedSeconds = 0;
  const harmonyNotes = [];
  const harmonyRegions = [];
  for (const anchor of anchors) {
    const end = anchor.start + anchor.duration;
    if (anchor.duration < 0.12 - CLOCK_TOLERANCE || anchor.start < previousEnd - CLOCK_TOLERANCE
      || end > duration + CLOCK_TOLERANCE || !Number.isFinite(anchor.confidence) || anchor.confidence < 0.9 || anchor.confidence > 1
      || !Number.isFinite(anchor.coverage) || anchor.coverage < 0.9 || anchor.coverage > 1
      || !Number.isInteger(anchor.supportCount) || anchor.supportCount < 3
      || !Number.isFinite(anchor.frequency) || anchor.frequency < 65 || anchor.frequency > 1400
      || Math.round(69 + 12 * Math.log2(anchor.frequency / 440)) !== anchor.midi
      || typeof anchor.name !== 'string' || !anchor.name.length || anchor.name.length > 8) return null;
    harmonyNotes.push({ midi: anchor.midi, name: anchor.name, start: anchor.start, duration: anchor.duration,
      confidence: anchor.confidence, frequency: anchor.frequency, supportCount: anchor.supportCount, coverage: anchor.coverage });
    const previous = harmonyRegions.at(-1);
    if (previous && anchor.start <= previous.start + previous.duration + CLOCK_TOLERANCE) previous.duration = end - previous.start;
    else harmonyRegions.push({ start: anchor.start, duration: anchor.duration });
    supportedSeconds += anchor.duration;
    previousEnd = end;
  }
  if (supportedSeconds < 0.75 - CLOCK_TOLERANCE || new Set(harmonyNotes.map(note => note.midi % 12)).size < 2) return null;
  return { harmonyNotes, harmonyRegions };
}

/** Conservative permission for inferred chord/bass backing, not transcription
 * accuracy. Original recorded audio remains the lead in either status. */
export function assessTranscription(analysis) {
  const ratio = analysis?.voicedRatio;
  const voicedRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const limited = reason => ({ status: 'limited', voicedRatio, canHarmonize: false,
    reason: `${reason} Your original hum is kept; chord and bass backing are disabled.` });
  if (!analysis || !Number.isFinite(analysis.duration) || analysis.duration < 0.3 || analysis.duration > 60
    || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    return limited('The pitch analysis has too little valid recording evidence to choose reliable harmony.');
  }
  try { validateMelodyNotes(analysis.notes, { allowEmpty: true }); }
  catch { return limited('The pitch analysis is incomplete or contains invalid notes.'); }
  if (analysis.notes.some(note => note.start + note.duration > analysis.duration + 1e-6)) {
    return limited('The detected notes do not match the recording clock.');
  }
  const reason = analysis.notes.length < 3 ? 'Too few clear notes were detected to choose reliable chords.'
    : voicedRatio < 0.55 ? `Only ${Math.round(voicedRatio * 100)}% of this take has reliable pitched evidence.`
    : analysis.notes.some(note => !Number.isFinite(note.confidence) || note.confidence < 0.8 || note.confidence > 1)
    ? 'Pitch confidence is too low to choose reliable chords.' : null;
  if (reason) {
    const supported = analysis.harmonicEvidence?.method === HARMONIC_METHOD
      ? validateHarmonicAnchors(analysis.harmonicEvidence.anchors, analysis.duration) : null;
    return supported ? { status: 'partial', voicedRatio, canHarmonize: true, harmonyScope: 'anchored', ...supported,
      reason: 'Pitch evidence is limited. Optional chord and bass backing plays only in independently confirmed clear parts; unsupported gaps stay unpitched. This is not a verified transcription. Your original hum remains the melody.' }
      : limited(reason);
  }
  return { status: 'estimated', voicedRatio, canHarmonize: true,
    reason: 'Pitch estimates support optional harmony, but they are not a verified transcription. Your original hum remains the melody.' };
}
