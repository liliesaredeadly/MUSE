import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createReferenceLibrary } from '../server/reference-library.js';
import { createApp } from '../server/app.js';

const pitches = [60, 64, 62, 67, 65, 69, 62, 64, 71, 67, 65, 60];
const notes = pitches.map((midi, index) => ({ midi, start: index * 0.5, duration: 0.45 }));
function features() {
  return {
    version: 1, id: 'invented-reference', title: 'Invented phrase', artist: 'Test fixture',
    sourceUrl: 'https://www.youtube.com/watch?v=fixture1234', duration: 12,
    method: 'spectral-chroma', notesVerified: false, frameSeconds: 0.1,
    chroma: Array.from({ length: 120 }, (_, frame) => Array.from({ length: 12 }, (_, pitch) => pitch === pitches[Math.min(11, Math.floor(frame / 5))] % 12 && frame < 60 ? 1 : 0)),
  };
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'muse-reference-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('muse-reference-'));
    await rm(directory, { recursive: true, force: true });
  });
  return path.join(directory, 'features.json');
}

test('missing or malformed private references degrade to unavailable without exposing paths', async t => {
  const referencePath = await temporary(t);
  const library = createReferenceLibrary({ referencePath });
  assert.equal((await library.status()).available, false);
  assert.equal((await library.match(notes)).status, 'unavailable');
  await writeFile(referencePath, '{broken');
  assert.equal((await library.status()).available, false);
  await writeFile(referencePath, JSON.stringify({ ...features(), chroma: [[null]] }));
  assert.equal((await library.status()).available, false);
  assert.doesNotMatch(JSON.stringify(await library.status()), /features\.json|muse-reference-/);
});

test('returns public metadata and a candidate from the actual private features', async t => {
  const referencePath = await temporary(t);
  await writeFile(referencePath, JSON.stringify({ ...features(), audioPath: 'PRIVATE-AUDIO-PATH' }));
  const library = createReferenceLibrary({ referencePath });
  assert.deepEqual(await library.status(), { available: true, id: 'invented-reference', title: 'Invented phrase', artist: 'Test fixture', sourceUrl: 'https://www.youtube.com/watch?v=fixture1234', duration: 12, method: 'spectral-chroma', notesVerified: false });
  const result = await library.match(notes);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.id, 'invented-reference');
  assert.equal(result.candidate.notesVerified, false);
  assert.equal(Object.hasOwn(result.candidate, 'notes'), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-AUDIO-PATH|chroma|features\.json/);
  assert.equal((await library.match(notes.map(note => ({ ...note, midi: 60 })))).status, 'no-match');
});

test('HTTP reference routes validate notes and expose neither local audio nor arbitrary feature paths', async t => {
  const referencePath = await temporary(t);
  await writeFile(referencePath, JSON.stringify(features()));
  const server = createApp({ dbPath: ':memory:', referencePath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(`${url}/api/reference`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).available, true);
  const post = body => fetch(`${url}/api/reference/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const matched = await post({ notes, referencePath: '/nonexistent' });
  assert.equal(matched.status, 200);
  assert.equal((await matched.json()).status, 'candidate');
  const invalid = await post({ notes: [{ midi: 'C4', start: 0, duration: 1 }] });
  assert.equal(invalid.status, 400);
  assert.equal((await post({ notes: [] })).status, 200);
  assert.equal((await fetch(`${url}/api/reference/audio`)).status, 404);
  assert.equal((await fetch(`${url}/api/reference/match`)).status, 405);
  assert.equal((await fetch(`${url}/api/reference`, { method: 'POST' })).status, 405);
});
