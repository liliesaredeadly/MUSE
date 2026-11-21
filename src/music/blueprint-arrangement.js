const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Each layer depends only on the shared source/harmony and its own controls.
 * Changing another layer, its gain or its variant cannot change these notes. */
export function buildBlueprintBacking({ blueprint, notes, chords, duration, bpm, canHarmonize, recording, production }) {
  const events = [];
  const beat = 60 / bpm;
  const startOfTake = recording ? 0 : notes[0]?.start ?? 0;
  const endingStart = duration * 0.75;
  const dance = production?.style === 'dance-pop';
  const percussive = production?.style === 'percussive-pop';
  const mood = {
    Dreamy: { level: 0.74, tone: 0.46 }, Cinematic: { level: 0.9, tone: 0.64 },
    Melancholic: { level: 0.66, tone: 0.32 }, Energetic: { level: 1, tone: 0.86 }, Peaceful: { level: 0.62, tone: 0.4 },
  }[blueprint.mood];
  const level = (0.38 + blueprint.intensity * 0.52) * mood.level;
  const structure = chords.map((chord, index) => ({
    name: chord.start + chord.duration > endingStart ? 'ending' : index === 0 ? 'opening' : 'develop',
    start: chord.start, end: chord.start + chord.duration,
    intensity: blueprint.intensity, phrase: index + 1,
  }));
  const layers = blueprint.layers.map(layer => ({ ...layer,
    blocked: layer.id !== 'drums' && !canHarmonize,
    reason: layer.id !== 'drums' && !canHarmonize
      ? 'Pitch evidence is limited. Reliable harmony is required before this pitched layer can play.' : null,
  }));
  for (const layer of layers) {
    if (!layer.enabled || layer.blocked) continue;
    const entry = Math.max(startOfTake, layer.section === 'ending' ? endingStart : 0);
    const variation = layer.variant;
    const pan = { guitar: -0.3, piano: 0.2, violin: 0.3, cello: -0.2, synth: -0.12, bass: 0, drums: 0 }[layer.id];
    const add = (midi, start, length, strength, track, extra = {}) => {
      const end = Math.min(start + length, duration);
      start = Math.max(start, entry);
      if (end <= start || start >= duration) return;
      events.push({ midi: clamp(midi, 0, 127), start, duration: end - start,
        velocity: clamp(strength * level, 0, 1), instrument: layer.instrument,
        track, layerId: layer.id, tone: mood.tone, pan, ...extra });
    };
    chords.forEach((chord, index) => {
      const end = chord.start + chord.duration;
      if (end <= entry) return;
      // A small deterministic accent change makes every explicit regeneration
      // meaningful even for a one-chord sustain, without inventing lead notes.
      const accent = 0.9 + (variation % 11) * 0.009;
      const at = (offset, length, pitch, strength, track = 'chords', extra) => {
        const start = chord.start + offset * beat;
        if (start < end) add(pitch, start, Math.min(length, end - start), strength * accent, track, extra);
      };
      if (layer.role === 'percussion') {
        const kickOffsets = dance || blueprint.intensity >= 0.7 ? [0, 1, 2, 3] : percussive ? [0, 2.5] : variation % 2 ? [0, 2.5] : [0, 2];
        kickOffsets.forEach(offset => at(offset, 0.17, 36, 0.68, 'percussion'));
        [1, 3].forEach(offset => at(offset, 0.12, dance ? 39 : 38, 0.39, 'percussion'));
        const step = dance || blueprint.intensity > 0.45 ? 0.5 : 1;
        for (let offset = 0; offset < 4; offset += step) at(offset, 0.055, 42, (Number.isInteger(offset) ? 0.16 : 0.22), 'percussion');
        return;
      }
      if (!chord.notes.length) return;
      const pitches = chord.notes.map(pitch => {
        // Keep low accompaniment below the melody while upper strings leave
        // room for an average low-register humming voice.
        if (layer.id === 'violin') return 60 + pitch % 12;
        if (layer.id === 'cello') return 48 + pitch % 12;
        return pitch;
      }).sort((a, b) => a - b);
      if (layer.role === 'bass') {
        const root = 32 + ((chord.notes[0] - 32) % 12 + 12) % 12;
        const offsets = layer.id === 'cello' ? [0, 2] : variation % 2 ? [0, 1.5, 2.5] : [0, 2, 3.5];
        offsets.forEach(offset => at(offset, beat * (layer.id === 'cello' ? 1.85 : 0.72), root, 0.53, 'bass'));
      } else if (layer.role === 'sustain' || layer.role === 'texture') {
        const voices = layer.id === 'cello' ? pitches.slice(0, 1) : pitches.slice(0, layer.id === 'violin' ? 2 : 3);
        voices.forEach((pitch, voice) => at(0, chord.duration * 0.95, pitch, 0.22 * (voice ? 0.83 : 1), 'chords', { timbre: 'pad' }));
      } else if (layer.role === 'arpeggio') {
        const step = blueprint.intensity >= 0.65 ? 0.5 : 1;
        for (let offset = 0, count = 0; offset < 4; offset += step, count++) {
          const pitch = pitches[(count + variation + index) % pitches.length];
          at(offset, beat * step * 0.66, pitch, 0.4, 'chords', { timbre: 'pluck' });
        }
      } else {
        const offsets = layer.role === 'rhythm' ? dance ? [.5, 1.5, 2.5, 3.5] : percussive ? [0, .75, 1.75, 2.5] : variation % 2 ? [0, 1.5, 2, 3.5] : [0, 1, 2.5, 3]
          : dance ? [.5, 1.5, 2.5, 3.5] : percussive ? [0, 1.25, 2.75] : variation % 2 ? [0, 2.5] : [0, 2];
        offsets.forEach((offset, pulse) => pitches.forEach((pitch, voice) =>
          at(offset + (layer.id === 'guitar' ? voice * 0.025 : 0), beat * (layer.id === 'guitar' ? 0.7 : 1.5), pitch,
            (pulse % 2 ? 0.27 : 0.33), 'chords', { timbre: 'pluck' })));
      }
    });
  }
  return { events, structure, layers };
}
