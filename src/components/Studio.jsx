import React from 'react';
import { ArrowDownToLine, AudioLines, ChevronDown, Circle, Headphones, Layers2, LoaderCircle, Mic2, Pause, Play, RotateCcw, Save, ShieldCheck, SlidersHorizontal, Square, WandSparkles } from 'lucide-react';
import Waveform from './Waveform.jsx';
import Timeline from './Timeline.jsx';
import Producer from './Producer.jsx';

export const moods = ['Dreamy', 'Cinematic', 'Melancholic', 'Energetic', 'Peaceful'];
export const genres = ['Electronic', 'Ambient', 'Classical', 'Pop', 'Experimental'];
export const instruments = ['Piano', 'Synthesizer', 'Strings', 'Bass', 'Drums'];
export const timeLabel = value => `${Math.floor((value || 0) / 60).toString().padStart(2, '0')}:${Math.floor((value || 0) % 60).toString().padStart(2, '0')}`;

function CapturePanel({ studio }) {
  const { capture, elapsed, pitch, project } = studio;
  const recording = capture === 'recording';
  const paused = capture === 'paused';
  const pending = capture === 'requesting' || capture === 'stopping';
  const blocked = pending || studio.saving;
  const hasNotes = project.notes.length > 0;
  const status = recording ? 'Recording' : paused ? 'Paused' : capture === 'requesting' ? 'Connecting microphone' : capture === 'stopping' ? 'Finishing take' : hasNotes ? 'Take captured' : 'Ready to record';
  return <section className={`panel recorder-panel ${recording ? 'recording' : ''}`} aria-labelledby="input-heading">
    <div className="panel-heading"><span className="panel-icon"><Mic2 size={17} /></span><h2 id="input-heading">Audio input</h2><span className="input-mode">MONO</span><span className={`capture-status ${recording ? 'is-live' : ''}`}><span className="capture-dot" />{status}</span></div>
    <div className="input-console">
      <div className="input-identity"><button className={`microphone-orb ${recording ? 'listening' : ''}`} disabled={blocked || paused} aria-label={recording ? 'Stop microphone recording' : 'Start microphone recording'} onClick={recording ? studio.stopRecording : studio.startRecording}>{pending ? <LoaderCircle size={24} className="spin" /> : recording ? <Square size={21} fill="currentColor" /> : <Mic2 size={26} strokeWidth={1.6} />}</button><span>MIC IN</span></div>
      <div className="input-display"><div className="input-display-heading"><div><h3>{recording ? 'Recording your melody' : paused ? 'Recording paused' : pending ? status : hasNotes ? 'Your original melody' : 'Capture your melody'}</h3><p>{recording ? 'Keep humming, one clear note at a time.' : paused ? 'Resume the take, or finish when you’re ready.' : capture === 'requesting' ? 'Allow microphone access in your browser.' : capture === 'stopping' ? 'Finalising the recording and detected notes.' : hasNotes ? 'Review the notes below or record a new take.' : 'Hum, sing or whistle a short phrase.'}</p></div><div className="recording-timer" aria-label={`${timeLabel(elapsed)} recorded`}>{timeLabel(elapsed)}<span className="timer-fraction">.{Math.floor((elapsed || 0) * 10) % 10}</span><small> / 01:00</small></div></div>
        <div className="waveform-wrap"><Waveform frameRef={studio.frameRef} active={recording} paused={!recording} /><div className="waveform-labels"><span>{recording ? <><span className="status-dot" /> LIVE INPUT</> : 'INPUT WAVEFORM'}</span><span className="detected-pitch">{recording && pitch ? <><strong>{pitch.name}</strong>{Math.round(pitch.frequency)} Hz</> : recording ? 'Listening for a clear pitch…' : 'Single voice · approximate pitch detection'}</span></div></div>
      </div>
    </div>
    <div className="record-controls"><div className="record-actions">{recording || paused ? <><button className="button subtle" onClick={studio.pauseRecording}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? 'Resume recording' : 'Pause recording'}</button><button className="button recording-stop" onClick={studio.stopRecording}><Square size={12} fill="currentColor" />Finish take</button></> : <button className="button primary" disabled={blocked} onClick={studio.startRecording}>{pending ? <LoaderCircle size={15} className="spin" /> : hasNotes ? <RotateCcw size={15} /> : <Circle size={11} fill="currentColor" />}{capture === 'stopping' ? 'Finishing take…' : capture === 'requesting' ? 'Connecting…' : hasNotes ? 'Record a new take' : 'Record your melody'}</button>}{capture === 'requesting' && <button className="button subtle" onClick={studio.cancelRecordingRequest}>Cancel request</button>}</div><span className="capture-hint"><ShieldCheck size={13} />Audio stays on this device</span></div>
    {studio.audioUrl && !studio.busy && <div className="original-recording"><span><Mic2 size={13} />Original take</span><audio ref={studio.audioRef} controls src={studio.audioUrl} preload="metadata" onPlay={studio.stopCompositionOnly} aria-label="Original microphone recording" /></div>}
  </section>;
}

function CreativeControls({ settings, change, disabled }) {
  return <section className="panel creative-panel" aria-labelledby="sound-heading">
    <div className="panel-heading"><span className="panel-icon"><SlidersHorizontal size={17} /></span><h2 id="sound-heading">Sound & arrangement</h2><span className="panel-hint">Shape the captured melody</span></div>
    <div className="creative-body">
      <fieldset className="mood-field" disabled={disabled}><legend>MOOD</legend><div className="mood-options">{moods.map((mood, index) => <button type="button" aria-pressed={settings.mood === mood} className={`mood-button ${settings.mood === mood ? 'selected' : ''}`} key={mood} onClick={() => change({ mood })}><span aria-hidden="true">{['✧', '◈', '☾', 'ϟ', '〰'][index]}</span>{mood}</button>)}</div></fieldset>
      <div className="creative-selects">
        <label className="field"><span>GENRE</span><div className="select-wrap"><select value={settings.genre} disabled={disabled} onChange={event => change({ genre: event.target.value })}>{genres.map(genre => <option key={genre}>{genre}</option>)}</select><ChevronDown size={14} /></div></label>
        <label className="field"><span>LEAD INSTRUMENT</span><div className="select-wrap"><select value={settings.instrument} disabled={disabled} onChange={event => change({ instrument: event.target.value })}>{instruments.map(instrument => <option key={instrument}>{instrument}</option>)}</select><ChevronDown size={14} /></div></label>
        <label className="field tempo-field"><span>TEMPO<strong>{settings.bpm}<small>BPM</small></strong></span><input aria-label="Composition tempo in BPM" type="range" min="40" max="200" step="1" value={settings.bpm} disabled={disabled} onChange={event => change({ bpm: Number(event.target.value) })} /></label>
      </div>
      <div className="layer-controls"><label><input type="checkbox" checked={settings.accompaniment} disabled={disabled} onChange={event => change({ accompaniment: event.target.checked })} /><Layers2 size={15} />Chord accompaniment</label><label><input type="checkbox" checked={settings.percussion} disabled={disabled} onChange={event => change({ percussion: event.target.checked })} /><AudioLines size={15} />Percussion</label></div>
      {settings.instrument === 'Drums' && <p className="control-note">Drums adds a beat; a pitched synth preserves your hummed melody.</p>}
    </div>
  </section>;
}

export default function Studio({ studio }) {
  const { project, busy, arrangement, transport, position } = studio;
  const playing = transport === 'playing';
  return <>
    <div className="studio-title"><div className="session-project"><span className="eyebrow">MUSIC STUDIO <span className="slash">/</span> SESSION</span><h1 className="sr-only">Music studio</h1><div className="title-edit"><label className="sr-only" htmlFor="project-title">Project title</label><input id="project-title" aria-label="Project title" maxLength={80} value={project.title} placeholder="Untitled melody" disabled={busy} onChange={event => studio.rename(event.target.value)} /><span className={`unsaved-label ${studio.dirty ? 'is-dirty' : ''}`}>{studio.dirty ? 'Unsaved changes' : 'Local session'}</span></div></div><div className="title-actions"><button className="button subtle" disabled={!project.notes.length || busy || studio.saving} onClick={studio.save}>{studio.saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}Save project</button><button className="button subtle export-button" disabled={!arrangement || busy || studio.exporting} onClick={studio.download}>{studio.exporting ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}{studio.exporting ? 'Rendering…' : 'Export WAV'}</button></div></div>
    <div className="studio-grid"><div className="studio-work">
      <CapturePanel studio={studio} />
      <Timeline key={project.id} notes={project.notes} arrangement={arrangement} position={position} updateNote={studio.updateNote} busy={busy} />
      <CreativeControls settings={project.settings} change={studio.changeSettings} disabled={busy || studio.arranging} />
      <section className={`panel playback-panel ${arrangement ? 'has-arrangement' : ''}`} aria-label="Composition transport"><div className="playback-info"><div className="playback-icon"><Headphones size={20} /></div><div><h3>{studio.arranging ? 'Building arrangement…' : arrangement ? 'Composition ready' : 'Composition transport'}</h3><p>{arrangement ? `${project.settings.instrument} · ${project.settings.mood}` : project.notes.length ? 'Create an arrangement from your captured melody.' : 'Record a melody to enable playback.'}</p></div></div>{!arrangement ? <button className="button primary" disabled={!project.notes.length || busy || studio.arranging} onClick={studio.generate}>{studio.arranging ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />}{studio.arranging ? 'Arranging…' : 'Create arrangement'}</button> : <div className="transport-controls"><span className="transport-tempo">{project.settings.bpm}<small>BPM</small></span><span className="transport-time">{timeLabel(position)}<span> / {timeLabel(arrangement.duration)}</span></span><button className="icon-button transport-stop" disabled={transport === 'stopped' || busy} aria-label="Stop composition" onClick={studio.stopPlayback}><Square size={15} /></button><button className="play-button" disabled={busy || studio.arranging} aria-label={playing ? 'Pause composition' : transport === 'paused' ? 'Resume composition' : 'Play composition'} onClick={playing ? studio.pausePlayback : studio.play}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button></div>}{arrangement && <div className="playback-progress"><div style={{ width: `${Math.min(100, position / arrangement.duration * 100)}%` }} /></div>}</section>
      <p className="studio-limits">{arrangement?.description || 'Single-voice pitch recognition is approximate. Record in a quiet room; all instrument sounds are synthesised.'}</p>
    </div><Producer key={project.id} settings={project.settings} analysis={{ notes: project.notes, key: arrangement?.key }} hasNotes={project.notes.length > 0} busy={busy || studio.arranging} apply={changes => { studio.changeSettings(changes); studio.notify('Producer direction applied to your sound settings.'); }} /></div>
  </>;
}

export function HumExperience({ studio, onOpenStudio }) {
  return <div className="hum-experience">
    <div className="page-title hum-heading"><div><span className="eyebrow">A SMALL SOUND. A NEW BEGINNING.</span><h1>It starts with <em>your voice.</em></h1><p>Hum the idea before it disappears. The notes take shape as you record.</p></div><span className="hum-heading-mark" aria-hidden="true">✳</span></div>
    <div className="hum-atmosphere"><CapturePanel studio={studio} /></div>
    <div className="hum-details"><div className="hum-analysis"><Timeline key={studio.project.id} notes={studio.project.notes} arrangement={studio.arrangement} position={studio.position} updateNote={studio.updateNote} busy={studio.busy} /><p className="studio-limits">Pitch analysis runs live. One clear voice in a quiet room works best.</p></div><div className="hum-next"><span className="eyebrow">THEN, MAKE IT YOURS</span><h2>A melody is<br />only the beginning.</h2><p>Bring these notes into the studio. Add chords, choose your instruments and hear a new arrangement.</p><button className="button primary" disabled={studio.busy} onClick={onOpenStudio}><SlidersHorizontal size={16} />Open music studio</button><div className="upload-boundary"><ArrowDownToLine size={17} /><div><strong>Audio file import</strong><span>Planned for a future release. Microphone capture is available now.</span></div></div></div></div>
  </div>;
}
