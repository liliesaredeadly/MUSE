const TAIL_SECONDS = 1.6;
const SAMPLE_RATE = 44100;
const noiseBuffers = new WeakMap();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function checkedArrangement(arrangement) {
  const events = Array.isArray(arrangement?.events) ? arrangement.events.filter(event => event &&
    Number.isFinite(event.midi) && event.midi >= 0 && event.midi <= 127 &&
    Number.isFinite(event.start) && event.start >= 0 && Number.isFinite(event.duration) && event.duration > 0) : [];
  if (!events.length) throw new Error('No notes to play. Record a melody first.');
  const duration = events.reduce((end, event) => Math.max(end, event.start + event.duration), Number.isFinite(arrangement.duration) ? arrangement.duration : 0);
  if (duration > 600 || events.length > 20000) throw new Error('This composition is too long to render in the browser.');
  return { ...arrangement, events, duration };
}

function getNoise(context) {
  if (noiseBuffers.has(context)) return noiseBuffers.get(context);
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.35), context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 741;
  for (let index = 0; index < data.length; index++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    data[index] = seed / 2147483648 - 1;
  }
  noiseBuffers.set(context, buffer);
  return buffer;
}

function createBus(context, arrangement, nodes) {
  const input = context.createGain();
  const master = context.createGain();
  const compressor = context.createDynamicsCompressor();
  master.gain.value = 0.74;
  compressor.threshold.value = -13;
  compressor.knee.value = 16;
  compressor.ratio.value = 5;
  input.connect(compressor);
  compressor.connect(master);
  master.connect(context.destination);
  nodes.push(input, master, compressor);
  const mood = String(arrangement.settings?.mood || '').toLowerCase();
  const wet = /dreamy/.test(mood) ? 0.23 : /cinematic/.test(mood) ? 0.27 : /peaceful/.test(mood) ? 0.16 : 0.08;
  const delay = context.createDelay(1);
  const feedback = context.createGain();
  const effectGain = context.createGain();
  delay.delayTime.value = clamp(30 / (arrangement.bpm || 90), 0.13, 0.5);
  feedback.gain.value = 0.23;
  effectGain.gain.value = wet;
  input.connect(delay);
  delay.connect(effectGain);
  effectGain.connect(compressor);
  delay.connect(feedback);
  feedback.connect(delay);
  nodes.push(delay, feedback, effectGain);
  return input;
}

function makeVoice(context, event, start, duration, bus, sources, nodes) {
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  const voiceNodes = [gain, filter];
  const voiceSources = [];
  const velocity = clamp(Number.isFinite(event.velocity) ? event.velocity : 0.7, 0, 1);
  const tone = clamp(Number.isFinite(event.tone) ? event.tone : 0.6, 0, 1);
  const frequency = 440 * 2 ** ((event.midi - 69) / 12);
  filter.type = 'lowpass';
  filter.frequency.value = 900 + tone * 6500;
  filter.Q.value = 0.5;
  filter.connect(gain);
  gain.connect(bus);
  let attack = 0.008;
  let release = 0.3;
  let amplitude = velocity * 0.21;
  let sustain = 0.45;
  const oscillator = (type, ratio = 1, level = 1, detune = 0) => {
    const source = context.createOscillator();
    const partialGain = context.createGain();
    source.type = type;
    source.frequency.setValueAtTime(frequency * ratio, start);
    source.detune.value = detune;
    partialGain.gain.value = level;
    source.connect(partialGain);
    partialGain.connect(filter);
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
      filter.type = 'highpass';
      filter.frequency.value = event.midi === 38 ? 1000 : 6500;
      amplitude = velocity * (event.midi === 38 ? 0.45 : 0.28);
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
  } else if (event.instrument === 'Synthesizer') {
    oscillator('sawtooth', 1, 0.5, -4);
    oscillator('triangle', 1, 0.5, 4);
    attack = 0.025;
    release = 0.23;
    amplitude = velocity * 0.2;
    sustain = 0.68;
    filter.frequency.value = 650 + tone * 5500;
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
  attack = Math.min(attack, duration * 0.4);
  const gateEnd = start + duration;
  const peak = start + attack;
  const decayEnd = Math.min(gateEnd, peak + Math.max(0.015, duration * 0.3));
  gain.gain.setValueAtTime(0.00001, start);
  gain.gain.linearRampToValueAtTime(Math.max(0.00001, amplitude), peak);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.00001, amplitude * sustain), decayEnd);
  gain.gain.setValueAtTime(Math.max(0.00001, amplitude * sustain), gateEnd);
  gain.gain.exponentialRampToValueAtTime(0.00001, gateEnd + release);
  let remaining = voiceSources.length;
  voiceSources.forEach(source => {
    source.onended = () => {
      if (--remaining === 0) voiceNodes.forEach(node => { try { node.disconnect(); } catch { /* Already disconnected. */ } });
    };
    source.start(start);
    source.stop(gateEnd + release + 0.015);
    sources.push(source);
  });
  nodes.push(...voiceNodes);
}

// Playback and WAV export use this identical signal graph and scheduling path.
function scheduleArrangement(context, arrangement, startTime, offset = 0) {
  const sources = [];
  const nodes = [];
  const bus = createBus(context, arrangement, nodes);
  try {
    for (const event of arrangement.events) {
      const end = event.start + event.duration;
      if (end <= offset) continue;
      const relative = Math.max(0, event.start - offset);
      makeVoice(context, event, startTime + relative, end - Math.max(event.start, offset), bus, sources, nodes);
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
    this.graph = scheduleArrangement(this.context, this.arrangement, this.startedAt, this.offset);
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
    this.begin();
  }

  stop() {
    this.generation++;
    this.clearPlayback();
    this.offset = 0;
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
  const graph = scheduleArrangement(context, arrangement, 0);
  try { return encodeWav(await context.startRendering()); }
  finally { graph.stop(); }
}

/** MIDI contains editable note data; synthesized effects belong to the WAV export. */
export function exportMidi(input) {
  const arrangement = checkedArrangement(input);
  const bpm = clamp(Number.isFinite(arrangement.bpm) && arrangement.bpm > 0 ? arrangement.bpm : 90, 40, 220);
  const ticksPerSecond = 480 * bpm / 60;
  const tempo = Math.round(60000000 / bpm);
  const messages = [{ tick: 0, order: 0, data: [0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] }];
  const programs = { Piano: 0, Synthesizer: 80, Strings: 48, Bass: 32 };
  const channels = { Piano: 0, Synthesizer: 1, Strings: 2, Bass: 3, Drums: 9 };
  Object.entries(programs).forEach(([instrument, program]) => messages.push({ tick: 0, order: 0, data: [0xc0 + channels[instrument], program] }));
  for (const event of arrangement.events) {
    const channel = channels[event.instrument] ?? 0;
    const midi = Math.round(event.midi);
    const start = Math.round(event.start * ticksPerSecond);
    messages.push({ tick: start, order: 2, data: [0x90 + channel, midi, clamp(Math.round((event.velocity ?? 0.7) * 127), 1, 127)] });
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
