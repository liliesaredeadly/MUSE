import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../lib/api.js';

const terminal = status => ['succeeded', 'failed', 'cancelled'].includes(status);
const working = status => ['submitting', 'uncertain', 'running', 'cancelling', 'loading-audio'].includes(status);
const initial = () => ({ status: 'idle', job: null, result: null, error: '', connectionError: '', active: false });
const availabilityReasons = {
  'not-configured': 'MusicGen is not set up on this device. Complete the local model setup, then check again.',
  'invalid-endpoint': 'The local music service connection is not valid. Check the model setup, then try again.',
  'service-unavailable': 'The local music service is not responding. Start it, then check again.',
  'invalid-provider': 'Choose a supported music provider in the server configuration, then restart Muse.',
};

export function describeModelAvailability(neural = {}) {
  const acceptsJobs = neural.configured === true && neural.reachable === true && neural.capabilities?.includes('jobs');
  const canSubmit = neural.ready === true || Boolean(acceptsJobs && ['not-loaded', 'loading', 'generating', 'preparing', 'queued', 'cancelling'].includes(neural.status));
  const reasonCode = neural.reasonCode || (Object.hasOwn(availabilityReasons, neural.reason) ? neural.reason : undefined);
  const reason = Object.hasOwn(availabilityReasons, reasonCode) ? availabilityReasons[reasonCode] : neural.reason;
  return { ...neural, reasonCode, reason, ready: neural.ready === true, canSubmit,
    status: neural.ready ? 'ready' : canSubmit ? neural.status : 'unavailable' };
}

/** The job lifecycle is separate from the protected arrangement and its lead. */
export function createMusicGenJobController({ client = api, getIdentity, getSource,
  schedule = setTimeout, unschedule = clearTimeout, createUrl = blob => URL.createObjectURL(blob),
  revokeUrl = url => URL.revokeObjectURL(url), makeRequestId = () => crypto.randomUUID() }) {
  let state = initial();
  let run = null;
  let timer = null;
  const listeners = new Set();
  const emit = changes => {
    const next = { ...state, ...changes };
    state = { ...next, active: working(next.status) && !terminal(next.job?.status) };
    for (const listener of listeners) listener();
  };
  const current = candidate => run === candidate && candidate.identity === getIdentity();
  const clearTimer = () => { if (timer !== null) unschedule(timer); timer = null; };
  const queue = candidate => {
    if (!current(candidate)) return;
    clearTimer();
    if (current(candidate) && working(state.status) && state.status !== 'uncertain') {
      timer = schedule(() => { timer = null; return poll(candidate); }, state.connectionError ? 3000 : 1000);
    }
  };
  const retryableCleanup = error => !error.status || error.status >= 500 || error.status === 429;
  async function abandonRemote(id, signal = AbortSignal.timeout(15000)) {
    if (!id) return;
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      try { await client.cancelGenerationJob(id, { signal }); return; }
      catch (error) { if (!retryableCleanup(error)) return; }
    }
  }
  function recoverDetached(candidate) {
    if (candidate.detachedRecovery) return candidate.detachedRecovery;
    candidate.detachedRecovery = (async () => {
      const signal = AbortSignal.timeout(15000);
      // Replay only the accepted request identity. Never re-upload/renew an
      // expired recording or read the new project's source during cleanup.
      const retainedSource = { conditioningId: candidate.source.conditioningId, receipt: candidate.source.receipt };
      for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
        try {
          const job = await client.createGenerationJob(candidate.payload, retainedSource, { signal });
          if (!job?.id || job.requestId !== candidate.payload.requestId
            || job.conditioning?.audioSha256 !== candidate.source.receipt.sha256) return;
          candidate.jobId = job.id;
          await abandonRemote(job.id, signal);
          return;
        } catch (error) { if (!retryableCleanup(error)) return; }
      }
    })();
    return candidate.detachedRecovery;
  }

  async function receive(job, candidate) {
    if (!current(candidate)) { abandonRemote(job?.id); return; }
    if (!job?.id || !['queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed'].includes(job.status)) {
      throw new Error('The server returned an unreadable generation status. Reconnect to check this request.');
    }
    if (candidate.jobId && candidate.jobId !== job.id) throw new Error('The generation response belongs to a different job.');
    candidate.jobId = job.id;
    if (job.requestId !== candidate.payload.requestId || job.conditioning?.audioSha256 !== candidate.source.receipt.sha256) {
      abandonRemote(job.id);
      emit({ status: 'failed', error: 'This preview does not match your original recording and request. Your existing audio is kept.', connectionError: '' });
      return;
    }
    emit({ job, connectionError: '', error: '' });
    if (job.status === 'failed') { emit({ status: 'failed', error: job.error?.message || 'The model could not finish this preview. Your original take is kept.' }); return; }
    if (job.status === 'cancelled') { emit({ status: 'cancelled' }); return; }
    if (job.status !== 'succeeded') { emit({ status: candidate.cancelWanted || job.status === 'cancelling' ? 'cancelling' : 'running' }); return; }
    emit({ status: 'loading-audio' });
    try {
      const audio = await client.generationAudio(job.id, { signal: candidate.abort.signal });
      if (!current(candidate)) return;
      if (!audio.blob?.size || !Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error('The model returned no playable WAV audio.');
      const audioUrl = createUrl(audio.blob);
      const previous = state.result;
      emit({ status: 'ready', result: { ...audio, audioUrl, jobId: job.id, prompt: candidate.payload.text,
        production: job.production, model: job.model, sourceSha256: candidate.source.receipt.sha256 } });
      if (previous?.audioUrl) revokeUrl(previous.audioUrl);
    } catch (error) {
      if (current(candidate)) emit({ status: 'failed', error: error.message || 'Could not load the generated audio. Your earlier preview is kept.' });
    }
  }

  async function submit(candidate) {
    if (!current(candidate) || candidate.inFlight) return;
    candidate.inFlight = true;
    emit({ status: candidate.cancelWanted ? 'cancelling' : 'submitting', connectionError: '', error: '' });
    try {
      // Do not abort a creation on source change: its response gives us the ID
      // required to cancel a possibly accepted server job safely.
      const job = await client.createGenerationJob(candidate.payload, candidate.source);
      await receive(job, candidate);
    } catch (error) {
      if (current(candidate)) emit({ status: error.status ? 'failed' : 'uncertain', error: error.status ? error.message : '',
        connectionError: error.status ? '' : 'The server may have accepted this request. Reconnect to check it safely.' });
      else if (!error.status) void recoverDetached(candidate);
    } finally {
      candidate.inFlight = false;
      if (current(candidate)) {
        if (candidate.cancelWanted && candidate.jobId && working(state.status)) await poll(candidate);
        else queue(candidate);
      }
    }
  }

  async function poll(candidate) {
    if (!current(candidate) || candidate.inFlight || !candidate.jobId) return;
    clearTimer(); candidate.inFlight = true;
    try {
      const job = await (candidate.cancelWanted ? client.cancelGenerationJob : client.generationJob)(candidate.jobId, { signal: candidate.abort.signal });
      await receive(job, candidate);
      candidate.pollFailures = 0;
    } catch (error) {
      if (current(candidate)) {
        if ([404, 410].includes(error.status)) emit({ status: 'failed', error: 'This generation job is no longer available. Your original take and earlier preview are kept.', connectionError: '' });
        else {
          candidate.pollFailures++;
          if (candidate.pollFailures >= 3) emit({ status: 'uncertain', connectionError: 'Automatic connection checks are paused after three failed attempts. Reconnect to check this same job. Your original take and earlier preview are kept.' });
          else emit({ connectionError: error.message || 'Connection interrupted. Checking the same job again…' });
        }
      }
    } finally { candidate.inFlight = false; queue(candidate); }
  }

  const controller = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    async start({ text, duration = 10, settings } = {}) {
      if (working(state.status)) return;
      const source = getSource();
      if (!text?.trim()) { emit({ error: 'Describe the music you want to create.' }); return; }
      if (!source?.conditioningId || !source?.receipt?.sha256) { emit({ error: 'Attach your original humming recording before generating a preview.' }); return; }
      clearTimer(); run?.abort.abort();
      run = { identity: getIdentity(), source, payload: { text: text.trim(), duration, requestId: makeRequestId(), ...(settings ? { settings } : {}) },
        abort: new AbortController(), jobId: null, cancelWanted: false, inFlight: false, pollFailures: 0 };
      emit({ job: null });
      await submit(run);
    },
    async cancel() {
      if (!run || !state.active) return;
      run.cancelWanted = true; emit({ status: 'cancelling', error: '' });
      if (run.inFlight) return;
      if (run.jobId) await poll(run);
      else await submit(run);
    },
    async reconnect() {
      if (!run) return;
      run.pollFailures = 0;
      if (state.status === 'failed' && state.job?.status === 'succeeded') {
        await receive(state.job, run);
        return;
      }
      if (!working(state.status)) return;
      if (run.jobId) await poll(run);
      else await submit(run);
    },
    reset() {
      clearTimer();
      if (run) {
        if (!terminal(state.job?.status)) {
          if (run.jobId) void abandonRemote(run.jobId);
          else if (state.status === 'uncertain' && !run.inFlight) void recoverDetached(run);
        }
        run.abort.abort();
      }
      run = null;
      if (state.result?.audioUrl) revokeUrl(state.result.audioUrl);
      emit(initial());
    },
    dispose() { controller.reset(); },
  };
  return controller;
}

export function useMusicGenJob(options) {
  const latest = useRef(options); latest.current = options;
  const controllerRef = useRef(null);
  if (!controllerRef.current) controllerRef.current = createMusicGenJobController({
    getIdentity: () => `${latest.current.projectId}:${latest.current.sourceIdentity || ''}`,
    getSource: () => latest.current.getSource(),
  });
  const controller = controllerRef.current;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [availability, setAvailability] = useState({ status: 'loading', ready: false });
  const [prompt, setPrompt] = useState(options.defaultPrompt || '');
  const audioRef = useRef(null);
  const availabilityRequest = useRef(0);
  const identity = `${options.projectId}:${options.sourceIdentity || ''}`;
  const previousDefault = useRef(options.defaultPrompt || '');

  useEffect(() => { controller.reset(); audioRef.current?.pause(); }, [identity, controller]);
  useEffect(() => {
    const previous = previousDefault.current;
    setPrompt(current => current === previous ? options.defaultPrompt || '' : current);
    previousDefault.current = options.defaultPrompt || '';
  }, [options.defaultPrompt]);
  useEffect(() => { setPrompt(options.defaultPrompt || ''); }, [options.projectId]);
  async function refreshAvailability() {
    const requestId = ++availabilityRequest.current;
    setAvailability(previous => ({ ...previous, status: 'loading' }));
    try {
      const result = await api.melodyModelStatus();
      if (requestId !== availabilityRequest.current) return;
      setAvailability(describeModelAvailability(result.neural));
    } catch (error) {
      if (requestId === availabilityRequest.current) setAvailability({ status: 'error', ready: false, reason: error.message || 'Could not check the music generation connection.' });
    }
  }
  useEffect(() => { void refreshAvailability(); return () => { availabilityRequest.current++; controller.dispose(); }; }, [controller]);
  function start(duration = 10) {
    if (latest.current.busy || !availability.canSubmit) return;
    latest.current.stopPlayback();
    return controller.start({ text: prompt, duration, settings: latest.current.settings });
  }
  return { ...state, availability, prompt, setPrompt, audioRef,
    canGenerate: Boolean(options.sourceIdentity && options.getSource()?.conditioningId && availability.canSubmit && !options.busy && !working(state.status)),
    start, cancel: controller.cancel, reconnect: controller.reconnect, refreshAvailability,
  };
}
