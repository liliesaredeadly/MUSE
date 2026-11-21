import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicGenJobController, describeModelAvailability } from '../src/hooks/useMusicGenJob.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let step = 0; step < 20; step++) await Promise.resolve(); };
function setup(overrides = {}, { makeRequestId = () => 'request-a' } = {}) {
  let identity = 'project-a:hash-a';
  const source = { conditioningId: 'take-a', receipt: { sha256: 'hash-a' } };
  const tasks = new Map(); let next = 0; const revoked = [];
  const job = (status = 'running', extra = {}) => ({ id: 'job-a', requestId: 'request-a', status,
    stage: status === 'succeeded' ? 'ready' : 'generating', conditioning: { audioSha256: 'hash-a' }, elapsedSeconds: 3, ...extra });
  const client = { createGenerationJob: async () => job(), generationJob: async () => job(),
    cancelGenerationJob: async () => job('cancelled'), generationAudio: async () => ({ blob: new Blob(['real WAV fixture boundary']), duration: 5 }), ...overrides };
  const controller = createMusicGenJobController({ client, getIdentity: () => identity, getSource: () => source,
    schedule: callback => { const id = ++next; tasks.set(id, callback); return id; }, unschedule: id => tasks.delete(id),
    createUrl: () => `blob:result-${next++}`, revokeUrl: url => revoked.push(url), makeRequestId });
  return { controller, client, source, job, tasks, revoked, setIdentity(value) { identity = value; controller.reset(); },
    async tick() { const entry = tasks.entries().next().value; assert.ok(entry, 'No status poll scheduled'); tasks.delete(entry[0]); await entry[1](); } };
}

test('duplicate start is blocked while stages follow only server reports', async () => {
  const create = deferred(); let calls = 0;
  const fixture = setup({ createGenerationJob: () => { calls++; return create.promise; } });
  const first = fixture.controller.start({ text: 'Piano', duration: 5 });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  assert.equal(calls, 1);
  assert.equal(fixture.controller.getSnapshot().status, 'submitting');
  create.resolve(fixture.job()); await first;
  await fixture.tick();
  assert.equal(fixture.controller.getSnapshot().job.stage, 'generating');
  assert.equal(fixture.controller.getSnapshot().job.progress, undefined);
  fixture.controller.dispose();
});

test('uncertain submission reconnects with the same request identity and cannot create a duplicate', async () => {
  let calls = 0; const payloads = [];
  const fixture = setup({ createGenerationJob: async payload => { payloads.push({ ...payload }); if (++calls === 1) throw new Error('Connection lost'); return fixture.job(); } });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  assert.equal(fixture.controller.getSnapshot().status, 'uncertain');
  await fixture.controller.reconnect();
  assert.deepEqual(payloads[0], payloads[1]);
  assert.equal(fixture.controller.getSnapshot().status, 'running');
  fixture.controller.dispose();
});

test('cancelling is pending until the server confirms a terminal status', async () => {
  const fixture = setup({ cancelGenerationJob: async () => fixture.job('cancelling') });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  await fixture.controller.cancel();
  assert.equal(fixture.controller.getSnapshot().status, 'cancelling');
  fixture.client.cancelGenerationJob = async () => fixture.job('cancelled');
  await fixture.tick();
  assert.equal(fixture.controller.getSnapshot().status, 'cancelled');
  assert.equal(fixture.tasks.size, 0);
  fixture.controller.dispose();
});

test('source change cancels an accepted stale job and never exposes its result', async () => {
  const create = deferred(); const cancelled = [];
  const fixture = setup({ createGenerationJob: () => create.promise, cancelGenerationJob: async id => { cancelled.push(id); return fixture.job('cancelled'); } });
  const pending = fixture.controller.start({ text: 'Piano', duration: 5 });
  fixture.setIdentity('project-b:hash-b');
  create.resolve(fixture.job('succeeded')); await pending;
  assert.deepEqual(cancelled, ['job-a']);
  assert.equal(fixture.controller.getSnapshot().result, null);
  assert.equal(fixture.controller.getSnapshot().status, 'idle');
  fixture.controller.dispose();
});

test('failed regeneration retains the usable preview and original source', async () => {
  const fixture = setup({ createGenerationJob: async () => fixture.job('succeeded') });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  const previous = fixture.controller.getSnapshot().result;
  assert.ok(previous?.audioUrl);
  fixture.client.createGenerationJob = async () => fixture.job('failed', { error: { message: 'Model timed out', retryable: true } });
  await fixture.controller.start({ text: 'Softer piano', duration: 5 });
  assert.equal(fixture.controller.getSnapshot().status, 'failed');
  assert.equal(fixture.controller.getSnapshot().result, previous);
  assert.equal(fixture.source.conditioningId, 'take-a');
  assert.deepEqual(fixture.revoked, []);
  fixture.controller.dispose();
  assert.deepEqual(fixture.revoked, [previous.audioUrl]);
});

test('mismatched conditioning and invalid audio never replace the prior preview', async () => {
  const fixture = setup({ createGenerationJob: async () => fixture.job('succeeded') });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  const previous = fixture.controller.getSnapshot().result;
  fixture.client.createGenerationJob = async () => fixture.job('succeeded', { conditioning: { audioSha256: 'other-source' } });
  await fixture.controller.start({ text: 'Strings', duration: 5 });
  assert.match(fixture.controller.getSnapshot().error, /recording|source|match/i);
  assert.equal(fixture.controller.getSnapshot().result, previous);
  fixture.client.createGenerationJob = async () => fixture.job('succeeded');
  fixture.client.generationAudio = async () => { throw new Error('Invalid WAV'); };
  await fixture.controller.start({ text: 'Strings', duration: 5 });
  assert.match(fixture.controller.getSnapshot().error, /WAV/);
  assert.equal(fixture.controller.getSnapshot().result, previous);
  fixture.controller.dispose();
});

test('a disconnected poll keeps the active job recoverable without starting another', async () => {
  let starts = 0;
  const fixture = setup({ createGenerationJob: async () => { starts++; return fixture.job(); }, generationJob: async () => { throw new Error('Server disconnected'); } });
  await fixture.controller.start({ text: 'Piano', duration: 5 }); await fixture.tick();
  assert.equal(fixture.controller.getSnapshot().status, 'running');
  assert.match(fixture.controller.getSnapshot().connectionError, /disconnected/);
  fixture.client.generationJob = async () => fixture.job('succeeded');
  await fixture.controller.reconnect();
  assert.equal(fixture.controller.getSnapshot().status, 'ready');
  assert.equal(starts, 1);
  fixture.controller.dispose();
});

test('a failed audio download retries the finished job without running inference again', async () => {
  let starts = 0; let downloads = 0;
  const fixture = setup({ createGenerationJob: async () => { starts++; return fixture.job('succeeded'); },
    generationAudio: async () => { if (++downloads === 1) throw new Error('Download interrupted'); return { blob: new Blob(['verified WAV']), duration: 5 }; } });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  assert.equal(fixture.controller.getSnapshot().status, 'failed');
  await fixture.controller.reconnect();
  assert.equal(fixture.controller.getSnapshot().status, 'ready');
  assert.equal(starts, 1);
  assert.equal(downloads, 2);
  fixture.controller.dispose();
});

test('a reachable lazy-loading job service can start a preview without claiming loaded readiness', () => {
  const availability = describeModelAvailability({ configured: true, reachable: true, ready: false,
    status: 'not-loaded', capabilities: ['jobs', 'progress', 'cancel'] });
  assert.equal(availability.canSubmit, true);
  assert.equal(availability.ready, false);
  assert.equal(availability.status, 'not-loaded');
  for (const properties of [{ reachable: false }, { configured: false }, { capabilities: [] }, { status: 'error' }]) {
    assert.equal(describeModelAvailability({ configured: true, reachable: true, ready: false, status: 'not-loaded', capabilities: ['jobs'], ...properties }).canSubmit, false);
  }
});

test('known model availability codes become readable recovery messages while retaining their code', () => {
  for (const [code, recovery] of [['not-configured', /set.?up/i], ['invalid-endpoint', /connection|set.?up/i], ['service-unavailable', /not responding|start/i]]) {
    const availability = describeModelAvailability({ configured: false, reachable: false, ready: false, reason: code });
    assert.equal(availability.reasonCode, code);
    assert.notEqual(availability.reason, code);
    assert.match(availability.reason, recovery);
    assert.doesNotMatch(availability.reason, /https?:\/\/|api.?key|password|token|127\.0\.0\.1/i);
    assert.equal(availability.canSubmit, false);
  }
  assert.equal(describeModelAvailability({ reason: 'A readable server message.' }).reason, 'A readable server message.');
});

test('reset recovers an uncertain accepted request with the same payload and cancels it without attaching to the new source', async () => {
  const recovery = deferred(); const creates = []; const cancelled = [];
  const fixture = setup({ createGenerationJob: async (payload, source) => {
    creates.push({ payload: structuredClone(payload), conditioningId: source.conditioningId });
    if (creates.length === 1) throw new Error('Acknowledgement lost');
    return recovery.promise;
  }, cancelGenerationJob: async id => { cancelled.push(id); return fixture.job('cancelled'); } });
  await fixture.controller.start({ text: 'Piano', duration: 5, settings: { mood: 'Dreamy' } });
  assert.equal(fixture.controller.getSnapshot().status, 'uncertain');
  fixture.setIdentity('project-b:hash-b');
  assert.equal(creates.length, 2, 'Detached recovery must retain the original stable request');
  assert.deepEqual(creates[1], creates[0]);
  recovery.resolve(fixture.job()); await flush();
  assert.deepEqual(cancelled, ['job-a']);
  assert.equal(fixture.controller.getSnapshot().status, 'idle');
  assert.equal(fixture.controller.getSnapshot().job, null);
  assert.equal(fixture.controller.getSnapshot().result, null);
  fixture.controller.dispose();
});

test('reset before a creation loses its response still recovers and cancels the detached request', async () => {
  const acknowledgement = deferred(); let creates = 0; const cancelled = [];
  const fixture = setup({ createGenerationJob: async () => ++creates === 1 ? acknowledgement.promise : fixture.job(),
    cancelGenerationJob: async id => { cancelled.push(id); return fixture.job('cancelled'); } });
  const pending = fixture.controller.start({ text: 'Piano', duration: 5 });
  fixture.setIdentity('project-b:hash-b');
  acknowledgement.reject(new Error('Connection closed before acknowledgement'));
  await pending; await flush();
  assert.equal(creates, 2);
  assert.deepEqual(cancelled, ['job-a']);
  assert.equal(fixture.controller.getSnapshot().status, 'idle');
  fixture.controller.dispose();
});

test('detached uncertain recovery is bounded when the server stays unavailable', async () => {
  let creates = 0;
  const fixture = setup({ createGenerationJob: async () => { creates++; throw new Error('Server unavailable'); } });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  fixture.setIdentity('project-b:hash-b'); await flush();
  assert.equal(creates, 4, 'One original attempt plus at most three detached attempts');
  assert.equal(fixture.tasks.size, 0);
  assert.equal(fixture.controller.getSnapshot().status, 'idle');
  fixture.controller.dispose();
});

test('detached recovery refuses a different source and never renews expired raw audio', async () => {
  for (const expired of [false, true]) {
    let creates = 0; let cancelled = 0; const recoverySources = [];
    const fixture = setup({ createGenerationJob: async (_payload, source) => {
      if (++creates === 1) throw new Error('Acknowledgement lost');
      recoverySources.push(source);
      if (expired) throw Object.assign(new Error('Take expired'), { status: 410 });
      return fixture.job('running', { conditioning: { audioSha256: 'other-source' } });
    }, cancelGenerationJob: async () => { cancelled++; return fixture.job('cancelled'); } });
    fixture.source.blob = new Blob(['retained original recording']);
    await fixture.controller.start({ text: 'Piano', duration: 5 });
    fixture.setIdentity('project-b:hash-b'); await flush();
    assert.equal(creates, 2);
    assert.equal(cancelled, 0);
    assert.equal(recoverySources[0].blob, undefined);
    assert.equal(recoverySources[0].conditioningId, 'take-a');
    assert.equal(fixture.controller.getSnapshot().result, null);
    fixture.controller.dispose();
  }
});

test('a completed remote job stops offering cancellation while its audio loads', async () => {
  const fixture = setup({ createGenerationJob: async () => fixture.job('succeeded') });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  const previous = fixture.controller.getSnapshot().result;
  const audio = deferred(); let cancelled = 0;
  fixture.client.generationAudio = async () => audio.promise;
  fixture.client.cancelGenerationJob = async () => { cancelled++; return fixture.job('cancelled'); };
  const pending = fixture.controller.start({ text: 'Soft strings', duration: 5 }); await flush();
  assert.equal(fixture.controller.getSnapshot().status, 'loading-audio');
  assert.equal(fixture.controller.getSnapshot().active, false);
  await fixture.controller.cancel();
  assert.equal(fixture.controller.getSnapshot().status, 'loading-audio');
  assert.equal(cancelled, 0);
  assert.equal(fixture.controller.getSnapshot().result, previous);
  audio.resolve({ blob: new Blob(['verified WAV']), duration: 5 }); await pending;
  assert.equal(fixture.controller.getSnapshot().status, 'ready');
  assert.notEqual(fixture.controller.getSnapshot().result, previous);
  assert.deepEqual(fixture.revoked, [previous.audioUrl]);
  fixture.controller.dispose();
});

test('three consecutive failed polls pause automatically and manual recovery resumes the same job', async () => {
  let starts = 0; let reads = 0; let online = false;
  const fixture = setup({ createGenerationJob: async () => { starts++; return fixture.job(); },
    generationJob: async id => { assert.equal(id, 'job-a'); reads++; if (!online) throw new Error('Connection interrupted'); return fixture.job(); } });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  for (let attempt = 0; attempt < 2; attempt++) { await fixture.tick(); assert.equal(fixture.controller.getSnapshot().status, 'running'); }
  await fixture.tick();
  assert.equal(fixture.controller.getSnapshot().status, 'uncertain');
  assert.equal(fixture.controller.getSnapshot().job.id, 'job-a');
  assert.match(fixture.controller.getSnapshot().connectionError, /paused|reconnect/i);
  assert.equal(fixture.tasks.size, 0);
  assert.equal(reads, 3);
  online = true; await fixture.controller.reconnect();
  assert.equal(fixture.controller.getSnapshot().status, 'running');
  assert.equal(fixture.tasks.size, 1);
  online = false;
  for (let attempt = 0; attempt < 2; attempt++) { await fixture.tick(); assert.equal(fixture.controller.getSnapshot().status, 'running'); }
  await fixture.tick();
  assert.equal(fixture.controller.getSnapshot().status, 'uncertain');
  assert.equal(fixture.tasks.size, 0);
  assert.equal(starts, 1, 'Recovery must not POST another inference');
  fixture.controller.dispose();
});

test('successful status responses reset poll failures and healthy unchanged stages keep polling', async () => {
  let reads = 0;
  const fixture = setup({ generationJob: async () => {
    reads++;
    if ([1, 2, 4, 5].includes(reads)) throw new Error('Temporary disconnection');
    return fixture.job();
  } });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  for (let step = 0; step < 14; step++) {
    await fixture.tick();
    assert.equal(fixture.controller.getSnapshot().status, 'running');
    assert.equal(fixture.controller.getSnapshot().job.stage, 'generating');
    assert.equal(fixture.tasks.size, 1);
  }
  fixture.controller.dispose();
});

test('a late old-source poll cannot clear the new job polling timer', async () => {
  const oldResponse = deferred(); const reads = []; let starts = 0; let request = 0;
  const fixture = setup({ createGenerationJob: async payload => fixture.job('running', { id: ++starts === 1 ? 'job-a' : 'job-b', requestId: payload.requestId }),
    generationJob: async id => { reads.push(id); return id === 'job-a' ? oldResponse.promise : fixture.job('running', { id: 'job-b', requestId: 'request-b' }); },
  }, { makeRequestId: () => ++request === 1 ? 'request-a' : 'request-b' });
  await fixture.controller.start({ text: 'Piano', duration: 5 });
  const oldPoll = fixture.tick();
  fixture.setIdentity('project-b:hash-a');
  await fixture.controller.start({ text: 'Strings', duration: 5 });
  assert.equal(fixture.tasks.size, 1);
  oldResponse.resolve(fixture.job()); await oldPoll;
  assert.equal(fixture.tasks.size, 1, 'Old cleanup must leave the current timer intact');
  await fixture.tick();
  assert.deepEqual(reads, ['job-a', 'job-b']);
  assert.equal(fixture.controller.getSnapshot().job.id, 'job-b');
  fixture.controller.dispose();
});
