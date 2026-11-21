import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/lib/api.js';

const notes = [{ midi: 60, start: 0.1, duration: 0.3 }];
const source = () => ({ conditioningId: 'take', receipt: { sha256: 'received-audio-hash' },
  notes: structuredClone(notes), audioWav: new Blob(['verified-normalized-wave']) });

test('recording lead attaches only the current received WAV to the matching source receipt', async t => {
  const original = source();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ arrangement: {
    events: [], duration: 1, recordingLead: { duration: 1, sha256: original.receipt.sha256 },
  } }));
  const arrangement = await api.arrange(notes, { leadSource: 'recording' }, original.conditioningId, original);
  assert.equal(arrangement.recordingLead.audioWav, original.audioWav);
});

test('recording lead refuses missing or mismatched original audio instead of playing a substitute', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ arrangement: {
    events: [], duration: 1, recordingLead: { duration: 1, sha256: 'different-audio' },
  } }));
  await assert.rejects(api.arrange(notes, { leadSource: 'recording' }, 'take', source()), /original|recording|match/i);
  await assert.rejects(api.arrange(notes, { leadSource: 'recording' }, 'take'), /original|recording|attach/i);
});
