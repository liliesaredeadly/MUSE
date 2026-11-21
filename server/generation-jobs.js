import { createHash, randomUUID } from 'node:crypto';
import { compileProductionPrompt } from '../src/producer/production-prompt.js';
import { MelodyModelError, validateGeneratedAudio } from './melody-model.js';

const MODEL = 'facebook/musicgen-melody';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const STAGES = new Set(['listening', 'understanding', 'exploring', 'arranging', 'generating', 'preparing', 'ready']);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

export class GenerationJobError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/** Session-only jobs: one inference, a bounded queue, and expiring audio. */
export function createGenerationJobs({ audioPipeline, melodyModel, compile = compileProductionPrompt,
  maxJobs = 12, maxQueued = 1, ttlMs = 30 * 60 * 1000,
  timeoutMs = Number(process.env.MUSE_MELODY_TIMEOUT_MS || 1800000) } = {}) {
  const jobs = new Map();
  const requests = new Map();
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 3600000) : 1800000;
  const retention = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, 3600000) : 1800000;
  let running = null;
  let closed = false;

  function touch(job) { job.updatedAt = new Date().toISOString(); }
  function view(job) {
    return structuredClone({ id: job.id, requestId: job.requestId, status: job.status, stage: job.stage, progress: job.progress,
      model: job.model, provider: job.provider, modelVariant: job.modelVariant,
      conditioning: job.conditioning, createdAt: job.createdAt, startedAt: job.startedAt, updatedAt: job.updatedAt,
      elapsedSeconds: job.startedAt ? Math.max(0, ((job.finishedAt || Date.now()) - Date.parse(job.startedAt)) / 1000) : 0,
      production: job.production, audioUrl: job.status === 'succeeded' ? `/api/generation/jobs/${job.id}/audio` : null, error: job.error });
  }
  function find(id) {
    if (!safeId(id)) throw new GenerationJobError(400, 'Invalid generation job id.', 'INVALID_JOB_ID');
    const job = jobs.get(id);
    if (!job) throw new GenerationJobError(404, 'This generation job is unavailable or has expired.', 'JOB_NOT_FOUND');
    return job;
  }
  function dispose(job) {
    clearTimeout(job.timer); clearTimeout(job.expiry);
    job.snapshot = null; job.audio = null;
    jobs.delete(job.id); requests.delete(job.requestId);
  }
  function finish(job, status, error = null) {
    if (TERMINAL.has(job.status)) return;
    clearTimeout(job.timer);
    job.status = status; job.error = error; job.progress = null; job.finishedAt = Date.now(); job.snapshot = null;
    if (status !== 'succeeded') job.audio = null;
    touch(job);
    if (!closed) { job.expiry = setTimeout(() => dispose(job), retention); job.expiry.unref?.(); }
  }
  function failure(error) {
    const code = typeof error?.code === 'string' ? error.code : 'MODEL_FAILED';
    return { message: error instanceof MelodyModelError || error instanceof GenerationJobError ? error.message
      : 'MusicGen Melody could not complete this generation. No substitute audio was produced.', code,
    retryable: !['INVALID_MELODY_INPUT', 'INVALID_MODEL_OUTPUT', 'MODEL_NOT_CONFIGURED', 'MODEL_CANCELLED', 'MODEL_AUTH_FAILED', 'MODEL_BILLING_REQUIRED', 'MODEL_SUBMISSION_UNCERTAIN'].includes(code) };
  }
  function update(job, stage, progress = null) {
    if (job.controller.signal.aborted || TERMINAL.has(job.status)) return;
    job.stage = STAGES.has(stage) ? stage : stage === 'loading' ? 'arranging' : job.stage;
    job.progress = job.stage === 'generating' && Number.isFinite(progress?.completed) && Number.isFinite(progress?.total)
      && progress.completed >= 0 && progress.total > 0 && progress.completed <= progress.total
      ? { completed: progress.completed, total: progress.total } : null;
    touch(job);
  }
  async function run(job) {
    running = job;
    job.status = 'running'; job.startedAt = new Date().toISOString(); update(job, 'understanding');
    try {
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      const snapshot = job.snapshot;
      job.production = structuredClone(compile({ text: job.text, settings: job.settings, notes: snapshot.analysis.notes, analysis: snapshot.analysis }));
      if (typeof job.production?.prompt !== 'string' || !job.production.prompt.trim() || job.production.prompt.length > 4000) {
        throw new GenerationJobError(400, 'The production direction could not be prepared within the model prompt limit.', 'INVALID_MELODY_INPUT');
      }
      update(job, 'exploring');
      if (typeof melodyModel.probe === 'function') {
        const status = await melodyModel.probe();
        if (!status.configured) throw new MelodyModelError(status.provider === 'replicate'
          ? 'Save a valid REPLICATE_API_TOKEN in the server .env and restart Muse.' : 'MusicGen Melody is not configured. Start the local model service.', 503, 'MODEL_NOT_CONFIGURED');
        if (status.reachable === false) throw new MelodyModelError(status.provider === 'replicate'
          ? 'Replicate is not responding. Your original recording is kept; retry when the connection returns.' : 'The local MusicGen Melody service is unavailable. Start it and retry.', 503, 'MODEL_UNAVAILABLE');
        if (status.provider === 'replicate' && !status.ready) throw new MelodyModelError(status.reason || 'The Replicate account connection is not ready. Check the server configuration.', 503, status.errorCode || 'MODEL_AUTH_FAILED');
        if (status.model) job.model = status.model;
      }
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      update(job, 'arranging');
      const generated = await melodyModel.generate({ audioWav: snapshot.audioWav, prompt: job.production.prompt, duration: job.duration,
        requestId: job.id, signal: job.controller.signal, requireReceipt: true,
        onProgress: value => update(job, value.stage, value.progress) });
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      update(job, 'preparing');
      try {
        job.audio = validateGeneratedAudio({ ...generated, audioWavBase64: generated.audioWav?.toString('base64') },
          { ...job.conditioning, mode: 'audio-melody' }, job.duration, job.model);
      } catch { throw new MelodyModelError('The generated audio failed PCM, duration or original-recording verification.', 502, 'INVALID_MODEL_OUTPUT'); }
      update(job, 'ready'); finish(job, 'succeeded');
    } catch (error) {
      if (job.timedOut) finish(job, 'failed', { message: 'Music generation reached its time limit. No substitute audio was generated.', code: 'MODEL_TIMEOUT', retryable: true });
      else if (job.controller.signal.aborted || error?.code === 'MODEL_CANCELLED') finish(job, 'cancelled', { message: 'Music generation was cancelled.', code: 'MODEL_CANCELLED', retryable: false });
      else finish(job, 'failed', failure(error));
    } finally {
      if (running === job) running = null;
      if (!closed) queueMicrotask(runNext);
    }
  }
  function runNext() {
    if (closed || running) return;
    const next = [...jobs.values()].find(job => job.status === 'queued');
    if (next) void run(next);
  }
  function cancel(job) {
    if (TERMINAL.has(job.status)) return view(job);
    if (job.status === 'queued') {
      job.controller.abort(new MelodyModelError('Music generation was cancelled.', 499, 'MODEL_CANCELLED'));
      finish(job, 'cancelled', { message: 'Music generation was cancelled.', code: 'MODEL_CANCELLED', retryable: false });
    } else {
      job.status = 'cancelling'; job.progress = null; touch(job);
      job.controller.abort(new MelodyModelError('Music generation was cancelled.', 499, 'MODEL_CANCELLED'));
    }
    return view(job);
  }
  return {
    start({ conditioningId, text, duration = 10, requestId, settings = {} } = {}) {
      if (closed) throw new GenerationJobError(503, 'The generation service has closed.', 'MODEL_CLOSED');
      if (!safeId(requestId) || typeof conditioningId !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 4000
        || !Number.isFinite(duration) || duration <= 0 || duration > 30) throw new GenerationJobError(400, 'Supply the original take, a direction of 1–4000 characters, a duration greater than 0 and at most 30 seconds, and a stable request id.', 'INVALID_MELODY_INPUT');
      const payload = JSON.stringify({ conditioningId, text: text.trim(), duration, settings });
      const signature = createHash('sha256').update(payload).digest('hex');
      const existing = requests.get(requestId);
      if (existing) {
        if (existing.signature !== signature) throw new GenerationJobError(409, 'This request id already belongs to a different generation. Use a new request id for an edited direction.', 'IDEMPOTENCY_CONFLICT');
        return view(find(existing.id));
      }
      if ([...jobs.values()].filter(job => !TERMINAL.has(job.status)).length >= Math.max(1, maxQueued + 1)) {
        throw new GenerationJobError(429, 'The local generation queue is full. Wait for a job to finish, then retry.', 'GENERATION_QUEUE_FULL');
      }
      while (jobs.size >= Math.max(1, maxJobs)) {
        const oldest = [...jobs.values()].find(job => TERMINAL.has(job.status));
        if (!oldest) throw new GenerationJobError(429, 'The local generation queue is full.', 'GENERATION_QUEUE_FULL');
        dispose(oldest);
      }
      const snapshot = audioPipeline.snapshot(conditioningId);
      const createdAt = new Date().toISOString();
      const modelStatus = melodyModel.status?.() || {};
      const job = { id: randomUUID(), requestId, text: text.trim(), settings: structuredClone(settings), duration,
        model: modelStatus.model || MODEL, provider: modelStatus.provider || null, modelVariant: modelStatus.modelVariant || null,
        status: 'queued', stage: 'listening', progress: null, createdAt, updatedAt: createdAt, startedAt: null, finishedAt: null,
        conditioning: { audioSha256: snapshot.receipt.sha256, inputBytes: snapshot.receipt.bytes },
        production: null, error: null, audio: null, snapshot, controller: new AbortController(), timedOut: false };
      job.timer = setTimeout(() => {
        job.timedOut = true;
        if (job.status === 'queued') finish(job, 'failed', { message: 'The queued generation reached its time limit.', code: 'MODEL_TIMEOUT', retryable: true });
        else { job.status = 'cancelling'; job.progress = null; touch(job); job.controller.abort(new MelodyModelError('Music generation timed out.', 504, 'MODEL_TIMEOUT')); }
      }, deadline); job.timer.unref?.();
      jobs.set(job.id, job); requests.set(requestId, { id: job.id, signature });
      queueMicrotask(runNext);
      return view(job);
    },
    get: id => view(find(id)),
    cancel: id => cancel(find(id)),
    audio(id) {
      const job = find(id);
      if (job.status !== 'succeeded' || !job.audio) throw new GenerationJobError(409, 'Audio is available only after this generation succeeds.', 'AUDIO_NOT_READY');
      return { ...job.audio, audioWav: Buffer.from(job.audio.audioWav) };
    },
    close() {
      closed = true;
      for (const job of jobs.values()) { cancel(job); clearTimeout(job.timer); clearTimeout(job.expiry); job.snapshot = null; job.audio = null; }
      jobs.clear(); requests.clear();
    },
  };
}
