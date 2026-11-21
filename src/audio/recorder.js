import { detectPitch } from './pitch.js';

const MAX_DURATION = 60;
const FRAME_INTERVAL = 1 / 25;
const STABLE_DURATION = 0.12;
const MIN_NOTE_DURATION = 0.12;
const RELEASE_DURATION = 0.12;

function samePitch(note, pitch) {
  if (!note || !pitch) return false;
  if (note.midi === pitch.midi) return true;
  if (!Number.isFinite(pitch.frequency) || pitch.frequency <= 0) return false;
  // A small hysteresis around rounded note boundaries tolerates natural tuning
  // wobble. A full semitone change still starts a separate candidate.
  const continuousMidi = 69 + 12 * Math.log2(pitch.frequency / 440);
  return Math.abs(continuousMidi - note.midi) <= 0.65;
}

function stopTracks(stream) {
  for (const track of stream?.getTracks() || []) {
    try { track.stop(); } catch { /* Continue releasing any other tracks. */ }
  }
}

function notify(callback, value) {
  // A consumer's rendering error must never leave a microphone running.
  try { callback?.(value); } catch (error) { console.error('MUSE capture callback failed:', error); }
}

/**
 * Browser-only capture. Notes use seconds on the active capture clock; pause time
 * is excluded. onFrame delivers fresh waveform arrays, pitch or null, time and
 * RMS level at 25fps on average. onNotes receives immutable snapshots of stable notes.
 * stop() is idempotent and resolves {notes, blob, duration}; blob is null only
 * when the browser cannot record encoded audio. On a device/encoder failure,
 * onAutoStop also returns a partial result with an additional error property.
 * dispose() cancels startup, and a disposed instance cannot be started again.
 */
export class MicrophoneRecorder {
  constructor({ onFrame, onNotes, onAutoStop } = {}) {
    this.onFrame = onFrame;
    this.onNotes = onNotes;
    this.onAutoStop = onAutoStop;
    this.state = 'idle';
    this._token = 0;
    this._notes = [];
    this._result = null;
    this._duration = 0;
  }

  async start() {
    if (this._stopping) await this._stopping;
    if (this.state === 'disposed') throw new Error('This microphone recorder has been disposed.');
    if (this.state === 'recording' || this.state === 'paused') return;
    if (this.state === 'requesting') return this._starting;
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture needs a supported browser on localhost or HTTPS.');
    }
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) throw new Error('This browser does not support Web Audio microphone analysis.');
    const token = ++this._token;
    this.state = 'requesting';
    this._result = null;
    this._duration = 0;
    this._notes = [];
    this._current = null;
    this._candidate = null;
    this._chunks = [];
    this._captureError = null;
    this.input = null;
    this._signal = { frames: 0, pitchedFrames: 0, peakLevel: 0 };
    this._pausedSeconds = 0;
    this._nextFrame = 0;
    notify(this.onNotes, []);

    this._starting = (async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        if (token !== this._token) {
          stopTracks(stream);
          throw new DOMException('Microphone startup was cancelled.', 'AbortError');
        }
        this._stream = stream;
        const track = stream.getAudioTracks?.()[0];
        const inputSettings = track?.getSettings?.() || {};
        this.input = { label: track?.label || 'Default microphone', channelCount: inputSettings.channelCount || null };
        this._context = new AudioContext();
        await this._context.resume();
        if (token !== this._token) throw new DOMException('Microphone startup was cancelled.', 'AbortError');
        this._source = this._context.createMediaStreamSource(stream);
        this._analyser = this._context.createAnalyser();
        this._analyser.fftSize = 4096;
        this._analyser.smoothingTimeConstant = 0;
        this._source.connect(this._analyser);
        // Deliberately never connect the microphone to the speaker destination.
        this._samples = new Float32Array(this._analyser.fftSize);
        const MediaRecorder = globalThis.MediaRecorder;
        if (MediaRecorder) {
          const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported?.(type));
          this._media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
          const chunks = this._chunks;
          this._media.ondataavailable = ({ data }) => { if (data?.size) chunks.push(data); };
          this._mediaDone = new Promise((resolve) => {
            this._media.onstop = () => {
              resolve();
              if (this.state === 'recording' || this.state === 'paused') {
                this._autoStop(new Error('The microphone recording stopped unexpectedly. Captured audio has been kept.'));
              }
            };
          });
          this._media.onerror = ({ error }) => {
            this._captureError = error || new Error('The microphone recording failed.');
            this._autoStop(this._captureError);
          };
          this._media.start(250);
        }
        this._startedAt = this._context.currentTime;
        this.state = 'recording';
        this._scheduleLimit();
        this._scheduleFrame();
      } catch (error) {
        stopTracks(stream);
        if (token === this._token) {
          this.state = 'idle';
          await this._release();
        }
        throw error;
      }
    })();
    return this._starting;
  }

  _time() {
    if (!this._context || this.state === 'idle' || this.state === 'disposed') return this._duration;
    const now = this.state === 'paused' ? this._pausedAt : this._context.currentTime;
    return Math.max(0, Math.min(MAX_DURATION, now - this._startedAt - this._pausedSeconds));
  }

  _scheduleLimit() {
    clearTimeout(this._limitTimer);
    this._limitTimer = setTimeout(() => this._autoStop(), Math.max(0, (MAX_DURATION - this._time()) * 1000));
  }

  _scheduleFrame() {
    this._frameId = requestAnimationFrame(() => this._frame());
  }

  _frame() {
    if (this.state !== 'recording') return;
    try {
      const time = this._time();
      if (time >= MAX_DURATION) { this._autoStop(); return; }
      if (time >= this._nextFrame - 0.000001) {
        // Keep analysis on its 40ms clock: starting a new delay at each rAF
        // callback turns 25Hz into 20Hz on a 60Hz display. Skip stale deadlines
        // after a stall; each callback supplies at most one real observation.
        const skipped = Math.max(0, Math.floor((time - this._nextFrame + 0.000001) / FRAME_INTERVAL));
        const frameTime = this._nextFrame + skipped * FRAME_INTERVAL;
        this._nextFrame = frameTime + FRAME_INTERVAL;
        this._analyser.getFloatTimeDomainData(this._samples);
        let energy = 0;
        for (const sample of this._samples) energy += sample * sample;
        const pitch = detectPitch(this._samples, this._context.sampleRate);
        const level = Math.sqrt(energy / this._samples.length);
        this._signal.frames++;
        if (pitch) this._signal.pitchedFrames++;
        this._signal.peakLevel = Math.max(this._signal.peakLevel, level);
        // Note evidence represents the scheduled interval. Callback jitter must
        // not turn three analysis frames into less than 120ms of evidence.
        this._groupPitch(pitch, frameTime);
        notify(this.onFrame, { waveform: this._samples.slice(), pitch, time, level });
      }
      if (this.state === 'recording') this._scheduleFrame();
    } catch (error) {
      this._autoStop(error);
    }
  }

  _groupPitch(pitch, time) {
    // A missed analysis interval is not evidence of a held note. Expire old
    // evidence before a matching pitch can extend it across the gap.
    if (this._current && time - this._current.end >= RELEASE_DURATION - 0.000001) this._finishNote();
    if (this._candidate && time - this._candidate.end >= RELEASE_DURATION - 0.000001) this._candidate = null;
    if (samePitch(this._current, pitch)) {
      this._current.end = time;
      this._current.sum += pitch.confidence;
      this._current.count++;
      this._candidate = null;
    } else if (pitch) {
      if (samePitch(this._candidate, pitch)) {
        this._candidate.end = time;
        this._candidate.sum += pitch.confidence;
        this._candidate.count++;
      } else {
        this._candidate = { midi: pitch.midi, name: pitch.name, start: time, end: time, sum: pitch.confidence, count: 1 };
      }
      // Each detector frame supplies one bounded analysis interval. Three
      // adjacent 40ms frames represent 120ms, though their timestamps span 80ms.
      if (time - this._candidate.start + FRAME_INTERVAL >= STABLE_DURATION - 0.000001 && this._candidate.count >= 3) {
        this._finishNote(Math.min(this._candidate.start, (this._current?.end ?? time) + FRAME_INTERVAL));
        this._current = this._candidate;
        this._candidate = null;
      }
    }
    this._emitNotes();
  }

  _note(current, end = current.end + FRAME_INTERVAL) {
    return {
      midi: current.midi, name: current.name, start: current.start,
      duration: Math.max(0, end - current.start), confidence: current.sum / current.count,
    };
  }

  _finishNote(end) {
    if (this._current) {
      const note = this._note(this._current, end);
      if (note.duration >= MIN_NOTE_DURATION - 0.000001) this._notes.push(note);
      this._current = null;
    }
  }

  _emitNotes() {
    const notes = this._notes.map((note) => ({ ...note }));
    if (this._current) {
      const current = this._note(this._current);
      if (current.duration >= MIN_NOTE_DURATION - 0.000001) notes.push(current);
    }
    notify(this.onNotes, notes);
  }

  pause() {
    if (this.state !== 'recording') return;
    this._duration = this._time();
    this._pausedAt = this._context.currentTime;
    this._finishNote(Math.min((this._current?.end ?? this._duration) + FRAME_INTERVAL, this._duration));
    this._candidate = null;
    this.state = 'paused';
    cancelAnimationFrame(this._frameId);
    clearTimeout(this._limitTimer);
    try {
      if (this._media?.state === 'recording') this._media.pause();
    } catch (error) { this._autoStop(error); return; }
    this._emitNotes();
  }

  resume() {
    if (this.state !== 'paused') return;
    try {
      if (this._media?.state === 'paused') this._media.resume();
    } catch (error) { this._autoStop(error); return; }
    this._pausedSeconds += this._context.currentTime - this._pausedAt;
    this._nextFrame = this._duration;
    this.state = 'recording';
    this._scheduleLimit();
    this._scheduleFrame();
  }

  async _autoStop(error) {
    if (this.state !== 'recording' && !(error && this.state === 'paused')) return;
    if (error) this._captureError = error;
    const result = await this.stop();
    notify(this.onAutoStop, result);
  }

  async stop() {
    if (this._stopping) return this._stopping;
    if (this._result) return this._result;
    const duration = this.state === 'requesting' ? 0 : this._time();
    ++this._token;
    this._duration = duration;
    this._finishNote(Math.min((this._current?.end ?? duration) + FRAME_INTERVAL, duration));
    this._candidate = null;
    if (this.state !== 'disposed') this.state = 'idle';
    cancelAnimationFrame(this._frameId);
    clearTimeout(this._limitTimer);
    this._stopping = (async () => {
      const media = this._media;
      try {
        if (media) {
          let waitForStop = true;
          if (media.state !== 'inactive') {
            try { media.stop(); }
            catch (error) { this._captureError = error; waitForStop = false; }
          }
          // Even an inactive encoder can have final data and stop events queued.
          stopTracks(this._stream);
          if (waitForStop) await this._mediaDone;
        }
        const blob = media ? new Blob(this._chunks, { type: media.mimeType || this._chunks[0]?.type || 'audio/webm' }) : null;
        this._result = { notes: this._notes.map((note) => ({ ...note })), blob, duration, input: this.input, signal: { ...this._signal } };
        if (this._captureError) this._result.error = this._captureError;
        return this._result;
      } finally {
        await this._release();
        this._emitNotes();
      }
    })();
    try { return await this._stopping; }
    finally { this._stopping = null; }
  }

  async _release() {
    cancelAnimationFrame(this._frameId);
    clearTimeout(this._limitTimer);
    stopTracks(this._stream);
    try { this._source?.disconnect(); } catch { /* A disconnected graph is already released. */ }
    try { this._analyser?.disconnect(); } catch { /* Continue closing the context. */ }
    if (this._media) {
      this._media.ondataavailable = null;
      this._media.onstop = null;
      this._media.onerror = null;
      if (this._media.state !== 'inactive') {
        try { this._media.stop(); } catch { /* Tracks are stopped above. */ }
      }
    }
    const context = this._context;
    this._source = null;
    this._analyser = null;
    this._stream = null;
    this._context = null;
    this._media = null;
    if (context && context.state !== 'closed') await context.close().catch(() => {});
  }

  async dispose() {
    const result = this.stop();
    this.state = 'disposed';
    this.onFrame = null;
    this.onNotes = null;
    this.onAutoStop = null;
    await result;
  }
}
