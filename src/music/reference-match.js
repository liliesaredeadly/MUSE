const TEMPO_SCALES = [0.65, 0.75, 0.8, 0.875, 1, 1.125, 1.25, 1.5];
const MAX_SAMPLE_LOOKUPS = 20_000_000;
const MIN_SIMILARITY = 0.85;
const MIN_ORDER_GAIN = 0.2;
const noMatch = reason => ({ status: 'no-match', reason });
const pitchClass = midi => (midi % 12 + 12) % 12;

/**
 * Compare a monophonic hum with local spectral chroma. This is a conservative
 * similarity candidate, not song identification or a verified transcription.
 * transpose is the semitone adjustment from the hum to the reference, modulo
 * octaves. A fixed grid allows moderate tempo differences without unconstrained
 * warping that could make unrelated short phrases appear to match.
 */
export function matchReference(inputNotes, reference) {
  const notes = (Array.isArray(inputNotes) ? inputNotes : []).filter(note => note
    && Number.isInteger(note.midi) && note.midi >= 0 && note.midi <= 127
    && Number.isFinite(note.start) && note.start >= 0
    && Number.isFinite(note.duration) && note.duration >= 0.09
    && (note.confidence === undefined || (Number.isFinite(note.confidence) && note.confidence >= 0.65 && note.confidence <= 1)))
    .sort((a, b) => a.start - b.start);
  const start = notes[0]?.start || 0;
  const duration = notes.reduce((end, note) => Math.max(end, note.start + note.duration), start) - start;
  const changes = notes.reduce((count, note, index) => count + (index > 0 && pitchClass(note.midi) !== pitchClass(notes[index - 1].midi) ? 1 : 0), 0);
  const overlap = notes.some((note, index) => index > 0 && note.start < notes[index - 1].start + notes[index - 1].duration - 0.05);
  const voiced = notes.reduce((sum, note) => sum + note.duration, 0);
  if (notes.length < 8 || notes.length > 96 || duration < 3 || duration > 30
    || new Set(notes.map(note => pitchClass(note.midi))).size < 4 || changes < 6 || overlap || voiced / duration < 0.6) {
    return noMatch('Hum a varied phrase of at least eight clear notes over 3–30 seconds, then compare again.');
  }
  if (!Array.isArray(reference?.chroma) || !reference.chroma.length || reference.chroma.length > 12000
    || !Number.isFinite(reference.frameSeconds) || reference.frameSeconds < 0.05 || reference.frameSeconds > 0.5
    || !Number.isFinite(reference.duration) || reference.duration <= 0 || reference.duration > 600
    || Math.abs(reference.chroma.length * reference.frameSeconds - reference.duration) > reference.frameSeconds * 2) {
    return noMatch('No usable reference features are available.');
  }
  const lookups = TEMPO_SCALES.reduce((total, scale) => total + Math.max(0,
    reference.chroma.length - Math.ceil(duration * scale / reference.frameSeconds) + 1), 0) * 12 * notes.length * 3;
  if (lookups > MAX_SAMPLE_LOOKUPS) return noMatch('This comparison is too large. Shorten the hum to a clear 5–15 second phrase and compare again.');
  if (!reference.chroma.every(frame => Array.isArray(frame) && frame.length === 12
    && frame.every(value => Number.isFinite(value) && value >= 0 && value <= 1.001))) {
    return noMatch('No usable reference features are available.');
  }

  // Remove each frame's broad spectral floor. A uniform spectrum supplies no
  // melodic evidence; shared chord/background energy cannot dominate the score.
  const salience = reference.chroma.map(frame => {
    const sorted = [...frame].sort((a, b) => a - b);
    const floor = (sorted[5] + sorted[6]) / 2;
    const contrast = sorted[11] - floor;
    return contrast > 0.00001 ? frame.map(value => Math.max(0, (value - floor) / contrast)) : Array(12).fill(0);
  });
  const weights = notes.map(note => Math.min(0.75, Math.max(0.15, note.duration)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  // Prefix sums make the same-pitch baseline over any candidate interval O(12).
  // Condition on tonal frames so pulsing a static chord cannot manufacture
  // apparent note-order evidence by adding silence between its attacks.
  const activePrefix = new Uint32Array(salience.length + 1);
  for (let frame = 0; frame < salience.length; frame++) {
    activePrefix[frame + 1] = activePrefix[frame] + (salience[frame].some(value => value > 0) ? 1 : 0);
  }
  const prefix = Array.from({ length: 12 }, (_, pitch) => {
    const sum = new Float64Array(salience.length + 1);
    for (let frame = 0; frame < salience.length; frame++) sum[frame + 1] = sum[frame] + salience[frame][pitch];
    return sum;
  });
  let best = { similarity: 0 };
  for (const scale of TEMPO_SCALES) {
    const frameLength = Math.ceil(duration * scale / reference.frameSeconds);
    if (frameLength > salience.length) continue;
    const samples = notes.map(note => [0.25, 0.5, 0.75].map(fraction => Math.floor((note.start - start + note.duration * fraction) * scale / reference.frameSeconds)));
    for (let transpose = -6; transpose < 6; transpose++) {
      const pitches = notes.map(note => pitchClass(note.midi + transpose));
      const pitchWeights = Array(12).fill(0);
      pitches.forEach((pitch, index) => { pitchWeights[pitch] += weights[index]; });
      for (let offset = 0; offset + frameLength <= salience.length; offset++) {
        let weighted = 0;
        let hits = 0;
        for (let index = 0; index < notes.length; index++) {
          const pitch = pitches[index];
          const score = samples[index].reduce((sum, sample) => sum + (salience[offset + sample]?.[pitch] || 0), 0) / 3;
          weighted += score * weights[index];
          if (score >= 0.65) hits++;
        }
        const similarity = weighted / totalWeight;
        if (similarity >= MIN_SIMILARITY && similarity > best.similarity && hits / notes.length >= 0.75) {
          const activeFrames = Math.max(1, activePrefix[offset + frameLength] - activePrefix[offset]);
          const baseline = pitchWeights.reduce((sum, weight, pitch) => sum
            + weight * (prefix[pitch][offset + frameLength] - prefix[pitch][offset]) / activeFrames, 0) / totalWeight;
          if (similarity - baseline < MIN_ORDER_GAIN) continue;
          best = { similarity, transpose, start: offset * reference.frameSeconds, end: (offset * reference.frameSeconds) + duration * scale };
        }
      }
    }
  }
  if (best.similarity < MIN_SIMILARITY) return noMatch('This take did not show a strong enough melodic similarity to the local reference. Try a longer, clearer phrase.');
  return {
    status: 'candidate',
    reason: 'A similar phrase was found in the local audio reference. Listen at the linked time to check it; exact notes are not verified.',
    start: Number(best.start.toFixed(2)), end: Number(Math.min(reference.duration, best.end).toFixed(2)),
    similarity: Number(Math.min(1, best.similarity).toFixed(3)), transpose: best.transpose,
  };
}
