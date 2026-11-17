export const DEFAULT_SETTINGS = Object.freeze({
  bpm: 90,
  sourceBpm: 90,
  instrument: 'Piano',
  mood: 'Dreamy',
  genre: 'Ambient',
  accompaniment: true,
  percussion: false,
});

const STORAGE_KEY = 'muse.projects.v1';
const MAX_PROJECTS = 30;
const MAX_NOTES = 512;
const MAX_SECONDS = 600;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const OPTIONS = {
  instrument: ['Piano', 'Synthesizer', 'Strings', 'Bass', 'Drums'],
  mood: ['Dreamy', 'Cinematic', 'Melancholic', 'Energetic', 'Peaceful'],
  genre: ['Ambient', 'Electronic', 'Classical', 'Pop', 'Experimental'],
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const validBpm = (value) => Number.isFinite(value) && value >= 40 && value <= 200;

function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function cleanSettings(value) {
  const source = isObject(value) ? value : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of ['bpm', 'sourceBpm']) if (validBpm(source[key])) settings[key] = Math.round(source[key]);
  for (const [key, options] of Object.entries(OPTIONS)) if (options.includes(source[key])) settings[key] = source[key];
  for (const key of ['accompaniment', 'percussion']) if (typeof source[key] === 'boolean') settings[key] = source[key];
  return settings;
}

function cleanNotes(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_NOTES).filter((note) => isObject(note)
    && Number.isInteger(note.midi) && note.midi >= 0 && note.midi <= 127
    && Number.isFinite(note.start) && note.start >= 0
    && Number.isFinite(note.duration) && note.duration > 0 && note.start + note.duration <= MAX_SECONDS
    && (note.confidence === undefined || (Number.isFinite(note.confidence) && note.confidence >= 0 && note.confidence <= 1)))
    .map((note) => ({
      midi: note.midi,
      name: `${NOTE_NAMES[note.midi % 12]}${Math.floor(note.midi / 12) - 1}`,
      start: note.start,
      duration: note.duration,
      confidence: note.confidence ?? 1,
    }))
    .sort((left, right) => left.start - right.start);
}

function cleanTimestamp(value, fallback) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : fallback;
}

function cleanProject(value) {
  if (!isObject(value) || !validId(value.id)) return null;
  const now = new Date().toISOString();
  const title = typeof value.title === 'string' ? value.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';
  return {
    id: value.id,
    title: title || 'Untitled melody',
    notes: cleanNotes(value.notes),
    settings: cleanSettings(value.settings),
    createdAt: cleanTimestamp(value.createdAt, now),
    updatedAt: cleanTimestamp(value.updatedAt, now),
  };
}

export function createProject() {
  const now = new Date().toISOString();
  const id = globalThis.crypto?.randomUUID?.() ?? `melody-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { id, title: 'Untitled melody', notes: [], settings: { ...DEFAULT_SETTINGS }, createdAt: now, updatedAt: now };
}

// Loading is recovery-oriented. Pick fields explicitly so stored audio, unknown
// properties, and prototype keys can never enter a reopened project.
export function loadProjects(storage = browserStorage()) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (typeof raw !== 'string' || raw.length > 2_000_000) return [];
    const values = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    const projects = [];
    const seen = new Set();
    for (const value of values.slice(0, 300)) {
      const project = cleanProject(value);
      if (!project || seen.has(project.id)) continue;
      seen.add(project.id);
      projects.push(project);
      if (projects.length === MAX_PROJECTS) break;
    }
    return projects;
  } catch { return []; }
}

export function saveProject(value, storage = browserStorage()) {
  const project = cleanProject(value);
  if (!project) throw new Error('Cannot save project: invalid project identity.');
  if (!storage || typeof storage.setItem !== 'function') throw new Error('Cannot save project: browser storage is unavailable.');
  const existing = loadProjects(storage);
  const previous = existing.find((item) => item.id === project.id);
  if (previous) project.createdAt = previous.createdAt;
  project.updatedAt = new Date().toISOString();
  const projects = [project, ...existing.filter((item) => item.id !== project.id)].slice(0, MAX_PROJECTS);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch (error) {
    throw new Error(`Could not save project to browser storage: ${error?.message || 'storage unavailable'}`, { cause: error });
  }
  return project;
}
