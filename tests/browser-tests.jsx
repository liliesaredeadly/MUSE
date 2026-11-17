// Developer-only QA fixtures. Never imported by the product or stored by the real API.
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildArrangement } from '../src/music/arrangement.js';
import { CompositionPlayer, exportWav } from '../src/audio/synth.js';
import { MicrophoneRecorder } from '../src/audio/recorder.js';
import { useStudio } from '../src/hooks/useStudio.js';
import { DEFAULT_SETTINGS } from '../src/lib/projects.js';
import Studio from '../src/components/Studio.jsx';
import App from '../src/App.jsx';
import { interpretDirection } from '../src/producer/producer.js';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}\nExpected ${JSON.stringify(expected)}\nReceived ${JSON.stringify(actual)}`);
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const fixtureNotes = [
  { midi: 60, name: 'C4', start: 0, duration: 0.4, confidence: 0.95 },
  { midi: 64, name: 'E4', start: 0.5, duration: 0.4, confidence: 0.95 },
  { midi: 67, name: 'G4', start: 1, duration: 0.4, confidence: 0.95 },
];
const fixtureSettings = { ...DEFAULT_SETTINGS, bpm: 90, sourceBpm: 90, instrument: 'Piano', mood: 'Dreamy', genre: 'Ambient', accompaniment: false, percussion: false };
const fixtureProject = () => ({ id: 'synthetic-browser-qa-fixture', title: 'Synthetic QA fixture', notes: fixtureNotes.map(note => ({ ...note })), settings: { ...fixtureSettings }, createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:00:00.000Z' });

async function waitFor(check, message, timeout = 5000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(message);
}

const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

const normalizedText = element => element.textContent.replace(/\s+/g, ' ').trim();
function buttonNamed(host, name) {
  const button = [...host.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') || normalizedText(element)) === name);
  assert(button, `The rendered UI is missing the button “${name}”.`);
  return button;
}
function labelledSelect(host, label) {
  const field = [...host.querySelectorAll('label')].find(element => element.querySelector('span')?.textContent.trim() === label);
  const select = field?.querySelector('select');
  assert(select, `The rendered UI is missing the select “${label}”.`);
  return select;
}
function changeNativeValue(element, value) {
  assert(element, 'The rendered UI is missing the input to change.');
  assert(!element.matches(':disabled'), 'The test attempted to change a disabled input.');
  // Bypass React's own value tracker, exactly as a browser edit changes the native value.
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, String(value));
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function withApi(action, onRequest) {
  const original = globalThis.fetch;
  let saved = null;
  globalThis.fetch = async (input, options = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (!path.startsWith('/api/')) return original(input, options);
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (onRequest) {
      const custom = await onRequest(path, options.method || 'GET', body);
      if (custom !== undefined) return custom;
    }
    if (path === '/api/health') return response({ status: 'ok', database: 'isolated QA fixture' });
    if (path === '/api/projects' && (options.method || 'GET') === 'GET') return response({ projects: saved ? [saved] : [] });
    if (path === '/api/projects') { saved = { ...body, updatedAt: new Date().toISOString() }; return response({ project: saved }); }
    if (path === '/api/arrange') return response({ arrangement: buildArrangement(body.notes, body.settings) });
    if (path === '/api/producer') return response(interpretDirection(body.text, body.settings));
    throw new Error(`Unexpected QA API request: ${path}`);
  };
  try { return await action(); }
  finally { globalThis.fetch = original; }
}

async function withGetUserMedia(replacement, action) {
  const devices = navigator.mediaDevices;
  assert(devices && typeof devices.getUserMedia === 'function', 'MediaDevices is unavailable. Open this page on localhost in a supported browser.');
  const descriptor = Object.getOwnPropertyDescriptor(devices, 'getUserMedia');
  Object.defineProperty(devices, 'getUserMedia', { configurable: true, writable: true, value: replacement });
  try { return await action(); }
  finally {
    if (descriptor) Object.defineProperty(devices, 'getUserMedia', descriptor);
    else delete devices.getUserMedia;
  }
}

async function withStudio(action, { renderActualUi = false } = {}) {
  const host = document.createElement('div');
  document.getElementById('integration-harness').append(host);
  const root = createRoot(host);
  let latest = null;
  function Harness() {
    const studio = useStudio();
    useLayoutEffect(() => { latest = studio; });
    return renderActualUi ? <Studio studio={studio} /> : <audio ref={studio.audioRef} />;
  }
  root.render(<Harness />);
  try {
    await waitFor(() => latest?.serverState === 'ready', 'The isolated studio harness did not become ready.');
    await latest.openProject(fixtureProject());
    await waitFor(() => latest.project.id === 'synthetic-browser-qa-fixture', 'The fixture project did not open.');
    return await action(() => latest, host);
  } finally {
    root.unmount();
    host.remove();
    await sleep(20);
  }
}

async function pcm(blob) {
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  assert(new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF', 'The export is not a RIFF WAV.');
  const sampleRate = view.getUint32(24, true);
  const channels = view.getUint16(22, true);
  const sampleCount = view.getUint32(40, true) / 2;
  assert(sampleCount === (bytes.byteLength - 44) / 2, 'PCM header length does not match the exported samples.');
  let energy = 0;
  let peak = 0;
  for (let index = 0; index < sampleCount; index++) {
    const sample = view.getInt16(44 + index * 2, true) / 32768;
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { view, sampleCount, duration: sampleCount / channels / sampleRate, rms: Math.sqrt(energy / sampleCount), peak };
}

const checks = [
  {
    id: 'real-wav-signal', title: 'Real OfflineAudioContext renders nonzero PCM WAV',
    async run() {
      const arrangement = buildArrangement(fixtureNotes, fixtureSettings);
      const rendered = await pcm(await exportWav(arrangement));
      assert(rendered.rms > 0.002 && rendered.peak > 0.01, `WAV contains no useful signal: RMS ${rendered.rms}, peak ${rendered.peak}.`);
      assert(rendered.peak < 0.999, `The rendered fixture clips at ${rendered.peak}.`);
      assert(Math.abs(rendered.duration - 3) < 0.001, `Expected 1.4 seconds of melody plus 1.6 seconds of effects tail; received ${rendered.duration}.`);
      return `Actual PCM: ${rendered.duration.toFixed(3)}s, RMS ${rendered.rms.toFixed(5)}, peak ${rendered.peak.toFixed(5)}.`;
    },
  },
  {
    id: 'real-instrument-tempo', title: 'Instrument and BPM controls change the rendered audio',
    async run() {
      const piano = await pcm(await exportWav(buildArrangement(fixtureNotes, fixtureSettings)));
      const strings = await pcm(await exportWav(buildArrangement(fixtureNotes, { ...fixtureSettings, instrument: 'Strings' })));
      const faster = await pcm(await exportWav(buildArrangement(fixtureNotes, { ...fixtureSettings, bpm: 180 })));
      let changed = 0;
      for (let index = 0; index < Math.min(piano.sampleCount, strings.sampleCount); index++) {
        if (Math.abs(piano.view.getInt16(44 + index * 2, true) - strings.view.getInt16(44 + index * 2, true)) > 8) changed++;
      }
      assert(strings.rms > 0.002, 'The Strings voice rendered silence.');
      assert(changed > piano.sampleCount * 0.1, 'Piano and Strings produced effectively identical PCM.');
      assert(Math.abs(faster.duration - 2.3) < 0.001, `Doubling BPM did not halve the musical duration: WAV ${faster.duration}s.`);
      return `${changed} samples differ between Piano and Strings. Tempo: ${piano.duration.toFixed(3)}s → ${faster.duration.toFixed(3)}s including the same effects tail.`;
    },
  },
  {
    id: 'real-synthetic-capture', title: 'Real microphone recorder recognizes an isolated synthetic C–E–G fixture',
    async run(audioContext) {
      const destination = audioContext.createMediaStreamDestination();
      const sources = [];
      const recorder = new MicrophoneRecorder();
      try {
        return await withGetUserMedia(async () => destination.stream, async () => {
          await recorder.start();
          const begins = audioContext.currentTime + 0.18;
          [60, 64, 67].forEach((midi, index) => {
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            const start = begins + index * 0.85;
            const end = start + 0.65;
            oscillator.type = 'sine';
            oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.18, start + 0.025);
            gain.gain.setValueAtTime(0.18, end - 0.025);
            gain.gain.linearRampToValueAtTime(0, end);
            oscillator.connect(gain);
            gain.connect(destination);
            oscillator.start(start);
            oscillator.stop(end + 0.03);
            sources.push(oscillator, gain);
          });
          await waitFor(() => audioContext.currentTime > begins + 2.6, 'Synthetic audio fixture did not finish; keep this test tab active.', 6000);
          const result = await recorder.stop();
          same(result.notes.map(note => note.midi), [60, 64, 67], 'Actual captured note pitches changed or were fabricated.');
          assert(result.notes.every(note => note.duration > 0.25 && note.start >= 0), `Invalid captured timings: ${JSON.stringify(result.notes)}.`);
          assert(result.blob?.size > 0, 'The actual MediaRecorder returned no original-audio data.');
          assert(destination.stream.getTracks().every(track => track.readyState === 'ended'), 'The recorder did not release its synthetic input tracks.');
          return `Synthetic QA input only: ${result.notes.map(note => `${note.name} @ ${note.start.toFixed(2)}s / ${note.duration.toFixed(2)}s`).join(', ')}. Original recording: ${result.blob.size} bytes. Input tracks released.`;
        });
      } finally {
        await recorder.dispose();
        destination.stream.getTracks().forEach(track => track.stop());
        sources.forEach(source => { try { source.stop?.(); source.disconnect(); } catch { /* Already ended. */ } });
        destination.disconnect();
      }
    },
  },
  {
    id: 'permission-preserves-melody', title: 'A refused re-record keeps the existing melody',
    async run() {
      return withApi(() => withStudio(async get => withGetUserMedia(async () => { throw new DOMException('Synthetic QA permission refusal', 'NotAllowedError'); }, async () => {
        await get().startRecording();
        await waitFor(() => get().capture === 'idle' && get().error.length > 0, 'Permission refusal did not commit an idle state and recovery message.');
        same(get().project.notes, fixtureNotes, 'Refusing the new microphone request erased or replaced the existing melody.');
        assert(/blocked|allow|permission/i.test(get().error), 'Permission refusal did not provide recovery guidance.');
        return 'Existing pitches, timing and confidence survived the simulated permission refusal.';
      })));
    },
  },
  {
    id: 'cancelled-permission-isolated', title: 'Cancelled microphone requests cannot affect a subsequent recording',
    async run(audioContext) {
      const details = [];
      for (const completion of ['rejected', 'late stream']) {
        await withApi(() => withStudio(async get => {
          const delayed = deferred();
          const cancelledDestination = audioContext.createMediaStreamDestination();
          const activeDestination = audioContext.createMediaStreamDestination();
          let pendingOriginal;
          let oscillator;
          let gain;
          let requests = 0;
          try {
            await withGetUserMedia(() => ++requests === 1 ? delayed.promise : Promise.resolve(activeDestination.stream), async () => {
              pendingOriginal = get().startRecording();
              await waitFor(() => get().capture === 'requesting', `${completion}: the delayed request did not enter requesting state.`);
              assert(typeof get().cancelRecordingRequest === 'function', 'The hook does not expose microphone-request cancellation.');
              get().cancelRecordingRequest();
              await waitFor(() => get().capture === 'idle', `${completion}: cancellation did not return capture to idle.`);
              same(get().project.notes, fixtureNotes, `${completion}: cancelling permission erased the existing melody.`);

              await get().startRecording();
              await waitFor(() => get().capture === 'recording', `${completion}: a new recording could not start after cancellation.`);
              assert(requests === 2, `${completion}: expected two isolated input requests, received ${requests}.`);
              oscillator = audioContext.createOscillator();
              gain = audioContext.createGain();
              const start = audioContext.currentTime + 0.06;
              const end = start + 0.7;
              oscillator.frequency.value = 440;
              gain.gain.setValueAtTime(0, start);
              gain.gain.linearRampToValueAtTime(0.18, start + 0.025);
              gain.gain.setValueAtTime(0.18, end - 0.025);
              gain.gain.linearRampToValueAtTime(0, end);
              oscillator.connect(gain);
              gain.connect(activeDestination);
              oscillator.start(start);
              oscillator.stop(end + 0.03);

              if (completion === 'rejected') delayed.reject(new DOMException('Synthetic QA delayed refusal', 'NotAllowedError'));
              else delayed.resolve(cancelledDestination.stream);
              await pendingOriginal;
              await sleep(50);
              assert(get().capture === 'recording', `${completion}: the cancelled request changed the newer recording state to ${get().capture}.`);
              assert(get().error === '', `${completion}: the cancelled request leaked an error into the newer session: ${get().error}`);
              assert(activeDestination.stream.getTracks().every(track => track.readyState === 'live'), `${completion}: the cancelled request stopped the newer session's input.`);
              if (completion === 'late stream') {
                assert(cancelledDestination.stream.getTracks().every(track => track.readyState === 'ended'), 'The late granted stream was not released after cancellation.');
              }
              await waitFor(() => audioContext.currentTime > end + 0.15, `${completion}: the subsequent synthetic note did not finish.`, 3500);
              await get().stopRecording();
              await waitFor(() => get().capture === 'idle' && get().project.notes.length > 0, `${completion}: the subsequent recording did not commit its captured notes.`);
              same(get().project.notes.map(note => note.midi), [69], `${completion}: the subsequent real recorder lost or altered its synthetic A4 note.`);
              assert(activeDestination.stream.getTracks().every(track => track.readyState === 'ended'), `${completion}: finishing the newer session did not release its input.`);
              details.push(`${completion}: prior melody preserved on Cancel, later A4 captured, input resources released`);
            });
          } finally {
            delayed.resolve(cancelledDestination.stream);
            if (pendingOriginal) await pendingOriginal;
            if (get().capture === 'recording' || get().capture === 'paused') await get().stopRecording();
            for (const source of [oscillator, gain]) { try { source?.stop?.(); source?.disconnect(); } catch { /* Already ended. */ } }
            for (const destination of [cancelledDestination, activeDestination]) {
              destination.stream.getTracks().forEach(track => track.stop());
              destination.disconnect();
            }
          }
        }));
      }
      return details.join('. ');
    },
  },
  {
    id: 'save-keeps-new-edits', title: 'Edits made while a save is in flight remain in the project',
    async run() {
      const gate = deferred();
      let posted = false;
      return withApi(() => withStudio(async get => {
        let pendingSave;
        try {
          pendingSave = get().save();
          await waitFor(() => posted, 'The save request was not dispatched.');
          get().rename('Edited while saving — QA');
          get().changeSettings({ mood: 'Cinematic' });
          await waitFor(() => get().project.title === 'Edited while saving — QA' && get().project.settings.mood === 'Cinematic', 'The integration harness did not apply the in-flight edits.');
          gate.resolve();
          assert(await pendingSave, 'The isolated save failed.');
          await sleep(40);
          assert(get().project.title === 'Edited while saving — QA', 'The old save response overwrote the newer title.');
          assert(get().project.settings.mood === 'Cinematic', 'The old save response overwrote newer sound settings.');
          assert(get().dirty, 'Newer unsaved edits were incorrectly marked saved.');
          return 'The server saved its snapshot; newer title and mood edits remain local and unsaved.';
        } finally { gate.resolve(); if (pendingSave) await pendingSave; }
      }), async (path, method, body) => {
        if (path !== '/api/projects' || method !== 'POST') return undefined;
        posted = true;
        await gate.promise;
        return response({ project: { ...body, updatedAt: '2026-11-17T12:00:00.000Z' } });
      });
    },
  },
  {
    id: 'unlock-stop-transport', title: 'Stopping while audio unlock is pending leaves the studio stopped',
    async run() {
      const OriginalAudioContext = globalThis.AudioContext;
      assert(OriginalAudioContext, 'AudioContext is unavailable.');
      const gate = deferred();
      let waiting = false;
      const contexts = [];
      // Real AudioContexts and nodes; delay only the resume boundary to reproduce the race.
      function DelayedAudioContext(...args) {
        const context = new OriginalAudioContext(...args);
        const resume = context.resume.bind(context);
        context.resume = async () => { waiting = true; await gate.promise; return resume(); };
        contexts.push(context);
        return context;
      }
      return withApi(() => withStudio(async get => {
        let pendingPlay;
        try {
          get().generate();
          await waitFor(() => !!get().arrangement && !get().arranging, 'The isolated arrangement did not become playable.');
          globalThis.AudioContext = DelayedAudioContext;
          pendingPlay = get().play();
          await waitFor(() => waiting, 'Playback never reached the audio unlock boundary.');
          get().stopPlayback();
          gate.resolve();
          await pendingPlay;
          await sleep(30);
          assert(get().transport === 'stopped', `The studio falsely reports ${get().transport} after Stop during audio unlock.`);
          return 'Delayed unlock completed without changing the stopped transport to playing.';
        } finally {
          gate.resolve();
          if (pendingPlay) await pendingPlay;
          globalThis.AudioContext = OriginalAudioContext;
          await Promise.all(contexts.filter(context => context.state !== 'closed').map(context => context.close()));
        }
      }));
    },
  },
  {
    id: 'studio-dom-workflow', title: 'Rendered studio controls edit, arrange, play and save the real project',
    async run() {
      return withApi(() => withStudio(async (get, host) => {
        assert(buttonNamed(host, 'Export WAV').disabled, 'WAV export was enabled before an arrangement existed.');
        buttonNamed(host, 'C4, 0.40 seconds, edit note').click();
        await waitFor(() => !!host.querySelector('[aria-label="Raise selected note one semitone"]'), 'Selecting the rendered C4 note did not reveal its editor.');
        buttonNamed(host, 'Raise selected note one semitone').click();
        await waitFor(() => get().project.notes[0].midi === 61, 'The rendered semitone button did not update the real note.');
        same(get().project.notes.map(note => [note.start, note.duration]), fixtureNotes.map(note => [note.start, note.duration]), 'Editing pitch changed captured note timing.');

        changeNativeValue(labelledSelect(host, 'LEAD INSTRUMENT'), 'Strings');
        await waitFor(() => get().project.settings.instrument === 'Strings', 'The rendered instrument select did not update the project.');
        changeNativeValue(host.querySelector('[aria-label="Composition tempo in BPM"]'), 120);
        await waitFor(() => get().project.settings.bpm === 120, 'The rendered BPM range did not update the project.');

        buttonNamed(host, 'Make it cinematic').click();
        await waitFor(() => [...host.querySelectorAll('button')].some(button => normalizedText(button) === 'Apply direction'), 'The rendered producer did not return an applicable direction.');
        assert(get().project.settings.mood === 'Dreamy', 'A producer proposal changed the mood before the user applied it.');
        buttonNamed(host, 'Apply direction').click();
        await waitFor(() => get().project.settings.mood === 'Cinematic', 'Apply direction did not update the real project settings.');

        buttonNamed(host, 'Create arrangement').click();
        await waitFor(() => !!get().arrangement && !get().arranging, 'The rendered arrangement button did not produce a playable arrangement.');
        same(get().arrangement, buildArrangement(get().project.notes, get().project.settings), 'The rendered studio did not use the real arrangement engine.');
        assert(!buttonNamed(host, 'Export WAV').disabled, 'WAV export remained disabled after the real arrangement was ready.');

        buttonNamed(host, 'Play composition').click();
        await waitFor(() => get().transport === 'playing', `The rendered Play control did not start the real composition: ${get().error}`);
        buttonNamed(host, 'Pause composition').click();
        await waitFor(() => get().transport === 'paused', 'The rendered Pause control did not pause the real composition.');
        buttonNamed(host, 'Resume composition').click();
        await waitFor(() => get().transport === 'playing', 'The rendered Resume control did not resume the real composition.');
        buttonNamed(host, 'Stop composition').click();
        await waitFor(() => get().transport === 'stopped' && get().position === 0, 'The rendered Stop control did not reset the real transport.');
        assert(buttonNamed(host, 'Stop composition').disabled, 'Stop remained enabled after the transport stopped.');

        const editedNotes = structuredClone(get().project.notes);
        assert(get().dirty, 'The actual note and settings edits were not marked unsaved.');
        buttonNamed(host, 'Save project').click();
        await waitFor(() => !get().saving && !get().dirty && get().projects.length === 1, 'The rendered Save button did not save the isolated project and clear its dirty state.');
        const saved = structuredClone(get().projects[0]);
        same(saved.notes, editedNotes, 'The in-memory API did not receive the note edited through the UI.');
        assert(saved.settings.instrument === 'Strings' && saved.settings.bpm === 120 && saved.settings.mood === 'Cinematic', 'Saving lost the controls applied through the rendered UI.');
        assert(await get().newProject(), 'A fresh project could not be created after saving.');
        await waitFor(() => get().project.id !== saved.id, 'The hook did not leave the saved project.');
        assert(await get().openProject(saved), 'The isolated saved project could not be reopened.');
        await waitFor(() => get().project.id === saved.id, 'The saved project did not reopen.');
        same(get().project.notes, editedNotes, 'Reopening changed the saved melody.');
        assert(labelledSelect(host, 'LEAD INSTRUMENT').value === 'Strings', 'Reopening did not restore the saved instrument in the actual control.');
        return 'Actual DOM controls raised C4 to C♯4, selected Strings / 120 BPM, explicitly applied Cinematic, used the real arranger and CompositionPlayer, then saved and reopened the edited notes. Export gating checked; WAV signal is verified separately.';
      }, { renderActualUi: true }));
    },
  },
  {
    id: 'studio-dom-capture-gating', title: 'A pending microphone request disables studio mutations and Cancel preserves the melody',
    async run() {
      return withApi(() => withStudio(async (get, host) => {
        const permission = deferred();
        let requested = false;
        return withGetUserMedia(() => { requested = true; return permission.promise; }, async () => {
          try {
            buttonNamed(host, 'Start microphone recording').click();
            await waitFor(() => requested && get().capture === 'requesting', 'The rendered Record control did not enter the delayed microphone-request state.');
            const controls = [
              ['project title', host.querySelector('[aria-label="Project title"]')],
              ['lead instrument', labelledSelect(host, 'LEAD INSTRUMENT')],
              ['composition tempo', host.querySelector('[aria-label="Composition tempo in BPM"]')],
              ['captured note', buttonNamed(host, 'C4, 0.40 seconds, edit note')],
              ['save', buttonNamed(host, 'Save project')],
              ['export', buttonNamed(host, 'Export WAV')],
              ['arrangement', buttonNamed(host, 'Create arrangement')],
              ['record', buttonNamed(host, 'Start microphone recording')],
              ['producer prompt', buttonNamed(host, 'Make it cinematic')],
              ['producer text', host.querySelector('#producer-input')],
            ];
            for (const [name, control] of controls) assert(control?.matches(':disabled'), `The rendered ${name} control allowed mutation during a microphone request.`);
            assert([...host.querySelectorAll('.mood-options button, .layer-controls input')].every(control => control.matches(':disabled')), 'Mood or musical layers remained editable while recording permission was pending.');
            same(get().project.notes, fixtureNotes, 'Requesting microphone access changed the existing melody.');
            const cancel = buttonNamed(host, 'Cancel request');
            assert(!cancel.disabled, 'Cancel was disabled during the pending microphone request.');
            cancel.click();
            await waitFor(() => get().capture === 'idle', 'The rendered Cancel control did not return the recorder to idle.');
            permission.reject(new DOMException('Synthetic QA cancelled request', 'NotAllowedError'));
            await sleep(40);
            same(get().project.notes, fixtureNotes, 'The rendered Cancel control erased or changed the prior melody.');
            assert(get().error === '', 'The cancelled request leaked a late permission error into the studio.');
            assert(!buttonNamed(host, 'Create arrangement').disabled, 'Cancelling did not restore arrangement creation.');
            assert(!labelledSelect(host, 'LEAD INSTRUMENT').disabled, 'Cancelling did not restore instrument editing.');
            return 'Record, note editing, settings, project actions and producer controls were disabled during the isolated pending request. Cancel preserved every captured note and ignored the late refusal.';
          } finally {
            permission.reject(new DOMException('Synthetic QA cleanup', 'NotAllowedError'));
            if (get().capture === 'requesting') get().cancelRecordingRequest();
            await sleep(40);
          }
        });
      }, { renderActualUi: true }));
    },
  },
  {
    id: 'app-dom-navigation-presets', title: 'Home HUM, DISCOVER and CREATE actions navigate and apply supported sound settings',
    async run() {
      return withApi(async () => {
        const host = document.createElement('div');
        document.getElementById('integration-harness').append(host);
        const root = createRoot(host);
        const previousTitle = document.title;
        const heroAction = name => {
          const button = [...host.querySelectorAll('.hero-actions button')].find(element => element.querySelector('strong')?.textContent === name);
          assert(button, `The rendered home page is missing its ${name} action.`);
          return button;
        };
        root.render(<App />);
        try {
          await waitFor(() => host.querySelector('.local-label')?.textContent.includes('Local server connected'), 'The isolated App did not connect to its in-memory API.');
          heroAction('HUM').click();
          await waitFor(() => !!host.querySelector('.hum-experience'), 'The home HUM action did not open the capture experience.');
          assert(host.querySelectorAll('.midi-note').length === 0, 'The empty HUM page fabricated detected melody notes.');
          assert(!buttonNamed(host, 'Start microphone recording').disabled, 'HUM did not expose an available recorder.');

          buttonNamed(host, 'Home').click();
          await waitFor(() => !!host.querySelector('.hero-actions'), 'Home navigation did not return to the hero actions.');
          heroAction('DISCOVER').click();
          await waitFor(() => !!host.querySelector('[aria-label="Explore Ambient"]'), 'The home DISCOVER action did not open the sound library.');
          buttonNamed(host, 'Explore Ambient').click();
          await waitFor(() => !!host.querySelector('[aria-label="Project title"]'), 'Choosing an Ambient starting point did not open the actual studio.');
          assert(labelledSelect(host, 'LEAD INSTRUMENT').value === 'Strings', 'The Ambient starting point did not select the supported Strings instrument.');
          assert(labelledSelect(host, 'GENRE').value === 'Ambient', 'The Ambient starting point did not select its actual engine genre.');
          const selectedInstrument = host.querySelector('.instrument-choice[aria-pressed="true"]');
          assert(selectedInstrument && normalizedText(selectedInstrument) === 'Strings', 'The sidebar instrument selection disagrees with the studio control.');
          assert(host.querySelectorAll('.midi-note').length === 0, 'A sound starting point fabricated captured notes.');

          buttonNamed(host, 'Home').click();
          await waitFor(() => !!host.querySelector('.hero-actions'), 'Home navigation did not return after applying a starting point.');
          buttonNamed(host, 'Start creating').click();
          await waitFor(() => !!host.querySelector('[aria-label="Project title"]'), 'The home CREATE action did not open a fresh studio project.');
          assert(labelledSelect(host, 'LEAD INSTRUMENT').value === DEFAULT_SETTINGS.instrument, 'CREATE did not restore the new-project instrument default.');
          assert(host.querySelectorAll('.midi-note').length === 0, 'CREATE filled a fresh project with invented melody notes.');
          assert(buttonNamed(host, 'Create arrangement').disabled && buttonNamed(host, 'Export WAV').disabled, 'A fresh project enabled arrangement or export without captured notes.');
          return 'Actual home actions opened HUM, the sound library and a fresh studio. Ambient selected the supported Strings / Ambient controls consistently; presets and new projects created no detected notes.';
        } finally {
          root.unmount();
          host.remove();
          document.title = previousTitle;
          await sleep(20);
        }
      });
    },
  },
];

function BrowserChecks() {
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  async function run() {
    if (running) return;
    setRunning(true); setDone(false); setResults([]);
    const collected = [];
    let context;
    let unlockError;
    try {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Web Audio requires a supported browser.');
      // Starts at the explicit button gesture; synthetic capture never connects to speakers.
      context = new AudioContextClass();
      await context.resume();
    } catch (error) { unlockError = error; }
    try {
      for (const check of checks) {
        setResults([...collected, { id: check.id, title: check.title, status: 'running' }]);
        const started = performance.now();
        try {
          if (unlockError) throw unlockError;
          const detail = await check.run(context);
          collected.push({ id: check.id, title: check.title, status: 'passed', milliseconds: Math.round(performance.now() - started), detail });
        } catch (error) {
          collected.push({ id: check.id, title: check.title, status: 'failed', milliseconds: Math.round(performance.now() - started), detail: error.message || String(error) });
        }
        setResults([...collected]);
      }
    } finally {
      if (context && context.state !== 'closed') await context.close();
      setRunning(false); setDone(true);
    }
  }
  const passed = results.filter(result => result.status === 'passed').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const status = running ? 'running' : done ? failed ? 'failed' : 'passed' : 'idle';
  return <main>
    <small>DEVELOPER CHECKS · SYNTHETIC QA FIXTURES ONLY</small>
    <h1>MUSE browser integration checks</h1>
    <p className="description">This separate test page exercises real Web Audio rendering, actual recorder analysis, the studio hook and rendered product controls. Generated C–E–G audio is an isolated synthetic QA fixture. Integration requests use an in-memory API double; no real projects are saved and no microphone permission is requested.</p>
    <p className="description">Keep this tab active while the recorder test runs. Synthetic microphone input is never connected to speakers. The rendered transport test briefly plays a synthetic arrangement through the real player. The audio unlock test delays a real AudioContext at its resume boundary.</p>
    <button id="run-browser-checks" disabled={running} onClick={run}>{running ? 'Running browser checks…' : 'Run browser checks'}</button>
    <p><output id="browser-summary" data-status={status} data-passed={passed} data-failed={failed} data-total={checks.length} aria-live="polite">{status.toUpperCase()} · {passed} passed · {failed} failed · {checks.length} total</output></p>
    <ol id="browser-check-results">{results.map(result => <li key={result.id} id={result.id} data-test-id={result.id} data-status={result.status}><strong>{result.status.toUpperCase()}: {result.title}</strong>{result.milliseconds !== undefined && <small> · {result.milliseconds}ms</small>}{result.detail && <pre>{result.detail}</pre>}</li>)}</ol>
    <h2>Machine-readable results</h2>
    <pre id="machine-results">{JSON.stringify({ status, passed, failed, total: checks.length, syntheticQaFixtures: true, results }, null, 2)}</pre>
  </main>;
}

createRoot(document.getElementById('root')).render(<BrowserChecks />);
