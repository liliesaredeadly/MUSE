import { recordingToWav } from '../audio/recording-file.js';
import { decodePcmWav } from '../audio/pcm-wav.js';

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const audioFailure = (message, code, retryable = false) => Object.assign(new Error(message), { code, retryable });

function readAudioChunk(reader, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (done, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); done(value);
    };
    const abort = () => finish(reject, signal.reason || new DOMException('Audio download cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { reader.read().then(value => finish(resolve, value), error => finish(reject, error)); }
    catch (error) { finish(reject, error); }
  });
}

async function readAudioBytes(response, signal) {
  const tooLarge = () => audioFailure('The finished WAV exceeds the audio download size limit. Your existing audio is kept.', 'AUDIO_TOO_LARGE');
  if (Number(response.headers?.get('Content-Length')) > MAX_AUDIO_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  signal.throwIfAborted();
  if (!response.body?.getReader) throw audioFailure('The server returned no readable WAV audio.', 'INVALID_AUDIO_WAV');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await readAudioChunk(reader, signal);
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw audioFailure('The server returned unreadable WAV audio.', 'INVALID_AUDIO_WAV');
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) throw tooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function request(path, body, { audio = false, timeout = 15000, method, signal: callerSignal, binary = false } = {}) {
  const deadline = AbortSignal.timeout(timeout);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const timedOut = error => deadline.reason?.name === 'TimeoutError' || error?.name === 'TimeoutError';
  const timeoutError = () => binary
    ? audioFailure('The finished preview download timed out. Load it again or download the finished WAV directly.', 'AUDIO_DOWNLOAD_TIMEOUT', true)
    : new Error('The MUSE request timed out. The server may still be working; wait a moment, then retry.');
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? {} : { 'Content-Type': audio ? 'audio/wav' : 'application/json' },
      body: body === undefined ? undefined : audio ? body : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason || error;
    if (timedOut(error)) throw timeoutError();
    if (binary) throw audioFailure('The finished preview download was interrupted. Load it again or download the finished WAV directly.', 'AUDIO_DOWNLOAD_INTERRUPTED', true);
    throw new Error('The MUSE server is unavailable. Start the app with npm run dev, then retry.');
  }
  let result;
  try {
    if (response.ok && binary) {
      const bytes = await readAudioBytes(response, signal);
      let decoded;
      try { decoded = decodePcmWav(bytes); }
      catch { throw audioFailure('The server returned invalid PCM WAV audio. Your existing audio is kept.', 'INVALID_AUDIO_WAV'); }
      return { blob: new Blob([bytes], { type: 'audio/wav' }), duration: decoded.duration };
    }
    result = await response.json();
  }
  catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason || error;
    if (timedOut(error)) throw timeoutError();
    if (binary) {
      if (['AUDIO_TOO_LARGE', 'INVALID_AUDIO_WAV'].includes(error.code)) throw error;
      throw Object.assign(audioFailure('The finished preview download was interrupted. Load it again or download the finished WAV directly.', 'AUDIO_DOWNLOAD_INTERRUPTED', response.ok || response.status >= 500 || response.status === 429),
        { status: response.ok ? undefined : response.status });
    }
    throw new Error('The server returned an unreadable response. Restart the MUSE server and retry.');
  }
  if (!response.ok) throw Object.assign(new Error(result?.error || `The request failed (${response.status}).`), { status: response.status, code: result?.code, retryable: result?.retryable });
  return result;
}

const melodySignature = notes => JSON.stringify(notes.map(note => ({ midi: note.midi, start: note.start, duration: note.duration,
  contour: (note.contour || []).map(({ time, frequency }) => ({ time, frequency })) })));

async function renewRecording(source) {
  if (!source.renewal) {
    source.renewal = (async () => {
      const refreshed = await api.analyzeRecording(source.blob, source.duration);
      if (!refreshed.conditioningId || !source.receipt?.sha256 || refreshed.receipt?.sha256 !== source.receipt.sha256
        || !Array.isArray(refreshed.analysis?.notes) || melodySignature(refreshed.analysis.notes) !== melodySignature(source.notes)) {
        throw new Error('The refreshed original recording does not match its verified audio and melody. Record a new take before arranging.');
      }
      source.conditioningId = refreshed.conditioningId;
      return refreshed.conditioningId;
    })().finally(() => { source.renewal = null; });
  }
  return source.renewal;
}

async function arrange(notes, settings, conditioningId, source) {
  if (source && melodySignature(notes) !== melodySignature(source.notes)) throw new Error('The notes have changed from the verified original recording.');
  const id = source?.conditioningId || conditioningId;
  const send = async nextId => {
    const arrangement = (await request('/arrange', { notes, settings, ...(nextId ? { conditioningId: nextId } : {}) })).arrangement;
    if (settings?.leadSource === 'recording') {
      if (!source?.audioWav?.size || !arrangement?.recordingLead || arrangement.recordingLead.sha256 !== source.receipt?.sha256) {
        throw new Error('Attach the matching original humming recording before playing this lead. No substitute was generated.');
      }
      return { ...arrangement, recordingLead: { ...arrangement.recordingLead, audioWav: source.audioWav } };
    }
    return arrangement;
  };
  try { return await send(id); }
  catch (error) {
    if (error.status !== 410 || !source?.blob?.size) throw error;
    // An overlapping settings request may already have renewed this same take.
    const renewedId = source.conditioningId !== id ? source.conditioningId : await renewRecording(source);
    return send(renewedId);
  }
}

export const api = {
  health: () => request('/health'),
  projects: async () => (await request('/projects')).projects,
  save: async project => (await request('/projects', project)).project,
  arrange,
  analyzeRecording: async (blob, durationLimit = 60, options = {}) => {
    const audioWav = await recordingToWav(blob, { durationLimit, ...options });
    const samples = decodePcmWav(new Uint8Array(await audioWav.arrayBuffer())).samples;
    let low = Infinity; let high = -Infinity;
    for (const sample of samples) { low = Math.min(low, sample); high = Math.max(high, sample); }
    const result = await request('/melody/analyze', audioWav, { audio: true, timeout: 90000 });
    return { ...result, audioWav, sourceHasSignal: high - low > 2 / 32768 };
  },
  melodyModelStatus: () => request('/melody/model/status'),
  createGenerationJob: async (payload, source, options = {}) => {
    if (!source?.conditioningId || !source?.receipt?.sha256) throw new Error('Attach your original humming recording before generating a preview.');
    // Retain the request identity across an uncertain response. Renew only a
    // definitively expired source, which the server has not accepted as a job.
    payload.conditioningId ||= source.conditioningId;
    const send = async () => (await request('/generation/jobs', payload, options)).job;
    try { return await send(); }
    catch (error) {
      if (error.status !== 410 || !source.blob?.size) throw error;
      payload.conditioningId = source.conditioningId !== payload.conditioningId ? source.conditioningId : await renewRecording(source);
      return send();
    }
  },
  generationJob: async (id, options = {}) => (await request(`/generation/jobs/${encodeURIComponent(id)}`, undefined, options)).job,
  cancelGenerationJob: async (id, options = {}) => (await request(`/generation/jobs/${encodeURIComponent(id)}`, undefined, { ...options, method: 'DELETE' })).job,
  generationAudio: async (id, options = {}) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      options.signal?.throwIfAborted();
      try { return await request(`/generation/jobs/${encodeURIComponent(id)}/audio`, undefined, { timeout: 60000, ...options, binary: true }); }
      catch (error) {
        const temporary = error.retryable === true || error.status >= 500 || error.status === 429;
        if (attempt === 1 || options.signal?.aborted || !temporary) throw error;
      }
    }
  },
  producerStatus: () => request('/producer/status'),
  producer: (text, settings, notes = []) => request('/producer', { text, settings, notes }),
  productionDirectorStatus: () => request('/production-director/status'),
  productionDirector: (text, settings, notes = []) => request('/production-director', { text, settings, notes }),
  referenceStatus: () => request('/reference'),
  matchReference: notes => request('/reference/match', { notes }),
};
