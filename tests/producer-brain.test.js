import test from 'node:test';
import assert from 'node:assert/strict';
import { createProducerBrain } from '../server/producer-brain.js';
import { interpretDirection } from '../src/producer/producer.js';
import { buildArrangement } from '../src/music/arrangement.js';

const settings = { bpm: 90, sourceBpm: 90, instrument: 'Piano', leadSource: 'instrument', mood: 'Dreamy', genre: 'Ambient', production: 'auto', accompaniment: true, bass: true, percussion: false, preserveMelodyTiming: true };
const notes = [{ midi: 60, start: 0, duration: 1 }, { midi: 67, start: 1, duration: 2 }];
const proposal = (changes = {}) => ({
  message: 'I suggest a fuller strings lead. Select Apply to hear it.',
  changes: { bpm: null, instrument: null, mood: null, genre: null, production: null, accompaniment: null, bass: null, percussion: null, ...changes },
  suggestions: ['Add percussion'],
});
const response = (value = proposal({ instrument: 'Strings' })) => ({
  id: 'resp_test', object: 'response', status: 'completed', error: null, incomplete_details: null,
  output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] }],
});
const provider = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('producer context retains the actual recorded lead and proposals cannot substitute an instrument lead', async () => {
  let context;
  const current = { ...settings, leadSource: 'recording' };
  const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: async (_url, options) => {
    context = JSON.parse(JSON.parse(options.body).input[0].content);
    return new Response(JSON.stringify(response(proposal({ production: 'dance-pop', genre: 'Electronic', accompaniment: true, bass: true, percussion: true }))), { status: 200 });
  } });
  const result = await brain.propose({ text: 'Beauty and a Beat production', settings: current, notes });
  assert.equal(context.settings.leadSource, 'recording');
  assert.equal(result.source, 'ai');
  assert.equal(Object.hasOwn(result.changes, 'leadSource'), false);
  assert.equal(current.leadSource, 'recording');
  const corrupt = createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(response(proposal({ leadSource: 'instrument' }))) });
  assert.equal((await corrupt.propose({ text: 'cinematic', settings: current, notes })).source, 'rules');
});

test('AI production choices stay generic and preserve source timing controls', async () => {
  let outbound;
  const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: async (_url, options) => {
    outbound = JSON.parse(options.body);
    return new Response(JSON.stringify(response(proposal({ production: 'percussive-pop', genre: 'Pop', bass: true, percussion: true }))), { status: 200 });
  } });
  const result = await brain.propose({ text: 'Shape of You production for my original phrase', settings, notes });
  assert.equal(result.source, 'ai');
  assert.equal(result.changes.production, 'percussive-pop');
  assert.equal(JSON.parse(outbound.input[0].content).settings.production, 'auto');
  assert.match(outbound.instructions, /unfamiliar|unseen|any.*melody/i);
  assert.match(outbound.instructions, /copyright|copy.*melod|production.*traits/i);
  assert.equal(Object.hasOwn(result.changes, 'sourceBpm'), false);
  assert.equal(Object.hasOwn(result.changes, 'preserveMelodyTiming'), false);
});

test('AI benchmark proposals cannot ignore the style, invent a BPM change or override explicit restrictions', async () => {
  for (const [text, changes] of [
    ['Shape of You production', { production: 'dance-pop', genre: 'Pop', bass: true, percussion: true }],
    ['Shape of You production', { production: 'percussive-pop', genre: 'Pop', bass: true, percussion: true, bpm: 120 }],
    ['Beauty and a Beat production, only piano', { production: 'dance-pop', instrument: 'Piano', accompaniment: true, bass: true, percussion: true }],
    ['Shape of You production, no bass or drums', { production: 'percussive-pop', genre: 'Pop', bass: true, percussion: true }],
  ]) {
    const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(response(proposal(changes))) });
    const result = await brain.propose({ text, settings, notes });
    assert.equal(result.source, 'rules', text);
    assert.deepEqual(result.changes, interpretDirection(text, settings).changes, text);
  }
});

function assertRules(result, text = 'cinematic strings') {
  assert.deepEqual(result.changes, { mood: 'Cinematic', instrument: 'Strings' });
  assert.deepEqual(result.suggestions, interpretDirection(text, settings).suggestions);
  assert.equal(result.message, interpretDirection(text, settings).message);
  assert.equal(result.source, 'rules');
  assert.match(result.notice, /AI.*unavailable.*musical rules/i);
  assert.doesNotMatch(JSON.stringify(result), /sk-private|provider secret|account suspended/i);
}

test('missing credentials or fetch preserve the rules result without contacting a provider', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('must not call provider'); };
  for (const options of [{ apiKey: '', fetchImpl }, { apiKey: '   ', fetchImpl }, { apiKey: 'sk-private', fetchImpl: null }]) {
    const brain = createProducerBrain(options);
    assert.deepEqual(brain.status(), { mode: 'rules', provider: null, model: null });
    const result = await brain.propose({ text: 'cinematic strings', settings, notes });
    assert.deepEqual(result, { ...interpretDirection('cinematic strings', settings), source: 'rules' });
  }
  assert.equal(requests, 0);
});

test('AI returns a validated proposal and leaves the current settings and melody untouched', async () => {
  const current = Object.freeze({ ...settings });
  const melody = Object.freeze(notes.map(note => Object.freeze({ ...note })));
  const brain = createProducerBrain({ apiKey: 'sk-private', model: 'gpt-5.4-mini', fetchImpl: provider(response(proposal({ bpm: 105.5, instrument: 'Drums', mood: 'Cinematic', genre: 'Electronic', accompaniment: false, percussion: true }))) });
  assert.deepEqual(brain.status(), { mode: 'ai', provider: 'openai', model: 'gpt-5.4-mini' });
  const result = await brain.propose({ text: 'make it larger', settings: current, notes: melody });
  assert.equal(result.source, 'ai');
  assert.deepEqual(result.changes, { bpm: 105.5, instrument: 'Drums', mood: 'Cinematic', genre: 'Electronic', accompaniment: false, percussion: true });
  assert.deepEqual(result.suggestions, ['Add percussion']);
  assert.match(result.message, /suggest|Apply/);
  assert.deepEqual(current, settings);
  assert.deepEqual(melody, notes);
  assert.equal(Object.hasOwn(result.changes, 'sourceBpm'), false);
});

test('AI percussion removal cannot retain the rhythm forced by the Drums lead', async () => {
  const current = { ...settings, instrument: 'Drums', percussion: true };
  for (const instrument of [null, 'Drums']) {
    const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(response(proposal({ instrument, percussion: false }))) });
    const result = await brain.propose({ text: 'Remove drums', settings: current, notes });
    const arrangement = buildArrangement(notes, { ...current, ...result.changes });
    assert.equal(arrangement.events.some(event => event.track === 'percussion'), false);
    assert.ok(arrangement.events.some(event => event.track === 'melody' && event.instrument === 'Synthesizer'));
    assert.deepEqual(result.changes, { percussion: false, instrument: 'Synthesizer' });
    assert.equal(result.source, 'rules');
    assert.match(result.notice, /rules/i);
  }
});

test('AI can disable the backing bass while retaining chord accompaniment', async () => {
  let context;
  const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: async (url, options) => {
    context = JSON.parse(JSON.parse(options.body).input[0].content);
    return new Response(JSON.stringify(response(proposal({ bass: false, accompaniment: true }))), { status: 200 });
  } });
  const result = await brain.propose({ text: 'Piano and strings without bass', settings: { ...settings, bass: false }, notes });
  assert.equal(result.source, 'ai');
  assert.deepEqual(result.changes, { bass: false, accompaniment: true });
  assert.equal(context.settings.bass, false);
});

test('AI bass removal cannot retain a Bass lead', async () => {
  const current = { ...settings, instrument: 'Bass' };
  for (const instrument of [null, 'Bass']) {
    const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(response(proposal({ instrument, bass: false }))) });
    const result = await brain.propose({ text: 'Remove bass', settings: current, notes });
    const arrangement = buildArrangement(notes, { ...current, ...result.changes });
    assert.equal(result.source, 'rules');
    assert.deepEqual(result.changes, { bass: false, instrument: 'Piano' });
    assert.equal(arrangement.events.some(event => event.instrument === 'Bass'), false);
  }
});

test('request uses Responses strict structured output and contains only bounded musical context', async () => {
  let outbound;
  const extraNotes = Array.from({ length: 70 }, (_, index) => ({ midi: 48 + index % 12, start: index, duration: 0.5, name: 'private-note-name', confidence: 0.123456, originalAudio: 'private-audio', blob: 'private-blob' }));
  extraNotes.push({ midi: 200, start: 0, duration: 1 }, { midi: 60, start: -1, duration: 1 });
  const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: async (url, options) => {
    outbound = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify(response(proposal())), { status: 200 });
  } });
  const result = await brain.propose({ text: 'x'.repeat(4500), settings: { ...settings, title: 'private-project-title', audio: 'private-settings-audio' }, notes: extraNotes, originalAudio: 'private-original-audio', title: 'private-project-title', blob: 'private-blob' });
  assert.equal(result.source, 'ai');
  assert.equal(outbound.url, 'https://api.openai.com/v1/responses');
  assert.equal(outbound.options.method, 'POST');
  assert.equal(outbound.options.headers.Authorization, 'Bearer sk-private');
  assert.equal(outbound.body.model, 'gpt-5.4-mini');
  assert.equal(outbound.body.store, false);
  assert.ok(outbound.body.max_output_tokens > 0 && outbound.body.max_output_tokens <= 1600);
  assert.deepEqual(outbound.body.reasoning, { effort: 'none' });
  assert.ok(outbound.options.signal instanceof AbortSignal);
  const format = outbound.body.text.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.strict, true);
  assert.equal(format.schema.additionalProperties, false);
  assert.equal(format.schema.properties.changes.additionalProperties, false);
  for (const field of [format.schema.properties.message, format.schema.properties.suggestions.items]) {
    assert.equal(Object.hasOwn(field, 'minLength'), false);
    assert.equal(Object.hasOwn(field, 'maxLength'), false);
  }
  const allowed = ['accompaniment', 'bass', 'bpm', 'genre', 'instrument', 'mood', 'percussion', 'production'];
  assert.deepEqual([...format.schema.properties.changes.required].sort(), allowed);
  assert.deepEqual(Object.keys(format.schema.properties.changes.properties).sort(), allowed);
  for (const field of Object.values(format.schema.properties.changes.properties)) assert.ok(field.type.includes('null'));
  const context = JSON.parse(outbound.body.input[0].content);
  assert.equal(context.direction.length, 4000);
  assert.deepEqual(context.settings, settings);
  assert.equal(context.melody.count, 70);
  assert.equal(context.melody.duration, 69.5);
  assert.deepEqual(context.melody.pitchRange, { min: 48, max: 59 });
  assert.equal(context.melody.notes.length, 64);
  assert.deepEqual(context.melody.notes[0], { midi: 48, start: 0, duration: 0.5 });
  assert.doesNotMatch(outbound.options.body, /private-|confidence|originalAudio|blob/);
  assert.match(outbound.body.instructions, /approximate/i);
  assert.match(outbound.body.instructions, /Apply/);
  assert.match(outbound.body.instructions, /raw audio/i);
});

test('empty melody has an honest empty summary and invalid settings never enter the request', async () => {
  let context;
  const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: async (url, options) => {
    context = JSON.parse(JSON.parse(options.body).input[0].content);
    return new Response(JSON.stringify(response(proposal())), { status: 200 });
  } });
  const result = await brain.propose({ text: 'more space', settings: { bpm: 'fast', sourceBpm: Infinity, instrument: 'Violin', mood: 'Angry', genre: 'Secret', accompaniment: 'yes', percussion: null }, notes: [] });
  assert.equal(result.source, 'ai');
  assert.deepEqual(context.settings, settings);
  assert.deepEqual(context.melody, { count: 0, duration: 0, pitchRange: null, notes: [] });
});

test('provider failures fall back once without revealing credentials or provider errors', async (t) => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      let calls = 0;
      const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: async () => { calls++; return new Response('provider secret: account suspended sk-private', { status }); } });
      assertRules(await brain.propose({ text: 'cinematic strings', settings, notes }));
      assert.equal(calls, 1);
    });
  }
  for (const [name, fetchImpl] of [
    ['network error', async () => { throw new Error('provider secret sk-private'); }],
    ['invalid HTTP JSON', async () => new Response('{broken', { status: 200 })],
    ['synchronous error', () => { throw new Error('provider secret sk-private'); }],
  ]) await t.test(name, async () => assertRules(await createProducerBrain({ apiKey: 'sk-private', fetchImpl }).propose({ text: 'cinematic strings', settings, notes })));
});

test('refused, incomplete and missing assistant responses never become AI proposals', async (t) => {
  const refused = response();
  refused.output[0].content = [{ type: 'refusal', refusal: 'provider secret' }];
  const unfinishedMessage = response();
  unfinishedMessage.output[0].status = 'incomplete';
  for (const [name, body] of [
    ['refusal', refused],
    ['incomplete response', { ...response(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }],
    ['failed response', { ...response(), status: 'failed', error: { message: 'provider secret' } }],
    ['missing completion status', { output: response().output }],
    ['unfinished message', unfinishedMessage],
    ['missing output', { status: 'completed' }],
    ['empty output', { status: 'completed', output: [] }],
    ['tool output only', { status: 'completed', output: [{ type: 'function_call', name: 'write_project', arguments: '{}' }] }],
  ]) await t.test(name, async () => assertRules(await createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(body) }).propose({ text: 'cinematic strings', settings, notes })));
});

test('local schema validation rejects unsupported, malformed and oversized proposals', async (t) => {
  const invalid = [
    ['extra action', { ...proposal(), saveProject: true }],
    ['extra control', proposal({ sourceBpm: 100 })],
    ['missing nullable control', { ...proposal(), changes: { instrument: 'Strings' } }],
    ['missing message', { changes: proposal().changes, suggestions: [] }],
    ['empty message', { ...proposal(), message: '   ' }],
    ['long message', { ...proposal(), message: 'x'.repeat(1001) }],
    ['non-string message', { ...proposal(), message: 12 }],
    ['array changes', { ...proposal(), changes: [] }],
    ['low tempo', proposal({ bpm: 39 })],
    ['high tempo', proposal({ bpm: 201 })],
    ['string tempo', proposal({ bpm: '100' })],
    ['unsupported instrument', proposal({ instrument: 'Violin' })],
    ['unsupported mood', proposal({ mood: 'Happy' })],
    ['unsupported genre', proposal({ genre: 'Jazz' })],
    ['unsupported production', proposal({ production: 'copy-the-song' })],
    ['string boolean', proposal({ accompaniment: 'true' })],
    ['numeric boolean', proposal({ percussion: 1 })],
    ['long suggestion', { ...proposal(), suggestions: ['x'.repeat(151)] }],
    ['many suggestions', { ...proposal(), suggestions: ['a', 'b', 'c', 'd', 'e'] }],
    ['non-string suggestion', { ...proposal(), suggestions: [true] }],
    ['empty suggestion', { ...proposal(), suggestions: [''] }],
    ['object suggestions', { ...proposal(), suggestions: {} }],
  ];
  for (const [name, value] of invalid) await t.test(name, async () => assertRules(await createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(response(value)) }).propose({ text: 'cinematic strings', settings, notes })));
  const malformed = response();
  malformed.output[0].content[0].text = '{not JSON';
  assertRules(await createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(malformed) }).propose({ text: 'cinematic strings', settings, notes }));
  const infinite = response();
  infinite.output[0].content[0].text = JSON.stringify(proposal({ bpm: 100 })).replace('"bpm":100', '"bpm":1e400');
  assertRules(await createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(infinite) }).propose({ text: 'cinematic strings', settings, notes }));
});

test('explicit tempo-transform slowdowns beyond the arrangement limit fall back, including notes beyond the sent sample', async () => {
  const longMelody = [...Array.from({ length: 64 }, (_, index) => ({ midi: 60, start: index, duration: 1 })), { midi: 72, start: 119, duration: 2 }];
  const current = { ...settings, sourceBpm: 200, preserveMelodyTiming: false };
  const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(response(proposal({ bpm: 40 }))) });
  const result = await brain.propose({ text: 'cinematic strings', settings: current, notes: longMelody });
  assert.equal(result.source, 'rules');
  assert.deepEqual(result.changes, { mood: 'Cinematic', instrument: 'Strings' });
  assert.match(result.notice, /unavailable/i);
  const boundary = await brain.propose({ text: 'cinematic strings', settings: current, notes: [{ midi: 60, start: 119, duration: 1 }] });
  assert.equal(boundary.source, 'ai');
  assert.equal(boundary.changes.bpm, 40);
});

test('unsafe rule fallback removes only the explicit tempo-transform change when melody context is supplied', async (t) => {
  const text = 'Set tempo to 40 BPM, cinematic strings';
  const longMelody = [{ midi: 60, start: 0, duration: 300 }];
  const current = { ...settings, preserveMelodyTiming: false };
  for (const [name, options] of [
    ['missing key', { apiKey: '' }],
    ['provider failure', { apiKey: 'sk-private', fetchImpl: async () => { throw new Error('provider secret'); } }],
    ['unsafe AI response', { apiKey: 'sk-private', fetchImpl: provider(response(proposal({ bpm: 40 }))) }],
  ]) await t.test(name, async () => {
    const brain = createProducerBrain(options);
    const result = await brain.propose({ text, settings: current, notes: longMelody });
    assert.equal(result.source, 'rules');
    assert.deepEqual(result.changes, { mood: 'Cinematic', instrument: 'Strings' });
    assert.match(result.message, /tempo.*600.second|600.second.*tempo/i);
    assert.match(result.message, /faster.*shorten|shorten.*faster/i);
    assert.doesNotMatch(result.message, /40 BPM/);
    assert.deepEqual(result.suggestions, interpretDirection(text, current).suggestions);
  });
});

test('locked long melody allows a backing tempo change without extending or replacing the lead', async () => {
  const melody = [{ midi: 60, start: 0.3, duration: 299.7 }];
  const current = { ...settings, sourceBpm: 200 };
  for (const brain of [
    createProducerBrain({ apiKey: '' }),
    createProducerBrain({ apiKey: 'sk-private', fetchImpl: provider(response(proposal({ bpm: 40, instrument: 'Strings' }))) }),
  ]) {
    const result = await brain.propose({ text: 'Set tempo to 40 BPM, cinematic strings', settings: current, notes: melody });
    assert.equal(result.changes.bpm, 40);
    const arrangement = buildArrangement(melody, { ...current, ...result.changes });
    assert.equal(arrangement.duration, 300);
    assert.equal(arrangement.bpm, 40);
    assert.deepEqual(arrangement.events.filter(event => event.track === 'melody').map(({ midi, start, duration }) => ({ midi, start, duration })), melody);
    assert.equal(arrangement.melodyProof.timingPreserved, true);
  }
});

test('safe or absent melody context preserves legacy rule proposals exactly', async () => {
  const brain = createProducerBrain({ apiKey: '' });
  const text = 'Set tempo to 40 BPM, cinematic strings';
  const expected = { ...interpretDirection(text, settings), source: 'rules' };
  assert.deepEqual(await brain.propose({ text, settings }), expected);
  assert.deepEqual(await brain.propose({ text, settings, notes: [] }), expected);
  assert.deepEqual(await brain.propose({ text, settings, notes: [{ midi: 60, start: 0, duration: 200 }] }), expected);
});

test('a timeout aborts the provider and releases its slot for the next request', async () => {
  let calls = 0;
  let firstSignal;
  const brain = createProducerBrain({ apiKey: 'sk-private', timeoutMs: 20, fetchImpl: async (url, options) => {
    calls++;
    if (calls === 1) {
      firstSignal = options.signal;
      return new Promise(() => {});
    }
    return new Response(JSON.stringify(response()), { status: 200 });
  } });
  assertRules(await brain.propose({ text: 'cinematic strings', settings, notes }));
  assert.equal(firstSignal.aborted, true);
  assert.equal((await brain.propose({ text: 'cinematic strings', settings, notes })).source, 'ai');
  assert.equal(calls, 2);
});

test('timeout covers the response body as well as the initial HTTP request', async () => {
  let signal;
  const brain = createProducerBrain({ apiKey: 'sk-private', timeoutMs: 20, fetchImpl: async (url, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  } });
  assertRules(await brain.propose({ text: 'cinematic strings', settings, notes }));
  assert.equal(signal.aborted, true);
});

test('at most two paid requests start concurrently and busy requests immediately use rules', async () => {
  const waiting = [];
  let calls = 0;
  const brain = createProducerBrain({ apiKey: 'sk-private', fetchImpl: () => {
    calls++;
    return new Promise(resolve => waiting.push(resolve));
  } });
  const first = brain.propose({ text: 'cinematic strings', settings, notes });
  const second = brain.propose({ text: 'cinematic strings', settings, notes });
  assertRules(await brain.propose({ text: 'cinematic strings', settings, notes }));
  assert.equal(calls, 2);
  for (const resolve of waiting) resolve(new Response(JSON.stringify(response()), { status: 200 }));
  assert.deepEqual((await Promise.all([first, second])).map(result => result.source), ['ai', 'ai']);
  const next = brain.propose({ text: 'cinematic strings', settings, notes });
  assert.equal(calls, 3);
  waiting[2](new Response(JSON.stringify(response()), { status: 200 }));
  assert.equal((await next).source, 'ai');
});
