import { validateMelodyNotes } from '../music/melody-contract.js';
import { decodePcmWav } from './pcm-wav.js';

const TAIL_SECONDS = 1.6;
const SAMPLE_RATE = 44100;
const noiseBuffers = new WeakMap();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const productionStyle = arrangement => arrangement.production?.style || arrangement.settings?.production || 'general';
const isPopProduction = arrangement => ['dance-pop', 'percussive-pop'].includes(productionStyle(arrangement));
const usesRecording = arrangement => arrangement?.settings?.leadSource === 'recording';

function checkedArrangement(arrangement) {
  const recording = usesRecording(arrangement);
  const source = arrangement?.recordingLead;
  if (recording && (!(source?.audioWav instanceof Blob) || !source.audioWav.size || source.audioWav.size > 16 * 1024 * 1024
    || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256)
    || !Number.isFinite(source.duration) || source.duration <= 0 || source.duration > 60)) {
    throw new Error('The verified original recording WAV is missing or invalid. Keep or reanalyze the original take; no instrument melody was substituted.');
  }
  const inputEvents = Array.isArray(arrangement?.events) ? arrangement.events : [];
  if (arrangement?.layers !== undefined && (!Array.isArray(arrangement.layers) || arrangement.layers.length > 7
    || arrangement.layers.some((layer, index, layers) => !layer || typeof layer.id !== 'string' || !layer.id
      || layers.findIndex(other => other?.id === layer.id) !== index
      || !Number.isFinite(layer.gain) || layer.gain < 0 || layer.gain > 1))) {
    throw new Error('This arrangement contains invalid layer gain controls.');
  }
  // An actual source waveform is the lead. Extracted notes may guide backing,
  // but a second synthesized lead would compete with and misrepresent it.
  const events = recording ? inputEvents.filter(event => event?.track !== 'melody') : inputEvents;
  if (!events.length && !recording) throw new Error('No notes to play. Record a melody first.');
  if (events.some(event => !event || !Number.isInteger(event.midi) || event.midi < 0 || event.midi > 127 ||
    !Number.isFinite(event.start) || event.start < 0 || !Number.isFinite(event.duration) || event.duration <= 0 || !Number.isFinite(event.start + event.duration))) throw new Error('This arrangement contains an invalid note; no melody notes were removed.');
  const melody = events.filter(event => event.track === 'melody');
  if (melody.length) validateMelodyNotes(melody);
  const duration = recording ? source.duration : events.reduce((end, event) => Math.max(end, event.start + event.duration), Number.isFinite(arrangement.duration) ? arrangement.duration : 0);
  if (recording && events.some(event => event.start + event.duration > duration + 1e-6)) throw new Error('Generated backing exceeds the original recording clock.');
  if (duration > 600 || events.length > 20000) throw new Error('This composition is too long to render in the browser.');
  return { ...arrangement, events, duration };
}

function activeLayer(arrangement, event) {
  if (event.track === 'melody' || !event.layerId) return null;
  return arrangement.layers?.find(layer => layer.id === event.layerId) ?? null;
}

function mutedLayer(layer) { return layer && (layer.enabled === false || layer.blocked === true || layer.gain === 0); }

async function prepareRecording(context, arrangement, isCurrent = () => true) {
  if (!usesRecording(arrangement)) return null;
  const source = arrangement.recordingLead;
  const bytes = await source.audioWav.arrayBuffer();
  if (!isCurrent()) return null;
  let decoded;
  try { decoded = decodePcmWav(new Uint8Array(bytes)); }
  catch (error) { throw new Error(`The original recording WAV could not be read: ${error.message}`); }
  if (Math.abs(decoded.duration - source.duration) > 1 / decoded.sampleRate + 1e-6) throw new Error('The original recording clock does not match its verified source metadata.');
  if (!globalThis.crypto?.subtle) throw new Error('Original recording fingerprint verification requires a supported secure browser.');
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  if (!isCurrent()) return null;
  if (fingerprint !== source.sha256.toLowerCase()) throw new Error('The original recording fingerprint does not match its verified source. No substitute melody was played.');
  const buffer = context.createBuffer(1, decoded.samples.length, decoded.sampleRate);
  buffer.getChannelData(0).set(decoded.samples);
  let energy = 0; let peak = 0;
  for (const value of decoded.samples) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
  const rms = Math.sqrt(energy / decoded.samples.length);
  // One bounded constant gain preserves the entire waveform's relative shape.
  // No note envelopes, pitch correction, stretching or per-frame gain are used.
  const gain = rms > 0 && peak > 0 ? Math.min(8, 0.08 / rms, 0.65 / peak) : 1;
  return { buffer, gain };
}

function makeRecordingVoice(context, recording, start, offset, duration, bus, sources, nodes) {
  if (!recording) throw new Error('The verified original recording is not ready. No instrument melody was substituted.');
  const remaining = duration - offset;
  if (remaining <= 0) return;
  const source = context.createBufferSource();
  const envelope = context.createGain();
  source.buffer = recording.buffer;
  source.playbackRate.value = 1;
  source.connect(envelope); envelope.connect(bus);
  const fade = Math.min(0.003, duration / 2);
  envelope.gain.setValueAtTime(recording.gain * Math.min(1, offset / fade, remaining / fade), start);
  if (offset < fade) envelope.gain.linearRampToValueAtTime(recording.gain, start + fade - offset);
  if (offset < duration - fade) envelope.gain.setValueAtTime(recording.gain, start + duration - fade - offset);
  envelope.gain.linearRampToValueAtTime(0, start + remaining);
  source.onended = () => { source.disconnect(); envelope.disconnect(); };
  source.start(start, offset, remaining);
  source.stop(start + remaining);
  sources.push(source); nodes.push(source, envelope);
}

function getNoise(context) {
  if (noiseBuffers.has(context)) return noiseBuffers.get(context);
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.6), context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 741;
  for (let index = 0; index < data.length; index++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    data[index] = seed / 2147483648 - 1;
  }
  noiseBuffers.set(context, buffer);
  return buffer;
}

function duckBacking(parameter, events, startTime, offset) {
  // One short envelope per distinct kick, excluding overlapping retriggers. The
  // dry lead and drum attack never pass through this rhythmic backing control.
  const kicks = [];
  for (const time of events.filter(event => event.instrument === 'Drums' && event.midi === 36)
    .map(event => event.start).sort((a, b) => a - b)) {
    if (!kicks.length || time - kicks.at(-1) >= 0.15) kicks.push(time);
  }
  let initial = 1;
  for (const kick of kicks) {
    if (offset >= kick - 0.006 && offset < kick + 0.14) initial = offset < kick + 0.003
      ? 1 - 0.52 * (offset - kick + 0.006) / 0.009
      : 0.48 + 0.52 * (offset - kick - 0.003) / 0.137;
  }
  parameter.setValueAtTime(initial, startTime);
  for (const kick of kicks) {
    if (kick + 0.14 <= offset) continue;
    if (kick + 0.003 > offset) {
      if (kick - 0.006 >= offset) parameter.setValueAtTime(1, startTime + kick - offset - 0.006);
      parameter.linearRampToValueAtTime(0.48, startTime + kick - offset + 0.003);
    }
    parameter.linearRampToValueAtTime(1, startTime + kick - offset + 0.14);
  }
}

function createBus(context, arrangement, nodes, startTime, offset) {
  const input = context.createGain();
  const melody = context.createGain();
  const master = context.createGain();
  const compressor = context.createDynamicsCompressor();
  const pop = isPopProduction(arrangement);
  master.gain.value = 0.74;
  // Backing effects stay beneath the dry captured lead and cannot duck it.
  input.gain.value = pop ? 0.5 : 0.28;
  melody.gain.value = 1;
  compressor.threshold.value = -13;
  compressor.knee.value = 16;
  compressor.ratio.value = 5;
  let backingOutput = compressor;
  let bass = input;
  let percussion = input;
  if (pop) {
    const duck = context.createGain();
    bass = context.createGain();
    percussion = context.createGain();
    bass.gain.value = 0.48;
    percussion.gain.value = 0.58;
    bass.connect(duck);
    percussion.connect(compressor);
    duck.connect(compressor);
    duckBacking(duck.gain, arrangement.events.filter(event => !mutedLayer(activeLayer(arrangement, event))), startTime, offset);
    compressor.threshold.value = -16;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.12;
    backingOutput = duck;
    nodes.push(duck, bass, percussion);
  }
  input.connect(backingOutput);
  compressor.connect(master);
  melody.connect(master);
  master.connect(context.destination);
  nodes.push(input, melody, master, compressor);
  const mood = String(arrangement.settings?.mood || '').toLowerCase();
  const wet = pop ? 0.1 : /dreamy/.test(mood) ? 0.23 : /cinematic/.test(mood) ? 0.27 : /peaceful/.test(mood) ? 0.16 : 0.08;
  const delay = context.createDelay(1);
  const feedback = context.createGain();
  const effectGain = context.createGain();
  delay.delayTime.value = clamp(30 / (arrangement.bpm || 90), 0.13, 0.5);
  feedback.gain.value = 0.23;
  effectGain.gain.value = wet;
  input.connect(delay);
  delay.connect(effectGain);
  effectGain.connect(backingOutput);
  delay.connect(feedback);
  feedback.connect(delay);
  nodes.push(delay, feedback, effectGain);
  let anchored = null;
  if (arrangement.harmonyScope === 'anchored') {
    // Confirmed pitch islands must not ring into the unsupported gaps. This
    // quiet dry path also bypasses compressor lookahead and release latency.
    anchored = context.createGain();
    // Short confirmed regions lose the long releases/effects of ordinary
    // backing. Restore a usable bed level on this isolated bus; the original
    // waveform and each instrument's user-controlled gain remain untouched.
    anchored.gain.value = 2;
    anchored.connect(master);
    nodes.push(anchored);
  }
  return { melody, backing: input, bass, percussion, anchored };
}

function makeVoice(context, event, start, duration, bus, sources, nodes, noteOffset = 0, strictGate = false) {
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  const voiceNodes = [gain, filter];
  const voiceSources = [];
  const velocity = clamp(Number.isFinite(event.velocity) ? event.velocity : 0.7, 0, 1);
  const tone = clamp(Number.isFinite(event.tone) ? event.tone : 0.6, 0, 1);
  const frequency = 440 * 2 ** ((event.midi - 69) / 12);
  const isMelody = event.track === 'melody';
  const contour = isMelody && event.contour?.length ? event.contour : null;
  let onsetFrequency = frequency;
  if (contour) {
    onsetFrequency = contour[0].frequency;
    for (let index = 0; index < contour.length; index++) {
      const point = contour[index];
      if (point.time <= noteOffset) onsetFrequency = point.frequency;
      else {
        if (index > 0) {
          const previous = contour[index - 1];
          const fraction = (noteOffset - previous.time) / (point.time - previous.time);
          onsetFrequency = previous.frequency + fraction * (point.frequency - previous.frequency);
        }
        break;
      }
    }
  }
  filter.type = 'lowpass';
  filter.frequency.value = 900 + tone * 6500;
  filter.Q.value = 0.5;
  filter.connect(gain);
  // A centered lead, kick and bass keep the core image stable. Optional stereo
  // placement is confined to backing voices and degrades to mono gracefully.
  const pan = Number.isFinite(event.pan) ? clamp(event.pan, -0.65, 0.65) : 0;
  if (!isMelody && event.track !== 'bass' && event.instrument !== 'Bass' && !(event.instrument === 'Drums' && event.midi === 36)
    && pan !== 0 && typeof context.createStereoPanner === 'function') {
    const panner = context.createStereoPanner();
    panner.pan.value = pan; gain.connect(panner); panner.connect(bus); voiceNodes.push(panner);
  } else gain.connect(bus);
  let attack = 0.008;
  let release = 0.3;
  let amplitude = velocity * 0.21;
  let sustain = 0.45;
  let clap = false;
  const oscillator = (type, ratio = 1, level = 1, detune = 0, destination = filter) => {
    const source = context.createOscillator();
    const partialGain = context.createGain();
    source.type = type;
    source.frequency.setValueAtTime(onsetFrequency * ratio, start);
    if (contour) for (const point of contour) {
      if (point.time > noteOffset) source.frequency.linearRampToValueAtTime(point.frequency * ratio, start + point.time - noteOffset);
    }
    source.detune.value = isMelody ? 0 : detune;
    partialGain.gain.value = level;
    source.connect(partialGain);
    partialGain.connect(destination);
    voiceSources.push(source);
    voiceNodes.push(source, partialGain);
    return source;
  };
  if (event.instrument === 'Drums') {
    attack = 0.002;
    release = 0.04;
    sustain = 0.04;
    if (event.midi === 36) {
      amplitude = velocity * 0.5;
      const kick = oscillator('sine');
      kick.frequency.setValueAtTime(135, start);
      kick.frequency.exponentialRampToValueAtTime(43, start + Math.min(duration, 0.16));
      filter.frequency.value = 800;
    } else {
      const source = context.createBufferSource();
      source.buffer = getNoise(context);
      source.connect(filter);
      voiceSources.push(source);
      voiceNodes.push(source);
      if (event.midi === 38) {
        const body = oscillator('triangle', 1, 0.32, 0, gain);
        body.frequency.setValueAtTime(185, start);
        body.frequency.exponentialRampToValueAtTime(135, start + Math.min(duration, 0.09));
        filter.type = 'bandpass'; filter.frequency.value = 2300; filter.Q.value = 0.65;
        amplitude = velocity * 0.42; release = 0.06;
      } else if (event.midi === 39) {
        filter.type = 'bandpass'; filter.frequency.value = 1450; filter.Q.value = 0.8;
        amplitude = velocity * 0.34; sustain = 0.015; release = 0.055; clap = true;
      } else {
        filter.type = 'highpass'; filter.frequency.value = event.midi === 46 ? 5800 : 7200;
        amplitude = velocity * (event.midi === 46 ? 0.23 : 0.19);
        release = event.midi === 46 ? 0.09 : 0.025;
        sustain = event.midi === 46 ? 0.04 : 0.008;
      }
    }
  } else if (event.instrument === 'Strings') {
    oscillator('sawtooth', 1, 0.38, -7);
    oscillator('sawtooth', 1, 0.38, 7);
    oscillator('triangle', 1, 0.24);
    attack = 0.15;
    release = 0.6;
    amplitude = velocity * 0.18;
    sustain = 0.86;
    filter.frequency.value = 1000 + tone * 3100;
  } else if (event.instrument === 'Acoustic Guitar') {
    // A rapid pluck with a decaying bright string attack. These are lightweight
    // synthesized approximations, not sampled acoustic instruments.
    oscillator('triangle', 1, 0.72);
    oscillator('sine', 2.001, 0.25);
    oscillator('sine', 3.003, 0.13);
    oscillator('sine', 4.006, 0.055);
    attack = 0.003; release = 0.16; sustain = 0.075; amplitude = velocity * 0.22;
    filter.frequency.setValueAtTime(2200 + tone * 4800, start);
    filter.frequency.exponentialRampToValueAtTime(650 + tone * 1100, start + Math.min(duration, 0.22));
  } else if (event.instrument === 'Violin') {
    oscillator('sawtooth', 1, 0.58);
    oscillator('triangle', 1, 0.3);
    oscillator('sine', 2, 0.12);
    attack = 0.095; release = 0.38; sustain = 0.83; amplitude = velocity * 0.17;
    filter.frequency.value = 1700 + tone * 3500;
    filter.Q.value = 0.85;
  } else if (event.instrument === 'Cello') {
    oscillator('sawtooth', 1, 0.35);
    oscillator('triangle', 1, 0.5);
    oscillator('sine', 2, 0.15);
    attack = 0.075; release = 0.42; sustain = 0.87; amplitude = velocity * 0.22;
    filter.frequency.value = 750 + tone * 1700;
    filter.Q.value = 0.7;
  } else if (event.instrument === 'Synthesizer') {
    if (!isMelody && event.timbre === 'pluck') {
      oscillator('sine', 1, 1);
      oscillator('sine', 2, 0.3);
      oscillator('sine', 3, 0.09);
      attack = 0.003; release = 0.055; sustain = 0.025; amplitude = velocity * 0.24;
      filter.frequency.setValueAtTime(1600 + tone * 5200, start);
      filter.frequency.exponentialRampToValueAtTime(500 + tone * 1200, start + Math.min(duration, 0.18));
    } else {
      oscillator('sawtooth', 1, 0.5, -4);
      oscillator('triangle', 1, 0.5, 4);
      attack = !isMelody && event.timbre === 'pad' ? 0.09 : 0.025;
      release = 0.23;
      amplitude = velocity * 0.2;
      sustain = 0.68;
      filter.frequency.value = 650 + tone * 5500;
    }
  } else if (event.instrument === 'Bass') {
    oscillator('triangle', 1, 0.6);
    oscillator('sine', 1, 0.4);
    release = 0.14;
    sustain = 0.7;
    amplitude = velocity * 0.28;
    filter.frequency.value = 450 + tone * 1200;
  } else {
    // Inharmonic partials and a short decay give the lightweight piano its struck character.
    oscillator('sine', 1, 1);
    oscillator('sine', 2.002, 0.25);
    oscillator('sine', 4.006, 0.07);
    sustain = 0.24;
  }
  attack = Math.min(attack, duration * 0.4, isMelody ? Math.min(0.008, duration * 0.08) : Infinity);
  if (clap) attack = Math.min(attack, duration / 12);
  const gateEnd = start + duration;
  const peak = start + attack;
  // Fade inside the captured gate: even Strings cannot smear into its next rest/note.
  const releaseStart = isMelody ? gateEnd - Math.min(0.012, duration * 0.15)
    : strictGate ? gateEnd - Math.min(0.003, duration * 0.15) : gateEnd;
  const decayEnd = Math.min(releaseStart, peak + Math.max(0.015, duration * 0.3));
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(Math.max(0.00001, amplitude), peak);
  if (clap) {
    const spacing = Math.min(0.018, duration / 5);
    for (let index = 1; index <= 2; index++) {
      gain.gain.exponentialRampToValueAtTime(Math.max(0.00001, amplitude * 0.08), start + index * spacing - spacing * 0.15);
      gain.gain.linearRampToValueAtTime(amplitude * (1 - index * 0.15), start + index * spacing);
    }
  }
  gain.gain.exponentialRampToValueAtTime(Math.max(0.00001, amplitude * sustain), Math.max(decayEnd, clap ? start + Math.min(0.036, duration * 0.4) : decayEnd));
  gain.gain.setValueAtTime(Math.max(0.00001, amplitude * sustain), releaseStart);
  if (isMelody || strictGate) gain.gain.linearRampToValueAtTime(0, gateEnd);
  else gain.gain.exponentialRampToValueAtTime(0.00001, gateEnd + release);
  let remaining = voiceSources.length;
  voiceSources.forEach(source => {
    source.onended = () => {
      if (--remaining === 0) voiceNodes.forEach(node => { try { node.disconnect(); } catch { /* Already disconnected. */ } });
    };
    source.start(start);
    source.stop(gateEnd + (strictGate ? 0 : isMelody ? 0.001 : release + 0.015));
    sources.push(source);
  });
  nodes.push(...voiceNodes);
}

// Playback and WAV export use this identical signal graph and scheduling path.
function scheduleArrangement(context, arrangement, startTime, offset = 0, recording = null) {
  const sources = [];
  const nodes = [];
  const bus = createBus(context, arrangement, nodes, startTime, offset);
  const layerBuses = new Map();
  try {
    if (usesRecording(arrangement)) makeRecordingVoice(context, recording, startTime, offset, arrangement.duration, bus.melody, sources, nodes);
    for (const event of arrangement.events) {
      const end = event.start + event.duration;
      if (end <= offset) continue;
      const layer = activeLayer(arrangement, event);
      if (mutedLayer(layer)) continue;
      const strictGate = arrangement.harmonyScope === 'anchored' && event.track !== 'melody' && event.instrument !== 'Drums';
      const relative = Math.max(0, event.start - offset);
      let voiceBus = event.track === 'melody' ? bus.melody
        : strictGate ? bus.anchored
        : event.track === 'bass' || event.instrument === 'Bass' ? bus.bass : event.instrument === 'Drums' ? bus.percussion : bus.backing;
      if (layer) {
        if (!layerBuses.has(layer.id)) {
          const layerBus = context.createGain();
          layerBus.gain.value = layer.gain;
          layerBus.connect(voiceBus);
          layerBuses.set(layer.id, layerBus);
          nodes.push(layerBus);
        }
        voiceBus = layerBuses.get(layer.id);
      }
      makeVoice(context, event, startTime + relative, end - Math.max(event.start, offset),
        voiceBus, sources, nodes, Math.max(0, offset - event.start), strictGate);
    }
  } catch (error) {
    sources.forEach(source => { try { source.stop(); } catch { /* May not have started. */ } });
    nodes.forEach(node => { try { node.disconnect(); } catch { /* Best effort cleanup. */ } });
    throw error;
  }
  return {
    stop() {
      sources.forEach(source => {
        source.onended = null;
        try { source.stop(context.currentTime); } catch { /* Source may have ended. */ }
      });
      nodes.forEach(node => { try { node.disconnect(); } catch { /* Already disconnected. */ } });
    },
  };
}

export class CompositionPlayer {
  constructor() {
    this.context = null;
    this.arrangement = null;
    this.offset = 0;
    this.startedAt = 0;
    this.graph = null;
    this.timer = null;
    this.generation = 0;
    this.state = 'stopped';
    this.callbacks = {};
    this.recording = null;
  }

  get status() { return this.state; }

  async play(arrangement, callbacks = {}) {
    const checked = checkedArrangement(arrangement);
    this.stop();
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Web Audio playback requires a supported browser.');
    if (!this.context || this.context.state === 'closed') this.context = new AudioContextClass();
    this.arrangement = checked;
    this.callbacks = callbacks;
    this.state = 'starting';
    const generation = this.generation;
    try {
      await this.context.resume();
      if (generation !== this.generation) return;
      const recording = await prepareRecording(this.context, checked, () => generation === this.generation && this.state === 'starting');
      if (generation !== this.generation || this.state !== 'starting') return;
      this.recording = recording;
      this.begin();
    } catch (error) {
      if (generation === this.generation) {
        this.clearPlayback();
        this.state = 'stopped';
      }
      throw error;
    }
  }

  begin() {
    this.startedAt = this.context.currentTime + 0.035;
    this.graph = scheduleArrangement(this.context, this.arrangement, this.startedAt, this.offset, this.recording);
    this.state = 'playing';
    const generation = this.generation;
    this.callbacks.onProgress?.(this.offset);
    if (generation !== this.generation || this.state !== 'playing') return;
    this.timer = setInterval(() => {
      if (generation !== this.generation || this.state !== 'playing') return;
      const elapsed = this.offset + Math.max(0, this.context.currentTime - this.startedAt);
      this.callbacks.onProgress?.(Math.min(this.arrangement.duration, elapsed));
      if (generation !== this.generation || this.state !== 'playing') return;
      if (elapsed >= this.arrangement.duration + TAIL_SECONDS) {
        const onEnded = this.callbacks.onEnded;
        this.clearPlayback();
        this.offset = 0;
        this.state = 'stopped';
        onEnded?.();
      }
    }, 50);
  }

  clearPlayback() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.graph?.stop();
    this.graph = null;
  }

  pause() {
    if (this.state !== 'playing' && this.state !== 'starting') return;
    if (this.state === 'playing') this.offset = Math.min(this.arrangement.duration, this.offset + Math.max(0, this.context.currentTime - this.startedAt));
    this.generation++;
    this.clearPlayback();
    this.state = 'paused';
    this.callbacks.onProgress?.(this.offset);
  }

  async resume() {
    if (this.state !== 'paused' || !this.arrangement) return;
    const generation = ++this.generation;
    await this.context.resume();
    if (generation !== this.generation || this.state !== 'paused') return;
    if (usesRecording(this.arrangement) && !this.recording) {
      const recording = await prepareRecording(this.context, this.arrangement, () => generation === this.generation && this.state === 'paused');
      if (generation !== this.generation || this.state !== 'paused') return;
      this.recording = recording;
    }
    this.begin();
  }

  stop() {
    this.generation++;
    this.clearPlayback();
    this.offset = 0;
    this.recording = null;
    this.state = 'stopped';
  }

  dispose() {
    this.stop();
    const context = this.context;
    this.context = null;
    this.arrangement = null;
    this.callbacks = {};
    if (context && context.state !== 'closed') context.close().catch(() => {});
  }
}

/** Turn rendered float samples into a standard signed 16-bit PCM WAV. */
export function encodeWav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const dataLength = length * channels * 2;
  const bytes = new ArrayBuffer(44 + dataLength);
  const view = new DataView(bytes);
  const write = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, dataLength, true);
  const samples = Array.from({ length: channels }, (_, channel) => audioBuffer.getChannelData(channel));
  let offset = 44;
  for (let index = 0; index < length; index++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = clamp(samples[channel][index], -1, 1);
      view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export async function exportWav(input) {
  const arrangement = checkedArrangement(input);
  const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error('Web Audio WAV export requires a supported browser.');
  const context = new OfflineContext(2, Math.ceil((arrangement.duration + TAIL_SECONDS) * SAMPLE_RATE), SAMPLE_RATE);
  const recording = await prepareRecording(context, arrangement);
  const graph = scheduleArrangement(context, arrangement, 0, 0, recording);
  try { return encodeWav(await context.startRendering()); }
  finally { graph.stop(); }
}

/** MIDI contains editable note data; synthesized effects belong to the WAV export. */
export function exportMidi(input) {
  const arrangement = checkedArrangement(input);
  if (usesRecording(arrangement)) throw new Error('MIDI cannot contain the protected original recording waveform. Use WAV export or explicitly choose an instrument lead.');
  const bpm = clamp(Number.isFinite(arrangement.bpm) && arrangement.bpm > 0 ? arrangement.bpm : 90, 40, 220);
  const ticksPerSecond = 480 * bpm / 60;
  const tempo = Math.round(60000000 / bpm);
  const messages = [{ tick: 0, order: 0, data: [0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] }];
  const programs = { Piano: 0, 'Acoustic Guitar': 24, Violin: 40, Cello: 42, Synthesizer: 80, Strings: 48, Bass: 32 };
  const channels = new Map();
  const availableChannels = Array.from({ length: 16 }, (_, channel) => channel).filter(channel => channel !== 9);
  for (const event of arrangement.events) {
    const layer = activeLayer(arrangement, event);
    if (mutedLayer(layer)) continue;
    // A backing note-off must never release a captured lead of the same pitch.
    const identity = event.track === 'melody' ? `melody:${event.instrument}` : event.layerId ? `layer:${event.layerId}` : `backing:${event.instrument}`;
    if (event.instrument !== 'Drums' && !channels.has(identity)) {
      if (!availableChannels.length) throw new Error('This MIDI arrangement needs more than 15 pitched instrument channels.');
      const channel = availableChannels.shift();
      channels.set(identity, channel);
      messages.push({ tick: 0, order: 0, data: [0xc0 + channel, programs[event.instrument] ?? 0] });
    }
    const channel = event.instrument === 'Drums' ? 9 : channels.get(identity);
    const midi = Math.round(event.midi);
    const start = Math.round(event.start * ticksPerSecond);
    messages.push({ tick: start, order: 2, data: [0x90 + channel, midi, clamp(Math.round((event.velocity ?? 0.7) * (layer?.gain ?? 1) * 127), 1, 127)] });
    messages.push({ tick: Math.max(start + 1, Math.round((event.start + event.duration) * ticksPerSecond)), order: 1, data: [0x80 + channel, midi, 0] });
  }
  messages.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const variableLength = number => {
    const result = [number & 127];
    while ((number >>= 7) > 0) result.unshift((number & 127) | 128);
    return result;
  };
  const track = [];
  let previous = 0;
  messages.forEach(message => { track.push(...variableLength(message.tick - previous), ...message.data); previous = message.tick; });
  track.push(0, 0xff, 0x2f, 0);
  const length = track.length;
  const header = [77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 224, 77, 84, 114, 107, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255];
  return new Blob([new Uint8Array(header), new Uint8Array(track)], { type: 'audio/midi' });
}

/** Estimated detected notes only: MIDI cannot represent the recorded voice or
 * its continuous sung contour. Exporting never changes the audible lead. */
export function exportMelodyMidi(notes, bpm = 90) {
  validateMelodyNotes(notes);
  return exportMidi({ bpm, duration: notes.reduce((end, note) => Math.max(end, note.start + note.duration), 0),
    events: notes.map(note => ({ ...note, track: 'melody', instrument: 'Piano', velocity: 0.7 })),
  });
}
