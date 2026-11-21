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

function productionPhrase(tokens, index) {
  for (const [words, style] of [
    [['beauty', 'and', 'a', 'beat'], 'dance-pop'],
    [['shape', 'of', 'you'], 'percussive-pop'],
    [['dance', 'pop'], 'dance-pop'],
    [['percussive', 'pop'], 'percussive-pop'],
    [['tropical', 'pop'], 'percussive-pop'],
    [['deep', 'rhythmic', 'pop'], 'percussive-pop'],
  ]) if (words.every((word, offset) => tokens[index + offset] === word)) return { style, length: words.length };
  return null;
}

// Deliberately small, transparent rules. These propose only controls the music
// engine supports; the caller decides when to apply the returned changes.
export function interpretDirection(text, settings = {}) {
  const input = typeof text === 'string' ? text.slice(0, 4000).toLowerCase().replaceAll('’', "'").replace(/\bdon't\b/g, 'do not') : '';
  const tokens = input.match(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?|[,;.!?]/g) ?? [];
  const changes = {};
  let negative = false;
  let less = false;
  let pianoRequested = false;
  let constraintNote = '';
  let productionRequested = null;
  let restrictedInstruments = false;
  const requestedInstruments = new Set();
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

    const production = productionPhrase(tokens, index);
    if (production) {
      if (!negative) productionRequested = production.style;
      else if (productionRequested === production.style) productionRequested = null;
      index += production.length - 1;
      continue;
    }
    if (Object.hasOwn(MOODS, word)) {
      if (!negative) changes.mood = MOODS[word];
      else if (less && word === 'energetic') changes.mood = 'Peaceful';
      else if (changes.mood === MOODS[word]) delete changes.mood;
    }
    if (Object.hasOwn(INSTRUMENTS, word)) {
      if (!negative) {
        changes.instrument = INSTRUMENTS[word];
        requestedInstruments.add(INSTRUMENTS[word]);
      } else {
        requestedInstruments.delete(INSTRUMENTS[word]);
        if (changes.instrument === INSTRUMENTS[word]) delete changes.instrument;
      }
    }
    if (word === 'piano') pianoRequested = !negative;
    if (word === 'bass' && negative) changes.bass = false;
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
  const pair = input.match(/\b(piano|strings)\s*(?:and|with|&|\+)\s*(piano|strings)\b/);
  const pairGenre = changes.genre && changes.genre !== 'Electronic' ? changes.genre : pair?.[1] === 'piano' ? 'Ambient' : 'Classical';
  if (pair && requestedInstruments.size === 2 && requestedInstruments.has('Piano') && requestedInstruments.has('Strings')
    && changes.accompaniment !== false && !excludedGenres.has(pairGenre)) {
    // One captured lead plus one real chord timbre, without unrequested layers.
    if (changes.genre === 'Electronic') constraintNote = `Electronic backing uses Synthesizer; ${pairGenre} backing keeps both piano and strings. `;
    changes.instrument = pairGenre === 'Ambient' ? 'Piano' : 'Strings';
    changes.genre = pairGenre;
    changes.accompaniment = true;
    changes.bass = false;
    changes.percussion ??= false;
    restrictedInstruments = true;
  } else {
    const solo = input.match(/\b(?:only|just)\s+(piano|strings|synthesizer|synth|bass)\b|\b(piano|strings|synthesizer|synth|bass)\s+only\b/);
    if (solo && requestedInstruments.size === 1 && changes.instrument === INSTRUMENTS[solo[1] ?? solo[2]]) {
      changes.accompaniment = false;
      changes.percussion ??= false;
      restrictedInstruments = true;
    }
  }
  if (productionRequested) {
    const genre = productionRequested === 'dance-pop' ? 'Electronic' : 'Pop';
    if (restrictedInstruments || excludedGenres.has(genre)) {
      changes.production = 'auto';
      constraintNote += 'Your instrument and genre restrictions take priority over the benchmark layers. Your original melody stays unchanged. ';
    } else {
      changes.production = productionRequested;
      changes.genre ??= genre;
      changes.accompaniment ??= true;
      changes.bass ??= true;
      changes.percussion ??= true;
      constraintNote += 'This uses general production traits only; your original melody and timing stay unchanged. ';
    }
  } else if (restrictedInstruments && settings?.production && settings.production !== 'auto') changes.production = 'auto';
  if (changes.bass === false && !changes.instrument && settings?.instrument === 'Bass') changes.instrument = 'Piano';
  // Drums uses a synth melody plus forced rhythm. Keep that pitched melody
  // while removing the rhythm requested by a negative percussion direction.
  if (changes.percussion === false && (changes.instrument ?? settings?.instrument) === 'Drums') changes.instrument = 'Synthesizer';
  const recordingLead = settings?.leadSource === 'recording';
  if (recordingLead && Object.keys(changes).length) constraintNote += 'Your original hum remains the lead; instrumental preferences do not replace that recording. ';
  const backing = BACKING[changes.genre ?? settings?.genre] ?? BACKING.Ambient;
  const labels = Object.entries(changes).map(([key, value]) => {
    if (key === 'bpm') return `${value} BPM (${value < currentBpm ? 'slower' : value > currentBpm ? 'faster' : 'steady'} timing, pitches preserved)`;
    if (key === 'mood') return `${value.toLowerCase()} mood (${MOOD_EFFECTS[value]})`;
    if (key === 'instrument') return recordingLead ? `${value.toLowerCase()} instrumental preference` : `${value.toLowerCase()} lead for the captured melody`;
    if (key === 'accompaniment') return value ? `accompaniment on (${backing})` : 'accompaniment off';
    if (key === 'percussion') return `percussion ${value ? 'on' : 'off'}`;
    if (key === 'bass') return `bass backing ${value ? 'on' : 'off'}`;
    return `${value.toLowerCase()} ${key}`;
  });
  return {
    message: labels.length
      ? `${constraintNote}I propose ${labels.join(', ')}. Select Apply to hear these changes.`
      : 'This rule-based producer supports mood, instrument, genre, tempo, accompaniment and percussion. Try one of the examples below.',
    changes,
    suggestions: [...SUGGESTIONS],
  };
}
