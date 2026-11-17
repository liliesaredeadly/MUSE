import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, createProject, loadProjects, saveProject } from '../src/lib/projects.js';

function memoryStorage(initial) {
  let value = initial ?? null;
  return { getItem() { return value; }, setItem(_key, next) { value = next; }, read() { return value; } };
}

function melodyProject() {
  return { ...createProject(), title: 'Evening idea', notes: [{ midi: 60, name: 'C4', start: 0, duration: 0.5, confidence: 0.9 }], settings: { ...DEFAULT_SETTINGS, bpm: 110, instrument: 'Strings' } };
}

test('new projects have independent defaults and a usable identity', () => {
  const first = createProject();
  const second = createProject();
  assert.notEqual(first.id, second.id);
  assert.equal(first.title, 'Untitled melody');
  assert.deepEqual(first.notes, []);
  assert.equal(first.settings.bpm, 90);
  assert.equal(first.settings.sourceBpm, 90);
  assert.equal(first.settings.instrument, 'Piano');
  assert.equal(first.settings.mood, 'Dreamy');
  assert.equal(first.settings.genre, 'Ambient');
  assert.equal(first.settings.accompaniment, true);
  assert.equal(first.settings.percussion, false);
  first.settings.bpm = 130;
  assert.equal(second.settings.bpm, 90);
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  assert.ok(Number.isFinite(Date.parse(first.updatedAt)));
});

test('saved melody and settings reopen without original audio or extra properties', () => {
  const storage = memoryStorage();
  const source = melodyProject();
  source.originalAudio = 'private original audio';
  source.blob = { secret: 'private blob' };
  source.settings.apiKey = 'secret';
  const saved = saveProject(source, storage);
  const [reopened] = loadProjects(storage);
  assert.deepEqual(reopened, saved);
  assert.deepEqual(reopened.notes, [{ midi: 60, name: 'C4', start: 0, duration: 0.5, confidence: 0.9 }]);
  assert.equal(reopened.settings.bpm, 110);
  assert.equal(reopened.settings.instrument, 'Strings');
  assert.equal(reopened.title, 'Evening idea');
  assert.doesNotMatch(storage.read(), /private|secret|apiKey|originalAudio|blob/);
});

test('saving an existing project updates it instead of creating a duplicate', () => {
  const storage = memoryStorage();
  const source = melodyProject();
  saveProject(source, storage);
  const updated = saveProject({ ...source, title: 'Revised idea' }, storage);
  const reopened = loadProjects(storage);
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].title, 'Revised idea');
  assert.equal(reopened[0].createdAt, source.createdAt);
  assert.equal(reopened[0].updatedAt, updated.updatedAt);
});

test('corrupt, missing and unavailable storage recover as an empty library', () => {
  for (const value of [undefined, '{broken JSON', '{}', 'null', 'true', '"projects"']) {
    assert.deepEqual(loadProjects(memoryStorage(value)), []);
  }
  assert.deepEqual(loadProjects({ getItem() { throw new Error('blocked'); } }), []);
  assert.deepEqual(loadProjects(null), []);
  assert.deepEqual(loadProjects(), []);
});

test('storage write failures explain why saving failed', () => {
  assert.throws(() => saveProject(melodyProject(), null), /sav.*(unavailable|storage)|storage.*unavailable/i);
  assert.throws(() => saveProject(melodyProject(), { getItem() { return null; }, setItem() { throw new Error('Quota exceeded'); } }), /sav.*(quota|storage)|quota.*sav/i);
});

test('invalid notes and settings cannot reenter the musical engine', () => {
  const invalid = {
    ...melodyProject(),
    title: '  \u0000  ',
    notes: [null, {}, { midi: 200, start: 0, duration: 1 }, { midi: 60, start: -1, duration: 1 }, { midi: 60, start: 0, duration: -1 }, { midi: 60, start: 0, duration: 1e100 }, { midi: 60.5, start: 0, duration: 1 }, { midi: 61, name: '<script>', start: 1, duration: 0.25, confidence: 0.8 }],
    settings: { bpm: -10, sourceBpm: 'rapid', instrument: 'Trumpet', mood: '__proto__', genre: 'Metal', accompaniment: 'yes', percussion: 1 },
  };
  const [reopened] = loadProjects(memoryStorage(JSON.stringify([invalid])));
  assert.equal(reopened.title, 'Untitled melody');
  assert.deepEqual(reopened.notes, [{ midi: 61, name: 'C#4', start: 1, duration: 0.25, confidence: 0.8 }]);
  assert.deepEqual(reopened.settings, DEFAULT_SETTINGS);
});

test('malicious objects and unbounded project data are discarded or bounded', () => {
  const normal = melodyProject();
  const malicious = JSON.parse(JSON.stringify(normal).replace('"Evening idea"', '"<script>alert(1)</script>"'));
  malicious.__proto__ = { polluted: true };
  const huge = { ...normal, id: 'huge', title: 'x'.repeat(20000), notes: Array.from({ length: 10000 }, (_, index) => ({ midi: 60, start: index * 0.01, duration: 0.1, confidence: 1 })) };
  const entries = [null, false, {}, { ...normal, id: '<script>' }, malicious, huge];
  const reopened = loadProjects(memoryStorage(JSON.stringify(entries)));
  assert.equal(reopened.length, 2);
  assert.ok(reopened[1].title.length <= 100);
  assert.ok(reopened[1].notes.length <= 512);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(reopened[0], '__proto__'), false);
});

test('a library stays bounded and keeps recently saved projects', () => {
  const storage = memoryStorage();
  for (let index = 0; index < 35; index++) saveProject({ ...melodyProject(), id: `project-${index}` }, storage);
  const reopened = loadProjects(storage);
  assert.equal(reopened.length, 30);
  assert.equal(reopened[0].id, 'project-34');
  assert.equal(reopened.at(-1).id, 'project-5');
});

test('saving rejects unusable identities and loading removes duplicate identities', () => {
  const project = melodyProject();
  assert.throws(() => saveProject(null, memoryStorage()), /project/i);
  assert.throws(() => saveProject({ ...project, id: '../../bad' }, memoryStorage()), /project|identity/i);
  assert.equal(loadProjects(memoryStorage(JSON.stringify([project, project]))).length, 1);
});
