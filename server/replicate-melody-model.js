import { createHash } from 'node:crypto';
import { MelodyModelError, inspectWav, validateGeneratedAudio } from './melody-model.js';

const MODEL = 'facebook/musicgen-melody-large';
const VERSION = '671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb';
const API = 'https://api.replicate.com/v1/';
const MAX_INPUT = 16 * 1024 * 1024;
const MAX_OUTPUT = 12 * 1024 * 1024;
// Prediction responses echo the complete data-URI input, including recordings
// well above 128 KiB. Keep a finite bound sized for our validated input limit.
const MAX_JSON = Math.ceil(MAX_INPUT / 3) * 4 + 128 * 1024;
const terminal = new Set(['succeeded', 'failed', 'canceled']);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export class ReplicateMelodyError extends MelodyModelError {}
const failure = (message, code = 'MODEL_UNAVAILABLE', status = 503) => new ReplicateMelodyError(message, status, code);

function responseError(status) {
  if ([401, 403].includes(status)) return failure('Replicate rejected the server API token. Check the private .env setting.', 'MODEL_AUTH_FAILED', 503);
  if (status === 402) return failure('Replicate requires billing credit before music can be generated.', 'MODEL_BILLING_REQUIRED', 402);
  if (status === 429) return failure('Replicate is temporarily rate limited. Wait before starting another generation.', 'MODEL_RATE_LIMITED', 429);
  if (status === 422) return failure('Replicate rejected the music input. Check the recording and whole-second preview duration.', 'INVALID_MELODY_INPUT', 400);
  return failure('Replicate could not complete this request. No substitute audio was generated.', 'MODEL_FAILED', 502);
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readBytes(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw failure('Replicate returned an oversized response.', 'INVALID_MODEL_OUTPUT', 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure('Replicate returned an empty response.', 'INVALID_MODEL_OUTPUT', 502);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw failure('Replicate returned an oversized response.', 'INVALID_MODEL_OUTPUT', 502);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

// inspectWav validates the complete PCM structure before this energy check.
function hasAudio(wav) {
  for (let cursor = 12; cursor + 8 <= wav.length;) {
    const size = wav.readUInt32LE(cursor + 4); const start = cursor + 8;
    if (wav.toString('ascii', cursor, cursor + 4) === 'data') {
      for (let i = start; i < start + size; i += 2) if (Math.abs(wav.readInt16LE(i)) > 2) return true;
      return false;
    }
    cursor = start + size + size % 2;
  }
  return false;
}

function deliveryUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
      || !(url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'))) return null;
    return url.href;
  } catch { return null; }
}

/** Server-only hosted adapter. A successful HTTP submission is not proof of exact melody preservation. */
export function createReplicateMelodyModel({ token = process.env.REPLICATE_API_TOKEN, fetchImpl = globalThis.fetch,
  timeoutMs = 600000, pollIntervalMs = 1000 } = {}) {
  const credential = typeof token === 'string' ? token.trim() : '';
  const configured = /^r8_[A-Za-z0-9_]+$/.test(credential) && typeof fetchImpl === 'function';
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 1800000) : 600000;
  const interval = Number.isFinite(pollIntervalMs) ? Math.max(1, Math.min(pollIntervalMs, 10000)) : 1000;
  const requests = new Map();
  let closed = false; let active = null; let activeRequestId = null; let live = null;
  const status = () => ({ mode: configured ? 'audio-melody' : 'unavailable', configured, ready: false,
    provider: 'replicate', model: MODEL, checkpoint: MODEL, modelVariant: 'melody-large',
    paid: true, serverSide: true, tokenConfigured: configured,
    capabilities: ['jobs', 'cancel'], ...(configured ? live || {} : { reason: credential ? 'invalid-token' : 'not-configured', errorCode: 'MODEL_NOT_CONFIGURED' }) });

  async function api(path, { method = 'GET', body, signal, attempts = method === 'GET' ? 2 : 1 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal.aborted) throw signal.reason;
      try {
        const callSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
        const response = await abortable(fetchImpl(new URL(path, API).href, { method, redirect: 'error',
          headers: { Authorization: `Bearer ${credential}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(method === 'POST' && path === 'predictions' ? { 'Cancel-After': `${Math.max(1, Math.ceil(deadline / 1000))}s` } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: callSignal }), callSignal);
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          if (method === 'GET' && [429, 500, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
            await pause(Math.min(interval, 1000), signal); continue;
          }
          if (method === 'POST' && path === 'predictions' && response.status >= 500) {
            throw failure('Replicate did not confirm submission. Check your provider dashboard before retrying to avoid duplicate charges.', 'MODEL_SUBMISSION_UNCERTAIN', 502);
          }
          throw responseError(response.status);
        }
        const bytes = await readBytes(response, path === 'account' ? 128 * 1024 : MAX_JSON, callSignal);
        try { return JSON.parse(bytes.toString('utf8')); }
        catch { throw failure('Replicate returned an invalid response.', 'INVALID_MODEL_OUTPUT', 502); }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof MelodyModelError) throw error;
        if (method === 'GET' && attempt + 1 < attempts) { await pause(Math.min(interval, 1000), signal); continue; }
        if (method === 'POST' && path === 'predictions') throw failure('Replicate did not confirm submission. It may still be running; check your Replicate dashboard before retrying to avoid duplicate charges.', 'MODEL_SUBMISSION_UNCERTAIN', 502);
        throw failure('Replicate could not be reached. No substitute audio was generated.');
      }
    }
  }

  async function cancelPrediction(id) {
    if (!safeId(id)) return;
    try { await api(`predictions/${id}/cancel`, { method: 'POST', signal: AbortSignal.timeout(10000), attempts: 1 }); }
    catch { /* Cancel-After still bounds provider lifetime if cancellation acknowledgement is lost. */ }
  }

  async function execute({ input, prompt, duration, requestId, signal, onProgress }) {
    const controller = new AbortController();
    const submissionController = new AbortController();
    const cancel = () => controller.abort(failure('Music generation was cancelled.', 'MODEL_CANCELLED', 499));
    const timer = setTimeout(() => {
      const error = failure('Replicate generation reached its time limit. Check the provider dashboard if submission was not acknowledged.', 'MODEL_TIMEOUT', 504);
      submissionController.abort(error); controller.abort(error);
    }, deadline);
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    active = controller; activeRequestId = requestId;
    let predictionId; let providerTerminal = false; let cancellationRequested = false;
    const cancelOnce = async () => {
      if (!predictionId || providerTerminal || cancellationRequested) return;
      cancellationRequested = true; await cancelPrediction(predictionId);
    };
    const conditioning = { audioSha256: sha(input), inputBytes: input.length, mode: 'audio-melody', verification: 'adapter-submitted' };
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      onProgress?.({ stage: 'arranging', progress: null });
      // Keep a bounded acknowledgement listener after a user cancellation: a
      // late successful POST can still reveal the id needed to stop billing.
      const submitted = api('predictions', { method: 'POST', body: { version: VERSION,
        input: { model_version: 'melody-large', prompt, input_audio: `data:audio/wav;base64,${input.toString('base64')}`,
          continuation: false, duration, output_format: 'wav', normalization_strategy: 'peak' } }, signal: submissionController.signal });
      void submitted.then(async value => {
        if (safeId(value?.id)) { predictionId = value.id; providerTerminal = terminal.has(value.status); }
        if (controller.signal.aborted) await cancelOnce();
      }).catch(() => {});
      let prediction = await abortable(submitted, controller.signal);
      if (!safeId(prediction?.id)) throw failure('Replicate returned an invalid prediction id.', 'INVALID_MODEL_OUTPUT', 502);
      predictionId = prediction.id;
      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (prediction?.id !== predictionId || !['starting', 'processing', ...terminal].includes(prediction?.status)) {
          throw failure('Replicate returned an invalid prediction status.', 'INVALID_MODEL_OUTPUT', 502);
        }
        providerTerminal = terminal.has(prediction.status);
        if (prediction.status === 'failed') throw failure('Replicate MusicGen could not generate this preview. No substitute audio was produced.', 'MODEL_FAILED', 502);
        if (prediction.status === 'canceled') throw failure('Replicate music generation was cancelled.', 'MODEL_CANCELLED', 499);
        if (prediction.status === 'succeeded') break;
        onProgress?.({ stage: prediction.status === 'starting' ? 'arranging' : 'generating', progress: null });
        await pause(interval, controller.signal);
        prediction = await api(`predictions/${predictionId}`, { signal: controller.signal });
      }
      onProgress?.({ stage: 'preparing', progress: null });
      const url = deliveryUrl(prediction.output);
      if (!url) throw failure('Replicate returned an untrusted audio destination.', 'INVALID_MODEL_OUTPUT', 502);
      const downloadSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
      const response = await abortable(fetchImpl(url, { method: 'GET', redirect: 'error', signal: downloadSignal }), downloadSignal);
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw failure('The generated WAV could not be downloaded. No substitute audio was produced.', 'MODEL_DOWNLOAD_FAILED', 502); }
      const audioWav = await readBytes(response, MAX_OUTPUT, downloadSignal);
      try {
        const info = inspectWav(audioWav, 30);
        if (!hasAudio(audioWav)) throw new Error('Silent audio');
        const validated = validateGeneratedAudio({ audioWavBase64: audioWav.toString('base64'), model: MODEL, sampleRate: info.sampleRate, conditioning }, conditioning, duration, MODEL);
        return { ...validated, conditioning, provider: 'replicate', providerModel: 'meta/musicgen', checkpoint: MODEL,
          modelVariant: 'melody-large', providerPredictionId: predictionId };
      } catch { throw failure('The generated file failed WAV, duration or audio-energy validation.', 'INVALID_MODEL_OUTPUT', 502); }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof MelodyModelError) throw error;
      throw failure('Replicate music generation could not complete. No substitute audio was generated.', 'MODEL_FAILED', 502);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (predictionId && !providerTerminal) await cancelOnce();
      if (active === controller) { active = null; activeRequestId = null; }
    }
  }

  return {
    status,
    async probe() {
      if (!configured || closed) return status();
      try { await api('account', { signal: AbortSignal.timeout(20000), attempts: 1 }); live = { ready: true, reachable: true, status: 'available' }; }
      catch (error) { live = { ready: false, reachable: error instanceof MelodyModelError && !['MODEL_UNAVAILABLE', 'MODEL_TIMEOUT'].includes(error.code),
        status: 'unavailable', reason: error?.code === 'MODEL_AUTH_FAILED' ? 'invalid-token' : 'provider-unavailable',
        errorCode: error instanceof MelodyModelError ? error.code : 'MODEL_UNAVAILABLE' }; }
      return status();
    },
    async generate({ audioWav, prompt, duration, requestId, signal, onProgress } = {}) {
      if (closed) throw failure('The hosted music service has closed.', 'MODEL_CLOSED');
      if (!configured) throw failure('Set a valid private REPLICATE_API_TOKEN on the server before using hosted MusicGen.', 'MODEL_NOT_CONFIGURED');
      let input;
      try {
        inspectWav(audioWav, 60, MAX_INPUT); input = Buffer.from(audioWav);
        if (!hasAudio(input) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000
          || !Number.isInteger(duration) || duration < 1 || duration > 30 || !safeId(requestId)) throw new Error('Invalid input');
      } catch { throw failure('Supply audible PCM16 WAV, a production direction, a stable request id, and a whole-second duration from 1 to 30.', 'INVALID_MELODY_INPUT', 400); }
      const signature = sha(Buffer.concat([Buffer.from(JSON.stringify([prompt.trim(), duration])), input]));
      for (const [id, entry] of requests) if (Date.now() - entry.created > 1800000 && id !== activeRequestId) requests.delete(id);
      const previous = requests.get(requestId);
      if (previous) {
        if (previous.signature !== signature) throw failure('This request id already belongs to another production direction.', 'IDEMPOTENCY_CONFLICT', 409);
        return previous.promise;
      }
      if (active) throw failure('A hosted generation is already running. Wait for it before starting another.', 'MODEL_BUSY');
      while (requests.size >= 12) requests.delete(requests.keys().next().value);
      const promise = execute({ input, prompt: prompt.trim(), duration, requestId, signal, onProgress });
      requests.set(requestId, { signature, promise, created: Date.now() });
      return promise;
    },
    close() { closed = true; active?.abort(failure('The hosted music service has closed.', 'MODEL_CLOSED')); requests.clear(); },
  };
}
