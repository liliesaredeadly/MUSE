import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArrangement } from '../src/music/arrangement.js';
import { createProducerBrain } from './producer-brain.js';
import { DEFAULT_SETTINGS } from '../src/lib/projects.js';
import { openProjectDatabase } from './db.js';
import { createAuthService } from './auth.js';
import { createReferenceLibrary } from './reference-library.js';
import { createAudioPipeline, AudioPipelineError } from './audio-pipeline.js';
import { MelodyModelError } from './melody-model.js';
import { createMusicGenProvider } from './musicgen-provider.js';
import { validateMelodyNotes } from '../src/music/melody-contract.js';
import { validateBlueprint } from '../src/producer/production-blueprint.js';
import { createProductionDirector } from './production-director.js';
import { createGenerationJobs, GenerationJobError } from './generation-jobs.js';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_NOTES = 512;
const MAX_SECONDS = 600;
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../dist', import.meta.url));
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const OPTIONS = {
  instrument: ['Piano', 'Synthesizer', 'Strings', 'Bass', 'Drums'],
  leadSource: ['instrument', 'recording'],
  mood: ['Dreamy', 'Cinematic', 'Melancholic', 'Energetic', 'Peaceful'],
  genre: ['Ambient', 'Electronic', 'Classical', 'Pop', 'Experimental'],
  production: ['auto', 'dance-pop', 'percussive-pop'],
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

function isLoopbackAuthority(value) {
  if (typeof value !== 'string') return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(value);
  return Boolean(match && (match[2] === undefined || (Number(match[2]) >= 1 && Number(match[2]) <= 65535)));
}

function requireLocalRequest(request) {
  // Validate the original authorities before any URL normalization. A loopback
  // listener alone does not prevent a rebound website from reaching local data.
  if (request.headersDistinct.host?.length !== 1 || !isLoopbackAuthority(request.headers.host)) {
    throw new HttpError(403, 'This local server requires a loopback Host header.');
  }
  if (request.headers.origin !== undefined) {
    const origin = /^https?:\/\/(.+)$/i.exec(request.headers.origin);
    if (request.headersDistinct.origin?.length !== 1 || !origin || !isLoopbackAuthority(origin[1])) {
      throw new HttpError(403, 'This local server only accepts loopback browser origins.');
    }
  }
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
  for (const key of ['accompaniment', 'bass', 'percussion', 'preserveMelodyTiming']) {
    if (!Object.hasOwn(source, key)) continue;
    if (typeof source[key] !== 'boolean') throw new HttpError(400, `${key} must be true or false.`);
    settings[key] = source[key];
  }
  if (Object.hasOwn(source, 'blueprint')) {
    try { settings.blueprint = validateBlueprint(source.blueprint); }
    catch (error) { throw new HttpError(400, error.message); }
    settings.mood = settings.blueprint.mood;
  }
  return settings;
}

function validateNotes(value, requireMelody = false) {
  if (!Array.isArray(value) || value.length > MAX_NOTES) throw new HttpError(400, `notes must be an array of at most ${MAX_NOTES} notes.`);
  if (requireMelody && value.length === 0) throw new HttpError(400, 'Record or add a recognised melody before generating an arrangement.');
  const notes = value.map((note, index) => {
    if (!isObject(note) || !Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127) throw new HttpError(400, `Note ${index + 1} must have an integer MIDI pitch between 0 and 127.`);
    if (!Number.isFinite(note.start) || note.start < 0 || !Number.isFinite(note.duration) || note.duration <= 0 || note.start + note.duration > MAX_SECONDS) throw new HttpError(400, `Note ${index + 1} must have valid positive timing within ${MAX_SECONDS} seconds.`);
    if (note.confidence !== undefined && (!Number.isFinite(note.confidence) || note.confidence < 0 || note.confidence > 1)) throw new HttpError(400, `Note ${index + 1} confidence must be between 0 and 1.`);
    return { midi: note.midi, name: `${NOTE_NAMES[note.midi % 12]}${Math.floor(note.midi / 12) - 1}`, start: note.start, duration: note.duration, confidence: note.confidence ?? 1,
      ...(note.contour === undefined ? {} : { contour: note.contour }) };
  });
  try { validateMelodyNotes(notes, { allowEmpty: true }); }
  catch (error) { throw new HttpError(400, error.message); }
  return notes.map(note => ({ ...note, ...(note.contour ? { contour: note.contour.map(({ time, frequency }) => ({ time, frequency })) } : {}) }));
}

function readAudio(request) {
  if (!/^audio\/(?:wav|x-wav)(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new HttpError(415, 'Send the actual recording as PCM WAV audio.');
  const limit = 16 * 1024 * 1024;
  if (Number(request.headers['content-length']) > limit) { request.resume(); throw new HttpError(413, 'Recording exceeds the 16 MB audio limit.'); }
  return new Promise((resolve, reject) => {
    let length = 0;
    let chunks = [];
    let exceeded = false;
    request.on('data', chunk => {
      length += chunk.length;
      if (length > limit) {
        chunks = [];
        if (!exceeded) reject(new HttpError(413, 'Recording exceeds the 16 MB audio limit.'));
        exceeded = true;
      } else if (!exceeded) chunks.push(chunk);
    });
    request.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks, length)); });
    request.on('aborted', () => reject(new HttpError(400, 'Audio upload was interrupted.')));
    request.on('error', reject);
  });
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
    throw new HttpError(413, 'Request body exceeds the 512 KB limit.');
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks = [];
    let tooLarge = false;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        chunks = [];
        if (!tooLarge) reject(new HttpError(413, 'Request body exceeds the 512 KB limit.'));
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
export function createApp({ dbPath, serveStatic = false, staticDir = DEFAULT_STATIC_DIR, producerBrain = createProducerBrain(), productionDirector = createProductionDirector(), referencePath, audioPipeline = createAudioPipeline(), melodyModel = createMusicGenProvider() } = {}) {
  const database = openProjectDatabase(dbPath);
  const referenceLibrary = createReferenceLibrary({ referencePath });
  let auth;
  try { auth = createAuthService({ db: database.connection, readJson, sendJson, HttpError }); }
  catch (error) { database.close(); throw error; }
  const generationJobs = createGenerationJobs({ audioPipeline, melodyModel });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      requireLocalRequest(request);
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
      catch { throw new HttpError(400, 'Invalid request URL.'); }
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) throw new HttpError(400, 'Invalid request path.');
      if (await auth.handle(request, response, pathname)) return;
      const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      const generationMatch = pathname.match(/^\/api\/generation\/jobs\/([^/]+)(\/audio)?$/);
      const allowed = ['/api/health', '/api/producer/status', '/api/production-director/status', '/api/reference', '/api/melody/model/status'].includes(pathname) ? ['GET']
        : pathname === '/api/generation/jobs' ? ['POST']
          : generationMatch ? generationMatch[2] ? ['GET'] : ['GET', 'DELETE']
        : pathname === '/api/projects' ? ['GET', 'POST']
          : projectMatch ? ['GET'] : ['/api/arrange', '/api/producer', '/api/production-director', '/api/reference/match', '/api/melody/analyze', '/api/melody/generate'].includes(pathname) ? ['POST'] : null;
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
      if (pathname === '/api/producer/status') return sendJson(response, 200, producerBrain.status());
      if (pathname === '/api/production-director/status') return sendJson(response, 200, productionDirector.status());
      if (pathname === '/api/reference') return sendJson(response, 200, await referenceLibrary.status());
      if (pathname === '/api/melody/model/status') return sendJson(response, 200, { strictEngine: 'strict-note-conditioned', neural: await (melodyModel.probe?.() ?? melodyModel.status()) });
      if (generationMatch) {
        const id = generationMatch[1];
        if (generationMatch[2]) {
          const audio = generationJobs.audio(id);
          response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.audioWav.length, 'Cache-Control': 'no-store',
            'X-Muse-Model': audio.model, 'X-Muse-Conditioning-Sha256': audio.conditioning.audioSha256,
            'X-Muse-Output-Sha256': audio.audioSha256, 'X-Muse-Exact-Melody-Verified': 'false' });
          response.end(audio.audioWav); return;
        }
        return sendJson(response, 200, { job: request.method === 'DELETE' ? generationJobs.cancel(id) : generationJobs.get(id) });
      }
      if (pathname === '/api/melody/analyze') return sendJson(response, 200, await audioPipeline.analyze(await readAudio(request)));
      if (pathname === '/api/projects' && request.method === 'GET') return sendJson(response, 200, { projects: database.list() });
      if (projectMatch) {
        if (!safeId(projectMatch[1])) throw new HttpError(400, 'Invalid project id.');
        const project = database.get(projectMatch[1]);
        if (!project) throw new HttpError(404, 'Project not found.');
        return sendJson(response, 200, { project });
      }
      const body = await readJson(request);
      if (pathname === '/api/generation/jobs') return sendJson(response, 202, { job: generationJobs.start({ ...body, settings: validateSettings(body.settings) }) });
      if (pathname === '/api/melody/generate') {
        if (typeof body.conditioningId !== 'string' || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000) throw new HttpError(400, 'Supply a recorded conditioning take and a direction of 1–4000 characters.');
        const result = await audioPipeline.generate(body.conditioningId, melodyModel, { prompt: body.prompt.trim(), duration: body.duration ?? 10 });
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': result.audioWav.length, 'Cache-Control': 'no-store',
          'X-Muse-Model': result.model, 'X-Muse-Conditioning-Sha256': result.conditioning.audioSha256, 'X-Muse-Exact-Melody-Verified': 'false' });
        response.end(result.audioWav);
        return;
      }
      if (pathname === '/api/projects') return sendJson(response, 200, { project: database.save(validateProject(body)) });
      if (pathname === '/api/reference/match') return sendJson(response, 200, await referenceLibrary.match(validateNotes(body.notes)));
      const settings = validateSettings(body.settings);
      if (pathname === '/api/arrange') {
        const recording = settings.leadSource === 'recording';
        if (recording && typeof body.conditioningId !== 'string') throw new HttpError(400, 'The original recording is required for a recorded-hum lead. Record or import the original take again; no synthetic melody was substituted.');
        const notes = validateNotes(body.notes, !recording);
        const speed = recording || settings.preserveMelodyTiming ? 1 : settings.sourceBpm / settings.bpm;
        if (notes.some(note => note.start * speed + note.duration * speed > MAX_SECONDS)) {
          throw new HttpError(400, `This tempo would extend the melody beyond the ${MAX_SECONDS}-second arrangement limit. Increase the tempo or shorten the melody.`);
        }
        const conditioning = body.conditioningId === undefined ? null : audioPipeline.condition(body.conditioningId, notes);
        const sourceMeta = recording ? { duration: conditioning.receipt.duration, sha256: conditioning.receipt.sha256, quality: conditioning.quality } : undefined;
        const arrangement = buildArrangement(notes, settings, sourceMeta);
        if (conditioning) arrangement.conditioning = conditioning;
        return sendJson(response, 200, { arrangement });
      }
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw new HttpError(400, 'Direction text must contain 1–4000 characters.');
      const notes = body.notes === undefined ? [] : validateNotes(body.notes);
      if (pathname === '/api/production-director') return sendJson(response, 200, await productionDirector.propose({ text: body.text.trim(), settings, notes }));
      return sendJson(response, 200, await producerBrain.propose({ text: body.text.trim(), settings, notes }));
    } catch (error) {
      if (error instanceof HttpError || error instanceof AudioPipelineError || error instanceof MelodyModelError || error instanceof GenerationJobError) {
        const code = error.code || (error instanceof AudioPipelineError && error.status === 410 ? 'CONDITIONING_EXPIRED' : null);
        return sendJson(response, error.status, { error: error.message, ...(code ? { code, retryable: !['INVALID_MELODY_INPUT', 'INVALID_MODEL_OUTPUT', 'MODEL_NOT_CONFIGURED', 'IDEMPOTENCY_CONFLICT'].includes(code) } : {}) });
      }
      console.error('MUSE server error:', error);
      sendJson(response, 500, { error: 'The local server could not complete this request. Check the server console and retry.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  const closeServer = server.close.bind(server);
  server.close = (...args) => {
    generationJobs.close();
    audioPipeline.close();
    melodyModel.close?.();
    return closeServer(...args);
  };
  server.once('close', () => database.close());
  return server;
}
