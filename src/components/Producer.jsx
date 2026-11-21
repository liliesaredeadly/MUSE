import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, CornerDownLeft, LoaderCircle, Music2, Sparkles, WandSparkles } from 'lucide-react';
import { api } from '../lib/api.js';
import ProductionDirector from './ProductionDirector.jsx';

const prompts = ['Make it cinematic', 'Give it a dreamy atmosphere', 'Add piano accompaniment', 'Make it more energetic'];
const settingLabels = { bpm: 'Tempo', instrument: 'Lead', mood: 'Mood', genre: 'Genre', accompaniment: 'Chords', percussion: 'Percussion' };

export default function Producer(props) {
  return props.settings.blueprint ? <ProductionDirector {...props} /> : <LegacyProducer {...props} />;
}

function LegacyProducer({ settings, apply, busy, hasNotes, analysis = { notes: [], key: null }, layout = 'panel', analysisPreview = null }) {
  const isDirection = layout === 'direction';
  const Heading = isDirection ? 'h1' : 'h3';
  const [text, setText] = useState('');
  const [proposal, setProposal] = useState(null);
  const [pending, setPending] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState('');
  const [providerStatus, setProviderStatus] = useState(null);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const requestGeneration = useRef(0);
  const context = JSON.stringify([settings, analysis.notes || []]);
  const result = proposal?.context === context ? proposal.direction : null;
  const currentContext = useRef(context);
  currentContext.current = context;
  const noteCount = analysis.notes?.length || 0;
  const estimatedKey = typeof analysis.key === 'string' ? analysis.key.trim() : '';
  const sourceLabel = result?.source === 'ai' ? 'AI direction' : result?.source === 'rules' ? 'Rule-based' : checkingStatus ? 'Checking…' : providerStatus?.mode === 'ai' ? 'AI enabled' : providerStatus?.mode === 'rules' ? 'Rule-based' : 'Status unavailable';
  const mayUseAi = !providerStatus || providerStatus.mode === 'ai' || result?.source === 'ai';

  useEffect(() => {
    let cancelled = false;
    api.producerStatus()
      .then(status => { if (!cancelled && ['ai', 'rules'].includes(status.mode)) setProviderStatus(status); })
      .catch(() => { /* Keep status unknown; directions can still be requested. */ })
      .finally(() => { if (!cancelled) setCheckingStatus(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    requestGeneration.current++;
    setProposal(null); setPending(false); setApplied(false); setError('');
    return () => { requestGeneration.current++; };
  }, [context]);

  async function ask(value = text) {
    if (!value.trim() || pending || busy) return;
    const generation = ++requestGeneration.current;
    const isCurrent = () => generation === requestGeneration.current && context === currentContext.current;
    setText(value); setPending(true); setError(''); setApplied(false); setProposal(null);
    try {
      const direction = await api.producer(value, settings, analysis.notes || []);
      if (isCurrent()) setProposal({ direction, context });
    }
    catch (err) { if (isCurrent()) setError(err.message); }
    finally { if (isCurrent()) setPending(false); }
  }
  function updateText(value) {
    requestGeneration.current++;
    setText(value); setProposal(null); setApplied(false); setError(''); setPending(false);
  }
  const promptForm = (
    <form noValidate className="producer-form" onSubmit={event => { event.preventDefault(); ask(); }}>
      <label htmlFor="producer-input" className={isDirection ? 'direction-form-label' : 'sr-only'}>{isDirection ? 'Your creative direction' : 'Describe a musical direction'}</label>
      <textarea className="resize-none" id="producer-input"
        aria-label={isDirection ? 'Your creative direction' : 'Describe a musical direction'}
        rows={3} style={{ resize: 'none' }} maxLength={500} value={text}
        onChange={event => updateText(event.target.value)}
        placeholder="A sunset set. Warm keys. Room to breathe…" disabled={busy || pending} />
      <div><span>Describe your direction</span><button type="submit" className="icon-button send-button" aria-label="Get producer recommendations" disabled={!text.trim() || pending || busy}><CornerDownLeft size={16} /></button></div>
    </form>
  );
  return (
    <aside className={`panel producer-panel${isDirection ? ' reference-producer' : ''}`}>
      <div className="panel-heading">
        <span className="panel-icon"><Sparkles size={17} /></span>
        <h2>{isDirection ? 'MUSE / Producer brain' : 'MUSE producer'}</h2>
        <span className="small-badge" role="status">{sourceLabel}</span>
      </div>

      <div className="producer-body">
        <section className="producer-analysis" aria-labelledby="producer-analysis-title">
          <div className="producer-analysis-heading">
            <Music2 size={14} />
            <h3 id="producer-analysis-title">{isDirection ? 'Your melody / the starting point' : 'Your take'}</h3>
          </div>
          {noteCount > 0 ? (
            <>
              <dl className="producer-analysis-grid">
                <div><dt>Captured notes</dt><dd>{noteCount}</dd></div>
                {estimatedKey && <div><dt>Estimated key</dt><dd>{estimatedKey}</dd></div>}
              </dl>
              {!estimatedKey && <p className="producer-analysis-hint">Create an arrangement to estimate the key.</p>}
            </>
          ) : (
            <p className="producer-analysis-hint">Record a melody to see its notes and explore its key.</p>
          )}
          {analysisPreview}
        </section>

        <div className="producer-intro">
          <div className="producer-avatar"><Sparkles size={23} /></div>
          <div><Heading>Give your sound<br /> a <em>feeling.</em></Heading><p>A mood, a scene, a little more energy. Start with a feeling.</p></div>
        </div>

        {isDirection && promptForm}

        {isDirection ? <details className="prompt-list direction-presets"><summary>Try a starting point <ChevronDown size={12} /></summary><div>{prompts.map(prompt => (
            <button type="button" key={prompt} onClick={() => ask(prompt)} disabled={pending || busy}>
              <span>{prompt}</span><ArrowRight size={13} />
            </button>
          ))}</div></details> : <div className="prompt-list">
          {prompts.map(prompt => (
            <button type="button" key={prompt} onClick={() => ask(prompt)} disabled={pending || busy}>
              <WandSparkles size={13} /><span>{prompt}</span><ArrowRight size={13} />
            </button>
          ))}
        </div>}

        {pending && (
          <div className="producer-response" role="status">
            <LoaderCircle size={16} className="spin" /> Finding a musical direction…
          </div>
        )}

        {isDirection && !pending && !result && (
          <div className="producer-response producer-direction producer-invitation">
            <h2>A feeling becomes<br />a <em>direction.</em></h2>
            <p>Your melody is the starting point.<br />Tell MUSE where you want to take it.</p>
            <svg className="direction-orbits" viewBox="0 0 420 230" aria-hidden="true"><ellipse cx="210" cy="160" rx="187" ry="66" transform="rotate(-8 210 160)" /><ellipse cx="210" cy="160" rx="180" ry="70" transform="rotate(6 210 160)" /><ellipse cx="210" cy="160" rx="165" ry="76" transform="rotate(-15 210 160)" /></svg>
          </div>
        )}

        {result && (
          <div className="producer-response producer-direction" role="status">
            <span className="response-label"><Sparkles size={12} /> {applied ? 'DIRECTION APPLIED' : 'A MUSICAL DIRECTION'}</span>
            {isDirection && Object.keys(result.changes || {}).length > 0 && <h3 className="direction-result-title">{result.changes.mood || settings.mood} character.<br /><em>{result.changes.instrument || settings.instrument} sound.</em></h3>}
            <p>{result.message}</p>
            {result.notice && <p className="producer-notice">{result.notice}</p>}
            {Object.keys(result.changes || {}).length > 0 && (
              <>
                <div className="change-tags">
                  {Object.entries(result.changes).map(([key, value]) => (
                    <span key={key}><small>{settingLabels[key] || key}</small>{key === 'bpm' ? `${value} BPM` : typeof value === 'boolean' ? value ? 'On' : 'Off' : value}</span>
                  ))}
                </div>
                <button className="button primary full" disabled={applied || busy} onClick={() => { if (context !== currentContext.current) return; apply(result.changes); setApplied(true); }}>
                  {applied ? <Check size={15} /> : <WandSparkles size={15} />}
                  {applied ? 'Changes applied' : isDirection ? hasNotes ? 'Create my composition' : 'Apply for my next take' : 'Apply direction'}
                </button>
                {!hasNotes && !applied && <small className="muted">Sets your sound for the next recording.</small>}
              </>
            )}
            {result.suggestions?.length > 0 && (
              <details className="producer-more-directions">
                <summary>More directions <ChevronDown size={13} /></summary>
                <div className="producer-suggestions">
                  {result.suggestions.map((suggestion, index) => (
                    <button type="button" key={index} onClick={() => ask(suggestion)} disabled={pending || busy}>
                      <span>{suggestion}</span><ArrowRight size={13} />
                    </button>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {error && <p role="alert" className="inline-error">{error}</p>}

        {!isDirection && promptForm}
        <p className="producer-disclosure">{mayUseAi
          ? `${providerStatus?.mode === 'ai' || result?.source === 'ai' ? 'AI directions send' : checkingStatus ? 'Checking producer status. Requests may send' : 'Producer status unavailable. Requests may send'} your instruction, settings and detected notes to OpenAI. Your raw recording stays on this device. Review each direction before Apply.`
          : 'Local rules were configured at last check. If AI is enabled on the server, requests send your instruction, settings and detected notes to OpenAI. Your raw recording stays on this device. Review each direction before Apply.'}</p>
      </div>
    </aside>
  );
}
