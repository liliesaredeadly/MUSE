const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PROFILES = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};
const INSTRUMENTS = ['Piano', 'Synthesizer', 'Strings', 'Bass', 'Drums'];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalizeSettings(input = {}) {
  const tempo = value => Number.isFinite(Number(value)) && Number(value) > 0 ? clamp(Number(value), 40, 220) : 90;
  return {
    bpm: tempo(input.bpm), sourceBpm: tempo(input.sourceBpm),
    instrument: INSTRUMENTS.includes(input.instrument) ? input.instrument : 'Piano',
    mood: typeof input.mood === 'string' ? input.mood : 'Dreamy',
    genre: typeof input.genre === 'string' ? input.genre : 'Ambient',
    accompaniment: input.accompaniment ?? true, percussion: input.percussion ?? false,
  };
}

// A duration-weighted pitch-class profile is a suggestion, not a reliable key detector.
function estimateKey(notes) {
  const histogram = Array(12).fill(0);
  notes.forEach(note => { histogram[note.midi % 12] += note.duration; });
  let best = { score: -Infinity, tonic: 0, mode: 'major' };
  for (const mode of ['major', 'minor']) {
    const scale = mode === 'major' ? MAJOR : MINOR;
    for (let tonic = 0; tonic < 12; tonic++) {
      let score = 0;
      histogram.forEach((weight, pitch) => {
        const relative = (pitch - tonic + 12) % 12;
        score += weight * (PROFILES[mode][relative] + (scale.includes(relative) ? 1.2 : -2));
      });
      score += histogram[tonic] * 0.4;
      if (notes[0].midi % 12 === tonic) score += notes.reduce((total, note) => total + note.duration, 0) * 0.35;
      if (score > best.score) best = { score, tonic, mode };
    }
  }
  return best;
}

function chordAt(notes, start, duration, key, index, jazz) {
  const scale = key.mode === 'major' ? MAJOR : MINOR;
  const pattern = key.mode === 'major' ? [0, 5, 3, 4] : [0, 5, 2, 6];
  const candidates = key.mode === 'major' ? [0, 5, 3, 4, 1, 2] : [0, 5, 2, 6, 3, 4];
  let best;
  for (const degree of candidates) {
    const root = 48 + ((key.tonic + scale[degree]) % 12);
    const relative = offset => scale[(degree + offset) % 7] + (degree + offset >= 7 ? 12 : 0) - scale[degree];
    const pitches = [root, root + relative(2), root + relative(4)];
    if (jazz) pitches.push(root + relative(6));
    const classes = pitches.map(pitch => pitch % 12);
    let score = degree === pattern[index % pattern.length] ? 0.08 : 0;
    for (const note of notes) {
      const overlap = Math.max(0, Math.min(note.start + note.duration, start + duration) - Math.max(note.start, start));
      score += overlap * (classes.includes(note.midi % 12) ? 2 : -0.3);
    }
    if (!best || score > best.score) {
      const minor = relative(2) === 3;
      const seventh = jazz ? (relative(6) === 11 ? 'maj7' : '7') : '';
      best = { score, name: `${PITCH_NAMES[root % 12]}${minor ? 'm' : ''}${seventh}`, start, duration, notes: pitches };
    }
  }
  const { score, ...chord } = best;
  return chord;
}

/** Preserve the user's melody; only timing, timbre and added backing follow settings. */
export function buildArrangement(inputNotes, inputSettings = {}) {
  const settings = normalizeSettings(inputSettings || {});
  const speed = settings.sourceBpm / settings.bpm;
  const notes = (Array.isArray(inputNotes) ? inputNotes : [])
    .filter(note => note && Number.isFinite(note.midi) && note.midi >= 0 && note.midi <= 127 && Number.isFinite(note.start) && note.start >= 0 && Number.isFinite(note.duration) && note.duration > 0)
    .map(note => ({ ...note, midi: Math.round(note.midi), start: note.start * speed, duration: note.duration * speed }))
    .filter(note => Number.isFinite(note.start + note.duration) && note.start + note.duration <= 600)
    .sort((a, b) => a.start - b.start);
  const duration = notes.reduce((end, note) => Math.max(end, note.start + note.duration), 0);
  const description = settings.instrument === 'Drums'
    ? 'Drums adds a rhythm layer; Synthesizer carries your pitched melody. Key and chords are approximate suggestions.'
    : 'Your captured melody with synthesized instruments. Key and chords are approximate suggestions from note duration and pitch classes.';
  if (!notes.length) return { events: [], duration: 0, bpm: settings.bpm, key: 'Undetermined', chords: [], settings, description };

  const mood = settings.mood.toLowerCase();
  const energetic = /energetic|uplifting|happy|bright/.test(mood);
  const dark = /dark|melanchol|sad/.test(mood);
  const cinematic = /cinematic/.test(mood);
  const peaceful = /peaceful|calm/.test(mood);
  const velocity = energetic ? 0.87 : dark ? 0.56 : cinematic ? 0.74 : peaceful ? 0.52 : 0.66;
  const tone = energetic ? 1 : dark ? 0.35 : cinematic ? 0.74 : peaceful ? 0.42 : 0.58;
  const events = notes.map(note => ({ midi: note.midi, start: note.start, duration: note.duration,
    velocity, instrument: settings.instrument === 'Drums' ? 'Synthesizer' : settings.instrument, track: 'melody', tone }));
  const key = estimateKey(notes);
  const beat = 60 / settings.bpm;
  const bar = beat * 4;
  const genre = settings.genre.toLowerCase();
  const jazz = /jazz/.test(genre);
  const arpeggio = /electronic|classical/.test(genre);
  const pulse = /pop|lo.?fi|hip.?hop/.test(genre);
  const strings = /ambient|cinematic|orchestral/.test(genre);
  const chords = [];
  const add = (midi, start, length, eventVelocity, instrument, track) => {
    if (start >= duration) return;
    events.push({ midi, start, duration: Math.min(length, duration - start), velocity: eventVelocity, instrument, track, tone });
  };
  for (let start = 0, index = 0; start < duration; start += bar, index++) {
    const chord = chordAt(notes, start, Math.min(bar, duration - start), key, index, jazz);
    chords.push(chord);
    if (!settings.accompaniment) continue;
    const backingInstrument = strings ? 'Strings' : /electronic/.test(genre) ? 'Synthesizer' : 'Piano';
    if (arpeggio) {
      for (let step = 0; step * beat / 2 < chord.duration; step++) {
        add(chord.notes[step % chord.notes.length], start + step * beat / 2, beat * 0.4, velocity * 0.4, backingInstrument, 'chords');
      }
    } else if (pulse) {
      for (let step = 0; step * beat < chord.duration; step++) {
        const swing = /lo.?fi|hip.?hop/.test(genre) && step % 2 ? beat * 0.12 : 0;
        chord.notes.forEach(midi => add(midi, start + step * beat + swing, beat * 0.65, velocity * 0.28, backingInstrument, 'chords'));
      }
    } else {
      chord.notes.forEach(midi => add(midi, start, chord.duration * 0.94, velocity * 0.3, backingInstrument, 'chords'));
    }
    const bassStep = /electronic|pop|hip.?hop/.test(genre) ? beat : bar;
    for (let offset = 0; offset < chord.duration; offset += bassStep) {
      add(chord.notes[0] - 12, start + offset, Math.min(bassStep * 0.8, chord.duration - offset), velocity * 0.4, 'Bass', 'bass');
    }
  }
  if (settings.percussion || settings.instrument === 'Drums') {
    const subdivisions = /electronic|pop|lo.?fi|hip.?hop/.test(genre) || energetic ? 2 : 1;
    for (let step = 0; step * beat / subdivisions < duration; step++) {
      const start = step * beat / subdivisions;
      add(42, start, 0.07, velocity * 0.24, 'Drums', 'percussion');
      if (step % (subdivisions * 2) === 0) add(36, start, 0.19, velocity * 0.7, 'Drums', 'percussion');
      if (step % (subdivisions * 2) === subdivisions) add(38, start, 0.14, velocity * 0.43, 'Drums', 'percussion');
    }
  }
  events.sort((a, b) => a.start - b.start);
  return { events, duration, bpm: settings.bpm, key: `${PITCH_NAMES[key.tonic]} ${key.mode} (estimate)`, chords, settings, description };
}
