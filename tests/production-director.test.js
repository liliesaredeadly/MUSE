import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionDirector } from '../server/production-director.js';
import { planProduction } from '../src/producer/production-blueprint.js';

const notes = [{ midi: 60, start: 0.25, duration: 1 }];
const input = () => ({ text: 'Add guitar, no drums', settings: { leadSource: 'recording', preserveMelodyTiming: true }, notes: structuredClone(notes) });
const complete = value => ({ status: 'completed', error: null, incomplete_details: null, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const served = value => async () => new Response(JSON.stringify(value), { status: 200 });

test('missing AI configuration returns an explicitly local plan without external inference', async () => {
  const director = createProductionDirector({ env: {}, fetchImpl: () => { throw new Error('must not call'); } });
  assert.deepEqual(director.status(), { mode: 'rules', provider: null, model: null });
  const result = await director.propose(input());
  assert.equal(result.source, 'rules');
  assert.deepEqual(result.blueprint, planProduction(input().text, input().settings));
  assert.match(result.summary, /rule|local/i);
  assert.match(result.summary, /melody|recording/i);
});

test('configured AI receives bounded musical context and returns a validated backing blueprint', async () => {
  let request;
  const candidate = planProduction('Add guitar, no drums', {});
  const settings = { leadSource: 'recording', preserveMelodyTiming: true, blueprint: candidate, audio: 'private-audio' };
  const director = createProductionDirector({ env: { OPENAI_API_KEY: 'sk-private', OPENAI_MODEL: 'configured-model' }, fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify(complete({ blueprint: candidate, summary: 'Proposed guitar backing; your recording stays the lead. Apply to hear it.' })), { status: 200 });
  } });
  const original = structuredClone(settings);
  const result = await director.propose({ text: 'Add guitar, no drums', settings, notes: [...notes, { midi: 200, start: 0, duration: 1, blob: 'private-blob' }] });
  assert.equal(result.source, 'ai');
  assert.deepEqual(result.blueprint, candidate);
  assert.deepEqual(settings, original);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.strict, true);
  const context = JSON.parse(request.body.input[0].content);
  assert.deepEqual(context.blueprint, candidate);
  assert.equal(context.settings.leadSource, 'recording');
  assert.equal(context.melody.notes.length, 1);
  assert.doesNotMatch(request.options.body, /private-audio|private-blob/);
  assert.doesNotMatch(JSON.stringify(result), /sk-private/);
});

test('malformed, refused, unsupported and contradictory AI plans fall back without leaking errors', async () => {
  const candidate = planProduction('Add guitar, no drums', {});
  const badBlueprint = { ...candidate, leadSource: 'instrument' };
  const contradictions = planProduction('Add drums', {});
  const responses = [
    complete({ blueprint: badBlueprint, summary: 'Changed the lead.' }),
    complete({ blueprint: candidate, summary: '' }),
    complete({ blueprint: contradictions, summary: 'Drums enabled.' }),
    { ...complete({ blueprint: candidate, summary: 'Okay' }), status: 'incomplete' },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'secret' }] }] },
  ];
  for (const body of responses) {
    const director = createProductionDirector({ env: { OPENAI_API_KEY: 'sk-private' }, fetchImpl: served(body) });
    const result = await director.propose(input());
    assert.equal(result.source, 'rules');
    assert.deepEqual(result.blueprint, candidate);
    assert.match(result.notice, /AI.*unavailable|local|rules/i);
    assert.doesNotMatch(JSON.stringify(result), /sk-private|secret/);
  }
  const director = createProductionDirector({ env: { OPENAI_API_KEY: 'sk-private' }, fetchImpl: async () => { throw new Error('secret sk-private'); } });
  assert.equal((await director.propose(input())).source, 'rules');
});

test('provider deadline aborts a hung response and releases capacity', async () => {
  let signal;
  let calls = 0;
  const candidate = planProduction('Add guitar, no drums', {});
  const director = createProductionDirector({ env: { OPENAI_API_KEY: 'sk-private' }, timeoutMs: 15, fetchImpl: async (_url, options) => {
    calls++; signal = options.signal;
    if (calls === 1) return { ok: true, json: () => new Promise(() => {}) };
    return new Response(JSON.stringify(complete({ blueprint: candidate, summary: 'A proposed guitar layer.' })), { status: 200 });
  } });
  assert.equal((await director.propose(input())).source, 'rules');
  assert.equal(signal.aborted, true);
  assert.equal((await director.propose(input())).source, 'ai');
});

test('unrecognized local directions explain supported choices without claiming an unsupported instrument', async () => {
  const director = createProductionDirector({ env: {} });
  const result = await director.propose({ text: 'Add trumpet and saxophone', settings: {} });
  assert.equal(result.source, 'rules');
  assert.match(result.summary, /supported|recogniz|try/i);
  assert.match(result.summary, /guitar|piano/i);
  assert.doesNotMatch(result.summary, /trumpet backing|saxophone backing/i);
});

test('AI cannot ignore a requested addition, ending entry or volume direction', async () => {
  const current = planProduction('Add guitar', { accompaniment: false, bass: false });
  for (const text of ['Make guitar louder', 'Add piano', 'Guitar in the ending']) {
    const director = createProductionDirector({ env: { OPENAI_API_KEY: 'sk-private' }, fetchImpl: served(complete({ blueprint: current, summary: 'Proposed changes.' })) });
    const result = await director.propose({ text, settings: { blueprint: current }, notes });
    assert.equal(result.source, 'rules', text);
    assert.deepEqual(result.blueprint, planProduction(text, { blueprint: current }));
  }
});

test('busy provider capacity is bounded and releases after completed proposals', async () => {
  const pending = [];
  const candidate = planProduction(input().text, input().settings);
  const director = createProductionDirector({ env: { OPENAI_API_KEY: 'sk-private' }, fetchImpl: () => new Promise(resolve => pending.push(resolve)) });
  const first = director.propose(input());
  const second = director.propose(input());
  assert.equal((await director.propose(input())).source, 'rules');
  assert.equal(pending.length, 2);
  for (const resolve of pending) resolve(new Response(JSON.stringify(complete({ blueprint: candidate, summary: 'A guitar backing proposal.' })), { status: 200 }));
  assert.deepEqual((await Promise.all([first, second])).map(result => result.source), ['ai', 'ai']);
});
