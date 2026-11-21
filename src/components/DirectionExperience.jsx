import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import ProductionDirector from './ProductionDirector.jsx';

/** Draws the original take when available; reopened projects use their actual note contour. */
export function MelodyPreview({ audioUrl, notes, label = 'Original take' }) {
  const [waveform, setWaveform] = useState(null);
  useEffect(() => {
    if (!audioUrl || !window.OfflineAudioContext) return;
    let current = true;
    const controller = new AbortController();
    async function decode() {
      try {
        const response = await fetch(audioUrl, { signal: controller.signal });
        const bytes = await response.arrayBuffer();
        const context = new window.OfflineAudioContext(1, 1, 44100);
        const buffer = await context.decodeAudioData(bytes);
        const samples = buffer.getChannelData(0);
        const bars = Array.from({ length: 144 }, (_, index) => {
          const start = Math.floor(index * samples.length / 144);
          const end = Math.floor((index + 1) * samples.length / 144);
          let energy = 0;
          for (let sample = start; sample < end; sample++) energy += samples[sample] * samples[sample];
          return Math.sqrt(energy / Math.max(1, end - start));
        });
        const maximum = Math.max(...bars, 0.0001);
        if (current) setWaveform({ url: audioUrl, bars: bars.map(value => value / maximum), duration: buffer.duration });
      } catch { /* Note data remains an honest visual fallback if decoding is unavailable. */ }
    }
    decode();
    return () => { current = false; controller.abort(); };
  }, [audioUrl]);
  const take = waveform?.url === audioUrl ? waveform : null;
  const duration = take?.duration ?? notes.reduce((end, note) => Math.max(end, note.start + note.duration), 0);
  const pitches = notes.map(note => note.midi);
  const low = Math.min(...pitches, 60);
  const high = Math.max(...pitches, low + 12);
  return <div className="direction-melody-preview">
    <svg viewBox="0 0 640 110" role="img" aria-label={take ? `${label} waveform` : notes.length ? `Detected melody note contour, ${notes.length} notes` : audioUrl ? 'Audio waveform loading or unavailable' : 'No melody recorded'}>
      {take ? take.bars.map((value, index) => <rect key={index} x={index * 640 / 144} y={55 - value * 47} width="3.2" height={Math.max(1, value * 94)} rx="1" />)
        : notes.length ? notes.map((note, index) => <rect key={index} x={note.start / Math.max(duration, 0.1) * 632} y={88 - (note.midi - low) / (high - low) * 68} width={Math.max(2, note.duration / Math.max(duration, 0.1) * 632)} height="5" rx="1" />)
          : <path d="M0 55H640" />}
    </svg>
    <div><span>{take ? label : notes.length ? 'Detected note contour' : audioUrl ? 'Audio waveform loading or unavailable' : 'Record a melody to begin'}</span><span>{duration > 0 ? `${duration.toFixed(1)} sec` : audioUrl ? 'Duration available in player' : 'No captured notes'}</span></div>
  </div>;
}

export default function DirectionExperience({ studio, onOpenStudio, onRecord }) {
  const { project, busy, arranging } = studio;
  const hasNotes = studio.hasMelody ?? project.notes.length > 0;
  function applyAndContinue(changes) {
    if (busy || arranging) return;
    studio.changeSettings(changes);
    if (hasNotes) {
      studio.generate();
      studio.notify('Direction applied. Creating an arrangement from your melody.');
      onOpenStudio();
    } else {
      studio.notify('Your sound is set for the next recording.');
      onRecord();
    }
  }
  function useCurrentSound() {
    if (!hasNotes || busy || arranging) return;
    studio.generate();
    onOpenStudio();
  }
  return <section className="reference-direction" aria-label="Shape your musical direction">
    <div className="direction-breadcrumb"><span>02 / PRODUCER BRAIN</span><span>YOUR MELODY. A NEW DIRECTION.</span></div>
    <ProductionDirector key={project.id} layout="direction" settings={project.settings}
      analysis={{ notes: project.notes, key: studio.arrangement?.key, sourceId: studio.captureSummary?.receipt?.sha256 }}
      analysisPreview={<MelodyPreview audioUrl={studio.audioUrl} notes={project.notes} />}
      hasNotes={hasNotes} busy={busy || arranging} arrangement={studio.arrangement} apply={applyAndContinue} />
    <div className="direction-page-actions">
      <button type="button" disabled={busy || arranging} onClick={onRecord}><ArrowLeft size={13} />Back to recording</button>
      {hasNotes && <button type="button" disabled={busy || arranging} onClick={useCurrentSound}>Use current sound<ArrowRight size={14} /></button>}
    </div>
  </section>;
}
