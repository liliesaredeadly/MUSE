const TOLERANCE = 1e-6;
const MAX_NOTES = 512;
const MAX_SECONDS = 600;
const MAX_CONTOUR_POINTS = 2000;
const MAX_TOTAL_CONTOUR_POINTS = 4000;

/** Validate the entire source without filtering, rounding or reordering it. */
export function validateMelodyNotes(notes, { allowEmpty = false } = {}) {
  if (!Array.isArray(notes) || notes.length > MAX_NOTES) throw new Error(`Melody must contain at most ${MAX_NOTES} notes.`);
  if (!allowEmpty && !notes.length) throw new Error('No captured melody notes to preserve.');
  let previousStart = -Infinity;
  let contourPoints = 0;
  for (const [index, note] of notes.entries()) {
    const label = `Melody note ${index + 1}`;
    if (!note || !Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127) throw new Error(`${label} has an invalid MIDI pitch.`);
    if (!Number.isFinite(note.start) || note.start < 0 || !Number.isFinite(note.duration) || note.duration <= 0 || !Number.isFinite(note.start + note.duration) || note.start + note.duration > MAX_SECONDS) throw new Error(`${label} has invalid timing; notes must end within ${MAX_SECONDS} seconds.`);
    if (note.start < previousStart) throw new Error('Melody notes must remain in chronological source order.');
    previousStart = note.start;
    if (note.confidence !== undefined && (!Number.isFinite(note.confidence) || note.confidence < 0 || note.confidence > 1)) throw new Error(`${label} has invalid confidence.`);
    if (note.contour === undefined) continue;
    if (!Array.isArray(note.contour) || note.contour.length > MAX_CONTOUR_POINTS) throw new Error(`${label} contour must contain at most ${MAX_CONTOUR_POINTS} points.`);
    contourPoints += note.contour.length;
    if (contourPoints > MAX_TOTAL_CONTOUR_POINTS) throw new Error(`Melody contour exceeds ${MAX_TOTAL_CONTOUR_POINTS} points.`);
    let previousTime = -Infinity;
    for (const point of note.contour) {
      if (!point || !Number.isFinite(point.time) || point.time < 0 || point.time > note.duration || point.time <= previousTime || !Number.isFinite(point.frequency) || point.frequency <= 0 || point.frequency > 20000) throw new Error(`${label} contour needs increasing times within its duration and positive frequencies up to 20000 Hz.`);
      previousTime = point.time;
    }
  }
  return notes;
}

/** Prove that backing/timbre changes have not substituted or drifted the lead. */
export function assertMelodyPreserved(notes, arrangement, { timingScale = 1 } = {}) {
  validateMelodyNotes(notes);
  if (!Number.isFinite(timingScale) || timingScale <= 0) throw new Error('Melody timing scale must be positive and finite.');
  if (!Array.isArray(arrangement?.events)) throw new Error('Melody arrangement is missing its events.');
  const lead = arrangement.events.filter(event => event?.track === 'melody');
  if (lead.length !== notes.length) throw new Error(`Melody note count changed: expected ${notes.length}, received ${lead.length}.`);
  validateMelodyNotes(lead);
  const close = (actual, expected, label) => {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > TOLERANCE) throw new Error(`Melody ${label} changed.`);
  };
  let contourPointCount = 0;
  notes.forEach((note, index) => {
    const event = lead[index];
    const label = `note ${index + 1}`;
    if (event.midi !== note.midi) throw new Error(`Melody ${label} pitch or order changed.`);
    close(event.start, note.start * timingScale, `${label} start timing`);
    close(event.duration, note.duration * timingScale, `${label} duration timing`);
    if ((note.contour === undefined) !== (event.contour === undefined) || (note.contour?.length ?? 0) !== (event.contour?.length ?? 0)) throw new Error(`Melody ${label} contour count changed.`);
    for (let pointIndex = 0; pointIndex < (note.contour?.length ?? 0); pointIndex++) {
      const original = note.contour[pointIndex];
      const rendered = event.contour[pointIndex];
      close(rendered.time, original.time * timingScale, `${label} contour timing`);
      close(rendered.frequency, original.frequency, `${label} contour pitch`);
      contourPointCount++;
    }
  });
  return {
    engine: 'strict-note-conditioned', preserved: true, timingPreserved: timingScale === 1,
    noteCount: notes.length, contourPointCount, timingScale, toleranceSeconds: TOLERANCE,
  };
}
