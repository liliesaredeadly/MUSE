import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// Compile the real component for server rendering without opening a server or
// depending on a local model. Controller tests exercise its asynchronous work.
const compiled = await build({ entryPoints: ['src/components/MusicGenJobPanel.jsx'], bundle: true, platform: 'node',
  format: 'cjs', write: false, packages: 'external', loader: { '.css': 'empty' } });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const Panel = module.exports.default;
const studio = overrides => ({ project: { title: 'My hum' }, audioUrl: 'blob:original', busy: false, captureSummary: { receipt: { sha256: 'hash-a' } },
  stopOtherAudio() {}, musicGen: { status: 'idle', job: null, result: null, active: false, canGenerate: true,
    prompt: 'Warm guitar', setPrompt() {}, audioRef: { current: null }, availability: { status: 'ready', ready: true },
    start() {}, cancel() {}, reconnect() {}, refreshAvailability() {}, error: '', connectionError: '', ...overrides } });
const render = overrides => renderToStaticMarkup(React.createElement(Panel, { studio: studio(overrides) }));

test('running panel announces the actual server stage without a fabricated percentage', () => {
  const html = render({ status: 'running', active: true, canGenerate: false, job: { status: 'running', stage: 'generating', elapsedSeconds: 42 } });
  assert.match(html, /aria-current="step"[^>]*>[^]*?Generating/);
  assert.match(html, /Cancel generation/);
  assert.match(html, /00:42/);
  assert.doesNotMatch(html, /aria-valuenow|\d+%/);
  assert.match(html, /Basic volume normalization only/);
});

test('ready panel exposes real output, original comparison, replay and download', () => {
  const html = render({ status: 'ready', result: { jobId: 'job-a', audioUrl: 'blob:generated', duration: 5, prompt: 'Warm guitar' } });
  assert.match(html, /<audio[^>]*controls=""[^>]*src="blob:generated"/);
  assert.match(html, /Original hum/);
  assert.match(html, /Replay/);
  assert.match(html, /href="blob:generated"[^>]*download="My hum-preview.wav"/);
  assert.match(html, /Generate another preview/);
});

test('unavailable service explains recovery and disables generation', () => {
  const html = render({ canGenerate: false, availability: { status: 'unavailable', ready: false, reason: 'The local model is offline.' } });
  assert.match(html, /The local model is offline/);
  assert.match(html, /Check model again/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
});

test('failed regeneration keeps previous audio alongside its recoverable error', () => {
  const html = render({ status: 'failed', error: 'The model timed out.', result: { audioUrl: 'blob:earlier', duration: 5, prompt: 'Piano' } });
  assert.match(html, /role="alert"[^>]*>The model timed out/);
  assert.match(html, /src="blob:earlier"/);
  assert.match(html, /Your previous preview is kept/);
  assert.match(html, /Retry generation/);
});

test('failed loading exposes only the completed job’s exact local WAV link and keeps prior playback', () => {
  const job = { id: 'job-a', status: 'succeeded', stage: 'ready', audioUrl: '/api/generation/jobs/job-a/audio' };
  const result = { audioUrl: 'blob:earlier', duration: 5, prompt: 'Piano' };
  const html = render({ status: 'failed', error: 'The finished preview download timed out.', job, result });
  assert.match(html, /href="\/api\/generation\/jobs\/job-a\/audio"[^>]*download="My hum-preview.wav"/);
  assert.match(html, /Download finished WAV/);
  assert.match(html, /src="blob:earlier"/);
  for (const audioUrl of ['https://example.com/audio', '//example.com/audio', '/api/generation/jobs/other/audio', '/api/generation/jobs/job-a/audio?redirect=1', 'javascript:alert(1)']) {
    assert.doesNotMatch(render({ status: 'failed', job: { ...job, audioUrl }, result }), /Download finished WAV/);
  }
  assert.doesNotMatch(render({ status: 'failed', job: { ...job, status: 'running' }, result }), /Download finished WAV/);
});

test('queued work is labelled as waiting rather than an active analysis stage', () => {
  const html = render({ status: 'running', active: true, canGenerate: false, job: { status: 'queued', stage: 'listening', elapsedSeconds: 0 } });
  assert.match(html, /Waiting for the local model/);
  assert.doesNotMatch(html, /aria-current="step"/);
});

test('genuine model token counts produce labelled semantic progress without completing the job', () => {
  for (const completed of [0, 12, 50]) {
    const html = render({ status: 'running', active: true, canGenerate: false,
      job: { status: 'running', stage: 'generating', elapsedSeconds: 12, progress: { completed, total: 50 } } });
    const progress = html.match(/<progress\b[^>]*>/)?.[0];
    assert.ok(progress, 'Actual token counts should expose a progress element');
    assert.match(progress, /aria-label="Model audio tokens"/);
    assert.match(progress, new RegExp(`value="${completed}"`));
    assert.match(progress, /max="50"/);
    assert.match(html, new RegExp(`${completed} / 50 audio tokens`));
    assert.doesNotMatch(html, /\d+%|class="musicgen-activity is-active"/);
    assert.match(html, /aria-current="step"[^>]*>[^]*?Generating/);
    assert.doesNotMatch(html, /Your music is ready!<\/span><\/div>|Generated music preview player/);
  }
});

test('missing invalid or non-generating token counts keep the indeterminate activity', () => {
  const cases = [
    { progress: null }, { progress: { completed: -1, total: 50 } }, { progress: { completed: 51, total: 50 } },
    { progress: { completed: 0, total: 0 } }, { progress: { completed: NaN, total: 50 } },
    { progress: { completed: 12, total: Infinity } }, { progress: { completed: '12', total: 50 } },
    { stage: 'preparing', progress: { completed: 50, total: 50 } },
    { status: 'queued', progress: { completed: 12, total: 50 } },
  ];
  for (const properties of cases) {
    const html = render({ status: 'running', active: true, canGenerate: false,
      job: { status: 'running', stage: 'generating', elapsedSeconds: 12, ...properties } });
    assert.doesNotMatch(html, /<progress\b|\d+ \/ \d+ audio tokens/);
    assert.match(html, /class="musicgen-activity/);
  }
});

test('cloud previews disclose upload and billing with an explicit paid action', () => {
  const html = render({ availability: { provider: 'replicate', model: 'facebook/musicgen-melody-large', paid: true, ready: true, status: 'ready' } });
  assert.match(html, /Generate paid preview/);
  assert.match(html, /Replicate/);
  assert.match(html, /recording and production instructions are sent/);
  assert.match(html, /billed per generation/);
  assert.match(html, /MusicGen Melody Large/);
  assert.doesNotMatch(html, /Runs on your local MusicGen service|CPU generation/);
});
