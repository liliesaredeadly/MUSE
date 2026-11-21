import { assertMelodyPreserved, validateMelodyNotes } from './melody-contract.js';
import { describeMelody } from './melody-profile.js';
import { buildProductionBacking, resolveProduction } from './production-arrangement.js';
import { buildBlueprintBacking } from './blueprint-arrangement.js';
import { validateBlueprint } from '../producer/production-blueprint.js';
import { validateHarmonicAnchors } from '../audio/transcription-quality.js';

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
    leadSource: input.leadSource === 'recording' ? 'recording' : 'instrument',
    mood: typeof input.mood === 'string' ? input.mood : 'Dreamy',
    genre: typeof input.genre === 'string' ? input.genre : 'Ambient',
    accompaniment: typeof input.accompaniment === 'boolean' ? input.accompaniment : true,
    bass: typeof input.bass === 'boolean' ? input.bass : true,
    percussion: typeof input.percussion === 'boolean' ? input.percussion : false,
    preserveMelodyTiming: typeof input.preserveMelodyTiming === 'boolean' ? input.preserveMelodyTiming : true,
    production: ['auto', 'dance-pop', 'percussive-pop'].includes(input.production) ? input.production : 'auto',
    ...(input.blueprint !== undefined ? { blueprint: validateBlueprint(input.blueprint) } : {}),
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

/** The captured lead is immutable by default; tempo controls the added backing. */
export function buildArrangement(inputNotes, inputSettings = {}, sourceMeta) {
  const settings = normalizeSettings(inputSettings || {});
  const recording = settings.leadSource === 'recording';
  if (recording && (!Number.isFinite(sourceMeta?.duration) || sourceMeta.duration <= 0 || sourceMeta.duration > 60
    || typeof sourceMeta.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceMeta.sha256))) {
    throw new Error('A verified original recording source and its full audio clock are required. Record or import the original take again.');
  }
  if (recording) settings.preserveMelodyTiming = true;
  const source = inputNotes == null ? [] : inputNotes;
  validateMelodyNotes(source, { allowEmpty: true });
  const speed = settings.preserveMelodyTiming ? 1 : settings.sourceBpm / settings.bpm;
  const notes = source.map(note => ({ ...note, start: note.start * speed, duration: note.duration * speed,
    ...(note.contour !== undefined ? { contour: note.contour.map(point => ({ ...point, time: point.time * speed })) } : {}),
  }));
  validateMelodyNotes(notes, { allowEmpty: true });
  const noteEnd = notes.reduce((end, note) => Math.max(end, note.start + note.duration), 0);
  if (recording && noteEnd > sourceMeta.duration + 0.001) throw new Error('The extracted notes exceed the original recording source clock.');
  const duration = recording ? sourceMeta.duration : noteEnd;
  const partialRequested = recording && sourceMeta.quality?.status === 'partial';
  const confirmed = partialRequested && sourceMeta.quality.harmonyScope === 'anchored'
    ? validateHarmonicAnchors(sourceMeta.quality.harmonyNotes, duration) : null;
  // Quality spans must match the validated anchors exactly. A broad or stale
  // region cannot turn independently supported fragments into full-take backing.
  const partial = Boolean(confirmed && Array.isArray(sourceMeta.quality.harmonyRegions)
    && sourceMeta.quality.harmonyRegions.length === confirmed.harmonyRegions.length
    && confirmed.harmonyRegions.every((region, index) => {
      const supplied = sourceMeta.quality.harmonyRegions[index];
      return supplied && Math.abs(supplied.start - region.start) <= 1e-6
        && Math.abs(supplied.duration - region.duration) <= 1e-6;
    }));
  const harmonyNotes = partial ? confirmed.harmonyNotes : notes;
  const canHarmonize = recording ? sourceMeta.quality?.canHarmonize === true
    && (partialRequested ? partial : notes.length > 0) : notes.length > 0;
  const melodyCharacter = describeMelody(notes);
  const production = resolveProduction(settings);
  const description = recording
    ? `Your original recording remains the lead, with its full timing and pitch intact. ${canHarmonize && partial
      ? 'Limited harmony is an approximate suggestion played only in independently confirmed clear parts; unsupported gaps stay unpitched.' : canHarmonize
      ? 'Harmony is an approximate suggestion from recognized notes.'
      : 'Pitch evidence is limited, so guessed chords and bass are disabled; only requested unpitched rhythm can be added.'}`
    : settings.instrument === 'Drums'
    ? 'Drums adds a rhythm layer; Synthesizer carries your pitched melody. Key and chords are approximate suggestions.'
    : 'Your captured melody with synthesized instruments. Key and chords are approximate suggestions from note duration and pitch classes.';
  if (!notes.length && !recording) return { events: [], duration: 0, bpm: settings.bpm, key: 'Undetermined', chords: [], settings, description, melodyProof: null, production, melodyCharacter, structure: [], ...(settings.blueprint ? { layers: settings.blueprint.layers.map(layer => ({ ...layer, blocked: false, reason: null })) } : {}) };

  const mood = settings.mood.toLowerCase();
  const energetic = /energetic|uplifting|happy|bright/.test(mood);
  const dark = /dark|melanchol|sad/.test(mood);
  const cinematic = /cinematic/.test(mood);
  const peaceful = /peaceful|calm/.test(mood);
  const velocity = energetic ? 0.87 : dark ? 0.56 : cinematic ? 0.74 : peaceful ? 0.52 : 0.66;
  const tone = energetic ? 1 : dark ? 0.35 : cinematic ? 0.74 : peaceful ? 0.42 : 0.58;
  const events = recording ? [] : notes.map(note => ({ ...note,
    velocity, instrument: settings.instrument === 'Drums' ? 'Synthesizer' : settings.instrument, track: 'melody', tone }));
  const key = canHarmonize ? estimateKey(harmonyNotes) : null;
  const beat = 60 / settings.bpm;
  const bar = beat * 4;
  const genre = settings.genre.toLowerCase();
  const jazz = /jazz/.test(genre);
  const arpeggio = /electronic|classical/.test(genre);
  const pulse = /pop|lo.?fi|hip.?hop/.test(genre);
  const strings = /ambient|cinematic|orchestral/.test(genre);
  const chords = [];
  const spans = [];
  const produced = production.style !== 'general';
  let structure = [];
  let layers;
  const add = (midi, start, length, eventVelocity, instrument, track) => {
    if (start >= duration) return;
    events.push({ midi, start, duration: Math.min(length, duration - start), velocity: eventVelocity, instrument, track, tone });
  };
  for (let start = produced && !recording ? notes[0].start : 0, index = 0; start < duration; start += bar, index++) {
    const chord = canHarmonize ? chordAt(harmonyNotes, start, Math.min(bar, duration - start), key, index, jazz)
      : { start, duration: Math.min(bar, duration - start), notes: [] };
    spans.push(chord);
    if (canHarmonize) chords.push(chord);
    if (!canHarmonize) continue;
    if (settings.blueprint || produced || !settings.accompaniment) continue;
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
    for (let offset = 0; settings.bass && offset < chord.duration; offset += bassStep) {
      add(chord.notes[0] - 12, start + offset, Math.min(bassStep * 0.8, chord.duration - offset), velocity * 0.4, 'Bass', 'bass');
    }
  }
  if (settings.blueprint) {
    const backing = buildBlueprintBacking({ blueprint: settings.blueprint, notes, chords: spans,
      duration, bpm: settings.bpm, canHarmonize, recording, production });
    events.push(...backing.events);
    structure = backing.structure;
    layers = backing.layers;
  } else if (produced) {
    const backingSettings = canHarmonize ? settings : { ...settings, accompaniment: false, bass: false };
    const backing = buildProductionBacking({ notes, chords: spans, settings: backingSettings, production, character: melodyCharacter, duration, velocity, tone });
    events.push(...backing.events);
    structure = backing.structure;
  } else if (settings.percussion || settings.instrument === 'Drums') {
    const subdivisions = /electronic|pop|lo.?fi|hip.?hop/.test(genre) || energetic ? 2 : 1;
    for (let step = 0; step * beat / subdivisions < duration; step++) {
      const start = step * beat / subdivisions;
      add(42, start, 0.07, velocity * 0.24, 'Drums', 'percussion');
      if (step % (subdivisions * 2) === 0) add(36, start, 0.19, velocity * 0.7, 'Drums', 'percussion');
      if (step % (subdivisions * 2) === subdivisions) add(38, start, 0.14, velocity * 0.43, 'Drums', 'percussion');
    }
  }
  const withinRegions = event => confirmed.harmonyRegions.flatMap(region => {
    const start = Math.max(event.start, region.start);
    const end = Math.min(event.start + event.duration, region.start + region.duration, duration);
    return end > start ? [{ ...event, start, duration: end - start }] : [];
  });
  const scopedEvents = canHarmonize && partial ? events.flatMap(event => event.instrument === 'Drums' || event.track === 'melody'
    ? [event] : withinRegions(event)) : events;
  if (canHarmonize && partial && layers) layers = layers.map(layer => layer.enabled && layer.id !== 'drums'
    && !scopedEvents.some(event => event.layerId === layer.id) ? { ...layer, blocked: true,
      reason: 'No reliable harmonic anchor in the chosen section can support this layer. Choose the full section or record a cleaner take.' } : layer);
  const scopedChords = canHarmonize && partial ? chords.flatMap(withinRegions) : chords;
  scopedEvents.sort((a, b) => a.start - b.start);
  const arrangement = { events: scopedEvents, duration, bpm: settings.bpm, key: key ? `${PITCH_NAMES[key.tonic]} ${key.mode} (estimate)` : 'Undetermined', chords: scopedChords, settings, description, production, melodyCharacter, structure };
  if (canHarmonize && partial) {
    arrangement.harmonyScope = 'anchored';
    arrangement.harmonyRegions = confirmed.harmonyRegions.map(region => ({ ...region }));
  }
  if (layers) arrangement.layers = layers;
  if (recording) {
    arrangement.recordingLead = { duration, sha256: sourceMeta.sha256 };
    arrangement.transcriptionQuality = sourceMeta.quality ? structuredClone(sourceMeta.quality) : { canHarmonize: false };
    arrangement.melodyProof = { engine: 'original-waveform', preserved: true, timingPreserved: true,
      audioSha256: sourceMeta.sha256, durationSeconds: duration, transcriptionVerified: false };
  } else arrangement.melodyProof = assertMelodyPreserved(source, arrangement, { timingScale: speed });
  return arrangement;
}
