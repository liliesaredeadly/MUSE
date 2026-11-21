import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { matchReference } from '../src/music/reference-match.js';

const DEFAULT_REFERENCE_PATH = fileURLToPath(new URL('../.local/reference-audio/features.json', import.meta.url));
const MAX_FEATURE_BYTES = 4 * 1024 * 1024;
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);

function validFeatures(value) {
  if (!value || value.version !== 1 || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id || '')
    || !validText(value.title) || !validText(value.artist) || value.method !== 'spectral-chroma' || value.notesVerified !== false
    || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 600
    || !Number.isFinite(value.frameSeconds) || value.frameSeconds < 0.05 || value.frameSeconds > 0.5
    || !Array.isArray(value.chroma) || value.chroma.length < 1 || value.chroma.length > 12000
    || Math.abs(value.chroma.length * value.frameSeconds - value.duration) > value.frameSeconds * 2) return false;
  try {
    const source = new URL(value.sourceUrl);
    if (source.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'youtu.be'].includes(source.hostname) || source.username || source.password) return false;
  } catch { return false; }
  return value.chroma.every(frame => Array.isArray(frame) && frame.length === 12
    && frame.every(number => Number.isFinite(number) && number >= 0 && number <= 1.001));
}

function metadata(reference) {
  const { id, title, artist, sourceUrl, duration, method } = reference;
  return { id, title, artist, sourceUrl, duration, method, notesVerified: false };
}

/** Only this fixed private feature file is read. No audio or local paths leave the service. */
export function createReferenceLibrary({ referencePath = DEFAULT_REFERENCE_PATH } = {}) {
  async function load() {
    try {
      const info = await stat(referencePath);
      if (!info.isFile() || info.size > MAX_FEATURE_BYTES) throw new Error('Invalid feature file');
      const content = await readFile(referencePath, 'utf8');
      if (Buffer.byteLength(content) > MAX_FEATURE_BYTES) throw new Error('Invalid feature file');
      const reference = JSON.parse(content);
      if (!validFeatures(reference)) throw new Error('Invalid features');
      return { reference };
    } catch (error) {
      return { reason: error.code === 'ENOENT'
        ? 'The local audio reference has not been prepared yet.'
        : 'The local reference features are unavailable or invalid. Prepare the reference again.' };
    }
  }
  return {
    async status() {
      const { reference, reason } = await load();
      return reference ? { available: true, ...metadata(reference) } : { available: false, reason };
    },
    async match(notes) {
      const { reference, reason } = await load();
      if (!reference) return { status: 'unavailable', reason };
      const result = matchReference(notes, reference);
      if (result.status !== 'candidate') return result;
      const { id, title, artist, sourceUrl } = reference;
      const { start, end, similarity, transpose } = result;
      return { status: 'candidate', reason: result.reason, candidate: { id, title, artist, sourceUrl, start, end, similarity, transpose, notesVerified: false } };
    },
  };
}
