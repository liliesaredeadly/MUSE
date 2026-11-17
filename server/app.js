import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArrangement } from '../src/music/arrangement.js';
import { interpretDirection } from '../src/producer/producer.js';
import { DEFAULT_SETTINGS } from '../src/lib/projects.js';
import { openProjectDatabase } from './db.js';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_NOTES = 512;
const MAX_SECONDS = 600;
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../dist', import.meta.url));
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const OPTIONS = {
  instrument: ['Piano', 'Synthesizer', 'Strings', 'Bass', 'Drums'],
  mood: ['Dreamy', 'Cinematic', 'Melancholic', 'Energetic', 'Peaceful'],
  genre: ['Ambient', 'Electronic', 'Classical', 'Pop', 'Experimental'],
};
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wav': 'audio/wav',
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireObject(value) {
  if (!isObject(value)) throw new HttpError(400, 'The request must contain a JSON object.');
  return value;
}

function validateSettings(value) {
  const source = value === undefined ? {} : requireObject(value);
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of ['bpm', 'sourceBpm']) {
    if (!Object.hasOwn(source, key)) continue;
    if (!Number.isFinite(source[key]) || source[key] < 40 || source[key] > 200) throw new HttpError(400, `${key} must be a number between 40 and 200.`);
    settings[key] = source[key];
  }
  for (const [key, values] of Object.entries(OPTIONS)) {
    if (!Object.hasOwn(source, key)) continue;
    if (!values.includes(source[key])) throw new HttpError(400, `${key} must be one of: ${values.join(', ')}.`);
    settings[key] = source[key];
  }
  for (const key of ['accompaniment', 'percussion']) {
    if (!Object.hasOwn(source, key)) continue;
    if (typeof source[key] !== 'boolean') throw new HttpError(400, `${key} must be true or false.`);
    settings[key] = source[key];
  }
  return settings;
}

function validateNotes(value, requireMelody = false) {
  if (!Array.isArray(value) || value.length > MAX_NOTES) throw new HttpError(400, `notes must be an array of at most ${MAX_NOTES} notes.`);
  if (requireMelody && value.length === 0) throw new HttpError(400, 'Record or add a recognised melody before generating an arrangement.');
  return value.map((note, index) => {
    if (!isObject(note) || !Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127) throw new HttpError(400, `Note ${index + 1} must have an integer MIDI pitch between 0 and 127.`);
    if (!Number.isFinite(note.start) || note.start < 0 || !Number.isFinite(note.duration) || note.duration <= 0 || note.start + note.duration > MAX_SECONDS) throw new HttpError(400, `Note ${index + 1} must have valid positive timing within ${MAX_SECONDS} seconds.`);
    if (note.confidence !== undefined && (!Number.isFinite(note.confidence) || note.confidence < 0 || note.confidence > 1)) throw new HttpError(400, `Note ${index + 1} confidence must be between 0 and 1.`);
    return { midi: note.midi, name: `${NOTE_NAMES[note.midi % 12]}${Math.floor(note.midi / 12) - 1}`, start: note.start, duration: note.duration, confidence: note.confidence ?? 1 };
  }).sort((left, right) => left.start - right.start);
}

function validateTimestamp(value, key) {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new HttpError(400, `${key} must be a valid ISO date.`);
  return new Date(value).toISOString();
}

function validateProject(value) {
  requireObject(value);
  if (!safeId(value.id)) throw new HttpError(400, 'Project id must use 1–100 letters, numbers, underscores or hyphens.');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 100 || /[\u0000-\u001f\u007f]/.test(value.title)) throw new HttpError(400, 'Project title must contain 1–100 characters without control characters.');
  return {
    id: value.id, title: value.title.trim(), notes: validateNotes(value.notes), settings: validateSettings(value.settings),
    createdAt: validateTimestamp(value.createdAt, 'createdAt'), updatedAt: validateTimestamp(value.updatedAt, 'updatedAt'),
  };
}

function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON with Content-Type: application/json.');
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    throw new HttpError(413, 'Request body exceeds the 256 KB limit.');
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks = [];
    let tooLarge = false;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        chunks = [];
        if (!tooLarge) reject(new HttpError(413, 'Request body exceeds the 256 KB limit.'));
        tooLarge = true;
      } else if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      try { resolve(requireObject(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch (error) { reject(error instanceof HttpError ? error : new HttpError(400, 'Request body contains invalid JSON.')); }
    });
    request.on('aborted', () => reject(new HttpError(400, 'Request was interrupted.')));
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function serveFile(request, response, pathname, staticDir) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'This route supports GET and HEAD.');
  const root = path.resolve(staticDir);
  let filename = path.resolve(root, `.${pathname}`);
  if (filename !== root && !filename.startsWith(root + path.sep)) throw new HttpError(403, 'Path is outside the application.');
  try {
    const info = await stat(filename);
    if (info.isDirectory()) filename = path.join(filename, 'index.html');
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    if (path.extname(pathname)) throw new HttpError(404, 'File not found.');
    filename = path.join(root, 'index.html');
  }
  let file;
  try {
    const [realRoot, realFilename] = await Promise.all([realpath(root), realpath(filename)]);
    if (realFilename !== realRoot && !realFilename.startsWith(realRoot + path.sep)) throw new HttpError(403, 'Path is outside the application.');
    file = await readFile(realFilename);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, 'Application files are unavailable. Run npm run build first.');
    throw error;
  }
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': file.length,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  response.end(request.method === 'HEAD' ? undefined : file);
}

/** Owns a SQLite connection, closed automatically when this HTTP server closes. */
export function createApp({ dbPath, serveStatic = false, staticDir = DEFAULT_STATIC_DIR } = {}) {
  const database = openProjectDatabase(dbPath);
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
      catch { throw new HttpError(400, 'Invalid request URL.'); }
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) throw new HttpError(400, 'Invalid request path.');
      const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      const allowed = pathname === '/api/health' ? ['GET']
        : pathname === '/api/projects' ? ['GET', 'POST']
          : projectMatch ? ['GET'] : ['/api/arrange', '/api/producer'].includes(pathname) ? ['POST'] : null;
      if (!allowed) {
        if (pathname === '/api' || pathname.startsWith('/api/') || !serveStatic) throw new HttpError(404, 'Route not found.');
        await serveFile(request, response, pathname, staticDir);
        return;
      }
      if (!allowed.includes(request.method)) {
        response.setHeader('Allow', allowed.join(', '));
        throw new HttpError(405, `This route supports ${allowed.join(' and ')}.`);
      }
      if (pathname === '/api/health') return sendJson(response, 200, { ok: true, storage: 'sqlite' });
      if (pathname === '/api/projects' && request.method === 'GET') return sendJson(response, 200, { projects: database.list() });
      if (projectMatch) {
        if (!safeId(projectMatch[1])) throw new HttpError(400, 'Invalid project id.');
        const project = database.get(projectMatch[1]);
        if (!project) throw new HttpError(404, 'Project not found.');
        return sendJson(response, 200, { project });
      }
      const body = await readJson(request);
      if (pathname === '/api/projects') return sendJson(response, 200, { project: database.save(validateProject(body)) });
      const settings = validateSettings(body.settings);
      if (pathname === '/api/arrange') {
        const notes = validateNotes(body.notes, true);
        const speed = settings.sourceBpm / settings.bpm;
        if (notes.some(note => note.start * speed + note.duration * speed > MAX_SECONDS)) {
          throw new HttpError(400, `This tempo would extend the melody beyond the ${MAX_SECONDS}-second arrangement limit. Increase the tempo or shorten the melody.`);
        }
        return sendJson(response, 200, { arrangement: buildArrangement(notes, settings) });
      }
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw new HttpError(400, 'Direction text must contain 1–4000 characters.');
      return sendJson(response, 200, interpretDirection(body.text, settings));
    } catch (error) {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
      console.error('MUSE server error:', error);
      sendJson(response, 500, { error: 'The local server could not complete this request. Check the server console and retry.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.once('close', () => database.close());
  return server;
}
