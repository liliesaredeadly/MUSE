// Developer-only QA fixtures. Never imported by the product or stored by the real API.
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildArrangement } from '../src/music/arrangement.js';
import { CompositionPlayer, exportWav } from '../src/audio/synth.js';
import { MicrophoneRecorder } from '../src/audio/recorder.js';
import { decodePcmWav, encodePcmWav } from '../src/audio/pcm-wav.js';
import { analyzeMelody } from '../src/audio/melody-analysis.js';
import { assessTranscription } from '../src/audio/transcription-quality.js';
import { makeHum } from './fixtures/hum-fixtures.js';
import { useStudio } from '../src/hooks/useStudio.js';
import { DEFAULT_SETTINGS } from '../src/lib/projects.js';
import Studio from '../src/components/Studio.jsx';
import Producer from '../src/components/Producer.jsx';
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
  let recordingSource = null;
  globalThis.fetch = async (input, options = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (!path.startsWith('/api/')) return original(input, options);
    const body = path === '/api/melody/analyze' ? options.body : options.body ? JSON.parse(options.body) : undefined;
    if (onRequest) {
      const custom = await onRequest(path, options.method || 'GET', body);
      if (custom !== undefined) return custom;
    }
    if (path === '/api/health') return response({ status: 'ok', database: 'isolated QA fixture' });
    if (path === '/api/projects' && (options.method || 'GET') === 'GET') return response({ projects: saved ? [saved] : [] });
    if (path === '/api/projects') { saved = { ...body, updatedAt: new Date().toISOString() }; return response({ project: saved }); }
    if (path === '/api/melody/analyze') {
      assert(new Headers(options.headers).get('Content-Type') === 'audio/wav', 'Full-recording analysis did not upload an audio file.');
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const decoded = decodePcmWav(bytes);
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
      const analysis = analyzeMelody(decoded.samples, decoded.sampleRate);
      analysis.quality = assessTranscription(analysis);
      recordingSource = { sha256, duration: decoded.duration, quality: analysis.quality };
      return response({ conditioningId: 'qa-take', receipt: {
        sha256, bytes: bytes.length, sampleRate: decoded.sampleRate, channels: decoded.channels,
        selectedChannel: decoded.selectedChannel, duration: decoded.duration,
      }, analysis });
    }
    if (path === '/api/arrange') return response({ arrangement: buildArrangement(body.notes, body.settings,
      body.settings.leadSource === 'recording' ? recordingSource : undefined) });
    if (path === '/api/producer/status') return response({ mode: 'rules', provider: null, model: null });
    if (path === '/api/producer') return response({ ...interpretDirection(body.text, body.settings), source: 'rules' });
    if (path === '/api/production-director/status') return response({ mode: 'rules', provider: null, model: null });
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

async function withStudio(action, { renderActualUi = false, renderLegacyProducer = false, visible = false } = {}) {
  const host = document.createElement('div');
  (visible ? document.body : document.getElementById('integration-harness')).append(host);
  const root = createRoot(host);
  let latest = null;
  function Harness() {
    const studio = useStudio();
    useLayoutEffect(() => { latest = studio; });
    return <>
      {renderActualUi ? <Studio studio={studio} /> : <audio ref={studio.audioRef} />}
      {renderLegacyProducer && <Producer key={studio.project.id} settings={studio.project.settings}
        analysis={{ notes: studio.project.notes, key: studio.arrangement?.key }} hasNotes={studio.hasMelody}
        busy={studio.busy || studio.arranging} apply={studio.changeSettings} />}
    </>;
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
    id: 'original-recording-lead-import', title: 'The actual imported hum stays the full lead and limited-transcription warnings survive generation',
    async run() {
      const fixture = makeHum([{ midi: 60, start: 0.2, duration: 0.15 }, { midi: 64, start: 1, duration: 0.15 }, { midi: 67, start: 1.8, duration: 0.15 }], { duration: 2.4, sampleRate: 16000 });
      const file = new File([encodePcmWav(fixture.samples, fixture.sampleRate)], 'original-hum-qa.wav', { type: 'audio/wav' });
      return withApi(() => withStudio(async (get, host) => {
        await get().importRecording(file);
        await waitFor(() => !get().busy && get().project.settings.leadSource === 'recording', 'The original recording did not become the selected lead.');
        const sourceNotes = structuredClone(get().project.notes);
        assert(get().transcriptionQuality?.canHarmonize === false, 'Sparse pitch evidence was incorrectly approved for harmony.');
        get().generate();
        await waitFor(() => get().arrangement && !get().arranging, 'The original hum could not be arranged.');
        assert(Math.abs(get().arrangement.duration - 2.4) < 1e-5, 'The full hum was truncated to the last detected fragment.');
        assert(get().arrangement.recordingLead.audioWav instanceof Blob, 'The actual verified waveform did not reach playback.');
        assert(!get().arrangement.events.some(event => event.track === 'melody' || event.track === 'chords' || event.track === 'bass'), 'Uncertain transcription produced a competing pitched layer.');
        assert(host.querySelector('[data-testid="transcription-quality"]')?.textContent.includes('Original hum'), 'The lead identity or reliability notice disappeared.');
        get().changeSettings({ production: 'dance-pop', genre: 'Electronic', percussion: true, instrument: 'Strings' });
        await waitFor(() => get().arrangement?.production.style === 'dance-pop' && !get().arranging, 'The production change lost the original lead.');
        assert(get().project.settings.leadSource === 'recording' && get().arrangement.recordingLead, 'A producer instrument proposal silently replaced the original hum.');
        assert(get().transcriptionQuality?.canHarmonize === false, 'Generation erased the transcription reliability warning.');
        get().updateNote(0, 1);
        await waitFor(() => get().project.settings.leadSource === 'instrument', 'An explicit note edit was mislabeled as unchanged original audio.');
        get().changeSettings({ leadSource: 'recording' });
        await waitFor(() => get().project.settings.leadSource === 'recording', 'The original recording could not be selected again.');
        same(get().project.notes, sourceNotes, 'Restoring the original hum reused edited transcription notes.');
        return 'Imported waveform and full clock survive generation/style changes; uncertain guessed harmony is disabled; instrumental edits are explicit and the original source can be restored.';
      }, { renderActualUi: true }));
    },
  },
  {
    id: 'failed-import-keeps-original', title: 'An invalid imported file cannot erase the current original hum',
    async run() {
      const fixture = makeHum([{ midi: 60, start: 0.1, duration: 0.4 }], { duration: 0.7, sampleRate: 16000 });
      return withApi(() => withStudio(async get => {
        await get().importRecording(new File([encodePcmWav(fixture.samples, 16000)], 'good.wav', { type: 'audio/wav' }));
        await waitFor(() => !get().busy && get().captureSummary?.receipt, 'The initial usable import did not finish.');
        const before = { notes: structuredClone(get().project.notes), url: get().audioUrl, receipt: get().captureSummary.receipt.sha256 };
        await get().importRecording(new File(['not an audio file'], 'broken.wav', { type: 'audio/wav' }));
        await waitFor(() => !get().busy, 'An invalid import left capture busy.');
        same(get().project.notes, before.notes, 'An invalid import erased detected notes from the previous take.');
        assert(get().audioUrl === before.url && get().captureSummary.receipt.sha256 === before.receipt, 'An invalid import replaced the usable original source.');
        get().generate();
        await waitFor(() => get().arrangement?.recordingLead, 'The retained original recording could not be arranged after import failure.');
        return 'Import failure keeps the previous waveform, notes, source receipt and ability to arrange.';
      }));
    },
  },
  {
    id: 'zero-note-capture-feedback', title: 'A zero-note take keeps its audio, microphone identity and useful feedback',
    async run(context) {
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.00001;
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      try {
        return await withApi(() => withGetUserMedia(async () => destination.stream, () => withStudio(async (get, host) => {
          await get().startRecording();
          await waitFor(() => get().capture === 'recording', 'The isolated silent capture did not start.');
          await sleep(260);
          await get().stopRecording();
          await waitFor(() => get().capture === 'idle' && get().audioUrl, 'The captured audio was not retained.');
          get().notify('');
          await waitFor(() => host.querySelector('.capture-feedback'), 'No persistent explanation remains after a take with zero stable notes.');
          assert(/no stable notes/i.test(host.querySelector('.capture-feedback').textContent), 'The feedback does not distinguish audio capture from note recognition.');
          assert(host.querySelector('.microphone-source')?.textContent.trim(), 'The recorder does not identify its active microphone.');
          const download = host.querySelector('.original-recording a[download]');
          assert(download?.getAttribute('href') === get().audioUrl, 'The original take cannot be downloaded before another attempt.');
          assert(get().project.notes.length === 0 && buttonNamed(host, 'Create arrangement').disabled, 'A silent take fabricated a melody or enabled arranging.');
          return 'The real recorder keeps its audio and microphone identity, explains zero-note results persistently, and offers an original download.';
        }, { renderActualUi: true })));
      } finally {
        oscillator.stop(); oscillator.disconnect(); gain.disconnect();
        destination.stream.getTracks().forEach(track => track.stop());
        destination.disconnect();
      }
    },
  },
  {
    id: 'note-boundary-controls', title: 'Pitch edit buttons respect MIDI limits and expose selection',
    async run() {
      return withApi(() => withStudio(async (get, host) => {
        await get().openProject({ ...fixtureProject(), id: 'pitch-boundaries-qa', notes: [
          { ...fixtureNotes[0], midi: 0, name: 'C-1' }, { ...fixtureNotes[1], midi: 127, name: 'G9' },
        ] });
        await waitFor(() => get().project.id === 'pitch-boundaries-qa', 'The boundary fixture did not open.');
        const low = buttonNamed(host, 'C-1, 0.40 seconds, edit note');
        low.click();
        await waitFor(() => host.querySelector('.note-editor'), 'The low note editor did not open.');
        assert(buttonNamed(host, 'Lower selected note one semitone').disabled, 'Lower remains active at MIDI 0.');
        assert(low.getAttribute('aria-pressed') === 'true', 'The selected note does not expose its selection.');
        buttonNamed(host, 'G9, 0.40 seconds, edit note').click();
        await waitFor(() => host.querySelector('.note-editor strong')?.textContent === 'G9', 'The high note editor did not open.');
        assert(buttonNamed(host, 'Raise selected note one semitone').disabled, 'Raise remains active at MIDI 127.');
        return 'Boundary actions are unavailable and selected note state is exposed to assistive technology.';
      }, { renderActualUi: true }));
    },
  },
  {
    id: 'note-edit-full-midi-range', title: 'Valid low and high pitches edit by exactly one semitone',
    async run() {
      return withApi(() => withStudio(async get => {
        await get().openProject({ ...fixtureProject(), id: 'pitch-edit-range-qa', notes: [
          { ...fixtureNotes[0], midi: 0, name: 'C-1' }, { ...fixtureNotes[1], midi: 127, name: 'G9' },
        ] });
        await waitFor(() => get().project.id === 'pitch-edit-range-qa', 'The pitch range fixture did not open.');
        get().updateNote(0, -1);
        await sleep(30);
        assert(get().project.notes[0].midi === 0 && !get().dirty, 'An unavailable lower edit changed or dirtied the project.');
        get().updateNote(0, 1);
        get().updateNote(1, -1);
        await waitFor(() => get().project.notes[0].midi === 1 && get().project.notes[1].midi === 126, 'Editing valid pitches jumped to an unrelated octave.');
        return 'MIDI 0→1 and 127→126 remain exact semitone edits; an unavailable edit has no side effects.';
      }));
    },
  },
  {
    id: 'note-edit-contour-frequency-boundary', title: 'A pitch edit outside the supported contour range preserves the current melody',
    async run() {
      return withApi(() => withStudio(async get => {
        await get().openProject({ ...fixtureProject(), id: 'contour-frequency-boundary-qa', notes: [
          { ...fixtureNotes[0], contour: [{ time: 0, frequency: 19900 }, { time: 0.4, frequency: 20000 }] },
        ] });
        await waitFor(() => get().project.id === 'contour-frequency-boundary-qa', 'The contour boundary fixture did not open.');
        const originalNotes = structuredClone(get().project.notes);
        get().updateNote(0, 1);
        await waitFor(() => !!get().error, 'The unsupported pitch edit did not explain its supported range.');
        same(get().project.notes, originalNotes, 'The rejected edit changed the source note or its contour.');
        assert(!get().dirty && /range|20,?000/i.test(get().error), 'The rejected edit dirtied the project or did not explain the audio range.');
        get().updateNote(0, -1);
        await waitFor(() => get().project.notes[0].midi === 59, 'A valid downward edit was blocked after the rejected edit.');
        assert(get().project.notes[0].contour.every(point => point.frequency > 0 && point.frequency < 20000), 'The valid edit produced an unsupported contour.');
        return 'An out-of-range transpose keeps the original note and clean project; a subsequent valid downward edit still succeeds.';
      }));
    },
  },
  {
    id: 'note-remove-restores-focus', title: 'Removing a note keeps keyboard focus in the melody editor',
    async run() {
      return withApi(() => withStudio(async (get, host) => {
        buttonNamed(host, 'E4, 0.40 seconds, edit note').click();
        await waitFor(() => host.querySelector('.note-editor'), 'The selected note editor did not open.');
        const remove = buttonNamed(host, 'Remove selected note');
        remove.focus();
        assert(document.activeElement === remove, 'The focus fixture must be visible before testing deletion.');
        remove.click();
        await waitFor(() => get().project.notes.length === 2, 'The selected note was not removed.');
        assert(document.activeElement === buttonNamed(host, 'G4, 0.40 seconds, edit note'), 'Removing the middle note lost focus instead of moving to the next note.');
        for (const name of ['G4', 'C4']) {
          buttonNamed(host, `${name}, 0.40 seconds, edit note`).click();
          await waitFor(() => host.querySelector('.note-editor'), 'The next note editor did not open.');
          const nextRemove = buttonNamed(host, 'Remove selected note');
          nextRemove.focus(); nextRemove.click();
          await waitFor(() => !host.querySelector('.note-editor'), 'The removed note editor remained open.');
        }
        assert(document.activeElement === host.querySelector('.piano-roll'), 'Removing the final note lost focus instead of returning to the melody area.');
        return 'Deletion focuses the next note, the previous note, or the empty melody area as appropriate.';
      }, { renderActualUi: true, visible: true }));
    },
  },
  {
    id: 'drums-layer-control', title: 'Drums shows its included percussion and restores the independent toggle for other leads',
    async run() {
      return withApi(() => withStudio(async (get, host) => {
        const lead = labelledSelect(host, 'LEAD INSTRUMENT');
        changeNativeValue(lead, 'Drums');
        await waitFor(() => get().project.settings.instrument === 'Drums', 'The Drums lead was not selected.');
        const percussion = host.querySelector('.layer-controls label:last-child input');
        assert(percussion.checked && percussion.disabled, 'Drums includes percussion, but its control showed an off or editable layer.');
        changeNativeValue(lead, 'Piano');
        await waitFor(() => get().project.settings.instrument === 'Piano', 'The Piano lead was not restored.');
        assert(!percussion.checked && !percussion.disabled, 'Leaving Drums did not restore the original independent percussion preference.');
        percussion.click();
        await waitFor(() => get().project.settings.percussion === true, 'The independent percussion toggle stopped working.');
        return 'Drums visibly includes its rhythm; switching lead restores the separately editable percussion preference.';
      }, { renderActualUi: true }));
    },
  },
  {
    id: 'startup-library-keeps-saved-project', title: 'A slow startup library response cannot hide a project saved in the meantime',
    async run() {
      const listing = deferred();
      let listRequested = false;
      return withApi(async () => {
        const host = document.createElement('div');
        document.getElementById('integration-harness').append(host);
        const root = createRoot(host);
        const previousTitle = document.title;
        root.render(<App />);
        try {
          await waitFor(() => listRequested && !!host.querySelector('.hero-actions'), 'The startup library request did not begin.');
          const create = [...host.querySelectorAll('.hero-actions button')].find(button => button.querySelector('strong')?.textContent === 'CREATE');
          assert(create, 'The home page did not expose its Create action.');
          create.click();
          await waitFor(() => !!host.querySelector('[aria-label="Project title"]'), 'Create did not open the studio while the library was loading.');
          changeNativeValue(host.querySelector('[aria-label="Project title"]'), 'Saved during startup — QA');
          await waitFor(() => !buttonNamed(host, 'Save project').disabled, 'The renamed project could not be saved during startup.');
          buttonNamed(host, 'Save project').click();
          await waitFor(() => host.textContent.includes('SAVED TO THIS DEVICE'), 'The new project was not saved before startup completed.');
          listing.resolve(response({ projects: [] }));
          await sleep(60);
          buttonNamed(host, 'My projects').click();
          await waitFor(() => !!host.querySelector('.reference-projects'), 'The saved project archive did not open.');
          assert(host.querySelector('.reference-project-card h3')?.textContent === 'Saved during startup — QA', 'The stale startup library snapshot hid the successfully saved project.');
          return 'A project saved before the initial library request finishes remains visible in the archive.';
        } finally {
          listing.resolve(response({ projects: [] }));
          root.unmount(); host.remove(); document.title = previousTitle;
          await sleep(20);
        }
      }, (path, method) => {
        if (path === '/api/projects' && method === 'GET') { listRequested = true; return listing.promise; }
      });
    },
  },
  {
    id: 'save-survives-library-failure', title: 'A persisted project stays saved when the library cannot refresh',
    async run() {
      let listRequests = 0;
      return withApi(() => withStudio(async get => {
        get().rename('Saved despite library outage — QA');
        await waitFor(() => get().dirty, 'The rename did not settle.');
        assert(await get().save(), 'A successful project save was reported as failed because the library refresh was unavailable.');
        await waitFor(() => !get().saving && !get().dirty, 'The persisted project was left marked unsaved.');
        assert(get().projects.some(item => item.id === get().project.id && item.title === 'Saved despite library outage — QA'), 'The authoritative saved project was not kept in the local library.');
        return 'A successful POST is authoritative; a later list outage cannot undo its saved state or hide its library entry.';
      }), (path, method) => {
        if (path === '/api/projects' && method === 'GET' && ++listRequests > 1) throw new Error('Isolated library refresh outage');
      });
    },
  },
  {
    id: 'reopen-current-keeps-edits', title: 'Reopening the current library project preserves its latest edits',
    async run() {
      return withApi(() => withStudio(async get => {
        const oldLibraryCopy = structuredClone(get().project);
        get().rename('Latest melody — QA');
        get().updateNote(0, 1);
        await waitFor(() => get().dirty && get().project.notes[0].midi === 61, 'The current project edits did not settle.');
        assert(await get().openProject(oldLibraryCopy), 'The current project could not reopen.');
        await waitFor(() => !get().saving, 'The reopen save did not finish.');
        assert(get().project.title === 'Latest melody — QA' && get().project.notes[0].midi === 61, 'Reopening the current project replaced its latest edits with the old gallery snapshot.');
        assert(!get().dirty, 'The successfully saved current project is still marked dirty.');
        same(get().projects[0].notes, get().project.notes, 'The studio and saved library disagree after reopening the current project.');
        return 'The same-project gallery snapshot cannot replace the title or edited pitches saved during reopen.';
      }));
    },
  },
  {
    id: 'empty-project-can-save', title: 'Removing every note still permits an explicit save',
    async run() {
      return withApi(() => withStudio(async (get, host) => {
        for (let index = fixtureNotes.length - 1; index >= 0; index--) get().updateNote(index, 'remove');
        await waitFor(() => get().project.notes.length === 0 && get().dirty, 'The final note was not removed.');
        const save = buttonNamed(host, 'Save project');
        assert(!save.disabled, 'Removing the final note made Save unavailable for the edited project.');
        save.click();
        await waitFor(() => !get().saving && !get().dirty && get().projects.length === 1, 'The empty edited project was not saved.');
        same(get().projects[0].notes, [], 'Saving resurrected deleted notes.');
        return 'The real Save control persists an intentionally empty melody and clears its dirty state.';
      }, { renderActualUi: true }));
    },
  },
  {
    id: 'empty-project-navigation-saves', title: 'New and Open preserve edits after the final note is removed',
    async run() {
      for (const destination of ['new', 'open']) {
        await withApi(() => withStudio(async get => {
          for (let index = fixtureNotes.length - 1; index >= 0; index--) get().updateNote(index, 'remove');
          get().rename('Cleared melody — QA');
          await waitFor(() => get().project.notes.length === 0 && get().dirty, 'The cleared project did not settle.');
          const opened = destination === 'new' ? await get().newProject() : await get().openProject({ ...fixtureProject(), id: 'other-qa-project' });
          assert(opened, `${destination} did not complete.`);
          await waitFor(() => get().project.id !== 'synthetic-browser-qa-fixture', `${destination} did not change projects.`);
          const saved = get().projects.find(item => item.id === 'synthetic-browser-qa-fixture');
          assert(saved && saved.title === 'Cleared melody — QA' && saved.notes.length === 0, `${destination} discarded the final-note deletion instead of saving it.`);
        }));
      }
      return 'Both New and Open save a dirty empty project before switching, preserving deleted notes and title edits.';
    },
  },
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
    id: 'real-instrument-tempo', title: 'Instrument and backing BPM change audio while the default melody timing stays locked',
    async run() {
      const piano = await pcm(await exportWav(buildArrangement(fixtureNotes, fixtureSettings)));
      const strings = await pcm(await exportWav(buildArrangement(fixtureNotes, { ...fixtureSettings, instrument: 'Strings' })));
      const faster = await pcm(await exportWav(buildArrangement(fixtureNotes, { ...fixtureSettings, bpm: 180, preserveMelodyTiming: false })));
      const backingSettings = { ...fixtureSettings, accompaniment: true, genre: 'Electronic' };
      const slowBacking = buildArrangement(fixtureNotes, backingSettings);
      const fastBacking = buildArrangement(fixtureNotes, { ...backingSettings, bpm: 180 });
      const locked = await pcm(await exportWav(fastBacking));
      let changed = 0;
      for (let index = 0; index < Math.min(piano.sampleCount, strings.sampleCount); index++) {
        if (Math.abs(piano.view.getInt16(44 + index * 2, true) - strings.view.getInt16(44 + index * 2, true)) > 8) changed++;
      }
      assert(strings.rms > 0.002, 'The Strings voice rendered silence.');
      assert(changed > piano.sampleCount * 0.1, 'Piano and Strings produced effectively identical PCM.');
      same(fastBacking.events.filter(event => event.track === 'melody').map(({ midi, start, duration }) => ({ midi, start, duration })), [
        { midi: 60, start: 0, duration: 0.4 }, { midi: 64, start: 0.5, duration: 0.4 }, { midi: 67, start: 1, duration: 0.4 },
      ], 'Backing tempo changed the locked source melody.');
      assert(JSON.stringify(slowBacking.events.filter(event => event.track !== 'melody')) !== JSON.stringify(fastBacking.events.filter(event => event.track !== 'melody')), 'Backing BPM did not change its accompaniment rhythm.');
      assert(Math.abs(locked.duration - 3) < 0.001, `Locked melody WAV changed duration with backing BPM: ${locked.duration}s.`);
      assert(Math.abs(faster.duration - 2.3) < 0.001, `Doubling BPM did not halve the musical duration: WAV ${faster.duration}s.`);
      return `${changed} samples differ between Piano and Strings. Locked melody stays ${locked.duration.toFixed(3)}s while backing changes; explicit tempo transformation gives ${faster.duration.toFixed(3)}s including the same tail.`;
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
    id: 'expired-conditioning-reanalyzes-original', title: 'Expired recording conditioning recovers from the identical original take',
    async run(context) {
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.06; oscillator.frequency.value = 440;
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      const uploads = [];
      let arrangementRequests = 0;
      try {
        return await withApi(() => withGetUserMedia(async () => destination.stream, () => withStudio(async get => {
          await get().startRecording();
          await waitFor(() => get().capture === 'recording', 'The expiry fixture did not start recording.');
          await sleep(400);
          await get().stopRecording();
          await waitFor(() => get().capture === 'idle' && get().project.notes.length > 0, 'The recorded expiry fixture produced no melody.');
          const originalNotes = structuredClone(get().project.notes);
          get().generate();
          await waitFor(() => !!get().arrangement && !get().arranging, `The expired take did not recover: ${get().error}`);
          same(get().project.notes, originalNotes, 'Expiry recovery rewrote the source melody.');
          same(uploads[1], uploads[0], 'Expiry recovery uploaded different audio or a different capture boundary.');
          assert(uploads.length === 2 && arrangementRequests === 2, 'Expiry recovery did not analyze and retry exactly once.');
          get().changeSettings({ bpm: 110 });
          await waitFor(() => !!get().arrangement && !get().arranging && arrangementRequests === 3, 'Settings did not reuse the recovered source.');
          assert(uploads.length === 2, 'A settings edit reanalyzed an already recovered source.');
          return 'The hook retained its original audio and cutoff, renewed the verified source once, preserved every source note, and reused the new conditioning ID.';
        })), async (path, _method, body) => {
          if (path === '/api/melody/analyze') uploads.push([...new Uint8Array(await body.arrayBuffer())]);
          if (path === '/api/arrange') {
            arrangementRequests++;
            assert(body.conditioningId === 'qa-take', 'The hook dropped recording conditioning during recovery.');
            if (arrangementRequests === 1) return new Response(JSON.stringify({ error: 'The original conditioning take expired.' }), { status: 410, headers: { 'Content-Type': 'application/json' } });
          }
        });
      } finally {
        oscillator.stop(); oscillator.disconnect(); gain.disconnect();
        destination.stream.getTracks().forEach(track => track.stop()); destination.disconnect();
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
    id: 'stale-playback-error-isolated', title: 'An obsolete audio unlock failure cannot interrupt a newer playback attempt',
    async run() {
      const originalAudioContext = globalThis.AudioContext;
      const firstUnlock = deferred();
      const contexts = [];
      let unlocks = 0;
      function DelayedAudioContext(...args) {
        const context = new originalAudioContext(...args);
        const resume = context.resume.bind(context);
        context.resume = async () => { if (++unlocks === 1) await firstUnlock.promise; return resume(); };
        contexts.push(context);
        return context;
      }
      return withApi(() => withStudio(async get => {
        let firstPlay;
        try {
          get().generate();
          await waitFor(() => !!get().arrangement && !get().arranging, 'The isolated arrangement did not become playable.');
          globalThis.AudioContext = DelayedAudioContext;
          firstPlay = get().play();
          await waitFor(() => unlocks === 1, 'Playback did not reach its first audio unlock.');
          get().stopPlayback();
          await get().play();
          await waitFor(() => get().transport === 'playing', 'The newer playback attempt did not start.');
          firstUnlock.reject(new Error('Synthetic obsolete audio unlock failure'));
          await firstPlay;
          await sleep(30);
          assert(get().transport === 'playing' && get().error === '', `The obsolete unlock failure changed the new playback to ${get().transport}: ${get().error}`);
          return 'A cancelled playback rejection cannot change the active transport or display a stale audio error.';
        } finally {
          firstUnlock.resolve();
          if (firstPlay) await firstPlay;
          globalThis.AudioContext = originalAudioContext;
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
      }, { renderActualUi: true, renderLegacyProducer: true }));
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
              ['director instructions', host.querySelector('[aria-label="Production instructions"]')],
              ['director planning', buttonNamed(host, 'Generate blueprint')],
            ];
            for (const [name, control] of controls) assert(control?.matches(':disabled'), `The rendered ${name} control allowed mutation during a microphone request.`);
            assert([...host.querySelectorAll('.mood-options button, .layer-controls input')].every(control => control.matches(':disabled')), 'Mood or musical layers remained editable while recording permission was pending.');
            assert([...host.querySelectorAll('.production-director fieldset input, .production-director fieldset select, .production-director fieldset button')].every(control => control.matches(':disabled')), 'Production blueprint controls remained editable during a microphone request.');
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
      }, { renderActualUi: true, renderLegacyProducer: true }));
    },
  },
  {
    id: 'producer-dom-ai-review', title: 'AI directions include detected notes and require an explicit Apply action',
    async run() {
      let sent;
      return withApi(() => withStudio(async (get, host) => {
        await waitFor(() => host.querySelector('.small-badge')?.textContent === 'AI enabled', 'Configured AI was not labelled AI enabled.');
        assert(!/connected/i.test(host.querySelector('.small-badge').textContent), 'Configuration was presented as a verified model connection.');
        const disclosure = host.querySelector('.producer-disclosure').textContent;
        assert(/OpenAI/.test(disclosure) && /notes/i.test(disclosure) && /settings/i.test(disclosure) && /instruction/i.test(disclosure), 'The AI disclosure omitted the instruction, settings, detected notes or provider.');
        assert(/recording.*device/i.test(disclosure), 'The AI disclosure did not explain that raw recording stays on the device.');
        buttonNamed(host, 'Make it cinematic').click();
        await waitFor(() => host.textContent.includes('Synthetic AI direction for review.'), 'The rendered producer did not show the mocked AI direction.');
        same(sent.notes, fixtureNotes, 'The producer request did not include the actual detected notes.');
        assert(sent.text === 'Make it cinematic' && sent.settings.mood === 'Dreamy', 'The producer did not send the current instruction and settings.');
        assert(host.querySelector('.small-badge').textContent === 'AI direction', 'An AI result did not identify its actual source.');
        assert(get().project.settings.mood === 'Dreamy', 'An AI direction changed settings before review and Apply.');
        buttonNamed(host, 'Apply direction').click();
        await waitFor(() => get().project.settings.mood === 'Cinematic', 'Explicitly applying the AI direction did not update the actual settings.');
        same(get().project.notes, fixtureNotes, 'Applying an AI direction replaced or rewrote captured notes.');
        return 'Real rendered Producer sent instruction, settings and captured notes, labelled configuration separately from the AI result, disclosed OpenAI, and changed only settings after Apply.';
      }, { renderLegacyProducer: true }), (path, method, body) => {
        if (path === '/api/producer/status') return response({ mode: 'ai', provider: 'openai', model: 'mock-model' });
        if (path === '/api/producer') { sent = body; return response({ message: 'Synthetic AI direction for review.', changes: { mood: 'Cinematic' }, suggestions: [], source: 'ai' }); }
      });
    },
  },
  {
    id: 'producer-dom-rules-fallback', title: 'A rules fallback identifies its source and displays the recovery notice',
    async run() {
      const notice = 'AI is unavailable. This direction uses musical rules.';
      return withApi(() => withStudio(async (get, host) => {
        await waitFor(() => host.querySelector('.small-badge')?.textContent === 'AI enabled', 'Configured AI did not become available in the rendered producer.');
        buttonNamed(host, 'Make it cinematic').click();
        await waitFor(() => host.textContent.includes(notice), 'The rendered producer hid the fallback notice.');
        assert(host.querySelector('.small-badge').textContent === 'Rule-based', 'A rules fallback was incorrectly labelled as an AI result.');
        assert(get().project.settings.mood === 'Dreamy', 'A fallback direction applied itself without user review.');
        assert(!buttonNamed(host, 'Apply direction').disabled, 'The fallback direction could not be explicitly applied.');
        return 'Configured AI fell back visibly to a Rule-based result, kept the explanation inline, and left settings unchanged for review.';
      }, { renderLegacyProducer: true }), (path, method, body) => {
        if (path === '/api/producer/status') return response({ mode: 'ai', provider: 'openai', model: 'mock-model' });
        if (path === '/api/producer') return response({ ...interpretDirection(body.text, body.settings), source: 'rules', notice });
      });
    },
  },
  {
    id: 'producer-dom-stale-directions', title: 'Changes to settings or notes discard stale directions and isolate overlapping requests',
    async run() {
      const first = deferred();
      const second = deferred();
      let requests = 0;
      return withApi(() => withStudio(async (get, host) => {
        buttonNamed(host, 'Make it cinematic').click();
        await waitFor(() => requests === 1, 'The first delayed producer request was not sent.');
        get().changeSettings({ bpm: 110 });
        await waitFor(() => !buttonNamed(host, 'Make it cinematic').disabled, 'Changing settings did not release the stale producer request.');
        buttonNamed(host, 'Give it a dreamy atmosphere').click();
        await waitFor(() => requests === 2, 'A new direction could not be requested for the updated settings.');
        first.resolve(response({ message: 'STALE synthetic direction.', changes: { mood: 'Cinematic' }, suggestions: [], source: 'ai' }));
        await sleep(60);
        assert(!host.textContent.includes('STALE synthetic direction.'), 'A late response for old settings appeared as an applicable direction.');
        assert(buttonNamed(host, 'Make it cinematic').disabled, 'An older request cleared the current request pending state.');
        second.resolve(response({ message: 'CURRENT synthetic direction.', changes: { mood: 'Peaceful' }, suggestions: [], source: 'ai' }));
        await waitFor(() => host.textContent.includes('CURRENT synthetic direction.'), 'The current response was discarded with the stale request.');
        get().updateNote(0, 1);
        await waitFor(() => !host.textContent.includes('CURRENT synthetic direction.'), 'Editing the take left an old direction available to apply.');
        assert(![...host.querySelectorAll('button')].some(button => normalizedText(button) === 'Apply direction'), 'A direction for an earlier take could still be applied.');
        assert(get().project.settings.mood === 'Dreamy' && get().project.settings.bpm === 110, 'A stale producer response changed the current settings.');
        return 'A settings edit invalidated the first request; its late result could not replace the second request or clear its pending state. Editing notes then removed the current proposal.';
      }, { renderLegacyProducer: true }), path => {
        if (path === '/api/producer') { requests++; return requests === 1 ? first.promise : second.promise; }
      });
    },
  },
  {
    id: 'producer-dom-status-loading', title: 'Producer status stays honest while configuration is loading',
    async run() {
      const status = deferred();
      return withApi(() => withStudio(async (get, host) => {
        assert(host.querySelector('.small-badge')?.textContent === 'Checking…', 'An unverified configuration was labelled as an active source.');
        assert(!/no external AI model/i.test(host.querySelector('.producer-disclosure').textContent), 'Loading status incorrectly promised that no AI provider could be used.');
        status.resolve({ mode: 'rules', provider: null, model: null });
        await waitFor(() => host.querySelector('.small-badge')?.textContent === 'Rule-based', 'The producer did not resolve to the configured rules mode.');
        const disclosure = host.querySelector('.producer-disclosure').textContent;
        assert(!/no external AI model/i.test(disclosure) && /OpenAI/.test(disclosure) && /last check/i.test(disclosure), 'Cached rules status failed to disclose possible AI after a server restart.');
        buttonNamed(host, 'Make it cinematic').click();
        await waitFor(() => host.querySelector('.small-badge')?.textContent === 'AI direction', 'Actual AI source did not override cached rules configuration.');
        assert(get().project.settings.mood === 'Dreamy', 'A direction after the server mode changed applied itself.');
        return 'Checking and cached rules status made no false offline promise. A mocked AI response after server mode changed identified its actual source and still required Apply.';
      }, { renderLegacyProducer: true }), path => {
        // A real server supplies a fresh body for each mount's status request.
        if (path === '/api/producer/status') return status.promise.then(value => response(value));
        if (path === '/api/producer') return response({ message: 'Server enabled AI after the last status check.', changes: { mood: 'Cinematic' }, suggestions: [], source: 'ai' });
      });
    },
  },
  {
    id: 'producer-dom-status-failure', title: 'An unavailable status endpoint makes no AI or rules-only claim',
    async run() {
      return withApi(() => withStudio(async (get, host) => {
        await waitFor(() => host.querySelector('.small-badge')?.textContent === 'Status unavailable', 'A failed status request was presented as a known producer mode.');
        const disclosure = host.querySelector('.producer-disclosure').textContent;
        assert(!/no external AI model/i.test(disclosure) && /OpenAI/.test(disclosure), 'Unknown status made a false rules-only promise or omitted possible provider use.');
        buttonNamed(host, 'Make it cinematic').click();
        await waitFor(() => host.querySelector('.small-badge')?.textContent === 'Rule-based', 'A successful rules result did not override the unavailable configuration status.');
        assert(get().project.settings.mood === 'Dreamy', 'The direction applied itself after status failure.');
        return 'A configuration error stayed visible without a false source claim; the later actual rules result accurately identified its source.';
      }, { renderLegacyProducer: true }), path => path === '/api/producer/status' ? new Response(JSON.stringify({ error: 'Synthetic status outage' }), { status: 503 }) : undefined);
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
          const selectedInstrument = labelledSelect(host, 'LEAD INSTRUMENT');
          assert(!selectedInstrument.closest('[hidden], .sr-only') && !selectedInstrument.disabled, 'The Ambient instrument is not available in the actual editable studio control.');
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
  {
    id: 'app-dom-direction-composition', title: 'HUM opens the structured Director and creates only the explicitly accepted editable blueprint',
    async run() {
      let saved = fixtureProject();
      let posted = null;
      let sent = null;
      let arranged = null;
      let arrangeRequests = 0;
      const direction = 'Give these notes cinematic guitar and piano, with violin in the final quarter and no drums.';
      const proposedBlueprint = {
        version: 1, prompt: direction, mood: 'Cinematic', intensity: .65,
        layers: [
          { id: 'guitar', instrument: 'Acoustic Guitar', role: 'rhythm', enabled: true, gain: .6, section: 'full', variant: 0 },
          { id: 'piano', instrument: 'Piano', role: 'chords', enabled: true, gain: .4, section: 'full', variant: 0 },
          { id: 'violin', instrument: 'Violin', role: 'sustain', enabled: true, gain: .35, section: 'ending', variant: 0 },
          { id: 'drums', instrument: 'Drums', role: 'percussion', enabled: false, gain: .2, section: 'full', variant: 0 },
        ],
      };
      const acceptedBlueprint = { ...proposedBlueprint, layers: proposedBlueprint.layers.map(layer => layer.id === 'piano' ? { ...layer, gain: .28 } : { ...layer }) };
      return withApi(async () => {
        const host = document.createElement('div');
        document.getElementById('integration-harness').append(host);
        const root = createRoot(host);
        const previousTitle = document.title;
        root.render(<App />);
        try {
          await waitFor(() => host.querySelector('.local-label')?.textContent.includes('Local server connected'), 'The reference App did not load its isolated saved project.');
          const navigation = host.querySelector('nav[aria-label="Main navigation"]');
          assert(navigation && navigation.closest('.reference-header'), 'The reference shell did not expose its top navigation.');
          for (const name of ['Discover sound library', 'Music studio', 'My projects']) assert(!buttonNamed(navigation, name).disabled, `The ${name} destination is unavailable in the top navigation.`);
          buttonNamed(navigation, 'My projects').click();
          await waitFor(() => !!host.querySelector('.reference-project-card'), 'My projects did not render the saved project gallery.');
          assert(host.querySelectorAll('.reference-project-card').length === 1, 'The project gallery inserted invented projects beside the only saved fixture.');
          buttonNamed(host, 'Open project Synthetic QA fixture').click();
          await waitFor(() => host.querySelector('[aria-label="Project title"]')?.value === 'Synthetic QA fixture', 'The project card did not open the actual saved melody.');
          assert(host.querySelector('.muse-reference-shell.reference-page-studio') && !host.querySelector('.muse-reference-shell.reference-light-shell'), 'Opening a project did not enter the dark reference studio.');
          same([...host.querySelectorAll('.midi-note')].map(note => note.getAttribute('aria-label')), ['C4, 0.40 seconds, edit note', 'E4, 0.40 seconds, edit note', 'G4, 0.40 seconds, edit note'], 'The studio did not render the three saved melody notes.');
          buttonNamed(host, 'Hum a melody').click();
          await waitFor(() => !!host.querySelector('.ref-hum.is-analysed'), 'Opening the captured melody did not show its completed HUM analysis.');
          assert(host.querySelector('.muse-reference-shell.reference-page-hum.reference-light-shell') && !host.querySelector('.muse-reference-shell.reference-photo-shell'), 'The completed HUM analysis did not switch from the photo capture scene to the cream shell.');
          buttonNamed(host, 'Shape this melody').click();
          await waitFor(() => !!host.querySelector('.production-director-direction'), 'Shape this melody did not open the structured Production Director for a project without a blueprint.');

          const askForDirection = async (verifyDraftEdit = false, openFromStudio = false) => {
            if (openFromStudio) buttonNamed(host, 'Producer brain').click();
            await waitFor(() => !!host.querySelector('.muse-reference-shell.reference-page-direction.reference-light-shell'), 'Producer brain did not open the cream direction page.');
            assert(host.querySelector('h1') && normalizedText(host.querySelector('h1')) === 'Give your sound a direction.', 'The direction page did not expose the Production Director headline.');
            const melodyPreview = host.querySelector('.direction-melody-preview svg[role="img"][aria-label="Detected melody note contour, 3 notes"]');
            assert(melodyPreview && melodyPreview.querySelectorAll('rect').length === 3, 'The direction melody contour fabricated or omitted captured notes.');
            assert(/Captured notes\s*3/.test(host.textContent), 'The direction analysis did not show the actual captured-note count.');
            const directionInput = host.querySelector('[aria-label="Production instructions"]');
            const directionLabel = directionInput?.labels?.[0];
            assert(directionLabel && normalizedText(directionLabel) === 'Production instructions' && !directionLabel.closest('[hidden], .sr-only'), 'The direction textarea did not expose its visible Production instructions label and accessible name.');
            assert(host.querySelectorAll('.director-instrument-choice input').length === 7, 'A fresh HUM direction did not expose the editable instrument catalog.');
            changeNativeValue(directionInput, direction);
            await waitFor(() => !buttonNamed(host, 'Generate blueprint').disabled, 'Editing the instruction did not enable a blueprint request.');
            assert(buttonNamed(host, 'Create my composition').disabled, 'An uninterpreted instruction could create a composition.');
            buttonNamed(host, 'Generate blueprint').click();
            await waitFor(() => host.querySelector('.director-summary')?.textContent.includes('Cinematic layers for your captured melody.'), 'The direction page did not render the reviewed structured AI blueprint.');
            same(sent.notes, fixtureNotes, 'The reference direction did not send the actual saved notes.');
            assert(sent.text === direction && sent.settings.instrument === 'Piano' && sent.settings.bpm === 90 && sent.settings.mood === 'Dreamy' && sent.settings.blueprint, 'The direction request did not contain the edited text, editable blueprint and current project settings.');
            const createComposition = buttonNamed(host, 'Create my composition');
            assert(!createComposition.disabled, 'The reviewed proposal cannot create a composition from existing notes.');
            assert(directionInput.compareDocumentPosition(createComposition) & Node.DOCUMENT_POSITION_FOLLOWING, 'The direction form appears after Create in DOM reading order.');
            if (verifyDraftEdit) {
              changeNativeValue(directionInput, 'Make this intimate and peaceful, with a solo piano.');
              await waitFor(() => !host.textContent.includes('Cinematic layers for your captured melody.') && buttonNamed(host, 'Create my composition').disabled, 'Editing the instruction left the earlier explanation or Create action available.');
              assert(posted === null && arrangeRequests === 0, 'Editing the direction saved or generated the unreviewed composition.');
              changeNativeValue(directionInput, direction);
              await waitFor(() => !buttonNamed(host, 'Generate blueprint').disabled, 'Restoring the instruction did not enable a fresh request.');
              buttonNamed(host, 'Generate blueprint').click();
              await waitFor(() => host.querySelector('.director-summary')?.textContent.includes('Cinematic layers for your captured melody.'), 'Submitting the restored instruction did not produce a fresh reviewable blueprint.');
              assert(!buttonNamed(host, 'Create my composition').disabled, 'The fresh reviewed direction did not restore explicit composition creation.');
            }
            changeNativeValue(host.querySelector('[aria-label="Piano level"]'), .28);
            await waitFor(() => Number(host.querySelector('[aria-label="Piano level"]').value) === .28, 'The returned piano layer could not be edited before acceptance.');
            assert(host.querySelector('[aria-label="Violin section"]').value === 'ending' && !host.querySelector('[aria-label="Include Drums"]').checked, 'The editable blueprint lost its final-section strings or drum exclusion.');
          };
          await askForDirection(true);
          assert(posted === null && arrangeRequests === 0, 'Reviewing a proposal saved or generated a composition before Create.');
          same(saved.settings, fixtureSettings, 'Reviewing the proposal changed the saved project snapshot.');
          buttonNamed(host.querySelector('nav[aria-label="Main navigation"]'), 'Music studio').click();
          await waitFor(() => !!host.querySelector('[aria-label="Project title"]'), 'The studio could not be reopened to inspect the unapplied proposal.');
          assert(labelledSelect(host, 'LEAD INSTRUMENT').value === 'Piano' && host.querySelector('[aria-label="Composition tempo in BPM"]').value === '90', 'The proposal applied its instrument or tempo before Create.');
          const initialMood = [...host.querySelectorAll('.mood-options button')].find(button => button.getAttribute('aria-pressed') === 'true');
          assert(initialMood && normalizedText(initialMood).includes('Dreamy'), 'The proposal applied its mood before Create.');
          assert(buttonNamed(host, 'Export WAV').disabled, 'Reviewing a direction generated playable audio before Create.');

          await askForDirection(false, true);
          buttonNamed(host, 'Create my composition').click();
          await waitFor(() => !!host.querySelector('.muse-reference-shell.reference-page-studio') && !!host.querySelector('[aria-label="Play composition"]') && !buttonNamed(host, 'Export WAV').disabled, 'Create my composition did not apply the direction, generate the real arrangement and open the studio.');
          assert(labelledSelect(host, 'LEAD INSTRUMENT').value === 'Piano' && host.querySelector('[aria-label="Composition tempo in BPM"]').value === '90', 'Applying backing layers silently replaced the selected lead or tempo.');
          const appliedMood = [...host.querySelectorAll('.mood-options button')].find(button => button.getAttribute('aria-pressed') === 'true');
          assert(appliedMood && normalizedText(appliedMood).includes('Cinematic'), 'Create did not apply the reviewed Cinematic mood.');
          same([...host.querySelectorAll('.midi-note')].map(note => note.getAttribute('aria-label')), ['C4, 0.40 seconds, edit note', 'E4, 0.40 seconds, edit note', 'G4, 0.40 seconds, edit note'], 'Creating the composition replaced the captured melody.');
          assert(arrangeRequests === 1 && arranged?.events.some(event => event.track === 'chords'), 'Create did not build chord accompaniment with the actual arrangement engine.');
          same(arranged.events.filter(event => event.track === 'melody').map(event => event.midi), [60, 64, 67], 'The generated arrangement changed the saved melody pitches.');
          assert(arranged.bpm === 90 && arranged.events.filter(event => event.track === 'melody').every(event => event.instrument === 'Piano'), 'The structured blueprint changed the selected melody instrument or tempo.');
          same(arranged.settings.blueprint, acceptedBlueprint, 'The actual arranger did not receive the manually edited accepted blueprint.');
          for (const layerId of ['guitar', 'piano', 'violin']) assert(arranged.events.some(event => event.layerId === layerId), `The accepted ${layerId} layer is inaudible in the real arrangement.`);
          assert(!arranged.events.some(event => event.layerId === 'drums') && arranged.events.filter(event => event.layerId === 'violin').every(event => event.start >= arranged.duration * .75), 'The real arranger ignored drum removal or final-section string entry.');
          assert(host.querySelector('[aria-label^="Acoustic Guitar,"]') && host.querySelector('[aria-label^="Violin,"]') && !buttonNamed(host, 'Play composition').disabled, 'The composition did not expose independent backing lanes and its available transport.');
          buttonNamed(host, 'Save project').click();
          await waitFor(() => posted !== null && host.textContent.includes('Project saved to your local MUSE database.'), 'Save did not persist the composition created through the direction page.');
          same(posted.notes, fixtureNotes, 'Saving the new composition rewrote the original note pitches or timing.');
          assert(posted.id === 'synthetic-browser-qa-fixture' && posted.settings.instrument === 'Piano' && posted.settings.bpm === 90 && posted.settings.mood === 'Cinematic' && posted.settings.percussion === false, 'The saved payload lost the source identity, selected lead or accepted mood.');
          same(posted.settings.blueprint, acceptedBlueprint, 'Saving lost the edited blueprint.');
          buttonNamed(host.querySelector('nav[aria-label="Main navigation"]'), 'My projects').click();
          await waitFor(() => !!host.querySelector('.reference-project-card'), 'The accepted composition could not return to its archive.');
          buttonNamed(host, 'Create something new').click();
          await waitFor(() => host.querySelector('[aria-label="Project title"]')?.value === 'Untitled melody', 'A new project could not be created after saving.');
          buttonNamed(host.querySelector('nav[aria-label="Main navigation"]'), 'My projects').click();
          await waitFor(() => !!host.querySelector('.reference-project-card'), 'The saved composition disappeared after starting a new project.');
          buttonNamed(host, 'Open project Synthetic QA fixture').click();
          await waitFor(() => host.querySelector('[aria-label="Piano level"]') && Number(host.querySelector('[aria-label="Piano level"]').value) === .28, 'Reopening the project lost its edited piano gain.');
          assert(host.querySelector('[aria-label="Violin section"]').value === 'ending' && labelledSelect(host, 'LEAD INSTRUMENT').value === 'Piano', 'Reopening lost the accepted string entry or changed the selected lead.');
          same([...host.querySelectorAll('.midi-note')].map(note => note.getAttribute('aria-label')), ['C4, 0.40 seconds, edit note', 'E4, 0.40 seconds, edit note', 'G4, 0.40 seconds, edit note'], 'The saved blueprint round trip changed the source notes.');
          return 'HUM Shape this melody opened the structured Director for a project without a blueprint. Instructions required planning; returned layers stayed editable and unapplied until explicit Create. Edited piano gain, final-quarter violin and removed drums reached real independent backing tracks; the selected lead and original notes survived Save/New/Open.';
        } finally {
          root.unmount();
          host.remove();
          document.title = previousTitle;
          await sleep(20);
        }
      }, (path, method, body) => {
        if (path === '/api/projects' && method === 'GET') return response({ projects: [saved] });
        if (path === '/api/projects' && method === 'POST') { posted = structuredClone(body); saved = { ...body, updatedAt: '2026-11-18T10:00:00.000Z' }; return response({ project: saved }); }
        if (path === '/api/production-director/status') return response({ mode: 'ai', provider: 'openai', model: 'mock-model' });
        if (path === '/api/production-director') { sent = structuredClone(body); return response({ summary: 'Cinematic layers for your captured melody.', blueprint: structuredClone(proposedBlueprint), source: 'ai' }); }
        if (path === '/api/arrange') { arrangeRequests++; arranged = buildArrangement(body.notes, body.settings); return response({ arrangement: arranged }); }
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
