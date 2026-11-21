import React from 'react';
import { ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown, Circle, Layers2, LoaderCircle, Mic2, Pause, Play, RotateCcw, Save, ShieldCheck, SlidersHorizontal, Sparkles, Square, WandSparkles } from 'lucide-react';
import Waveform from './Waveform.jsx';
import Timeline from './Timeline.jsx';
import ProductionDirector from './ProductionDirector.jsx';
import { MelodyPreview } from './DirectionExperience.jsx';
import ReferenceMatch from './ReferenceMatch.jsx';
import MusicGenJobPanel from './MusicGenJobPanel.jsx';

export const moods = ['Dreamy', 'Cinematic', 'Melancholic', 'Energetic', 'Peaceful'];
export const genres = ['Electronic', 'Ambient', 'Classical', 'Pop', 'Experimental'];
export const instruments = ['Piano', 'Synthesizer', 'Strings', 'Bass', 'Drums'];
export const timeLabel = value => `${Math.floor((value || 0) / 60).toString().padStart(2, '0')}:${Math.floor((value || 0) % 60).toString().padStart(2, '0')}`;

function OriginalTake({ studio }) {
  return <div className="original-recording">
    <span><Mic2 size={13} />Original take</span>
    <audio ref={studio.audioRef} controls src={studio.audioUrl} preload="metadata" onPlay={studio.stopCompositionOnly} aria-label="Original microphone recording" />
    <a className="text-button original-download" href={studio.audioUrl} download={studio.audioFilename || 'MUSE-original-take.webm'}><ArrowDownToLine size={14} />Download original</a>
  </div>;
}

function RecordingNotice({ studio }) {
  if (!studio.captureSummary?.quality) return null;
  return <p className="capture-feedback" role="status" data-testid="transcription-quality">
    {studio.project.settings.leadSource === 'recording'
      ? `Original hum is the lead. ${studio.captureSummary.quality.reason}`
      : 'This instrumental lead uses estimated notes and may differ from your hum. Choose Original hum to preserve your recorded voice.'}
  </p>;
}

export function CapturePanel({ studio }) {
  const { capture, elapsed, pitch, project } = studio;
  const recording = capture === 'recording';
  const paused = capture === 'paused';
  const pending = capture === 'requesting' || capture === 'stopping';
  const blocked = pending || studio.saving;
  const hasNotes = project.notes.length > 0;
  const needsReview = studio.captureSummary?.noteCount === 0 && !hasNotes;
  const hasTake = Boolean(studio.audioUrl);
  const levelDb = Math.max(-60, Math.min(0, 20 * Math.log10(studio.inputLevel || 0.000001)));
  const status = recording ? 'Recording' : paused ? 'Paused' : capture === 'requesting' ? 'Connecting microphone' : capture === 'stopping' ? 'Finishing take' : needsReview ? hasTake ? 'Audio captured' : 'No notes detected' : hasNotes ? 'Take captured' : 'Ready to record';
  return <section className={`panel recorder-panel ${recording ? 'recording' : ''}`} aria-labelledby="input-heading">
    <div className="panel-heading"><span className="panel-icon"><Mic2 size={17} /></span><h2 id="input-heading">Audio input</h2><span className="input-mode">{studio.inputDevice?.channelCount ? `${studio.inputDevice.channelCount} CH` : 'MIC'}</span><span className={`capture-status ${recording ? 'is-live' : ''}`}><span className="capture-dot" />{status}</span></div>
    <div className="input-console">
      <div className="input-identity"><button className={`microphone-orb ${recording ? 'listening' : ''}`} disabled={blocked || paused} aria-label={recording ? 'Stop microphone recording' : 'Start microphone recording'} onClick={recording ? studio.stopRecording : studio.startRecording}>{pending ? <LoaderCircle size={24} className="spin" /> : recording ? <Square size={21} fill="currentColor" /> : <Mic2 size={26} strokeWidth={1.6} />}</button><span>MIC IN</span></div>
      <div className="input-display"><div className="input-display-heading"><div><h3>{recording ? 'Recording your melody' : paused ? 'Recording paused' : pending ? status : needsReview && hasTake ? 'Review your recording' : hasNotes ? 'Your original melody' : 'Capture your melody'}</h3><p>{recording ? 'Keep humming, one clear note at a time.' : paused ? 'Resume the take, or finish when you’re ready.' : capture === 'requesting' ? 'Allow microphone access in your browser.' : capture === 'stopping' ? 'Finalising the recording and detected notes.' : needsReview && hasTake ? 'Replay the original audio before trying again.' : hasNotes ? 'Review the notes below or record a new take.' : 'Hum, sing or whistle a short phrase.'}</p></div><div className="recording-timer" aria-label={`${timeLabel(elapsed)} recorded`}>{timeLabel(elapsed)}<span className="timer-fraction">.{Math.floor((elapsed || 0) * 10) % 10}</span><small> / 01:00</small></div></div>
        <div className="waveform-wrap"><Waveform frameRef={studio.frameRef} active={recording} paused={!recording} /><div className="waveform-labels"><span>{recording ? <><span className="status-dot" /> LIVE INPUT</> : 'INPUT WAVEFORM'}</span><span className="detected-pitch">{recording && pitch ? <><strong>{pitch.name}</strong>{Math.round(pitch.frequency)} Hz</> : recording ? 'Listening for a clear pitch…' : 'Single voice · approximate pitch detection'}</span></div></div>
      </div>
    </div>
    {studio.inputDevice && <div className="microphone-details"><span className="microphone-source"><Mic2 size={13} />{studio.inputDevice.label}</span>{recording && <div className="input-level"><meter min="-60" max="0" value={levelDb} aria-label="Microphone input level" /><span>{levelDb <= -54 ? 'Very quiet input' : 'Sound detected'}</span></div>}</div>}
    {needsReview && !pending && !recording && !paused && <p className="capture-feedback" role="status">No stable notes detected. {hasTake ? 'Your original audio is kept below. ' : ''}{!studio.captureSummary?.frames ? 'Keep this tab active so Muse can analyse your next take.' : (studio.captureSummary?.peakLevel || 0) < 0.001 ? 'The input was very quiet; move closer to the microphone and hum a steady note.' : 'Check that you hear your voice, then hum one steady note at a time.'}</p>}
    <div className="record-controls"><div className="record-actions">{recording || paused ? <><button className="button subtle" onClick={studio.pauseRecording}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? 'Resume recording' : 'Pause recording'}</button><button className="button recording-stop" onClick={studio.stopRecording}><Square size={12} fill="currentColor" />Finish take</button></> : <button className="button primary" disabled={blocked} onClick={studio.startRecording}>{pending ? <LoaderCircle size={15} className="spin" /> : (hasNotes || hasTake) ? <RotateCcw size={15} /> : <Circle size={11} fill="currentColor" />}{capture === 'stopping' ? 'Finishing take…' : capture === 'requesting' ? 'Connecting…' : (hasNotes || hasTake) ? 'Record a new take' : 'Record your melody'}</button>}{capture === 'requesting' && <button className="button subtle" onClick={studio.cancelRecordingRequest}>Cancel request</button>}</div><span className="capture-hint"><ShieldCheck size={13} />Audio stays on this device</span></div>
    <ReferenceMatch studio={studio} />
    <RecordingNotice studio={studio} />
    {studio.importRecording && <label className="text-button">Use a humming audio file<input aria-label="Import humming recording" type="file" accept="audio/*,.webm,.wav,.m4a,.mp4,.mp3" disabled={blocked || recording || paused} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (file) void studio.importRecording(file);
    }} /></label>}
    {studio.audioUrl && !studio.busy && <OriginalTake studio={studio} />}
    {studio.audioUrl && !studio.busy && studio.reanalyzeOriginal && <button type="button" className="text-button" onClick={studio.reanalyzeOriginal}>Reanalyse original take</button>}
  </section>;
}

function CreativeControls({ settings, change, disabled }) {
  return <section className="panel creative-panel" aria-labelledby="sound-heading">
    <div className="panel-heading"><span className="panel-icon"><SlidersHorizontal size={17} /></span><h2 id="sound-heading">Sound & arrangement</h2><span className="panel-hint">Shape the captured melody</span></div>
    <div className="creative-body">
      <fieldset className="mood-field" disabled={disabled}><legend>MOOD</legend><div className="mood-options">{moods.map((mood, index) => <button type="button" aria-pressed={settings.mood === mood} className={`mood-button ${settings.mood === mood ? 'selected' : ''}`} key={mood} onClick={() => change({ mood })}><span aria-hidden="true">{['✧', '◈', '☾', 'ϟ', '〰'][index]}</span>{mood}</button>)}</div></fieldset>
      <div className="creative-selects">
        <label className="field"><span>GENRE</span><div className="select-wrap"><select value={settings.genre} disabled={disabled} onChange={event => change({ genre: event.target.value })}>{genres.map(genre => <option key={genre}>{genre}</option>)}</select><ChevronDown size={14} /></div></label>
        <label className="field tempo-field"><span>TEMPO<strong>{settings.bpm}<small>BPM</small></strong></span><input aria-label="Composition tempo in BPM" type="range" min="40" max="200" step="1" value={settings.bpm} disabled={disabled} onChange={event => change({ bpm: Number(event.target.value) })} /></label>
      </div>
      {settings.blueprint ? <p className="control-note">Manage backing instruments in the AI Production Director below.</p> : <>
        <div className="layer-controls"><label><input type="checkbox" checked={settings.accompaniment} disabled={disabled} onChange={event => change({ accompaniment: event.target.checked })} /><Layers2 size={15} />Chord accompaniment</label><label><input type="checkbox" checked={settings.percussion || settings.instrument === 'Drums'} disabled={disabled || settings.instrument === 'Drums'} onChange={event => change({ percussion: event.target.checked })} /><AudioLines size={15} />Percussion</label></div>
        {settings.instrument === 'Drums' && <p className="control-note">Drums includes percussion while a pitched synth preserves your melody. Choose another lead to turn percussion off.</p>}
      </>}
    </div>
  </section>;
}

export default function Studio({ studio, onOpenProducer }) {
  const { project, busy, arrangement, transport, position } = studio;
  const playing = transport === 'playing';
  const hasNotes = studio.hasMelody ?? project.notes.length > 0;
  const saved = studio.projects?.some(item => item.id === project.id);
  return <div className="ref-studio">
    <div className="studio-session-line"><span>MUSE / COMPOSITION</span><span>LOCAL SESSION <span aria-hidden="true">·</span> {studio.dirty ? 'UNSAVED CHANGES' : saved ? 'SAVED TO THIS DEVICE' : 'NEW IDEA'}</span></div>
    <header className="composition-heading"><div><h1>{hasNotes ? <>Your idea is<br /><em>opening up.</em></> : <>There’s music<br />in that <em>idea.</em></>}</h1><div className="composition-project-title"><label className="sr-only" htmlFor="project-title">Project title</label><input id="project-title" aria-label="Project title" maxLength={80} value={project.title} placeholder="Untitled melody" disabled={busy} onChange={event => studio.rename(event.target.value)} /><span>{studio.dirty ? 'Unsaved changes' : 'Local session'}</span></div></div><div className="composition-heading-side"><span className="eyebrow">YOUR SESSION</span><p>{studio.arranging ? 'Building your arrangement…' : arrangement ? 'Your composition is ready.' : hasNotes ? `${project.notes.length} notes, ready for a direction.` : 'A little hum is all it takes.'}</p>{onOpenProducer && <button className="button subtle" disabled={busy || studio.arranging} onClick={onOpenProducer}><Sparkles size={14} />Producer brain<ArrowRight size={14} /></button>}</div></header>
    <Timeline key={project.id} notes={project.notes} arrangement={arrangement} position={position} updateNote={studio.updateNote} busy={busy} />
    <section className="composition-transport" aria-label="Composition transport">
      <div className="composition-playback"><button className="play-button" disabled={!arrangement || busy || studio.arranging} aria-label={playing ? 'Pause composition' : transport === 'paused' ? 'Resume composition' : 'Play composition'} onClick={playing ? studio.pausePlayback : studio.play}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><div><span className="transport-label">{playing ? 'NOW PLAYING' : transport === 'paused' ? 'PLAYBACK PAUSED' : 'COMPOSITION'}</span><span className="transport-time">{timeLabel(position)}<span> / {timeLabel(arrangement?.duration || 0)}</span></span></div><button className="icon-button transport-stop" disabled={!arrangement || transport === 'stopped' || busy} aria-label="Stop composition" onClick={studio.stopPlayback}><Square size={13} /></button></div>
      <div className="transport-value"><span className="transport-label">TEMPO</span><strong>{project.settings.bpm}<small>BPM</small></strong></div>
      <div className="transport-value transport-key"><span className="transport-label">KEY</span><strong>{arrangement?.key || 'Not estimated'}</strong></div>
      <label className="field transport-lead"><span>LEAD INSTRUMENT</span><div className="select-wrap"><select value={project.settings.leadSource === 'recording' ? 'Original hum' : project.settings.instrument} disabled={busy || studio.arranging} onChange={event => studio.changeSettings(event.target.value === 'Original hum' ? { leadSource: 'recording' } : { instrument: event.target.value, leadSource: 'instrument' })}><option>Original hum</option>{instruments.map(instrument => <option key={instrument}>{instrument}</option>)}</select><ChevronDown size={13} /></div></label>
      {!arrangement && <button className="button primary arrangement-action" disabled={!hasNotes || busy || studio.arranging} onClick={studio.generate}>{studio.arranging ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}{studio.arranging ? 'Arranging…' : 'Create arrangement'}</button>}
      {arrangement && <span className="composition-ready"><Check size={13} />{playing ? 'PLAYING' : transport === 'paused' ? 'PAUSED' : 'READY TO PLAY'}</span>}
    </section>
    <div className="composition-utilities"><p className="studio-limits">{arrangement?.description || 'Record a single voice. Every note here comes from your take; instrument sounds are synthesised.'}</p><div className="title-actions"><button className="button subtle" disabled={(!hasNotes && !studio.dirty) || busy || studio.saving} onClick={studio.save}>{studio.saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}Save project</button><button className="button subtle export-button" disabled={!arrangement || busy || studio.exporting} onClick={studio.download}>{studio.exporting ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}{studio.exporting ? 'Rendering…' : 'Export WAV'}</button></div></div>
    {studio.musicGen && <MusicGenJobPanel studio={studio} />}
    <div className="studio-secondary-heading"><span>MAKE IT YOURS</span><p>Keep your melody. Change the world around it.</p></div>
    <div className="studio-secondary-grid"><CreativeControls settings={project.settings} change={studio.changeSettings} disabled={busy || studio.arranging} /><CapturePanel studio={studio} /></div>
    {studio.downloadMidi && <div className="composition-utilities director-midi-export"><p className="studio-limits">MIDI contains estimated melody notes. It cannot contain your original voice or continuous sung pitch.</p><button className="button subtle" disabled={!project.notes.length || busy || studio.exporting} onClick={studio.downloadMidi}><ArrowDownToLine size={14} />Export detected melody MIDI</button></div>}
    <div className="studio-producer-section"><ProductionDirector key={project.id} settings={project.settings} analysis={{ notes: project.notes, key: arrangement?.key, sourceId: studio.captureSummary?.receipt?.sha256 }} hasNotes={hasNotes} busy={busy || studio.arranging} arrangement={arrangement} apply={changes => { studio.changeSettings(changes); if (hasNotes) studio.generate(); studio.notify('Production blueprint applied. Your selected lead is preserved.'); }} /></div>
  </div>;
}

export function HumExperience({ studio, onOpenStudio, onOpenDirection }) {
  const complete = (studio.hasMelody ?? studio.project.notes.length > 0) && !studio.busy;
  const phraseDuration = studio.project.settings.leadSource === 'recording' && studio.captureSummary?.receipt
    ? studio.captureSummary.receipt.duration : Math.max(0, ...studio.project.notes.map(note => note.start + note.duration));
  return <div className={`hum-experience ref-hum ${complete ? 'is-analysed' : ''}`}>
    {complete && <RecordingNotice studio={studio} />}
    {complete ? <section className="ref-hum-analysis"><div className="hum-analysis-intro"><span className="eyebrow">MUSE / CAPTURED IDEA</span><h1>There’s music<br />in that <em>idea.</em></h1><p>The notes, the timing,<br />and the shape of your sound.</p><button className="text-button" disabled={studio.busy} onClick={studio.startRecording}><RotateCcw size={14} />Record a new take</button></div><div className="hum-analysis-result"><MelodyPreview audioUrl={studio.audioUrl} notes={studio.project.notes} /><Timeline key={studio.project.id} notes={studio.project.notes} arrangement={studio.arrangement} position={studio.position} updateNote={studio.updateNote} busy={studio.busy} /><dl className="hum-real-analysis"><div><dt><Check size={16} />Melody captured</dt><dd>{studio.project.notes.length} notes</dd></div><div><dt><Check size={16} />Phrase timing</dt><dd>{phraseDuration.toFixed(1)} seconds</dd></div><div><dt><Check size={16} />Pitch editing</dt><dd>Ready to refine</dd></div></dl>{studio.audioUrl && <OriginalTake studio={studio} />}<ReferenceMatch studio={studio} /><div className="hum-analysis-actions"><button className="button primary" onClick={onOpenDirection || onOpenStudio}>Shape this melody<ArrowRight size={16} /></button><button className="text-button" onClick={onOpenStudio}>Open music studio<ArrowRight size={14} /></button></div><p className="hum-analysis-note">Pitch detection is approximate. Select a note above to adjust it.</p></div></section> : <section className="ref-hum-stage"><div className="hum-stage-copy"><span className="eyebrow">YOUR VOICE. YOUR STARTING POINT.</span><h1>A little hum.<br />A whole<br /> <em>universe.</em></h1><p>Record what’s in your head.<br />We’ll find where it can go.</p><span className="hum-stage-footnote">MUSE — FROM INSPIRATION TO MUSIC</span></div><div className="hum-stage-recorder"><CapturePanel studio={studio} /><p className="hum-stage-caption">A small beginning. Endless possibilities.</p></div></section>}
  </div>;
}
