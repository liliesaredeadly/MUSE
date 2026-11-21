import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Layers2, LoaderCircle, RotateCcw, Sparkles, WandSparkles } from 'lucide-react';
import { api } from '../lib/api.js';
import { createBlueprint, LAYER_CATALOG, validateBlueprint } from '../producer/production-blueprint.js';

const moods = ['Dreamy', 'Cinematic', 'Melancholic', 'Energetic', 'Peaceful'];
const percent = value => `${Math.round(value * 100)}%`;
const roleLabel = value => ({ rhythm: 'Rhythm', arpeggio: 'Arpeggio', chords: 'Chords', sustain: 'Sustained notes', bass: 'Bass line', texture: 'Texture', percussion: 'Percussion' })[value] || value;
function currentBlueprint(settings) {
  try { if (settings.blueprint) return validateBlueprint(settings.blueprint); }
  catch { /* A recoverable default remains editable if a legacy document is incomplete. */ }
  return createBlueprint({ ...settings, blueprint: undefined });
}

export default function ProductionDirector({ settings, analysis = { notes: [] }, hasNotes, busy, apply, arrangement,
  layout = 'panel', analysisPreview = null, sourceIdentity = null }) {
  const isDirection = layout === 'direction';
  const id = useId();
  const context = JSON.stringify([settings, analysis.notes || [], sourceIdentity || analysis.sourceId || null]);
  const latestContext = useRef(context);
  latestContext.current = context;
  const requestId = useRef(0);
  const [draftState, setDraftState] = useState(() => ({ blueprint: currentBlueprint(settings), context }));
  const [instruction, setInstruction] = useState(() => currentBlueprint(settings).prompt);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [provider, setProvider] = useState('checking');
  const draft = draftState.context === context ? draftState.blueprint : currentBlueprint(settings);
  const needsPlanning = instruction.trim() !== draft.prompt.trim();
  const changed = !settings.blueprint || JSON.stringify(draft) !== JSON.stringify(settings.blueprint);
  const sourceLabel = result?.source === 'ai' ? 'AI blueprint' : result?.source === 'rules' ? 'Local blueprint'
    : provider === 'checking' ? 'Checking planner…' : provider === 'ai' ? 'AI enabled' : provider === 'rules' ? 'Local planner' : 'Status unavailable';
  const responseHeading = isDirection ? 'h2' : 'h3';
  const Heading = responseHeading;

  useEffect(() => {
    let current = true;
    if (typeof api.productionDirectorStatus !== 'function') { setProvider('unknown'); return; }
    api.productionDirectorStatus().then(next => {
      if (current) setProvider(['ai', 'rules'].includes(next?.mode) ? next.mode : 'unknown');
    }).catch(() => { if (current) setProvider('unknown'); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    requestId.current++;
    const blueprint = currentBlueprint(settings);
    setDraftState({ blueprint, context });
    setInstruction(blueprint.prompt);
    setPending(false); setResult(null); setError(''); setStatus('');
    return () => { requestId.current++; };
  }, [context]);

  function interruptRequest() {
    requestId.current++;
    setPending(false); setError(''); setResult(null); setStatus('Draft edited. Review it before applying.');
  }
  function editBlueprint(change) {
    if (busy) return;
    interruptRequest();
    setDraftState(previous => {
      const base = previous.context === context ? previous.blueprint : currentBlueprint(settings);
      return { context, blueprint: validateBlueprint({ ...base, ...(typeof change === 'function' ? change(base) : change) }) };
    });
  }
  function editLayer(layerId, changes) {
    editBlueprint(base => ({ layers: base.layers.map(layer => layer.id === layerId ? { ...layer, ...changes } : layer) }));
  }
  function toggleLayer(catalog, enabled) {
    editBlueprint(base => {
      const existing = base.layers.find(layer => layer.id === catalog.id);
      const layers = existing ? base.layers.map(layer => layer.id === catalog.id ? { ...layer, enabled } : layer)
        : [...base.layers, { id: catalog.id, instrument: catalog.instrument, role: catalog.roles[0], enabled,
          gain: .6, section: 'full', variant: 0 }];
      return { layers };
    });
  }

  async function ask(event) {
    event.preventDefault();
    const text = instruction.trim();
    if (!text || pending || busy) return;
    const generation = ++requestId.current;
    const current = () => generation === requestId.current && context === latestContext.current;
    setPending(true); setError(''); setStatus('Planning your instruments and arrangement…');
    try {
      const next = await api.productionDirector(text, { ...settings, blueprint: draft }, analysis.notes || []);
      const blueprint = validateBlueprint({ ...validateBlueprint(next.blueprint), prompt: text });
      if (!current()) return;
      setDraftState({ context, blueprint });
      setInstruction(text);
      setResult({ source: next.source, summary: typeof next.summary === 'string' ? next.summary : '', notice: typeof next.notice === 'string' ? next.notice : '' });
      setStatus('Blueprint ready to review. Apply it when you are happy with the instruments.');
    } catch (err) {
      if (current()) { setError(err.message || 'The blueprint could not be created. Edit your instruction and retry.'); setStatus(''); }
    } finally { if (current()) setPending(false); }
  }
  function accept() {
    if (busy || pending || needsPlanning || !changed || context !== latestContext.current) return;
    try {
      const blueprint = validateBlueprint(draft);
      requestId.current++;
      apply({ blueprint, mood: blueprint.mood });
      setStatus('Blueprint applied to your arrangement.'); setError('');
    } catch (err) { setError(err.message || 'Review the blueprint controls and try applying again.'); }
  }

  const activeLayers = draft.layers.filter(layer => layer.enabled);
  return <section className={`panel production-director${isDirection ? ' production-director-direction' : ''}`} aria-labelledby={`${id}-title`}>
    <div className="panel-heading"><span className="panel-icon"><Sparkles size={17} /></span><h2 id={`${id}-title`}>AI Production Director</h2><span className="small-badge">{sourceLabel}</span></div>
    <div className="director-body">
      <div className="director-instructions">
        <span className="director-kicker">YOUR MELODY / YOUR DECISIONS</span>
        {isDirection ? <h1>Give your sound<br /> a <em>direction.</em></h1> : <h3>Build around<br /> your <em>idea.</em></h3>}
        <p>Choose the instruments around your melody. Ask for a new direction, then review and edit the blueprint.</p>
        {isDirection && <p className="director-take-summary">Captured notes <strong>{analysis.notes?.length || 0}</strong>{typeof analysis.key === 'string' && analysis.key.trim() ? <> · Estimated key {analysis.key}</> : null}</p>}
        {analysisPreview}
        <form noValidate className="director-form" onSubmit={ask}>
          <label htmlFor={`${id}-instructions`}>Production instructions</label>
          <textarea id={`${id}-instructions`} aria-label="Production instructions" rows={5} maxLength={4000} className="resize-none" style={{ resize: 'none' }}
            value={instruction} disabled={busy} aria-describedby={`${id}-prompt-help`}
            onChange={event => { interruptRequest(); setInstruction(event.target.value); }}
            placeholder="Warm acoustic guitar, gentle piano and violin in the final section. Keep the drums light…" />
          <p id={`${id}-prompt-help`} className="director-help">{needsPlanning ? 'Generate a blueprint to interpret your edited instructions.' : settings.blueprint ? 'Refine this arrangement: louder guitar, softer piano, or fewer drums.' : 'Describe a mood, instruments or how the arrangement should develop.'}</p>
          <button type="submit" className="button subtle" disabled={!instruction.trim() || pending || busy}>
            {pending ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}{pending ? 'Planning…' : 'Generate blueprint'}
          </button>
        </form>
        <p className="director-disclosure">{provider === 'rules' && result?.source !== 'ai' ? 'Local planning is configured at last check. ' : provider === 'ai' || result?.source === 'ai' ? 'AI planning is enabled. ' : provider === 'checking' ? 'Checking planner configuration. ' : 'Planner configuration is unavailable. '}
          Requests may send your instructions, settings and detected notes to the configured AI provider. Your original audio stays on this device. Instrument sounds are synthesized.</p>
      </div>

      <div className="director-blueprint">
        <div className="director-blueprint-heading"><div><span className="director-kicker">{changed ? 'EDITABLE DRAFT' : 'CURRENT BLUEPRINT'}</span><Heading>Your production<br /><em>blueprint.</em></Heading></div><Layers2 size={23} aria-hidden="true" /></div>
        {result?.summary && <p className="director-summary">{result.summary}</p>}
        {result?.notice && <p className="director-notice">{result.notice}</p>}
        <div className="director-status" role="status" aria-live="polite">{status || (settings.blueprint ? 'Edit a layer or describe a refinement. Your original lead stays selected.' : 'Start with these controls or describe your own arrangement. Review before Apply.')}</div>
        {error && <p role="alert" className="inline-error">{error}</p>}

        <fieldset className="director-character" disabled={busy}><legend>Character</legend>
          <label className="field"><span>Mood</span><div className="select-wrap"><select aria-label="Blueprint mood" value={draft.mood} onChange={event => editBlueprint({ mood: event.target.value })}>{moods.map(mood => <option key={mood}>{mood}</option>)}</select><ChevronDown size={13} /></div></label>
          <label className="field director-range"><span>Intensity <output>{percent(draft.intensity)}</output></span><input type="range" aria-label="Production intensity" min="0" max="1" step=".01" value={draft.intensity} onChange={event => editBlueprint({ intensity: Number(event.target.value) })} /></label>
        </fieldset>
        <fieldset className="director-instruments" disabled={busy}><legend>Instruments</legend><div className="director-instrument-choices">
          {LAYER_CATALOG.map(catalog => <label className="director-instrument-choice" key={catalog.id}><input id={`${id}-include-${catalog.id}`} type="checkbox" aria-label={`Include ${catalog.instrument}`} checked={Boolean(draft.layers.find(layer => layer.id === catalog.id)?.enabled)} onChange={event => toggleLayer(catalog, event.target.checked)} /><span>{catalog.label || catalog.instrument}</span></label>)}
        </div></fieldset>

        <div className="director-layers">
          {activeLayers.map(layer => {
            const catalog = LAYER_CATALOG.find(item => item.id === layer.id);
            const rendered = arrangement?.layers?.find(item => item.id === layer.id);
            const blockedReason = rendered?.blocked ? rendered.reason || rendered.blockedReason || 'Pitch evidence is limited. This pitched layer cannot play yet.' : null;
            return <fieldset className="director-layer" key={layer.id} disabled={busy}>
              <legend>{catalog.label || layer.instrument}</legend>
              <div className="director-layer-controls">
                <label className="field"><span>Role</span><div className="select-wrap"><select aria-label={`${layer.instrument} role`} value={layer.role} onChange={event => editLayer(layer.id, { role: event.target.value })}>{catalog.roles.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}</select><ChevronDown size={12} /></div></label>
                <label className="field"><span>Section</span><div className="select-wrap"><select aria-label={`${layer.instrument} section`} value={layer.section} onChange={event => editLayer(layer.id, { section: event.target.value })}><option value="full">Full arrangement</option><option value="ending">Final quarter</option></select><ChevronDown size={12} /></div></label>
                <label className="field director-range"><span>Level <output>{percent(layer.gain)}</output></span><input type="range" aria-label={`${layer.instrument} level`} min="0" max="1" step=".01" value={layer.gain} onChange={event => editLayer(layer.id, { gain: Number(event.target.value) })} /></label>
              </div>
              <div className="director-layer-actions"><span>Variation {layer.variant + 1}</span><button className="text-button" type="button" aria-label={`Regenerate ${layer.instrument}`} onClick={() => editLayer(layer.id, { variant: (layer.variant + 1) % 1000 })}><RotateCcw size={12} />Regenerate layer</button><button className="text-button" type="button" aria-label={`Remove ${layer.instrument}`} onClick={() => { toggleLayer(catalog, false); document.getElementById(`${id}-include-${layer.id}`)?.focus(); }}>Remove</button></div>
              {blockedReason && <p className="director-blocked">Not playing: {blockedReason}</p>}
            </fieldset>;
          })}
          {!activeLayers.length && <p className="director-empty">No backing instruments selected. Your melody remains the starting point.</p>}
        </div>
        <div className="director-accept"><p>{needsPlanning ? 'Your instruction has changed. Generate and review its blueprint before applying.' : 'Instrument edits and regenerated variations take effect when you Apply.'}</p><button type="button" className="button primary" disabled={busy || pending || needsPlanning || !changed} onClick={accept}>{!changed ? <Check size={15} /> : <WandSparkles size={15} />}{!changed ? 'Blueprint applied' : isDirection ? hasNotes ? 'Create my composition' : 'Apply for my next take' : 'Apply blueprint'}</button></div>
      </div>
    </div>
  </section>;
}
