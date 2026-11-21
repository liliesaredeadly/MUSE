import { createHash, randomUUID } from 'node:crypto';

const MODEL = 'facebook/musicgen-melody';
const MAX_INPUT_WAV_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_WAV_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_OUTPUT_WAV_BYTES / 3) * 4 + 8192;

export class MelodyModelError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'MelodyModelError';
    this.status = status;
    this.code = code;
  }
}

function localEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname === '/') url.pathname = '/generate';
    return url.href;
  } catch { return null; }
}

export function inspectWav(bytes, maxSeconds, maxBytes = MAX_OUTPUT_WAV_BYTES) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 46 || bytes.byteLength > maxBytes) throw new Error('Invalid WAV length');
  const wav = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE'
    || wav.readUInt32LE(4) !== wav.length - 8) throw new Error('Invalid WAV header');
  let format;
  let dataBytes;
  let cursor = 12;
  while (cursor + 8 <= wav.length) {
    const name = wav.toString('ascii', cursor, cursor + 4);
    const size = wav.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    if (start + size > wav.length) throw new Error('Truncated WAV');
    if (name === 'fmt ') {
      if (format || size < 16) throw new Error('Invalid WAV format');
      format = { codec: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2), sampleRate: wav.readUInt32LE(start + 4), byteRate: wav.readUInt32LE(start + 8), blockAlign: wav.readUInt16LE(start + 12), bits: wav.readUInt16LE(start + 14) };
    }
    if (name === 'data') {
      if (dataBytes !== undefined) throw new Error('Duplicate WAV data');
      dataBytes = size;
    }
    cursor = start + size + (size % 2);
  }
  if (cursor !== wav.length || !format || !dataBytes || format.codec !== 1 || format.bits !== 16
    || ![1, 2].includes(format.channels) || format.sampleRate < 8000 || format.sampleRate > 96000
    || format.blockAlign !== format.channels * 2 || format.byteRate !== format.sampleRate * format.blockAlign
    || dataBytes % format.blockAlign !== 0 || dataBytes / format.byteRate > maxSeconds) throw new Error('Unsupported WAV format or duration');
  return { ...format, duration: dataBytes / format.byteRate };
}

async function readResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Oversized model response');
  }
  const chunks = [];
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing model response');
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Oversized model response');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

function modelOutput(value, expectedModel = MODEL) {
  if (![MODEL, 'facebook/musicgen-melody-large'].includes(expectedModel)
    || !value || value.model !== expectedModel || typeof value.audioWavBase64 !== 'string'
    || !value.audioWavBase64.length || value.audioWavBase64.length > MAX_RESPONSE_BYTES
    || value.audioWavBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.audioWavBase64)) throw new Error('Invalid melody model result');
  const audioWav = Buffer.from(value.audioWavBase64, 'base64');
  const { sampleRate } = inspectWav(audioWav, 30);
  if (value.sampleRate !== sampleRate) throw new Error('Inconsistent output sample rate');
  return { audioWav, model: expectedModel, sampleRate };
}

/** Validate PCM and provenance before publishing a neural result. */
export function validateGeneratedAudio(value, conditioning, duration, expectedModel = MODEL) {
  const output = modelOutput(value, expectedModel);
  const actual = inspectWav(output.audioWav, 30);
  const receipt = value.conditioning;
  if (!receipt || receipt.audioSha256 !== conditioning.audioSha256 || receipt.inputBytes !== conditioning.inputBytes
    || receipt.mode !== 'audio-melody' || Math.abs(actual.duration - duration) > 0.15) throw new Error('Generated audio does not match its conditioning or requested duration');
  return { ...output, conditioning: { ...conditioning }, duration: actual.duration,
    audioSha256: createHash('sha256').update(output.audioWav).digest('hex') };
}

const modelFailure = (message, code = 'MODEL_UNAVAILABLE', status = 503) => new MelodyModelError(message, status, code);
const safeJobId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Audio is sent only to an explicitly configured local inference process. */
export function createMelodyModel({ endpoint = process.env.MUSE_MELODY_MODEL_URL, fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.MUSE_MELODY_TIMEOUT_MS || 1800000), pollIntervalMs = 1000 } = {}) {
  const url = localEndpoint(endpoint);
  const configured = Boolean(url) && typeof fetchImpl === 'function';
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 3600000) : 1800000;
  const interval = Number.isFinite(pollIntervalMs) ? Math.max(1, Math.min(pollIntervalMs, 10000)) : 1000;
  const baseUrl = configured ? new URL('.', url).href : null;
  let active = null;
  let closed = false;
  let live = null;
  const configuredStatus = () => configured
    ? { mode: 'audio-melody', configured: true, ready: false, provider: 'local-audiocraft', model: MODEL, ...(live || {}) }
    : { mode: 'unavailable', configured: false, ready: false, provider: null, model: null, reason: typeof endpoint === 'string' && endpoint.trim() ? 'invalid-endpoint' : 'not-configured' };
  async function jsonFetch(target, options, signal, attempts = 2) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw signal.reason;
      try {
        const response = await fetchImpl(target, { redirect: 'error', ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(5000) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if ((response.status >= 500 || response.status === 429) && attempt + 1 < attempts) continue;
          throw modelFailure('The local melody service could not complete this request.', 'MODEL_FAILED', response.status === 409 ? 409 : 502);
        }
        return await readResponse(response);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof MelodyModelError || attempt + 1 === attempts) throw error;
      }
    }
  }
  async function probe() {
    if (!configured || closed) return configuredStatus();
    try {
      const health = await jsonFetch(new URL('health', baseUrl).href, { method: 'GET' }, null, 1);
      if (health?.model !== MODEL) throw new Error('Wrong model');
      live = { reachable: true, loaded: health.loaded === true, ready: health.ready === true,
        provider: health.backend === 'transformers' ? 'local-transformers' : 'local-audiocraft',
        status: typeof health.status === 'string' ? health.status : health.ready ? 'ready' : 'loading',
        backend: typeof health.backend === 'string' ? health.backend : 'audiocraft',
        device: typeof health.device === 'string' ? health.device : null,
        capabilities: Array.isArray(health.capabilities) ? health.capabilities.filter(item => ['jobs', 'progress', 'cancel'].includes(item)) : [] };
    } catch { live = { reachable: false, loaded: false, ready: false, status: 'unavailable', capabilities: [], reason: 'service-unavailable' }; }
    return configuredStatus();
  }
  return {
    status: configuredStatus,
    probe,
    async generate({ audioWav, prompt, duration, requestId, signal, onProgress, requireReceipt = false } = {}) {
      if (closed) throw new MelodyModelError('The local melody model service has closed.', 503, 'MODEL_CLOSED');
      if (!configured) throw new MelodyModelError('MusicGen Melody is not configured. Start the local audio model and set MUSE_MELODY_MODEL_URL.', 503, 'MODEL_NOT_CONFIGURED');
      try {
        inspectWav(audioWav, 60, MAX_INPUT_WAV_BYTES);
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000
          || !Number.isFinite(duration) || duration <= 0 || duration > 30) throw new Error('Invalid music direction');
      } catch {
        throw new MelodyModelError('Supply a nonempty PCM16 WAV (mono or stereo, at most 60 seconds), a music direction, and a generation duration from 0 to 30 seconds.', 400, 'INVALID_MELODY_INPUT');
      }
      if (active) throw new MelodyModelError('The local melody model is busy. Wait for the current generation to finish, then retry.', 503, 'MODEL_BUSY');
      // Snapshot before awaiting: caller changes cannot alter the audio sent or its fingerprint.
      const input = Buffer.from(audioWav);
      const conditioning = { audioSha256: createHash('sha256').update(input).digest('hex'), inputBytes: input.length, mode: 'audio-melody' };
      const controller = new AbortController();
      const cancel = () => controller.abort(modelFailure('Music generation was cancelled. No substitute audio was generated.', 'MODEL_CANCELLED', 499));
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      active = controller;
      let timer;
      let remoteId;
      const usesJobs = live?.capabilities?.includes('jobs');
      try {
        const inference = async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (usesJobs) {
            const serviceRequestId = requestId ?? randomUUID();
            if (!safeJobId(serviceRequestId)) throw modelFailure('A stable request id is required for local generation jobs.', 'INVALID_MELODY_INPUT', 400);
            // The service uses this same id, so cancellation can address even a
            // submission whose acknowledgement was lost in transit.
            remoteId = serviceRequestId;
            let job = await jsonFetch(new URL('jobs', baseUrl).href, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audioWavBase64: input.toString('base64'), prompt: prompt.trim(), duration, requestId: serviceRequestId }) }, controller.signal);
            while (true) {
              if (!job || !safeJobId(job.id) || job.id !== remoteId) throw modelFailure('The local model returned an invalid job.', 'INVALID_MODEL_OUTPUT', 502);
              if (controller.signal.aborted) throw controller.signal.reason;
              onProgress?.({ status: job.status, stage: job.stage, progress: job.progress || null });
              if (job.status === 'succeeded') {
                try { return validateGeneratedAudio(job.result, conditioning, duration); }
                catch { throw modelFailure('The local model returned invalid audio or mismatched melody conditioning.', 'INVALID_MODEL_OUTPUT', 502); }
              }
              if (job.status === 'cancelled') throw modelFailure('Music generation was cancelled.', 'MODEL_CANCELLED', 499);
              if (job.status === 'failed') throw modelFailure('MusicGen Melody inference failed. Check the local service console; no substitute audio was generated.', 'MODEL_FAILED', 502);
              if (!['queued', 'running', 'cancelling'].includes(job.status)) throw modelFailure('The local model returned an invalid job status.', 'INVALID_MODEL_OUTPUT', 502);
              await pause(interval, controller.signal);
              job = await jsonFetch(new URL(`jobs/${encodeURIComponent(remoteId)}`, baseUrl).href, { method: 'GET' }, controller.signal);
            }
          }
          const response = await fetchImpl(url, {
            method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ audioWavBase64: input.toString('base64'), prompt: prompt.trim(), duration }),
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new MelodyModelError('The local melody model could not generate audio. Check that its dependencies and model weights are ready.', 502, 'MODEL_FAILED');
          }
          try {
            const value = await readResponse(response);
            return requireReceipt ? validateGeneratedAudio(value, conditioning, duration) : { ...modelOutput(value), conditioning };
          }
          catch { throw new MelodyModelError('The local model returned invalid audio or a model without melody conditioning.', 502, 'INVALID_MODEL_OUTPUT'); }
        };
        const interrupted = new Promise((resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
          if (controller.signal.aborted) { reject(controller.signal.reason); return; }
          timer = setTimeout(() => {
            controller.abort(new MelodyModelError('The local melody model timed out. No substitute audio was generated.', 504, 'MODEL_TIMEOUT'));
          }, deadline);
        });
        return await Promise.race([inference(), interrupted]);
      } catch (error) {
        if (error instanceof MelodyModelError) throw error;
        throw new MelodyModelError('The local melody model is unavailable. No substitute audio was generated.', 503, 'MODEL_UNAVAILABLE');
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (controller.signal.aborted && remoteId) {
          try {
            const stopSignal = AbortSignal.timeout(60000);
            const target = new URL(`jobs/${encodeURIComponent(remoteId)}`, baseUrl).href;
            let stopped = await jsonFetch(target, { method: 'DELETE' }, stopSignal, 1);
            // Keep our single inference slot while cooperative cancellation is
            // still unwinding the provider's token generation or model load.
            while (!closed && !['cancelled', 'failed', 'succeeded'].includes(stopped?.status)) {
              await pause(interval, stopSignal);
              stopped = await jsonFetch(target, { method: 'GET' }, stopSignal, 1);
            }
          } catch { /* The provider's own watchdog still bounds its worker. */ }
        }
        active = null;
      }
    },
    close() {
      closed = true;
      active?.abort(new MelodyModelError('The local melody model service has closed.', 503, 'MODEL_CLOSED'));
    },
  };
}
