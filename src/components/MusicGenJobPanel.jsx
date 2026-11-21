import React, { useEffect, useId, useState } from 'react';
import { ArrowDownToLine, AudioLines, Check, LoaderCircle, RotateCcw, Square, WandSparkles } from 'lucide-react';
import { MelodyPreview } from './DirectionExperience.jsx';
import '../styles/musicgen-job.css';

const stages = [
  ['listening', 'Listening to your melody…'],
  ['understanding', 'Understanding your musical idea…'],
  ['exploring', 'Exploring production possibilities…'],
  ['arranging', 'Building your arrangement…'],
  ['generating', 'Generating your music…'],
  ['preparing', 'Mastering the final preview…'],
  ['ready', 'Your music is ready!'],
];
const time = value => `${Math.floor(Math.max(0, value || 0) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, value || 0) % 60).toString().padStart(2, '0')}`;
const sourceLink = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } };

export default function MusicGenJobPanel({ studio }) {
  const generation = studio.musicGen;
  const id = useId();
  const [duration, setDuration] = useState(10);
  const [comparison, setComparison] = useState('generated');
  const [playbackError, setPlaybackError] = useState('');
  const { job, result, status, active, availability } = generation;
  const available = availability.canSubmit ?? availability.ready;
  const cloud = availability.provider === 'replicate';
  const queued = job?.status === 'queued';
  const progress = job?.progress;
  const tokenProgress = active && status === 'running' && job?.status === 'running' && job.stage === 'generating'
    && Number.isFinite(progress?.completed) && Number.isFinite(progress?.total)
    && progress.completed >= 0 && progress.total > 0 && progress.completed <= progress.total ? progress : null;
  const currentIndex = queued ? -1 : stages.findIndex(([key]) => key === job?.stage);
  const original = comparison === 'original' && Boolean(studio.audioUrl);
  const playbackUrl = original ? studio.audioUrl : result?.audioUrl;
  const production = result?.production || job?.production;
  const filename = `${studio.project.title.replace(/[^\w -]/g, '').trim() || 'MUSE'}-preview.wav`;
  const finishedDownload = job?.status === 'succeeded' && typeof job.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(job.id)
    && job.audioUrl === `/api/generation/jobs/${job.id}/audio` ? job.audioUrl : null;
  const currentLabel = status === 'submitting' ? 'Sending your request…' : status === 'uncertain' ? 'Checking the generation request'
    : status === 'cancelling' ? 'Cancelling generation…' : queued ? cloud ? 'Waiting for the cloud model' : 'Waiting for the local model' : status === 'loading-audio' ? 'Loading your finished preview…'
      : status === 'cancelled' ? 'Generation cancelled. Your original take is kept.' : status === 'failed' ? 'Preview could not finish'
        : status === 'ready' ? 'Your music is ready!' : currentIndex >= 0 ? stages[currentIndex][1] : 'Ready for your direction';

  useEffect(() => { setComparison('generated'); setPlaybackError(''); }, [result?.audioUrl]);
  function compare(next) {
    generation.audioRef.current?.pause();
    setComparison(next); setPlaybackError('');
  }
  async function replay() {
    const audio = generation.audioRef.current;
    if (!audio) return;
    try { audio.currentTime = 0; await audio.play(); setPlaybackError(''); }
    catch { setPlaybackError('Playback could not start. Press play in the audio player to try again.'); }
  }
  if (!generation) return null;
  return <section className="panel musicgen-panel" aria-labelledby={`${id}-title`}>
    <div className="musicgen-heading"><div><span className="musicgen-kicker">MUSICGEN MELODY / NEURAL PREVIEW</span><h2 id={`${id}-title`}>Hear another<br />direction.</h2></div><AudioLines size={26} aria-hidden="true" /></div>
    <div className="musicgen-layout">
      <div className="musicgen-direction">
        <p>Turn your actual hum and production direction into a short music preview.</p>
        <form noValidate onSubmit={event => { event.preventDefault(); void generation.start(duration); }}>
          <label htmlFor={`${id}-prompt`}>Describe your music</label>
          <textarea id={`${id}-prompt`} rows={5} maxLength={4000} className="resize-none" style={{ resize: 'none' }} value={generation.prompt}
            aria-describedby={`${id}-prompt-help`} onChange={event => generation.setPrompt(event.target.value)}
            placeholder="Warm acoustic guitar, a soft piano pulse and strings entering near the end…" />
          <p id={`${id}-prompt-help`} className="musicgen-help">{active ? 'You can edit the next direction while this request finishes.' : 'Describe the genre, mood, instruments, rhythm and how the music should develop.'}</p>
          <div className="musicgen-request-controls"><label htmlFor={`${id}-duration`}>Preview length<select id={`${id}-duration`} value={duration} disabled={active} onChange={event => setDuration(Number(event.target.value))}>
            {[5, 10, 15, 30].map(seconds => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label>
            <button type="submit" className="button primary" disabled={!generation.canGenerate || !generation.prompt.trim()}>
              {active ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}
              {active ? 'Generation in progress' : cloud ? 'Generate paid preview' : status === 'failed' || status === 'cancelled' ? 'Retry generation' : result ? 'Generate another preview' : 'Generate preview'}
            </button></div>
        </form>
        {!studio.captureSummary?.receipt?.sha256 && <p className="musicgen-notice">Record or attach your original hum to generate a neural preview. Saved projects need their original recording reattached.</p>}
        {!available && <div className="musicgen-availability" role="status"><p>{availability.status === 'loading' ? 'Checking the MusicGen connection…' : availability.reason || 'The MusicGen connection is not ready. Check the server setup, then try again.'}</p><button type="button" className="text-button" disabled={availability.status === 'loading'} onClick={generation.refreshAvailability}>Check model again</button></div>}
        {available && !availability.ready && <p className="musicgen-notice">{availability.status === 'not-loaded' ? 'The first preview downloads and loads the model weights. Startup can take several minutes.' : 'The local model is working. Your preview can wait in its bounded queue.'}</p>}
        <p className="musicgen-disclosure">{cloud ? 'Replicate cloud · MusicGen Melody Large. Your recording and production instructions are sent to Replicate when you generate, and usage is billed per generation. ' : 'Runs on your local MusicGen service. CPU generation can take several minutes. '}Neural previews may change the melody. Your original hum and editable composition are kept.</p>
      </div>
      <div className="musicgen-output">
        <div className="musicgen-status-line"><span role="status" aria-live="polite">{currentLabel}</span>{job && <span className="musicgen-elapsed" aria-label={`${Math.floor(job.elapsedSeconds || 0)} seconds elapsed`}>{time(job.elapsedSeconds)} elapsed</span>}</div>
        {tokenProgress ? <div className="musicgen-token-progress">
          <label htmlFor={`${id}-tokens`}>Model audio tokens</label>
          <progress id={`${id}-tokens`} aria-label="Model audio tokens" value={tokenProgress.completed} max={tokenProgress.total}
            aria-valuetext={`${tokenProgress.completed} / ${tokenProgress.total} audio tokens`} aria-describedby={`${id}-token-count`} />
          <span id={`${id}-token-count`}>{`${tokenProgress.completed} / ${tokenProgress.total} audio tokens`}</span>
        </div> : <div className={`musicgen-activity${active && !queued && status !== 'uncertain' ? ' is-active' : ''}`} aria-hidden="true">{Array.from({ length: 24 }, (_, index) => <span key={index} style={{ '--bar-index': index }} />)}</div>}
        <p className="musicgen-activity-caption">{tokenProgress ? 'Audio tokens only · preview preparation follows' : queued ? 'Waiting · duration unknown' : active ? 'Working · duration unknown' : result ? 'Preview generated from your recording' : 'A new interpretation of your melody'}</p>
        <ol className="musicgen-stages" aria-label="Generation stages">{stages.map(([key, label], index) => {
          const completed = currentIndex > index || (key === 'ready' && status === 'ready');
          const current = currentIndex === index && status !== 'ready';
          return <li key={key} className={completed ? 'is-complete' : current ? 'is-current' : ''} aria-current={current ? 'step' : undefined}>
            <span className="musicgen-stage-marker" aria-hidden="true">{completed ? <Check size={12} /> : String(index + 1).padStart(2, '0')}</span><span>{label}{key === 'preparing' && <small>Basic volume normalization only</small>}</span>
          </li>;
        })}</ol>
        {active && <div className="musicgen-active-actions"><button type="button" className="button subtle" disabled={status === 'cancelling'} onClick={() => { void generation.cancel(); }}><Square size={12} />{status === 'cancelling' ? 'Cancellation requested' : 'Cancel generation'}</button>{job?.status === 'queued' && <span>{cloud ? 'Queued for the cloud model' : 'Queued for the local model'}</span>}</div>}
        {generation.connectionError && <div className="musicgen-notice" role="status"><p>{generation.connectionError}</p><button type="button" className="text-button" onClick={() => { void generation.reconnect(); }}>Reconnect to this job</button></div>}
        {generation.error && <p role="alert" className="musicgen-error">{generation.error}</p>}
        {status === 'failed' && job?.status === 'succeeded' && <div className="musicgen-player-actions"><button type="button" className="text-button" onClick={() => { void generation.reconnect(); }}>Load finished preview again</button>{finishedDownload && <a className="text-button" href={finishedDownload} download={filename}><ArrowDownToLine size={14} />Download finished WAV</a>}</div>}
        {status === 'failed' && result && <p className="musicgen-help">Your previous preview is kept. Edit the direction or retry when you are ready.</p>}
        {result && <div className="musicgen-player">
          <div className="musicgen-player-heading"><h3>{original ? 'Original hum' : 'Generated preview'}</h3><span>{original ? studio.captureSummary?.receipt?.duration ? time(studio.captureSummary.receipt.duration) : '' : time(result.duration)}</span></div>
          <div className="musicgen-comparison" aria-label="Compare audio"><button type="button" aria-pressed={!original} onClick={() => compare('generated')}>Generated preview</button><button type="button" aria-pressed={original} disabled={!studio.audioUrl} onClick={() => compare('original')}>Original hum</button></div>
          <MelodyPreview audioUrl={playbackUrl} notes={[]} label={original ? 'Original hum' : 'Generated preview'} />
          <audio ref={generation.audioRef} controls src={playbackUrl} preload="metadata" aria-label={original ? 'Original hum comparison player' : 'Generated music preview player'} onPlay={event => studio.stopOtherAudio(event.currentTarget)} onError={() => setPlaybackError('This audio could not be played. Download the preview or try generating again.')} />
          <div className="musicgen-player-actions"><button type="button" className="text-button" onClick={() => { void replay(); }}><RotateCcw size={14} />Replay</button><a className="text-button" href={result.audioUrl} download={filename}><ArrowDownToLine size={14} />Download preview WAV</a></div>
          {playbackError && <p className="musicgen-error" role="alert">{playbackError}</p>}
          <p className="musicgen-help">Mastering preview applies basic volume normalization only. Melody fidelity is unverified. This preview does not replace your original lead.</p>
          <p className="musicgen-help">Preview direction: {result.prompt}</p>
          <p className="musicgen-help">Download to keep this session-only preview.</p>
        </div>}
        {production && <details className="musicgen-production"><summary>Production direction and references</summary><p>{production.prompt}</p>{production.techniques?.length > 0 && <ul>{production.techniques.map(technique => <li key={technique.id || technique.label}><strong>{technique.label}</strong>{technique.description && <> — {technique.description}</>}</li>)}</ul>}{production.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}{production.sources?.length > 0 && <ul className="musicgen-sources">{production.sources.map(source => sourceLink(source.url) ? <li key={source.id || source.url}><a href={sourceLink(source.url)} target="_blank" rel="noreferrer">{source.title}</a></li> : null)}</ul>}</details>}
      </div>
    </div>
  </section>;
}
