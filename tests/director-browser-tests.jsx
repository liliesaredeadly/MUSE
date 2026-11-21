import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProductionDirector from '../src/components/ProductionDirector.jsx';
import { api } from '../src/lib/api.js';
import { DEFAULT_SETTINGS } from '../src/lib/projects.js';
import { createBlueprint, LAYER_CATALOG } from '../src/producer/production-blueprint.js';
import '../src/styles.css';
import '../src/styles/reference-shell.css';
import '../src/styles/reference-studio.css';
import '../src/styles/atelier.css';
import '../src/styles/production-director.css';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const notes = [{ midi: 60, name: 'C4', start: .2, duration: .5, confidence: .95 }];
async function waitFor(check, message) {
  const end = performance.now() + 5000;
  while (performance.now() < end) { if (check()) return; await sleep(20); }
  throw new Error(message);
}
function button(host, name) {
  const found = [...host.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') || item.textContent.trim()) === name);
  assert(found, `Missing action: ${name}`);
  return found;
}
function change(host, name, value) {
  const field = host.querySelector(`[aria-label="${name}"]`);
  assert(field, `Missing field: ${name}`);
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
async function withDirector(action, { planner, settings = DEFAULT_SETTINGS, status, arrangement } = {}) {
  const originalPlanner = api.productionDirector;
  const originalStatus = api.productionDirectorStatus;
  api.productionDirector = planner || (async (text, current) => ({ blueprint: { ...createBlueprint(current), prompt: text }, summary: 'Fixture plan', source: 'rules' }));
  api.productionDirectorStatus = status || (async () => ({ mode: 'rules' }));
  const host = document.createElement('div');
  host.className = 'reference-page-studio';
  document.getElementById('director-harness').append(host);
  const root = createRoot(host);
  let latest;
  const applied = [];
  function Harness() {
    const [current, setCurrent] = useState(structuredClone(settings));
    const [analysis, setAnalysis] = useState({ notes: structuredClone(notes), sourceId: 'source-a' });
    useLayoutEffect(() => { latest = { settings: current, setCurrent, setAnalysis }; });
    return <ProductionDirector settings={current} analysis={analysis} hasNotes busy={false} arrangement={arrangement} apply={changes => {
      applied.push(structuredClone(changes)); setCurrent(previous => ({ ...previous, ...changes }));
    }} />;
  }
  root.render(<Harness />);
  try {
    await waitFor(() => latest && host.querySelector('[aria-label="Production instructions"]'), 'Director did not render.');
    return await action(() => latest, host, applied);
  } finally {
    root.unmount(); host.remove(); api.productionDirector = originalPlanner; api.productionDirectorStatus = originalStatus;
    await sleep(20);
  }
}

const checks = [
  ['manual-draft-acceptance', async () => {
    await withDirector(async (get, host, applied) => {
      assert(host.querySelectorAll('.director-instrument-choice input').length === LAYER_CATALOG.length, 'The complete instrument catalog is unavailable.');
      const guitar = host.querySelector('[aria-label="Include Acoustic Guitar"]');
      if (!guitar.checked) guitar.click();
      await waitFor(() => host.querySelector('[aria-label="Acoustic Guitar level"]'), 'Adding guitar did not expose editable controls.');
      change(host, 'Acoustic Guitar level', '.82');
      change(host, 'Acoustic Guitar section', 'ending');
      change(host, 'Production intensity', '.72');
      await sleep(30);
      assert(applied.length === 0 && !get().settings.blueprint, 'Editing a draft applied it before acceptance.');
      button(host, 'Apply blueprint').click();
      await waitFor(() => applied.length === 1 && get().settings.blueprint, 'Accepting the draft did not update the project.');
      const layer = get().settings.blueprint.layers.find(item => item.id === 'guitar');
      assert(layer.enabled && layer.gain === .82 && layer.section === 'ending' && get().settings.blueprint.intensity === .72, 'Acceptance lost the edited instrument values.');
      assert(host.querySelector('[aria-label="Acoustic Guitar level"]').value === '.82' || Number(host.querySelector('[aria-label="Acoustic Guitar level"]').value) === .82, 'Applying reset the accepted blueprint controls.');
      assert(get().settings.leadSource === 'recording', 'Blueprint acceptance changed the original-hum lead.');
    }, { settings: { ...DEFAULT_SETTINGS, leadSource: 'recording' }, status: async () => { throw new Error('Status unavailable'); } });
  }],
  ['planner-review-and-refinement-context', async () => {
    let sent;
    await withDirector(async (get, host, applied) => {
      change(host, 'Production instructions', 'Warm guitar, gentle piano and strings at the end.');
      button(host, 'Generate blueprint').click();
      await waitFor(() => host.textContent.includes('Review this fixture blueprint.'), 'The planner draft did not appear.');
      assert(applied.length === 0, 'The planner response applied its draft automatically.');
      assert(sent.settings.blueprint && sent.text.includes('Warm guitar'), 'Planning did not receive the editable blueprint context.');
      same(sent.notes, notes, 'Planning changed or omitted the actual detected notes.');
      button(host, 'Apply blueprint').click();
      await waitFor(() => applied.length === 1, 'The reviewed plan cannot be applied.');
      const before = structuredClone(get().settings.blueprint.layers);
      const target = before.find(layer => layer.enabled) || before[0];
      button(host, `Regenerate ${LAYER_CATALOG.find(layer => layer.id === target.id).instrument}`).click();
      await sleep(30);
      assert(applied.length === 1, 'A variation bypassed draft review.');
      button(host, 'Apply blueprint').click();
      await waitFor(() => applied.length === 2, 'The regenerated layer cannot be accepted.');
      const after = get().settings.blueprint.layers;
      same(after.filter(layer => layer.id !== target.id), before.filter(layer => layer.id !== target.id), 'Regenerating one layer changed another layer.');
      assert(after.find(layer => layer.id === target.id).variant === (target.variant + 1) % 1000, 'Regeneration did not select the next deterministic variation.');
    }, { planner: async (text, settings, sourceNotes) => {
      sent = { text, settings: structuredClone(settings), notes: structuredClone(sourceNotes) };
      return { blueprint: { ...createBlueprint(settings), prompt: text }, source: 'ai', summary: 'Review this fixture blueprint.' };
    } });
  }],
  ['stale-request-cannot-replace-edits-or-source', async () => {
    const first = deferred(); const second = deferred(); let requests = 0;
    await withDirector(async (get, host, applied) => {
      change(host, 'Production instructions', 'Guitar and piano.');
      button(host, 'Generate blueprint').click();
      await waitFor(() => requests === 1, 'First request was not submitted.');
      change(host, 'Production intensity', '.91');
      first.resolve({ blueprint: { ...createBlueprint(get().settings), intensity: .1 }, source: 'ai', summary: 'Stale edited request' });
      await sleep(80);
      assert(Number(host.querySelector('[aria-label="Production intensity"]').value) === .91 && !host.textContent.includes('Stale edited request'), 'An old response replaced a newer manual draft.');
      button(host, 'Generate blueprint').click();
      await waitFor(() => requests === 2, 'Second request was not submitted.');
      get().setAnalysis({ notes: structuredClone(notes), sourceId: 'source-b' });
      await sleep(40);
      second.resolve({ blueprint: { ...createBlueprint(get().settings), intensity: .05 }, source: 'ai', summary: 'Stale source request' });
      await sleep(80);
      assert(!host.textContent.includes('Stale source request') && applied.length === 0, 'A previous source response was accepted into the new source.');
    }, { planner: () => ++requests === 1 ? first.promise : second.promise });
  }],
  ['invalid-output-is-recoverable', async () => {
    await withDirector(async (get, host, applied) => {
      change(host, 'Production instructions', 'Try an arrangement.');
      button(host, 'Generate blueprint').click();
      await waitFor(() => host.querySelector('[role="alert"]'), 'Invalid output did not expose a recoverable error.');
      assert(applied.length === 0 && !get().settings.blueprint, 'Malformed output changed the accepted project.');
      assert(!button(host, 'Generate blueprint').disabled, 'A failed planner request cannot be retried.');
    }, { planner: async () => ({ blueprint: { version: 1, intensity: 9 }, source: 'ai', summary: 'Invalid' }) });
  }],
  ['instructions-require-replanning-and-blocked-layers-explain-why', async () => {
    const blueprint = createBlueprint(DEFAULT_SETTINGS);
    const target = blueprint.layers.find(layer => layer.id !== 'drums');
    const reason = 'Fixture pitch evidence is too limited for reliable harmony.';
    await withDirector(async (get, host, applied) => {
      assert(host.textContent.includes(reason), 'The rendered pitched-layer restriction is hidden.');
      change(host, 'Production instructions', 'A different production instruction.');
      change(host, 'Production intensity', '.8');
      await sleep(40);
      assert(button(host, 'Apply blueprint').disabled, 'Edited instructions can be accepted without interpretation.');
      assert(applied.length === 0 && get().settings.blueprint.intensity === .5, 'Uninterpreted text changed the accepted composition.');
    }, { settings: { ...DEFAULT_SETTINGS, blueprint }, arrangement: { layers: [{ ...target, blocked: true, reason }] } });
  }],
];

document.getElementById('run').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  const results = [];
  const output = document.getElementById('results');
  for (const [id, run] of checks) {
    output.textContent = `Running ${id}…`;
    try { await run(); results.push({ id, status: 'passed' }); }
    catch (error) { results.push({ id, status: 'failed', error: error.message }); }
  }
  window.__directorResults = results;
  output.textContent = JSON.stringify(results, null, 2);
  document.getElementById('run').disabled = false;
});
