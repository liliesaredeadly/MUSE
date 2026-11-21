// Isolated developer fixtures. These are not imported by the product.
import React, { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useStudio } from '../src/hooks/useStudio.js';
import { api } from '../src/lib/api.js';
import { createProject } from '../src/lib/projects.js';
import { CapturePanel, HumExperience } from '../src/components/Studio.jsx';
import '../src/styles.css';
import '../src/styles/reference-shell.css';
import '../src/styles/reference-studio.css';
import '../src/styles/atelier.css';
import '../src/styles/reference-match.css';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reference = { available: true, id: 'synthetic-reference', title: 'QA reference', artist: 'QA artist', sourceUrl: 'https://www.youtube.com/watch?v=synthetic', notesVerified: false };
const candidate = { ...reference, start: 34.2, end: 42.6, similarity: .814, transpose: -2 };
const notes = [60, 64, 67, 65, 62, 69, 64, 60].map((midi, index) => ({ midi, name: `QA ${midi}`, start: index * .8, duration: .6, confidence: .95 }));
const fixture = () => ({ ...createProject(), id: 'reference-browser-fixture', title: 'Reference QA', notes: notes.map(note => ({ ...note })) });

async function waitFor(check, message) {
  const end = performance.now() + 5000;
  while (performance.now() < end) { if (check()) return; await sleep(20); }
  throw new Error(message);
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function button(host, name) {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent.trim() === name);
  assert(found, `Missing action: ${name}`);
  return found;
}

async function withStudio(action, { match = async () => ({ status: 'candidate', candidate }), status = async () => reference, hum = false, optionalApi = false } = {}) {
  const originalFetch = globalThis.fetch;
  const originalStatus = api.referenceStatus;
  const originalMatch = api.matchReference;
  let matchCalls = 0;
  api.referenceStatus = optionalApi ? undefined : status;
  api.matchReference = async value => { matchCalls++; return match(value); };
  globalThis.fetch = async (input, options = {}) => {
    const path = new URL(input, location.href).pathname;
    if (path === '/api/health') return response({ status: 'ok' });
    if (path === '/api/projects' && !options.body) return response({ projects: [] });
    if (path === '/api/projects') return response({ project: JSON.parse(options.body) });
    throw new Error(`Unexpected isolated reference request: ${path}`);
  };
  const host = document.createElement('div');
  host.className = hum ? 'reference-page-hum' : 'reference-page-studio';
  document.getElementById('reference-harness').append(host);
  let latest;
  const root = createRoot(host);
  function Harness() {
    const studio = useStudio();
    useLayoutEffect(() => { latest = studio; });
    return hum ? <HumExperience studio={studio} /> : <CapturePanel studio={studio} />;
  }
  root.render(<Harness />);
  try {
    await waitFor(() => latest?.serverState === 'ready' && latest.reference.status !== 'loading', 'Reference harness did not become ready.');
    return await action(() => latest, host, () => matchCalls);
  } finally {
    root.unmount(); host.remove(); globalThis.fetch = originalFetch;
    api.referenceStatus = originalStatus; api.matchReference = originalMatch;
    await sleep(20);
  }
}

const checks = [
  ['candidate-and-no-match', async () => {
    let matches = 0;
    await withStudio(async (get, host) => {
      assert(button(host, 'Compare my hum').disabled, 'An empty melody can be compared.');
      await get().openProject(fixture());
      await waitFor(() => !button(host, 'Compare my hum').disabled, 'The captured melody cannot be compared.');
      const originalNotes = JSON.stringify(get().project.notes);
      button(host, 'Compare my hum').focus();
      assert(document.activeElement === button(host, 'Compare my hum'), 'Compare cannot receive keyboard focus.');
      button(host, 'Compare my hum').click();
      await waitFor(() => host.querySelector('.reference-match-candidate'), 'Possible match was not shown.');
      assert(host.textContent.includes('Exact reference notes have not been verified.'), 'The candidate does not explain its note-transcription limit.');
      assert(!host.textContent.includes('0.814') && !host.textContent.includes('81.4%'), 'A raw similarity or confidence score is shown to the user.');
      assert(host.querySelector('.reference-match-candidate a').href.endsWith('&t=34s'), 'The source does not link to the suggested segment.');
      assert(JSON.stringify(get().project.notes) === originalNotes, 'Comparison replaced the captured notes.');
      button(host, 'Compare my hum').click();
      await waitFor(() => get().referenceMatch.status === 'no-match', 'No-match did not settle.');
      assert(!host.querySelector('.reference-match-candidate') && host.textContent.includes('No distinctive phrase'), 'No-match kept the old candidate or lost its reason.');
    }, { match: async () => ++matches === 1 ? { status: 'candidate', candidate } : { status: 'no-match', reason: 'No distinctive phrase. Try a longer hum.' } });
  }],
  ['stale-edit-and-duplicate', async () => {
    const pending = deferred();
    await withStudio(async (get, host, calls) => {
      await get().openProject(fixture());
      await waitFor(() => get().project.notes.length === notes.length, 'Fixture did not open.');
      get().compareReference(); get().compareReference();
      await waitFor(() => get().referenceMatch.status === 'matching', 'The pending state was not exposed.');
      assert(calls() === 1 && button(host, 'Comparing…').disabled, 'A duplicate comparison was submitted.');
      get().updateNote(0, 1);
      await waitFor(() => get().referenceMatch.status === 'idle', 'A note edit did not clear the comparison.');
      pending.resolve({ status: 'candidate', candidate });
      await sleep(80);
      assert(get().referenceMatch.status === 'idle' && !host.querySelector('.reference-match-candidate'), 'A stale candidate returned after a note edit.');
    }, { match: () => pending.promise });
  }],
  ['project-switch-clears-match', async () => {
    await withStudio(async (get, host) => {
      await get().openProject(fixture());
      await waitFor(() => get().project.notes.length === notes.length, 'Fixture did not open.');
      await get().compareReference();
      await waitFor(() => host.querySelector('.reference-match-candidate'), 'Candidate did not appear.');
      await get().openProject(get().project);
      await waitFor(() => get().referenceMatch.status === 'idle', 'Reopening a project kept the old candidate.');
      await get().compareReference();
      await waitFor(() => get().referenceMatch.status === 'candidate', 'Second candidate did not appear.');
      await get().newProject();
      await waitFor(() => !get().project.notes.length && get().referenceMatch.status === 'idle', 'A new project kept the old reference result.');
    });
  }],
  ['network-retry-and-optional-api', async () => {
    let attempts = 0;
    await withStudio(async (get, host) => {
      await waitFor(() => host.textContent.includes('Reference network fixture unavailable'), 'Status failure was not visible.');
      button(host, 'Retry reference check').click();
      await waitFor(() => get().reference.available, 'Reference retry did not recover.');
      await get().openProject(fixture());
      await waitFor(() => get().project.notes.length === notes.length, 'Fixture did not open.');
      await get().compareReference();
      await waitFor(() => host.textContent.includes('Comparison network fixture unavailable'), 'Comparison failure was not visible.');
      assert(!button(host, 'Compare my hum again').disabled, 'A failed comparison cannot be retried.');
    }, { status: async () => { if (++attempts === 1) throw new Error('Reference network fixture unavailable'); return reference; }, match: async () => { throw new Error('Comparison network fixture unavailable'); } });
    await withStudio(async (get, host) => {
      assert(get().reference.status === 'unavailable' && host.textContent.includes('No local reference'), 'An absent optional API broke the capture panel.');
      assert(!get().error && get().serverState === 'ready', 'Optional reference absence broke the main studio connection.');
    }, { optionalApi: true });
  }],
  ['captured-hum-panel', async () => {
    await withStudio(async (get, host) => {
      assert(host.querySelector('.hum-stage-recorder .reference-match'), 'Empty HUM has no reference panel.');
      await get().openProject(fixture());
      await waitFor(() => host.querySelector('.hum-analysis-result .reference-match'), 'Captured HUM has no reference panel.');
      assert(!button(host, 'Compare my hum').disabled, 'Captured HUM cannot compare its notes.');
    }, { hum: true });
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
  window.__referenceResults = results;
  output.textContent = JSON.stringify(results, null, 2);
  document.getElementById('run').disabled = false;
});
