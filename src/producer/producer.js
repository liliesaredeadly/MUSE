const MOODS = { cinematic: 'Cinematic', dreamy: 'Dreamy', melancholic: 'Melancholic', energetic: 'Energetic', peaceful: 'Peaceful' };
const INSTRUMENTS = { piano: 'Piano', synth: 'Synthesizer', synthesizer: 'Synthesizer', strings: 'Strings', bass: 'Bass' };
const GENRES = { ambient: 'Ambient', electronic: 'Electronic', classical: 'Classical', pop: 'Pop', experimental: 'Experimental' };
const MOOD_EFFECTS = {
  Dreamy: 'echo and softer dynamics',
  Cinematic: 'fuller tone and more echo',
  Melancholic: 'darker tone and softer dynamics',
  Energetic: 'brighter tone and louder dynamics',
  Peaceful: 'gentler tone and quieter dynamics',
};
const BACKING = {
  Ambient: 'sustained string backing', Electronic: 'synth arpeggio backing',
  Classical: 'piano arpeggio backing', Pop: 'pulsing piano backing', Experimental: 'sustained piano backing',
};
const SUGGESTIONS = ['Make it cinematic with strings', 'Set tempo to 100 BPM', 'Add percussion', 'Remove accompaniment'];
const clampBpm = (value) => Math.min(200, Math.max(40, Math.round(value)));

// Deliberately small, transparent rules. These propose only controls the music
// engine supports; the caller decides when to apply the returned changes.
export function interpretDirection(text, settings = {}) {
  const input = typeof text === 'string' ? text.slice(0, 4000).toLowerCase().replaceAll('’', "'").replace(/\bdon't\b/g, 'do not') : '';
  const tokens = input.match(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?|[,;.!?]/g) ?? [];
  const changes = {};
  let negative = false;
  let less = false;
  let pianoRequested = false;
  const excludedGenres = new Set();
  const currentBpm = Number.isFinite(settings?.bpm) ? clampBpm(settings.bpm) : 90;

  for (let index = 0; index < tokens.length; index++) {
    const word = tokens[index];
    if (/^[,;.!?]$/.test(word) || ['but', 'then', 'instead', 'however'].includes(word)) {
      negative = false;
      less = false;
      continue;
    }
    if (['no', 'not', 'without', 'remove', 'avoid', 'exclude', 'stop', 'less'].includes(word)) {
      negative = true;
      less = word === 'less';
      continue;
    }
    if (['use', 'add', 'include', 'make', 'with'].includes(word) && !['no', 'not', 'without', 'avoid'].includes(tokens[index - 1])) {
      negative = false;
      less = false;
    }

    if (Object.hasOwn(MOODS, word)) {
      if (!negative) changes.mood = MOODS[word];
      else if (less && word === 'energetic') changes.mood = 'Peaceful';
    }
    if (Object.hasOwn(INSTRUMENTS, word) && !negative) changes.instrument = INSTRUMENTS[word];
    if (word === 'piano') pianoRequested = !negative;
    if (Object.hasOwn(GENRES, word)) {
      if (!negative) { changes.genre = GENRES[word]; excludedGenres.delete(GENRES[word]); }
      else {
        excludedGenres.add(GENRES[word]);
        if (changes.genre === GENRES[word]) delete changes.genre;
      }
    }
    if (['drum', 'drums', 'percussion'].includes(word)) changes.percussion = !negative;
    if (['accompaniment', 'chord', 'chords'].includes(word)) changes.accompaniment = !negative;
    if (word === 'slower' && !negative) changes.bpm = clampBpm(currentBpm - 10);
    if (word === 'faster' && !negative) changes.bpm = clampBpm(currentBpm + 10);

    const isTempoNumber = /^\d+(?:\.\d+)?$/.test(word) && (
      tokens[index + 1] === 'bpm' ||
      ['tempo', 'bpm'].includes(tokens[index - 1]) ||
      (tokens[index - 1] === 'to' && ['tempo', 'bpm'].includes(tokens[index - 2]))
    );
    if (isTempoNumber && !negative) changes.bpm = clampBpm(Number(word));
  }

  // Backing timbre is controlled by genre in the arrangement engine. Classical
  // selects real piano arpeggios; selecting only the lead would leave Ambient
  // string backing in place. An explicit genre or its exclusion takes priority.
  if (pianoRequested && changes.accompaniment === true && !changes.genre && !excludedGenres.has('Classical')) changes.genre = 'Classical';
  const backing = BACKING[changes.genre ?? settings?.genre] ?? BACKING.Ambient;
  const labels = Object.entries(changes).map(([key, value]) => {
    if (key === 'bpm') return `${value} BPM (${value < currentBpm ? 'slower' : value > currentBpm ? 'faster' : 'steady'} timing, pitches preserved)`;
    if (key === 'mood') return `${value.toLowerCase()} mood (${MOOD_EFFECTS[value]})`;
    if (key === 'instrument') return `${value.toLowerCase()} lead for the captured melody`;
    if (key === 'accompaniment') return value ? `accompaniment on (${backing})` : 'accompaniment off';
    if (key === 'percussion') return `percussion ${value ? 'on' : 'off'}`;
    return `${value.toLowerCase()} ${key}`;
  });
  return {
    message: labels.length
      ? `I propose ${labels.join(', ')}. Select Apply to hear these changes.`
      : 'This rule-based producer supports mood, instrument, genre, tempo, accompaniment and percussion. Try one of the examples below.',
    changes,
    suggestions: [...SUGGESTIONS],
  };
}
