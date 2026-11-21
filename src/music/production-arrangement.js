const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function resolveProduction(settings) {
  const requested = ['dance-pop', 'percussive-pop'].includes(settings.production) ? settings.production : 'auto';
  const style = requested !== 'auto' ? requested : settings.genre === 'Electronic' ? 'dance-pop' : settings.genre === 'Pop' ? 'percussive-pop' : 'general';
  return { requested, style, rationale: requested === 'auto'
    ? `Backing follows the selected ${settings.genre} genre and the captured phrase; tempo remains independently editable.`
    : `${style === 'dance-pop' ? 'Steady dance pulse, bright synth articulation and evolving layers' : 'Sparse percussive plucks, syncopated bass and restrained layers'} around the original captured melody.` };
}

function voiceChord(pitches, previous, register) {
  const target = register === 'low' ? 63 : register === 'high' ? 57 : 52;
  let best;
  for (let inversion = 0; inversion < pitches.length; inversion++) {
    const inverted = [...pitches.slice(inversion), ...pitches.slice(0, inversion).map(pitch => pitch + 12)];
    for (const shift of [-24, -12, 0, 12, 24]) {
      const notes = inverted.map(pitch => pitch + shift);
      if (notes[0] < 40 || notes.at(-1) > 76) continue;
      const center = notes.reduce((sum, pitch) => sum + pitch, 0) / notes.length;
      const movement = previous ? notes.reduce((sum, pitch, i) => sum + Math.abs(pitch - previous[i]), 0) / notes.length : 0;
      const score = Math.abs(center - target) + movement * 0.75;
      if (!best || score < best.score) best = { score, notes };
    }
  }
  return best?.notes ?? pitches;
}

/** Generic production grammar. Pitches/voicings come from this input's harmony,
 * never from a reference recording, stored hook or song recognition result. */
export function buildProductionBacking({ notes, chords, settings, production, character, duration, velocity, tone }) {
  const events = [];
  const structure = [];
  const beat = 60 / settings.bpm;
  const dance = production.style === 'dance-pop';
  const sparse = character.rhythm.density > 3;
  const backingInstrument = settings.production === 'auto' && settings.genre === 'Pop' ? 'Piano' : 'Synthesizer';
  const startOfTake = settings.leadSource === 'recording' ? 0 : notes[0]?.start ?? 0;
  const phrases = character.phrases.length ? character.phrases : [{ start: 0, end: duration }];
  const add = (midi, start, length, level, instrument, track, extra = {}) => {
    const gate = Math.min(length, duration - start);
    if (start < startOfTake || gate <= 0) return;
    events.push({ midi, start, duration: gate, velocity: clamp(level, 0, 1), instrument, track, tone, ...extra });
  };
  let previous;
  chords.forEach((chord, index) => {
    const voicing = chord.notes.length ? voiceChord(chord.notes, previous, character.register) : [];
    if (voicing.length) previous = voicing;
    const last = index === chords.length - 1;
    const fraction = chords.length <= 1 ? 0.5 : index / (chords.length - 1);
    let phraseIndex = 0;
    phrases.forEach((phrase, i) => { if (phrase.start <= chord.start + 1e-6) phraseIndex = i; });
    const phrase = phrases[phraseIndex];
    const phraseEntry = phraseIndex > 0 && chord.start - phrase.start < beat;
    const baseIntensity = chords.length <= 1 ? 0.8 : index === 0 ? 0.64 : last ? 0.72 : fraction < 0.5 ? 0.8 : 1;
    const energy = character.character.energy === 'low' ? 0.84 : character.character.energy === 'high' ? 1 : 0.93;
    const intensity = baseIntensity * energy * (phraseEntry ? 0.9 : 1);
    const name = chords.length <= 1 ? 'phrase' : index === 0 ? 'opening' : last ? 'resolve' : fraction < 0.5 ? 'develop' : 'lift';
    structure.push({ name, start: chord.start, end: chord.start + chord.duration, intensity, phrase: phraseIndex + 1 });
    const crowdedOnset = time => sparse && notes.some(note => Math.abs(note.start - time) < 0.045);
    const melodicSeed = notes.filter(note => note.start >= chord.start && note.start < chord.start + chord.duration)
      .reduce((sum, note) => sum + note.midi, index);
    if (settings.accompaniment && voicing.length) {
      if (dance) {
        const offsets = sparse ? [0.5, 2.5] : [0.5, 1.5, 2.5, 3.5];
        for (const [step, offset] of offsets.entries()) {
          const start = chord.start + offset * beat;
          if (start >= chord.start + chord.duration || crowdedOnset(start)) continue;
          for (const [voice, pitch] of voicing.slice(0, 2).entries()) add(pitch, start, beat * 0.36,
            velocity * 0.5 * intensity, backingInstrument, 'chords', { timbre: 'pluck', pan: voice ? 0.24 : -0.24 });
        }
        if (!sparse && intensity >= 0.8 && index % 2 === 0) {
          voicing.forEach((pitch, voice) => add(pitch, chord.start, chord.duration * 0.82,
            velocity * 0.17 * intensity, backingInstrument, 'chords', { timbre: 'pad', pan: (voice - 1) * 0.28 }));
        }
      } else {
        // Change the contour of the chord texture with the fresh melody. These
        // generic offbeats contain no reference-song pitch or rhythmic motif.
        const offsets = sparse ? [0.5, 2.25] : melodicSeed % 2 ? [0, 0.75, 1.75, 2.5, 3.25] : [0, 1.25, 2, 2.75, 3.5];
        offsets.forEach((offset, step) => {
          const start = chord.start + offset * beat;
          if (start >= chord.start + chord.duration || crowdedOnset(start)) return;
          const pitch = voicing[(step + melodicSeed) % voicing.length];
          add(pitch, start, beat * 0.3, velocity * (step % 2 ? 0.47 : 0.56) * intensity,
            backingInstrument, 'chords', { timbre: 'pluck', pan: step % 2 ? 0.18 : -0.18 });
        });
      }
      if (settings.bass) {
        let root = 36 + chord.notes[0] % 12;
        if (root > 43) root -= 12;
        // Keep useful bass fundamentals even for a low hummed lead. Chord
        // voicing moves above low voices; dropping bass again would reach 27 Hz.
        const offsets = dance ? [0.5, 1.5, 2.5, 3.5] : sparse ? [0, 2.5] : [0, 1.75, 2.5];
        offsets.forEach(offset => {
          const start = chord.start + offset * beat;
          if (start < chord.start + chord.duration) add(root, start, beat * (dance ? 0.42 : 0.62), velocity * 0.66 * intensity, 'Bass', 'bass');
        });
      }
    }
    if (settings.percussion || settings.instrument === 'Drums') {
      const drum = (pitch, offset, length, level) => {
        const start = chord.start + offset * beat;
        if (start < chord.start + chord.duration) add(pitch, start, length, velocity * level * intensity, 'Drums', 'percussion');
      };
      for (const offset of dance ? [0, 1, 2, 3] : [0, 2.5]) drum(36, offset, 0.19, 0.9);
      for (const offset of [1, 3]) drum(dance ? 39 : 38, offset, 0.12, dance ? 0.57 : 0.44);
      const hatStep = sparse && !dance ? 1 : 0.5;
      for (let offset = 0; offset < 4; offset += hatStep) {
        const accent = Number.isInteger(offset) ? 0.2 : 0.29;
        drum(42, offset, 0.055, accent * (index % 2 && offset === 3.5 ? 1.2 : 1));
      }
      if (dance && intensity >= 0.9) drum(46, 3.5, 0.12, 0.25);
      if (phraseIndex < phrases.length - 1 && phrase.end >= chord.start && phrase.end < chord.start + chord.duration) {
        drum(38, (phrase.end - chord.start) / beat + 0.25, 0.07, 0.17);
      }
    }
  });
  return { events, structure };
}
