import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { decodePcmWav } from '../src/audio/pcm-wav.js';
import { validateMelodyNotes } from '../src/music/melody-contract.js';
import { assessTranscription } from '../src/audio/transcription-quality.js';

export class AudioPipelineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function melodySignature(notes) {
  return JSON.stringify(notes.map(note => ({ midi: note.midi, start: note.start, duration: note.duration,
    contour: (note.contour || []).map(({ time, frequency }) => ({ time, frequency })) })));
}

/** Short-lived, bounded conditioning state. No audio is published or silently replaced. */
export function createAudioPipeline({ analyzeImpl, maxTakes = 5, ttlMs = 30 * 60 * 1000 } = {}) {
  const takes = new Map();
  const jobs = new Set();
  let active = false;
  let closed = false;
  function dispose(id) {
    const take = takes.get(id);
    if (!take) return;
    clearTimeout(take.timer);
    takes.delete(id);
  }
  function expire() {
    for (const [id, take] of takes) if (take.expires <= Date.now()) dispose(id);
  }
  function find(id) {
    expire();
    const take = typeof id === 'string' && takes.get(id);
    if (!take) throw new AudioPipelineError(410, 'This audio conditioning take has expired. Record or analyze the original audio again.');
    return take;
  }
  function runWorker(samples, sampleRate) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./melody-worker.js', import.meta.url), { workerData: { samples, sampleRate }, transferList: [samples.buffer] });
      jobs.add(worker);
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); jobs.delete(worker);
        worker.terminate().catch(() => {});
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => finish(new AudioPipelineError(504, 'Full-recording pitch analysis timed out. Try a shorter, clear take.')), 60000);
      worker.once('message', value => finish(value.error ? new AudioPipelineError(422, value.error) : null, value.analysis));
      worker.once('error', error => finish(new AudioPipelineError(422, error.message)));
      worker.once('exit', () => { if (!settled) finish(new AudioPipelineError(503, 'Audio analysis was interrupted.')); });
    });
  }
  return {
    async analyze(input) {
      if (closed || active) throw new AudioPipelineError(503, 'Audio analysis is busy. Wait for the current take to finish, then retry.');
      let decoded;
      const wav = Buffer.from(input);
      try { decoded = decodePcmWav(wav); }
      catch (error) { throw new AudioPipelineError(400, error.message); }
      const receipt = { sha256: createHash('sha256').update(wav).digest('hex'), bytes: wav.length,
        sampleRate: decoded.sampleRate, channels: decoded.channels, selectedChannel: decoded.selectedChannel, duration: decoded.duration };
      active = true;
      let analysis;
      try { analysis = await (analyzeImpl || runWorker)(decoded.samples, decoded.sampleRate); }
      finally { active = false; }
      if (closed) throw new AudioPipelineError(503, 'The audio service has closed.');
      if (!analysis || !Array.isArray(analysis.notes)) throw new AudioPipelineError(422, 'The recording did not produce a valid melody analysis.');
      try { validateMelodyNotes(analysis.notes, { allowEmpty: true }); }
      catch (error) { throw new AudioPipelineError(422, `Invalid extracted melody: ${error.message}`); }
      if (!Number.isFinite(analysis.duration) || Math.abs(analysis.duration - receipt.duration) > 0.001) throw new AudioPipelineError(422, 'The extracted melody clock does not match the received recording.');
      if (analysis.notes.some(note => note.start + note.duration > receipt.duration + 0.001)) throw new AudioPipelineError(422, 'The extracted notes exceed the received recording clock.');
      analysis = { ...analysis, quality: assessTranscription(analysis) };
      // The real recording remains usable even when transcription finds no
      // reliable notes. Preserving its waveform must not depend on a pitch guess.
      expire();
      while (takes.size >= Math.max(1, maxTakes)) dispose(takes.keys().next().value);
      const conditioningId = randomUUID();
      const timer = setTimeout(() => dispose(conditioningId), ttlMs);
      timer.unref?.();
      takes.set(conditioningId, { wav, analysis: structuredClone(analysis), receipt, expires: Date.now() + ttlMs, timer });
      return { conditioningId, receipt: { ...receipt }, analysis: structuredClone(analysis) };
    },
    condition(id, notes) {
      const take = find(id);
      if (melodySignature(notes) !== melodySignature(take.analysis.notes)) throw new AudioPipelineError(409, 'The requested notes differ from the melody extracted from this audio. Analyze the take again or explicitly use the edited note sequence.');
      return { receipt: { ...take.receipt }, method: take.analysis.method, verifiedInput: true,
        quality: structuredClone(take.analysis.quality),
        analysisSummary: { duration: take.analysis.duration, noteCount: take.analysis.notes.length, voicedRatio: take.analysis.voicedRatio } };
    },
    async generate(id, model, options) {
      const take = find(id);
      return model.generate({ ...options, audioWav: take.wav });
    },
    snapshot(id) {
      if (closed) throw new AudioPipelineError(503, 'The audio service has closed.');
      const take = find(id);
      return { audioWav: Buffer.from(take.wav), receipt: { ...take.receipt }, analysis: structuredClone(take.analysis) };
    },
    close() {
      closed = true;
      for (const id of takes.keys()) dispose(id);
      for (const worker of jobs) worker.terminate().catch(() => {});
      jobs.clear();
    },
  };
}
