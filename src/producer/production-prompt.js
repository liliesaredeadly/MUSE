import { createBlueprint, planProduction } from './production-blueprint.js';
import { describeMelody } from '../music/melody-profile.js';

// Sources teach the underlying concepts. The selection rules below are Muse's
// editorial heuristics, not recipes attributed to a producer or to these authors.
const SOURCES = [
  { id: 'meta-description', title: 'MusicGen: text and melody-conditioned examples', publisher: 'Meta AI', url: 'https://audiocraft.metademolab.com/musicgen.html' },
  { id: 'ableton-tempo', title: 'Beat and tempo', publisher: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/make-beats/beat-and-tempo.html' },
  { id: 'ableton-genre', title: 'Tempo and genre', publisher: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/make-beats/tempo-and-genre.html' },
  { id: 'ableton-backbeat', title: 'Backbeats', publisher: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/make-beats/backbeats.html' },
  { id: 'ableton-form', title: 'Play with song structures', publisher: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/song-structure/song-structure.html' },
  { id: 'ableton-voicings', title: 'Voicings', publisher: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/advanced-topics/voicings.html' },
  { id: 'izotope-transitions', title: 'How to Create Better Transitions in Your Mix', publisher: 'iZotope', url: 'https://www.izotope.com/community/blog/how-to-create-better-transitions-in-your-mix' },
  { id: 'ableton-effects', title: 'Live Audio Effect Reference', publisher: 'Ableton', url: 'https://www.ableton.com/en/manual/live-audio-effect-reference/' },
];

const GENRES = [
  ['Drum and bass', /\b(?:drum\s*(?:and|&)\s*bass|dnb)\b/g],
  ['Hip-hop', /\bhip[ -]?hop\b/g], ['Lo-fi', /\blo[ -]?fi\b/g],
  ['Dance-pop', /\bdance[ -]?pop\b/g], ['Synth-pop', /\bsynth[ -]?pop\b/g],
  ['R&B', /\b(?:r\s*&\s*b|rhythm and blues)\b/g],
  ...['Electronic', 'Ambient', 'Classical', 'Cinematic', 'Orchestral', 'Jazz', 'Rock', 'Folk', 'House', 'Techno', 'Synthwave', 'Experimental', 'Pop', 'Acoustic']
    .map(name => [name, new RegExp(`\\b${name.toLowerCase()}\\b`, 'g')]),
];
const MOODS = ['dreamy', 'cinematic', 'melancholic', 'energetic', 'peaceful', 'hopeful', 'nostalgic', 'joyful', 'dark', 'bright', 'calm', 'tense', 'romantic', 'playful', 'euphoric', 'intimate'];
const TEXTURES = ['warm', 'airy', 'crisp', 'soft', 'gritty', 'saturated', 'lush', 'minimal', 'sparse', 'dense', 'organic', 'acoustic', 'shimmering', 'rounded', 'dry', 'raw', 'polished', 'lo-fi'];
const ATMOSPHERES = ['intimate', 'spacious', 'dreamy', 'cinematic', 'nocturnal', 'ethereal', 'earthy', 'euphoric', 'underwater'];
const ROLES = { rhythm: 'rhythmic accompaniment', arpeggio: 'arpeggios', chords: 'supporting chords', sustain: 'sustained tones', texture: 'a supporting texture', bass: 'a low foundation', percussion: 'a rhythmic pulse' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedTempo = value => Number.isFinite(value) && value >= 40 && value <= 220 ? Math.round(value * 10) / 10 : null;

function negated(input, index) {
  const clause = input.slice(0, index).split(/[,;.!?]|\b(?:but|then|with|and)\b/).at(-1);
  return /\b(?:not|no|without|avoid|less)\s+(?:\w+\s+){0,2}$/.test(clause);
}

function terms(input, words) {
  return words.flatMap(word => {
    const pattern = new RegExp(`\\b${word.replaceAll('-', '[ -]?')}\\b`, 'g');
    return [...input.matchAll(pattern)].filter(match => !negated(input, match.index)).map(match => ({ value: word, index: match.index }));
  }).sort((a, b) => a.index - b.index).filter((item, index, all) => all.findIndex(other => other.value === item.value) === index).map(item => item.value);
}

function genreIn(input) {
  const matches = GENRES.flatMap(([name, pattern]) => [...input.matchAll(pattern)]
    .filter(match => !negated(input, match.index)).map(match => ({ name, index: match.index, length: match[0].length })));
  // A specific compound genre takes precedence over its overlapping generic word.
  const distinct = matches.filter(item => !matches.some(other => other !== item && other.index <= item.index && other.index + other.length >= item.index + item.length && other.length > item.length));
  return distinct.sort((a, b) => b.index - a.index)[0]?.name ?? null;
}

function melodyEvidence(notes, analysis, warnings) {
  const source = Array.isArray(notes) && notes.length ? notes : Array.isArray(analysis?.notes) ? analysis.notes : [];
  if (!source.length) return null;
  try {
    if (source.length > 512) throw new Error('Too many notes');
    const profile = describeMelody(source.map(note => ({ midi: note?.midi, start: note?.start, duration: note?.duration })));
    return { noteCount: profile.noteCount, duration: profile.duration, register: profile.register, motion: profile.character.motion,
      density: profile.rhythm.density, estimatedBpm: profile.rhythm.estimatedBpm, tempoConfidence: profile.rhythm.confidence };
  } catch {
    warnings.push('Invalid detected notes were omitted from production analysis.');
    return null;
  }
}

/**
 * Build an English MusicGen description locally. Only allowlisted musical
 * descriptors leave this function; arbitrary text, audio, references and source
 * note sequences are never copied into the prompt. No I/O or provider calls.
 */
export function compileProductionPrompt(options = {}) {
  const input = object(options) ? options : {};
  const settings = object(input.settings) ? input.settings : {};
  const warnings = [];
  let safeSettings = settings;
  let base;
  try { base = createBlueprint(settings); }
  catch {
    warnings.push('An invalid production blueprint was ignored; valid settings and directions were used.');
    safeSettings = { ...settings };
    delete safeSettings.blueprint;
    base = createBlueprint(safeSettings);
  }
  const raw = typeof input.text === 'string' && input.text.trim() ? input.text : base.prompt;
  const direction = (typeof raw === 'string' ? raw : '').slice(0, 4000).toLowerCase().replaceAll('’', "'");
  if (typeof raw === 'string' && raw.length > 4000) warnings.push('Production direction was limited to 4,000 characters.');
  const blueprint = planProduction(direction, { ...safeSettings, blueprint: base });
  const melody = melodyEvidence(input.notes, input.analysis, warnings);
  const explicitGenre = genreIn(direction);
  const settingsGenre = genreIn(typeof settings.genre === 'string' ? settings.genre.toLowerCase().slice(0, 100) : '');
  const genre = explicitGenre || settingsGenre || 'Ambient';
  const explicitMoods = terms(direction, MOODS).slice(-3);
  const settingMoods = terms(blueprint.mood.toLowerCase(), MOODS);
  const mood = (explicitMoods.length ? explicitMoods : settingMoods).join(', ') || 'dreamy';
  const tempoMatches = [...direction.matchAll(/\b(\d{2,3}(?:\.\d+)?)\s*bpm\b/g)].filter(match => !negated(direction, match.index));
  const explicitTempo = boundedTempo(Number(tempoMatches.at(-1)?.[1]));
  if (tempoMatches.length && explicitTempo === null) warnings.push('Tempo outside 40–220 BPM was ignored.');
  const settingTempo = boundedTempo(settings.bpm) ?? boundedTempo(settings.sourceBpm);
  const measuredTempo = melody && melody.tempoConfidence >= 0.5 ? boundedTempo(melody.estimatedBpm) : null;
  const bpm = explicitTempo ?? settingTempo ?? measuredTempo;
  const requestedEnergy = terms(direction, ['gentle', 'relaxed', 'subdued', 'restrained', 'energetic', 'driving', 'powerful', 'intense', 'explosive']).at(-1);
  const energyDirection = [...direction.matchAll(/\b(more|higher|increase|raise|less|lower|reduce)\s+(?:the\s+)?(?:energy|intensity|intense|energetic)\b/g)]
    .filter(match => !negated(direction, match.index)).at(-1)?.[1];
  const energy = energyDirection ? /more|higher|increase|raise/.test(energyDirection) ? 'high' : 'low'
    : requestedEnergy ? /energetic|driving|powerful|intense|explosive/.test(requestedEnergy) ? 'high' : 'low'
    : /\b(?:intensity|energy)\b/.test(direction) || safeSettings.blueprint ? blueprint.intensity >= 0.7 ? 'high' : blueprint.intensity <= 0.35 ? 'low' : 'medium'
      : /energetic|euphoric/.test(mood) ? 'high' : /peaceful|calm|intimate/.test(mood) ? 'low' : 'medium';
  const instrumentation = blueprint.layers.filter(layer => layer.enabled).map(({ id, instrument, role, section, gain }) => ({ id, instrument, role, section, gain }));
  const textures = terms(direction, TEXTURES).slice(0, 5);
  const texture = textures.length ? textures : /dreamy|peaceful|melancholic/.test(mood) ? ['soft', 'rounded'] : energy === 'high' ? ['crisp', 'defined'] : ['balanced', 'clear'];
  const atmosphereTerms = terms(direction, ATMOSPHERES).slice(0, 3);
  const atmosphere = atmosphereTerms.length ? atmosphereTerms : /cinematic|dreamy/.test(mood) ? ['spacious'] : /intimate/.test(mood) ? ['intimate'] : ['natural'];
  const structure = [];
  if (/\b(?:start|begin|intro|opening)\b[^.;]{0,40}\b(?:sparse|minimal|quiet|soft)\b/.test(direction)) structure.push('Begin with a sparse opening');
  if (/\b(?:build|grow|crescendo|riser)\b/.test(direction) && !/\b(?:no|not|without|avoid)\s+(?:a\s+)?(?:build|riser|crescendo)\b/.test(direction)) structure.push('Build gradually through added detail and dynamic contrast');
  if (/\b(?:breakdown|strip back|drop out)\b/.test(direction)) structure.push('Create a contrasting stripped-back passage');
  if (/\b(?:chorus|climax|peak)\b/.test(direction) && !/\b(?:hook|copy|recreate|song)\b/.test(direction)) structure.push('Give the central high point a fuller, wider sound');
  if (/\b(?:ending|outro|finish)\b[^.;]{0,35}\b(?:sparse|quiet|soft|fade)\b/.test(direction)) structure.push('Return to a sparse, gentle ending');
  if (!structure.length) structure.push('Develop short phrases through subtle changes in the backing');
  const techniques = [];
  const add = (id, label, description, sourceIds, reason) => techniques.push({ id, label, description, sourceIds, reason });
  add('descriptive-conditioning', 'Descriptive music direction', 'Combine genre, emotion, instrument roles and atmosphere in a concise description.', ['meta-description'], 'The text describes audible musical qualities for the generation model.');
  if (bpm !== null) add('tempo-direction', 'Tempo direction', 'Use the requested pulse rate as a descriptive target.', ['ableton-tempo', 'ableton-genre'], explicitTempo !== null ? 'The direction specifies a BPM.' : settingTempo !== null ? 'The selected settings specify a BPM.' : 'Detected note timing supplies an uncertain tempo suggestion.');
  const drums = instrumentation.some(item => item.id === 'drums');
  const noFloor = /\b(?:no|not|without|avoid)\s+(?:a\s+)?(?:four[ -]on[ -]the[ -]floor|steady kicks?)\b/.test(direction);
  const noBackbeat = /\b(?:no|not|without|avoid)\s+(?:a\s+)?backbeat\b/.test(direction);
  const floor = drums && !noFloor && (/four[ -]on[ -]the[ -]floor|steady kick/.test(direction) || /House|Techno|Dance-pop/.test(genre));
  let groove = '';
  if (floor) {
    groove = 'Use a steady four-on-the-floor kick with a clear, consistent pulse.';
    add('steady-pulse', 'Steady pulse', 'Place a kick on each beat for a clear underlying pulse.', ['ableton-tempo'], 'A dance groove was requested and percussion is enabled.');
  } else if (drums && !noBackbeat && /Pop|Rock|Hip-hop|Lo-fi/.test(genre)) {
    groove = 'Use a restrained backbeat and a rhythm section that supports the melodic phrase.';
    add('backbeat', 'Supporting backbeat', 'Emphasize the second and fourth beats with restrained snare or clap accents.', ['ableton-backbeat'], 'The selected genre uses a supporting groove and percussion is enabled.');
  }
  add('section-development', 'Phrase development', 'Develop shorter patterns into contrasting musical sections.', ['ableton-form'], 'The backing should develop rather than remain a static loop.');
  if (structure.length > 1 || instrumentation.some(item => item.section === 'ending')) add('section-contrast', 'Arrangement contrast', 'Use entries, exits and changes in density to distinguish passages.', ['izotope-transitions'], 'The direction or blueprint requests changes across the arrangement.');
  if (structure.some(item => item.startsWith('Build'))) add('gradual-build', 'Gradual build', 'Increase detail progressively to suggest tension and release.', ['izotope-transitions'], 'A build or crescendo was requested.');
  const openVoicing = /\b(?:open|spread|wide)\s+(?:chord\s+)?voicings?\b/.test(direction) && instrumentation.some(item => ['chords', 'arpeggio'].includes(item.role));
  if (openVoicing) add('open-voicings', 'Open chord voicings', 'Spread supporting chord tones across registers.', ['ableton-voicings'], 'Open voicings were requested for a harmonic backing instrument.');
  const dry = texture.includes('dry') || /\b(?:no|without|avoid)\s+reverb\b/.test(direction);
  const space = dry ? 'Keep the production dry and close.' : atmosphere.includes('spacious') || atmosphere.includes('ethereal') ? 'Use gentle reverb depth around the supporting parts.' : '';
  if (space && !dry) add('spatial-depth', 'Spatial depth', 'Describe reverb space around supporting sounds.', ['ableton-effects'], 'A spacious or ethereal atmosphere was requested or selected.');
  if (/\b(?:like|inspired by|style of|influences?|producer|copy|recreate|hook from|sound of)\b/.test(direction)) warnings.push('Artist, producer and song references are reduced to general musical descriptors; names and recognizable hooks are omitted.');
  if (/\b(?:sing|singer|vocals?|lyrics?)\b/.test(direction) && !/\b(?:no|without)\s+vocals?\b/.test(direction)) warnings.push('This prompt targets instrumental music; MusicGen does not reliably generate realistic vocals.');
  if (/\b(?:exact|precise|guarantee|\d+\s*(?:bars?|seconds?))\b/.test(direction)) warnings.push('Tempo and arrangement directions are descriptive targets, not guarantees of exact timing or form.');
  const parts = instrumentation.map(item => `${item.gain <= 0.35 ? 'soft ' : item.gain >= 0.7 ? 'forward ' : ''}${item.instrument.toLowerCase()} ${ROLES[item.role]}${item.section === 'ending' ? ' entering only near the ending' : ''}`);
  const prompt = [
    `Instrumental ${genre.toLowerCase()} music with a ${mood} character${bpm !== null ? `, ${measuredTempo !== null && explicitTempo === null && settingTempo === null ? 'around ' : ''}${bpm} BPM` : ''} and ${energy} energy.`,
    parts.length ? `The arrangement features ${parts.join('; ')}.` : 'Keep the arrangement sparse and focused on the main musical phrase.',
    `Use a ${texture.join(', ')} texture and ${atmosphere.join(', ')} atmosphere.`,
    groove, `${structure.join('. ')}.`, openVoicing ? 'Use open chord voicings for the harmonic backing.' : '', space,
    'Keep the main melodic phrase clearly audible above the supporting parts.',
  ].filter(Boolean).join(' ').slice(0, 2000);
  const sourceIds = new Set(techniques.flatMap(item => item.sourceIds));
  return { prompt, analysis: { genre, mood, bpm, energy, instrumentation, structure, texture, atmosphere, melody, interpretation: 'local-rules',
    provenance: { genre: explicitGenre ? 'direction' : settingsGenre ? 'settings' : 'default', mood: explicitMoods.length ? 'direction' : safeSettings.blueprint ? 'blueprint' : typeof settings.mood === 'string' && terms(settings.mood.toLowerCase(), MOODS).length ? 'settings' : 'default',
      bpm: explicitTempo !== null ? 'direction' : settingTempo !== null ? 'settings' : measuredTempo !== null ? 'detected-notes' : 'unspecified',
      energy: requestedEnergy || /\b(?:intensity|energy)\b/.test(direction) ? 'direction' : safeSettings.blueprint ? 'blueprint' : 'mood-heuristic',
      instrumentation: 'blueprint-and-direction', texture: textures.length ? 'direction' : 'mood-heuristic', atmosphere: atmosphereTerms.length ? 'direction' : 'mood-heuristic',
      melody: melody ? 'detected-notes' : 'unavailable' } }, techniques, sources: SOURCES.filter(source => sourceIds.has(source.id)).map(source => ({ ...source })), warnings };
}
