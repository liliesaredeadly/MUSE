import React, { useState } from 'react';
import { ArrowRight, Check, ChevronDown, CornerDownLeft, LoaderCircle, Music2, Sparkles, WandSparkles } from 'lucide-react';
import { api } from '../lib/api.js';

const prompts = ['Make it cinematic', 'Give it a dreamy atmosphere', 'Add piano accompaniment', 'Make it more energetic'];

export default function Producer({ settings, apply, busy, hasNotes, analysis = { notes: [], key: null } }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [pending, setPending] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState('');
  const noteCount = analysis.notes?.length || 0;
  const estimatedKey = typeof analysis.key === 'string' ? analysis.key.trim() : '';

  async function ask(value = text) {
    if (!value.trim() || pending) return;
    setText(value); setPending(true); setError(''); setApplied(false); setResult(null);
    try { setResult(await api.producer(value, settings)); }
    catch (err) { setError(err.message); }
    finally { setPending(false); }
  }
  return (
    <aside className="panel producer-panel">
      <div className="panel-heading">
        <span className="panel-icon"><Sparkles size={17} /></span>
        <h2>MUSE producer</h2>
        <span className="small-badge">Rule-based</span>
      </div>

      <div className="producer-body">
        <section className="producer-analysis" aria-labelledby="producer-analysis-title">
          <div className="producer-analysis-heading">
            <Music2 size={14} />
            <h3 id="producer-analysis-title">Your take</h3>
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
        </section>

        <div className="producer-intro">
          <div className="producer-avatar"><Sparkles size={23} /></div>
          <div><h3>Find your next direction.</h3><p>A mood, a scene, a little more energy. Start with a feeling.</p></div>
        </div>

        <div className="prompt-list">
          {prompts.map(prompt => (
            <button type="button" key={prompt} onClick={() => ask(prompt)} disabled={pending || busy}>
              <WandSparkles size={13} /><span>{prompt}</span><ArrowRight size={13} />
            </button>
          ))}
        </div>

        {pending && (
          <div className="producer-response" role="status">
            <LoaderCircle size={16} className="spin" /> Finding a musical direction…
          </div>
        )}

        {result && (
          <div className="producer-response" role="status">
            <span className="response-label"><Sparkles size={12} /> {applied ? 'DIRECTION APPLIED' : 'A MUSICAL DIRECTION'}</span>
            <p>{result.message}</p>
            {Object.keys(result.changes || {}).length > 0 && (
              <>
                <div className="change-tags">
                  {Object.entries(result.changes).map(([key, value]) => (
                    <span key={key}>{key === 'bpm' ? `${value} BPM` : typeof value === 'boolean' ? `${key} ${value ? 'on' : 'off'}` : value}</span>
                  ))}
                </div>
                <button className="button primary full" disabled={applied || busy} onClick={() => { apply(result.changes); setApplied(true); }}>
                  {applied ? <Check size={15} /> : <WandSparkles size={15} />}
                  {applied ? 'Changes applied' : 'Apply direction'}
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

        <form noValidate className="producer-form" onSubmit={event => { event.preventDefault(); ask(); }}>
          <label htmlFor="producer-input" className="sr-only">Describe a musical direction</label>
          <textarea
            className="resize-none"
            id="producer-input"
            rows={3}
            style={{ resize: 'none' }}
            maxLength={500}
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder="A sunset set. Warm keys. Room to breathe…"
            disabled={busy || pending}
          />
          <div>
            <span>Describe your direction</span>
            <button type="submit" className="icon-button send-button" aria-label="Get producer recommendations" disabled={!text.trim() || pending || busy}>
              <CornerDownLeft size={16} />
            </button>
          </div>
        </form>
        <p className="producer-disclosure">Musical rules, no external AI model. Review each direction before applying.</p>
      </div>
    </aside>
  );
}
