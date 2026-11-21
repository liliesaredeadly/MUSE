// Entire waveforms are generated from handwritten note schedules. No microphone
// recording, reference song, or production pitch detector defines the answers.
export const frequency = midi => 440 * 2 ** ((midi - 69) / 12);

export function makeHum(notes, { sampleRate = 48000, duration, amplitude = 0.08,
  harmonics = [1, 0.3, 0.12], breath = 0, seed = 42 } = {}) {
  const seconds = duration ?? Math.max(0, ...notes.map(note => note.start + note.duration)) + 0.15;
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  let phase = 0;
  for (let index = 0; index < samples.length; index++) {
    const time = index / sampleRate;
    const note = notes.find(value => time >= value.start && time < value.start + value.duration);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 4294967296 * 2 - 1) * breath;
    if (!note) { samples[index] = noise; continue; }
    const local = time - note.start;
    const cents = (note.vibrato ?? 0) * Math.sin(2 * Math.PI * (note.vibratoRate ?? 5) * local)
      + (note.glide ?? 0) * local / note.duration;
    phase += 2 * Math.PI * frequency(note.midi) * 2 ** (cents / 1200) / sampleRate;
    const envelope = Math.min(1, local / 0.004, (note.duration - local) / 0.004);
    samples[index] = amplitude * envelope * harmonics.reduce((sum, strength, harmonic) => sum + strength * Math.sin(phase * (harmonic + 1)), 0) + noise;
  }
  return { samples, sampleRate, notes, duration: seconds };
}

export const FIXTURES = {
  irregular: () => makeHum([
    { midi: 57, start: 0.17, duration: 0.23 },
    { midi: 60, start: 0.48, duration: 0.17 },
    { midi: 64, start: 0.65, duration: 0.31 },
    { midi: 62, start: 1.11, duration: 0.19 },
    { midi: 55, start: 1.34, duration: 0.26 },
  ]),
  fast: () => makeHum([
    { midi: 60, start: 0.2, duration: 0.08 },
    { midi: 62, start: 0.28, duration: 0.12 },
    { midi: 64, start: 0.4, duration: 0.08 },
    { midi: 65, start: 0.48, duration: 0.12 },
    { midi: 67, start: 0.6, duration: 0.08 },
    { midi: 64, start: 0.68, duration: 0.12 },
  ]),
  repeated: () => makeHum([
    { midi: 60, start: 0.2, duration: 0.3 },
    { midi: 60, start: 0.54, duration: 0.3 },
    { midi: 64, start: 0.9, duration: 0.3 },
  ]),
  breathy: () => makeHum([
    { midi: 50, start: 0.2, duration: 0.3 },
    { midi: 55, start: 0.57, duration: 0.25 },
    { midi: 57, start: 0.89, duration: 0.3 },
  ], { amplitude: 0.003, breath: 0.003 }),
  contour: () => makeHum([
    { midi: 57, start: 0.2, duration: 0.8, vibrato: 25, vibratoRate: 5 },
    { midi: 60, start: 1.12, duration: 0.6, glide: 35 },
  ]),
  weakFundamental: () => makeHum([
    { midi: 50, start: 0.2, duration: 0.24 },
    { midi: 53, start: 0.5, duration: 0.24 },
    { midi: 57, start: 0.8, duration: 0.24 },
  ], { harmonics: [0.18, 1, 0.45, 0.12] }),
};
