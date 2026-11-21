const MOODS = ['Dreamy', 'Cinematic', 'Melancholic', 'Energetic', 'Peaceful'];
export const LAYER_CATALOG = Object.freeze([
  { id: 'guitar', instrument: 'Acoustic Guitar', label: 'Acoustic guitar', roles: ['rhythm', 'arpeggio'] },
  { id: 'piano', instrument: 'Piano', label: 'Piano', roles: ['chords', 'arpeggio'] },
  { id: 'violin', instrument: 'Violin', label: 'Violin', roles: ['sustain'] },
  { id: 'cello', instrument: 'Cello', label: 'Cello', roles: ['sustain', 'bass'] },
  { id: 'synth', instrument: 'Synthesizer', label: 'Synthesizer', roles: ['texture', 'arpeggio'] },
  { id: 'bass', instrument: 'Bass', label: 'Bass', roles: ['bass'] },
  { id: 'drums', instrument: 'Drums', label: 'Drums', roles: ['percussion'] },
].map(item => Object.freeze({ ...item, roles: Object.freeze(item.roles) })));

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;
const clamp = value => Math.min(1, Math.max(0, value));
const gains = { guitar: 0.55, piano: 0.45, violin: 0.35, cello: 0.35, synth: 0.35, bass: 0.5, drums: 0.45 };
const aliases = { guitar: ['guitar'], guitars: ['guitar'], piano: ['piano'], pianos: ['piano'], violin: ['violin'], violins: ['violin'], cello: ['cello'], cellos: ['cello'], strings: ['violin', 'cello'], string: ['violin', 'cello'], synth: ['synth'], synthesizer: ['synth'], synths: ['synth'], bass: ['bass'], drum: ['drums'], drums: ['drums'], percussion: ['drums'] };

/** Shared browser/server contract. A blueprint never contains source or lead controls. */
export function validateBlueprint(input) {
  if (!exactKeys(input, ['version', 'prompt', 'mood', 'intensity', 'layers']) || input.version !== 1
    || typeof input.prompt !== 'string' || input.prompt.length > 4000 || !MOODS.includes(input.mood)
    || !unit(input.intensity) || !Array.isArray(input.layers) || input.layers.length > 7) throw new Error('Invalid production blueprint.');
  const seen = new Set();
  const layers = input.layers.map(layer => {
    const catalog = LAYER_CATALOG.find(item => item.id === layer?.id);
    if (!exactKeys(layer, ['id', 'instrument', 'role', 'enabled', 'gain', 'section', 'variant']) || !catalog || seen.has(layer.id)
      || layer.instrument !== catalog.instrument || !catalog.roles.includes(layer.role) || typeof layer.enabled !== 'boolean'
      || !unit(layer.gain) || !['full', 'ending'].includes(layer.section) || !Number.isInteger(layer.variant) || layer.variant < 0 || layer.variant > 999) {
      throw new Error('Invalid production layer: use unique supported instruments, roles and bounded controls.');
    }
    seen.add(layer.id);
    return { id: layer.id, instrument: layer.instrument, role: layer.role, enabled: layer.enabled, gain: layer.gain, section: layer.section, variant: layer.variant };
  });
  return { version: 1, prompt: input.prompt, mood: input.mood, intensity: input.intensity, layers };
}

function newLayer(id) {
  const item = LAYER_CATALOG.find(layer => layer.id === id);
  return { id, instrument: item.instrument, role: item.roles[0], enabled: true, gain: gains[id], section: 'full', variant: 0 };
}

export function createBlueprint(settings = {}) {
  if (settings?.blueprint !== undefined) return validateBlueprint(settings.blueprint);
  const layers = [];
  if (settings?.accompaniment !== false) {
    const id = settings?.genre === 'Electronic' ? 'synth' : ['Classical', 'Pop'].includes(settings?.genre) ? 'piano' : 'violin';
    const layer = newLayer(id);
    if (settings?.genre === 'Electronic' || settings?.genre === 'Classical') layer.role = 'arpeggio';
    layers.push(layer);
  }
  if (settings?.bass !== false) layers.push(newLayer('bass'));
  if (settings?.percussion === true || settings?.instrument === 'Drums') layers.push(newLayer('drums'));
  return { version: 1, prompt: '', mood: MOODS.includes(settings?.mood) ? settings.mood : 'Dreamy', intensity: 0.5, layers };
}

function gainDirection(words, fromEnd = false) {
  const values = words.map(word => ['softer', 'quieter', 'lower', 'less', 'soft', 'gentler', 'reduce', 'lowering', 'light', 'lighter'].includes(word) ? -1
    : ['louder', 'loud', 'stronger', 'boost', 'raise', 'increase'].includes(word) ? 1 : 0).filter(Boolean);
  return fromEnd ? values.at(-1) || 0 : values[0] || 0;
}

/** Small local planner: modifies named backing layers, never the captured melody. */
export function planProduction(text, settings = {}) {
  const blueprint = createBlueprint(settings);
  blueprint.prompt = typeof text === 'string' ? text.slice(0, 4000) : '';
  const input = blueprint.prompt.toLowerCase().replaceAll('’', "'").replace(/\b(?:don't|do not|never)\b/g, 'not');
  const clauses = input.split(/[,;.!?]|\b(?:but|then|instead|however)\b/);
  const requested = new Set();
  for (const clause of clauses) {
    const words = clause.match(/[a-z]+|\d+(?:\.\d+)?/g) || [];
    let negative = false;
    let previousMention = -1;
    const mentions = words.flatMap((word, index) => {
      if (!Object.hasOwn(aliases, word)) return [];
      // "cello bass" assigns a cello role; "cello and bass" names two instruments.
      if (word === 'bass' && words[index - 1] === 'cello') return [];
      return [{ index, ids: aliases[word] }];
    });
    for (let m = 0; m < mentions.length; m++) {
      const { index, ids } = mentions[m];
      const before = words.slice(previousMention + 1, index);
      const after = words.slice(index + 1, mentions[m + 1]?.index ?? words.length);
      const boundary = Math.max(before.lastIndexOf('and'), before.lastIndexOf('or'));
      const modifiersBefore = previousMention < 0 ? before : before.slice(boundary + 1);
      const coordinated = after.findIndex(word => ['with', 'and', 'or'].includes(word));
      const modifiersAfter = coordinated < 0 ? after : after.slice(0, coordinated);
      // A negated destructive action is a request to retain the layer.
      const keepLayer = /\bnot\s+(?:remove|mute|disable|exclude|stop|off|turn\s+off)\b/.test([...modifiersBefore, ...modifiersAfter].join(' '));
      if (keepLayer) { previousMention = index; continue; }
      for (let i = previousMention + 1; i < index; i++) {
        if (['no', 'not', 'without', 'remove', 'avoid', 'exclude', 'stop', 'disable', 'mute', 'off'].includes(words[i])) negative = true;
        if (['add', 'use', 'include', 'with', 'enable', 'bring', 'introduce', 'unmute'].includes(words[i]) && !['no', 'not', 'without', 'avoid'].includes(words[i - 1])) negative = false;
      }
      if (modifiersAfter.some(word => ['off', 'muted', 'disabled'].includes(word))) negative = true;
      const delta = gainDirection(modifiersBefore, true) || gainDirection(modifiersAfter);
      const rejectedModifier = delta !== 0 && (negative && modifiersBefore.includes('not') || after.includes('not'));
      if (!rejectedModifier) for (const id of ids) {
        let layer = blueprint.layers.find(item => item.id === id);
        if (!layer) { layer = newLayer(id); blueprint.layers.push(layer); }
        if (negative) { layer.enabled = false; continue; }
        requested.add(id);
        // A reduction must not accidentally re-enable a previously removed layer.
        if (!delta || before.some(word => ['add', 'enable', 'include'].includes(word))) layer.enabled = true;
        if (delta) layer.gain = Math.round(clamp(layer.gain + delta * 0.15) * 100) / 100;
        const local = [...modifiersBefore, ...after];
        if (local.some(word => ['ending', 'end', 'outro'].includes(word)) || /final\s+(?:quarter|section|part)/.test(local.join(' '))) layer.section = 'ending';
        if (local.some(word => ['throughout', 'full', 'whole'].includes(word))) layer.section = 'full';
        const roleWord = after.find(word => /^(?:arpeggios?|arpeggiated|chords?|texture|rhythm|sustain|bass)$/.test(word))
          || modifiersBefore.findLast(word => /^(?:arpeggios?|arpeggiated|chords?|texture|rhythm|sustain)$/.test(word));
        const role = roleWord?.startsWith('arpegg') ? 'arpeggio' : roleWord?.startsWith('chord') ? 'chords' : roleWord;
        if (role && LAYER_CATALOG.find(item => item.id === id).roles.includes(role)) layer.role = role;
      }
      previousMention = index;
    }
    for (const mood of MOODS) if (new RegExp(`\\b${mood.toLowerCase()}\\b`).test(clause)
      && !new RegExp(`\\b(?:not|no|less)\\s+${mood.toLowerCase()}\\b`).test(clause)) blueprint.mood = mood;
  }
  const restricted = /\b(?:only|just)\b/.test(input.replace(/\bonly\s+(?:in|at|for|during|towards?|near)\b/g, ''));
  if (restricted && requested.size) for (const layer of blueprint.layers) if (!requested.has(layer.id)) layer.enabled = false;
  if (/\b(?:more|higher|increase|raise)\s+(?:the\s+)?(?:intensity|intense|energy|energetic)\b/.test(input)) blueprint.intensity = Math.round(clamp(blueprint.intensity + 0.15) * 100) / 100;
  if (/\b(?:less|lower|reduce)\s+(?:the\s+)?(?:intensity|intense|energy|energetic)\b/.test(input)) blueprint.intensity = Math.round(clamp(blueprint.intensity - 0.15) * 100) / 100;
  const explicitIntensity = /\bintensity\s*(?:to|at|of)?\s*(\d+(?:\.\d+)?)\s*(%)?/.exec(input);
  if (explicitIntensity) blueprint.intensity = clamp(Number(explicitIntensity[1]) / (explicitIntensity[2] ? 100 : 1));
  return validateBlueprint(blueprint);
}
