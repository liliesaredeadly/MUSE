import { encodePcmWav } from './pcm-wav.js';

/** Decode the completed recording, not the animation-frame pitch preview. */
export async function recordingToWav(blob, { durationLimit = 60, strictDuration = false } = {}) {
  if (!blob?.size) throw new Error('No recorded audio file was received. Record a new take.');
  if (!Number.isFinite(durationLimit) || durationLimit <= 0 || durationLimit > 60) throw new Error('The recording capture boundary must be within 60 seconds.');
  const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error('Full-recording analysis requires a browser with Web Audio decoding.');
  const context = new OfflineContext(1, 1, 16000);
  let decoded;
  try { decoded = await context.decodeAudioData(await blob.arrayBuffer()); }
  catch { throw new Error('The recorded audio could not be decoded. Keep the original take and record again in a supported browser.'); }
  if (!decoded.length) throw new Error('The recording contains no audio samples.');
  if (strictDuration && decoded.length / decoded.sampleRate > 60) throw new Error('Import a humming recording of at most 60 seconds.');
  const count = Math.min(decoded.length, Math.floor(durationLimit * decoded.sampleRate));
  let channel = 0;
  let maxEnergy = -1;
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const samples = decoded.getChannelData(c).subarray(0, count);
    let energy = 0;
    for (const value of samples) energy += value * value;
    if (energy > maxEnergy) { channel = c; maxEnergy = energy; }
  }
  return new Blob([encodePcmWav(decoded.getChannelData(channel).subarray(0, count), decoded.sampleRate)], { type: 'audio/wav' });
}

/** Encoder stop is idempotent; automatic/manual consumers must also coalesce. */
export function createRecordingFinalizer(analyze) {
  const results = new WeakMap();
  return result => {
    if (!results.has(result)) results.set(result, Promise.resolve().then(() => analyze(result)));
    return results.get(result);
  };
}
