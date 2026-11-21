import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/lib/api.js';

test('a request deadline reports a timeout rather than a missing MUSE server', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Deadline exceeded', 'TimeoutError'); });
  await assert.rejects(api.health(), /timed out|timeout/i);
});

test('a deadline while reading JSON remains a timeout rather than unreadable server data', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    async json() {
      controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
      throw new DOMException('The response stream was aborted', 'AbortError');
    },
  }));
  await assert.rejects(api.health(), /timed out|timeout/i);
});

test('invalid server data keeps its distinct response error', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>error</html>', { status: 502 }));
  await assert.rejects(api.health(), /unreadable response/i);
});

test('HTTP failures retain their status for expired recording recovery', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Take expired' }, { status: 410 }));
  await assert.rejects(api.arrange([], {}, 'expired'), error => error.status === 410 && /expired/i.test(error.message));
});

const notes = [{ midi: 60, start: 0.1, duration: 0.3, contour: [{ time: 0, frequency: 261.626 }] }];
const retainedRecording = () => ({ blob: new Blob(['the same encoded take']), duration: 0.6, conditioningId: 'expired',
  receipt: { sha256: 'original-fingerprint' }, notes: structuredClone(notes) });

function recoveryService(t, { changedAudio = false, changedNotes = false, expireAgain = false } = {}) {
  const requests = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioContext');
  Object.defineProperty(globalThis, 'OfflineAudioContext', { configurable: true, writable: true, value: class { async decodeAudioData() { return {
    sampleRate: 16000, length: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(16000).fill(0.1),
  }; } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'OfflineAudioContext', descriptor) : delete globalThis.OfflineAudioContext);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    if (url === '/api/melody/analyze') {
      const wav = new Uint8Array(await options.body.arrayBuffer());
      assert.equal(new DataView(wav.buffer).getUint32(40, true), 19200, 'Recovery must retain the original 0.6-second cutoff.');
      return Response.json({ conditioningId: 'renewed', receipt: { sha256: changedAudio ? 'different-fingerprint' : 'original-fingerprint' },
        analysis: { notes: changedNotes ? [{ ...notes[0], midi: 61 }] : structuredClone(notes) } });
    }
    const body = JSON.parse(options.body);
    assert.deepEqual(body.notes, notes);
    if (body.conditioningId === 'expired' || expireAgain) return Response.json({ error: 'Take expired' }, { status: 410 });
    assert.equal(body.conditioningId, 'renewed');
    return Response.json({ arrangement: { exactSource: true } });
  });
  return requests;
}

test('an expired take reanalyzes the retained original once and retries its unchanged melody', async t => {
  const requests = recoveryService(t);
  const source = retainedRecording();
  assert.deepEqual(await api.arrange(notes, { bpm: 90 }, 'expired', source), { exactSource: true });
  assert.equal(source.conditioningId, 'renewed');
  assert.deepEqual(requests, ['/api/arrange', '/api/melody/analyze', '/api/arrange']);
  await api.arrange(notes, { bpm: 110 }, 'expired', source);
  assert.equal(requests.filter(url => url === '/api/melody/analyze').length, 1, 'The new source ID should survive subsequent settings edits.');
});

test('overlapping expiry recoveries share one analysis of the same retained audio', async t => {
  const requests = recoveryService(t);
  const source = retainedRecording();
  const results = await Promise.all([api.arrange(notes, { bpm: 90 }, 'expired', source), api.arrange(notes, { bpm: 110 }, 'expired', source)]);
  assert.deepEqual(results, [{ exactSource: true }, { exactSource: true }]);
  assert.equal(requests.filter(url => url === '/api/melody/analyze').length, 1);
});

test('an expired take without its original audio does not retry without conditioning', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    assert.equal(JSON.parse(options.body).conditioningId, 'expired');
    return Response.json({ error: 'Take expired' }, { status: 410 });
  });
  await assert.rejects(api.arrange(notes, {}, 'expired'), error => error.status === 410);
  assert.deepEqual(requests, ['/api/arrange']);
});

for (const changed of ['changedAudio', 'changedNotes', 'expireAgain']) {
  test(`expiry recovery refuses substitution or an unlimited retry: ${changed}`, async t => {
    const requests = recoveryService(t, { [changed]: true });
    await assert.rejects(api.arrange(notes, {}, 'expired', retainedRecording()), /same|changed|expired|original|match/i);
    assert.equal(requests.filter(url => url === '/api/melody/analyze').length, 1);
    assert.equal(requests.filter(url => url === '/api/arrange').length, changed === 'expireAgain' ? 2 : 1);
  });
}
