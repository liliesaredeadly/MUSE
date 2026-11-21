import { api } from '../src/lib/api.js';
import { exportWav } from '../src/audio/synth.js';
import { decodePcmWav } from '../src/audio/pcm-wav.js';
import { planProduction } from '../src/producer/production-blueprint.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const round = value => Math.round(value * 1e6) / 1e6;
const decode = async blob => new OfflineAudioContext(2, 1, 44100).decodeAudioData(await blob.arrayBuffer());
function metrics(buffer) {
  let sum = 0; let peak = 0; let clipped = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) for (const value of buffer.getChannelData(ch)) {
    assert(Number.isFinite(value), 'Nonfinite rendered audio.'); sum += value * value; peak = Math.max(peak, Math.abs(value));
    if (Math.abs(value) >= .999) clipped++;
  }
  return { rms: round(Math.sqrt(sum / (buffer.length * buffer.numberOfChannels))), peak: round(peak), clipped,
    duration: buffer.length / buffer.sampleRate };
}
document.getElementById('run').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  const output = document.getElementById('results');
  const results = []; let extracted; let arrangement; let source;
  const show = current => { output.textContent = JSON.stringify({ status: current ? 'running' : results.every(item => item.passed) ? 'passed' : 'failed', current,
    passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, results }, null, 2); };
  async function check(name, run) {
    show(name);
    try { results.push({ name, passed: true, metrics: await run() }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  }
  try {
    await check('Real source-bound analysis recovers supported harmonic anchors', async () => {
      let file = document.getElementById('take').files[0];
      const localPath = document.documentElement.getAttribute('data-local-recording');
      if (!file && localPath) {
        assert(/^\/\.local\/audio-diagnostics\/[a-zA-Z0-9_-]+\.wav$/.test(localPath), 'Use an explicitly named local diagnostic WAV.');
        const response = await fetch(localPath); assert(response.ok, 'The local diagnostic recording is unavailable.');
        file = new File([await response.blob()], 'local-verification-take.wav', { type: 'audio/wav' });
      }
      assert(file, 'Choose the actual local take first.');
      extracted = await api.analyzeRecording(file, 60, { strictDuration: true });
      assert(extracted.analysis.harmonicEvidence?.anchors.length >= 3, 'No independent harmonic anchors recovered.');
      assert(extracted.quality?.canHarmonize === true || extracted.analysis.quality?.canHarmonize === true, 'Evidence still cannot support backing.');
      source = { blob: file, duration: extracted.receipt.duration, notes: structuredClone(extracted.analysis.notes),
        receipt: extracted.receipt, audioWav: extracted.audioWav, conditioningId: extracted.conditioningId };
      const blueprint = planProduction('Use only acoustic guitar, piano and strings', { accompaniment: false, bass: false });
      arrangement = await api.arrange(source.notes, { bpm: 114, sourceBpm: 114, leadSource: 'recording', preserveMelodyTiming: true,
        mood: 'Dreamy', genre: 'Pop', blueprint }, source.conditioningId, source);
      assert(arrangement.recordingLead.sha256 === extracted.receipt.sha256, 'Original source changed.');
      assert(arrangement.events.every(item => item.track !== 'melody'), 'A synthetic tune was substituted for the original hum.');
      return { duration: extracted.receipt.duration, noteCount: source.notes.length, voicedRatio: extracted.analysis.voicedRatio,
        anchorCount: extracted.analysis.harmonicEvidence.anchors.length, quality: arrangement.transcriptionQuality?.status,
        harmonyScope: arrangement.harmonyScope, layerEvents: Object.fromEntries(['guitar', 'piano', 'violin', 'cello'].map(id => [id, arrangement.events.filter(item => item.layerId === id).length])) };
    });
    if (arrangement) {
      for (const id of ['guitar', 'piano', 'violin', 'cello']) await check(`${id} has actual nonzero native audio`, async () => {
        const events = arrangement.events.filter(item => item.layerId === id);
        assert(events.length, `No supported events for ${id}.`);
        const pcm = await decode(await exportWav({ ...arrangement, settings: { ...arrangement.settings, leadSource: 'instrument' }, events }));
        const measured = metrics(pcm); assert(measured.rms > .0008 && measured.clipped === 0, `${id} is too quiet or clips.`);
        return measured;
      });
      await check('Original whole-wave lead remains aligned and unchanged by the backing', async () => {
        const normalized = decodePcmWav(new Uint8Array(await extracted.audioWav.arrayBuffer()));
        const context = new OfflineAudioContext(1, Math.ceil(normalized.duration * 44100), 44100);
        const buffer = context.createBuffer(1, normalized.samples.length, normalized.sampleRate); buffer.getChannelData(0).set(normalized.samples);
        const voice = context.createBufferSource(); voice.buffer = buffer; voice.playbackRate.value = 1; voice.connect(context.destination); voice.start();
        const baseline = (await context.startRendering()).getChannelData(0);
        const lead = await decode(await exportWav({ ...arrangement, events: [] }));
        const rendered = lead.getChannelData(0); const edge = Math.ceil(.01 * 44100);
        let dot = 0; let inputEnergy = 0; let outputEnergy = 0;
        for (let i = edge; i < baseline.length - edge; i++) { dot += baseline[i] * rendered[i]; inputEnergy += baseline[i] ** 2; outputEnergy += rendered[i] ** 2; }
        const correlation = dot / Math.sqrt(inputEnergy * outputEnergy); const gain = dot / inputEnergy;
        assert(correlation > .9999 && gain > 0 && gain <= 8 * .74 + .001, 'Original waveform or clock changed.');
        const mixBlob = await exportWav(arrangement);
        const mix = metrics(await decode(mixBlob));
        assert(mix.clipped === 0 && mix.peak < .98 && mix.duration >= normalized.duration, 'The mix clips or truncates the source.');
        let download = document.getElementById('fixed-wav');
        if (!download) { download = document.createElement('a'); download.id = 'fixed-wav'; download.textContent = 'Download fixed hum with guitar, piano and strings'; document.body.append(download); }
        if (download.dataset.objectUrl) URL.revokeObjectURL(download.dataset.objectUrl);
        download.href = URL.createObjectURL(mixBlob); download.dataset.objectUrl = download.href;
        download.download = 'MUSE-fixed-hum-guitar-piano-strings.wav';
        return { zeroLagCorrelation: round(correlation), constantGainIncludingMaster: round(gain), originalDuration: normalized.duration,
          noSyntheticMelody: true, playbackRate: 1, fullMix: mix,
          limitation: 'This verifies the retained waveform and real backing audio, not perfect human transcription or subjective harmony quality.' };
      });
      if (arrangement.harmonyScope === 'anchored') await check('Pitched backing stays silent outside confirmed source regions', async () => {
        const pcm = await decode(await exportWav({ ...arrangement, settings: { ...arrangement.settings, leadSource: 'instrument' },
          events: arrangement.events.filter(item => item.instrument !== 'Drums') }));
        let outsidePeak = 0; let outsideEnergy = 0; let outsideCount = 0;
        for (let i = 0; i < pcm.length; i++) {
          const time = i / pcm.sampleRate;
          if (arrangement.harmonyRegions.some(region => time >= region.start && time <= region.start + region.duration)) continue;
          for (let ch = 0; ch < pcm.numberOfChannels; ch++) {
            const value = pcm.getChannelData(ch)[i]; outsidePeak = Math.max(outsidePeak, Math.abs(value)); outsideEnergy += value ** 2; outsideCount++;
          }
        }
        assert(outsidePeak < 2 / 32768, 'Instrument tails or effects leaked into unsupported source gaps.');
        return { outsidePeak: round(outsidePeak), outsideRms: round(Math.sqrt(outsideEnergy / Math.max(1, outsideCount))), samplesChecked: outsideCount };
      });
    }
  } finally { button.disabled = false; show(null); }
});
