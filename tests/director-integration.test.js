import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { createProject, saveProject, loadProjects } from '../src/lib/projects.js';
import { api } from '../src/lib/api.js';

const blueprint = () => ({ version: 1, prompt: 'Acoustic guitar with soft piano', mood: 'Dreamy', intensity: 0.45,
  layers: [
    { id: 'guitar', instrument: 'Acoustic Guitar', role: 'rhythm', enabled: true, gain: 0.55, section: 'full', variant: 0 },
    { id: 'piano', instrument: 'Piano', role: 'chords', enabled: true, gain: 0.25, section: 'full', variant: 0 },
  ] });
const notes = [{ midi: 60, start: 0.12, duration: 0.4, confidence: 0.95 }, { midi: 64, start: 0.7, duration: 0.5, confidence: 0.95 }, { midi: 67, start: 1.4, duration: 0.3, confidence: 0.95 }];

async function start(t, productionDirector) {
  const server = createApp({ dbPath: ':memory:', productionDirector });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function post(url, path, body) {
  const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('Director HTTP accepts current layers and notes without exposing editable melody fields', async t => {
  let context;
  const url = await start(t, { status: () => ({ mode: 'rules' }), propose: async value => {
    context = value; return { source: 'rules', summary: 'Review this production blueprint.', blueprint: blueprint() };
  } });
  assert.equal((await fetch(`${url}/api/production-director/status`)).status, 200);
  const result = await post(url, '/api/production-director', { text: 'Make the guitar louder', notes, settings: { blueprint: blueprint(), leadSource: 'recording' } });
  assert.equal(result.status, 200);
  assert.deepEqual(context.settings.blueprint, blueprint());
  assert.equal(context.settings.leadSource, 'recording');
  assert.deepEqual(context.notes.map(({ midi, start, duration }) => ({ midi, start, duration })), notes.map(({ midi, start, duration }) => ({ midi, start, duration })));
  assert.deepEqual(result.body.blueprint, blueprint());
  assert.equal(result.body.changes, undefined);
});

test('blueprint survives SQLite save/reopen and reaches the arranger without changing the melody', async t => {
  const url = await start(t);
  const project = { ...createProject(), notes, settings: { ...createProject().settings, blueprint: blueprint() } };
  const saved = await post(url, '/api/projects', project);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.project.settings.blueprint, blueprint());
  const reopened = await (await fetch(`${url}/api/projects/${project.id}`)).json();
  assert.deepEqual(reopened.project.settings.blueprint, blueprint());
  const arranged = await post(url, '/api/arrange', { notes, settings: project.settings });
  assert.equal(arranged.status, 200);
  assert.deepEqual(arranged.body.arrangement.settings.blueprint, blueprint());
  assert.deepEqual(arranged.body.arrangement.events.filter(event => event.track === 'melody').map(({ midi, start, duration }) => ({ midi, start, duration })), notes.map(({ midi, start, duration }) => ({ midi, start, duration })));
  assert.ok(arranged.body.arrangement.events.some(event => event.layerId === 'guitar' && event.instrument === 'Acoustic Guitar'));
});

test('invalid layer controls are rejected at HTTP instead of silently changing the plan', async t => {
  const url = await start(t);
  for (const patch of [{ gain: 1.5 }, { gain: null }, { instrument: 'Unrenderable instrument' }, { section: 'somewhere' }, { variant: -1 }]) {
    const bad = blueprint(); Object.assign(bad.layers[0], patch);
    assert.equal((await post(url, '/api/arrange', { notes, settings: { blueprint: bad } })).status, 400);
    assert.equal((await post(url, '/api/projects', { ...createProject(), notes, settings: { blueprint: bad } })).status, 400);
  }
});

test('browser project persistence retains the validated blueprint and refuses invalid new saves', () => {
  let value = null; const storage = { getItem: () => value, setItem: (_key, next) => { value = next; } };
  const project = { ...createProject(), notes, settings: { ...createProject().settings, leadSource: 'recording', blueprint: blueprint() } };
  saveProject(project, storage);
  const [loaded] = loadProjects(storage);
  assert.deepEqual(loaded.settings.blueprint, blueprint());
  assert.equal(loaded.settings.leadSource, 'recording');
  assert.equal(loaded.recordingLead, undefined);
  const bad = blueprint(); bad.layers[0].gain = Infinity;
  assert.throws(() => saveProject({ ...project, settings: { ...project.settings, blueprint: bad } }, storage), /gain|layer|blueprint/i);
});

test('Director API sends the complete production context and exposes server status', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return Response.json(options.body ? { blueprint: blueprint(), source: 'rules' } : { mode: 'rules' }); });
  assert.deepEqual(await api.productionDirectorStatus(), { mode: 'rules' });
  const settings = { leadSource: 'recording', blueprint: blueprint() };
  const result = await api.productionDirector('Soften the piano', settings, notes);
  assert.deepEqual(result.blueprint, blueprint());
  assert.equal(requests[0].url, '/api/production-director/status');
  assert.equal(requests[1].url, '/api/production-director');
  assert.deepEqual(JSON.parse(requests[1].options.body), { text: 'Soften the piano', settings, notes });
});
