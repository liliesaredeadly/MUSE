import { useEffect, useRef, useState } from 'react';
import { MicrophoneRecorder } from '../audio/recorder.js';
import { CompositionPlayer, exportWav, exportMelodyMidi } from '../audio/synth.js';
import { createProject } from '../lib/projects.js';
import { api } from '../lib/api.js';
import { createRecordingFinalizer } from '../audio/recording-file.js';
import { assessTranscription } from '../audio/transcription-quality.js';
import { validateBlueprint } from '../producer/production-blueprint.js';
import { useMusicGenJob } from './useMusicGenJob.js';

export function useStudio() {
  const [project, setProject] = useState(createProject);
  const [projects, setProjects] = useState([]);
  const [serverState, setServerState] = useState('connecting');
  const [saving, setSaving] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [arrangement, setArrangement] = useState(null);
  const [capture, setCapture] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [pitch, setPitch] = useState(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioFilename, setAudioFilename] = useState('MUSE-original-take.webm');
  const [inputDevice, setInputDevice] = useState(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [captureSummary, setCaptureSummary] = useState(null);
  const [generated, setGenerated] = useState(false);
  const [transport, setTransport] = useState('stopped');
  const [position, setPosition] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reference, setReference] = useState({ status: 'loading', available: false });
  const [referenceMatch, setReferenceMatch] = useState({ status: 'idle' });
  const frameRef = useRef(null);
  const recorderRef = useRef(null);
  const playerRef = useRef(null);
  const audioRef = useRef(null);
  const lastFrameUpdate = useRef(0);
  const revisionRef = useRef(0);
  const playbackGenerationRef = useRef(0);
  const conditioningIdRef = useRef(null);
  const recordingSourceRef = useRef(null);
  const analysisGenerationRef = useRef(0);
  const finalizerRef = useRef(null);
  const referenceStatusRequest = useRef(0);
  const referenceMatchRequest = useRef({ generation: 0, pending: false });
  const mounted = useRef(true);
  const busy = saving || capture === 'recording' || capture === 'paused' || capture === 'requesting' || capture === 'stopping';
  const musicGen = useMusicGenJob({ projectId: project.id, sourceIdentity: captureSummary?.receipt?.sha256,
    defaultPrompt: project.settings.blueprint?.prompt || '', settings: project.settings, busy,
    getSource: () => recordingSourceRef.current, stopPlayback });

  function notify(message) { setNotice(message); }
  function clearReferenceMatch() {
    referenceMatchRequest.current = { generation: referenceMatchRequest.current.generation + 1, pending: false };
    setReferenceMatch({ status: 'idle' });
  }

  async function refreshReference() {
    const request = ++referenceStatusRequest.current;
    clearReferenceMatch();
    if (typeof api.referenceStatus !== 'function') {
      setReference({ status: 'unavailable', available: false, reason: 'No local reference is available in this session.' });
      return;
    }
    setReference({ status: 'loading', available: false });
    try {
      const result = await api.referenceStatus();
      if (!mounted.current || request !== referenceStatusRequest.current) return;
      setReference({ ...result, status: result.available ? 'ready' : 'unavailable' });
    } catch (err) {
      if (mounted.current && request === referenceStatusRequest.current) setReference({ status: 'error', available: false, reason: err.message || 'Could not check the local reference. Retry when the MUSE server is available.' });
    }
  }

  async function compareReference() {
    if (busy || !reference.available || project.notes.length < 8 || referenceMatchRequest.current.pending) return;
    if (typeof api.matchReference !== 'function') {
      setReferenceMatch({ status: 'unavailable', reason: 'Reference comparison is unavailable in this session.' });
      return;
    }
    const request = referenceMatchRequest.current.generation + 1;
    referenceMatchRequest.current = { generation: request, pending: true };
    setReferenceMatch({ status: 'matching' });
    try {
      const result = await api.matchReference(project.notes);
      if (!mounted.current || request !== referenceMatchRequest.current.generation) return;
      referenceMatchRequest.current.pending = false;
      if (result.status === 'candidate' && result.candidate) setReferenceMatch({ status: 'candidate', candidate: result.candidate });
      else setReferenceMatch({ status: result.status === 'no-match' ? 'no-match' : 'unavailable', reason: result.reason || 'No possible match found. Try another clear phrase from the reference.' });
    } catch (err) {
      if (!mounted.current || request !== referenceMatchRequest.current.generation) return;
      referenceMatchRequest.current.pending = false;
      setReferenceMatch({ status: 'error', reason: err.message || 'Comparison could not finish. Check the MUSE server and retry.' });
    }
  }
  function stopPlayback() {
    stopOtherAudio();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (musicGen.audioRef.current) musicGen.audioRef.current.currentTime = 0;
  }
  function stopOtherAudio(except = null) {
    playbackGenerationRef.current++; playerRef.current?.stop(); setTransport('stopped'); setPosition(0);
    if (audioRef.current !== except) audioRef.current?.pause();
    if (musicGen.audioRef.current !== except) musicGen.audioRef.current?.pause();
  }
  function stopCompositionOnly() { stopOtherAudio(audioRef.current); }

  useEffect(() => {
    mounted.current = true;
    Promise.all([api.health(), api.projects()]).then(([, saved]) => {
      if (mounted.current) {
        setProjects(current => [...current, ...saved.filter(item => !current.some(project => project.id === item.id))]);
        setServerState('ready');
      }
    }).catch(err => { if (mounted.current) { setServerState('error'); setError(err.message); } });
    return () => { mounted.current = false; recorderRef.current?.dispose(); playerRef.current?.dispose(); };
  }, []);
  useEffect(() => {
    refreshReference();
    return () => { referenceStatusRequest.current++; referenceMatchRequest.current.generation++; };
  }, []);
  useEffect(() => {
    let current = true;
    if (!generated || (!project.notes.length && project.settings.leadSource !== 'recording')) { setArrangement(null); setArranging(false); return; }
    setArranging(true);
    const timer = setTimeout(() => {
      const source = project.settings.leadSource === 'recording' || conditioningIdRef.current ? recordingSourceRef.current : null;
      api.arrange(project.notes, project.settings, conditioningIdRef.current, source).then(next => {
        if (current) { if (source) conditioningIdRef.current = source.conditioningId; setArrangement(next); setArranging(false); }
      }).catch(err => { if (current) { setArrangement(null); setArranging(false); setGenerated(false); setError(err.message); } });
    }, 160);
    return () => { current = false; clearTimeout(timer); };
  }, [generated, project.notes, project.settings]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(''), 5500); return () => clearTimeout(timeout); }, [notice]);
  useEffect(() => {
    if (!dirty && !busy && !musicGen.active) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy, musicGen.active]);

  function finishRecording(result) {
    if (!finalizerRef.current) finalizerRef.current = createRecordingFinalizer(analyzeFinishedRecording);
    return finalizerRef.current(result);
  }

  async function analyzeFinishedRecording(result) {
    if (!mounted.current) return;
    const generation = ++analysisGenerationRef.current;
    conditioningIdRef.current = null;
    recordingSourceRef.current = null;
    clearReferenceMatch();
    setCapture('stopping'); setPitch(null); setElapsed(result.duration || 0); setGenerated(false);
    setInputLevel(0); setInputDevice(result.input || null);
    setProject(previous => ({ ...previous, notes: [] }));
    if (result.blob?.size) {
      setAudioUrl(URL.createObjectURL(result.blob));
      setAudioFilename(result.blob.type.includes('mp4') ? 'MUSE-original-take.m4a' : 'MUSE-original-take.webm');
    }
    try {
      const extracted = result.extracted || await api.analyzeRecording(result.blob, result.duration || 60, { strictDuration: Boolean(result.imported) });
      if (!mounted.current || generation !== analysisGenerationRef.current) return;
      if (!Array.isArray(extracted.analysis?.notes) || !extracted.receipt?.sha256) throw new Error('The audio service returned no verified recording analysis.');
      const analysis = extracted.analysis;
      if (!extracted.conditioningId) throw new Error('The audio service returned no verified recording source.');
      conditioningIdRef.current = extracted.conditioningId;
      recordingSourceRef.current = extracted.conditioningId ? { blob: result.blob, duration: result.duration || 60,
        audioWav: extracted.audioWav, hasSignal: extracted.sourceHasSignal, conditioningId: extracted.conditioningId, receipt: { ...extracted.receipt }, notes: structuredClone(analysis.notes) } : null;
      revisionRef.current++;
      setProject(previous => ({ ...previous, notes: analysis.notes, settings: { ...previous.settings, leadSource: 'recording', preserveMelodyTiming: true } }));
      setCaptureSummary({ ...result.signal, noteCount: analysis.notes.length, hasAudio: Boolean(result.blob?.size), hasSignal: extracted.sourceHasSignal, voicedRatio: analysis.voicedRatio,
        quality: extracted.quality || analysis.quality || assessTranscription(analysis), receipt: extracted.receipt, rhythm: analysis.rhythm });
      setElapsed(analysis.duration || result.duration || 0);
      setDirty(true); setCapture('idle');
      if (result.error) setError(result.error.message || 'The microphone stopped unexpectedly. Its partial audio has been analyzed.');
      else if (analysis.warnings?.length) setError(analysis.warnings.join(' '));
      notify('Your original hum is the lead. The full recording keeps its pitch and timing while backing develops around it.');
      return analysis;
    } catch (error) {
      if (!mounted.current || generation !== analysisGenerationRef.current) return;
      setCapture('idle'); setDirty(true);
      setCaptureSummary({ ...result.signal, noteCount: 0, hasAudio: Boolean(result.blob?.size) });
      setError(`Full-recording melody analysis failed: ${error.message}. The original take is kept; no music was substituted.`);
    }
  }

  async function importRecording(file) {
    if (busy || !file) return;
    if (!file.size || file.size > 16 * 1024 * 1024) { setError('Choose a humming audio file up to 16 MB and 60 seconds.'); return; }
    stopPlayback(); setError(''); setCapture('stopping');
    const generation = ++analysisGenerationRef.current;
    try {
      // Decode and analyze a candidate before replacing the usable current take.
      const extracted = await api.analyzeRecording(file, 60, { strictDuration: true });
      if (!mounted.current || generation !== analysisGenerationRef.current) return;
      if (!Array.isArray(extracted.analysis?.notes) || !extracted.receipt?.sha256 || !extracted.conditioningId || !extracted.audioWav?.size) {
        throw new Error('The imported recording has no verified audio source.');
      }
      await analyzeFinishedRecording({ blob: file, duration: extracted.receipt.duration, imported: true, extracted, signal: {}, input: { label: 'Imported humming recording', channelCount: null } });
      if (file.name) setAudioFilename(file.name);
    } catch (failure) {
      if (!mounted.current || generation !== analysisGenerationRef.current) return;
      setCapture('idle'); setError(`Could not import that recording: ${failure.message} Your previous take is unchanged.`);
    }
  }

  async function reanalyzeOriginal() {
    if (busy) return;
    const original = recordingSourceRef.current?.blob;
    if (!original?.size) { setError('Attach your original recording before reanalysing this take.'); return; }
    const wasGenerated = generated;
    await importRecording(original);
    if (wasGenerated && mounted.current) setGenerated(true);
  }

  async function startRecording() {
    if (busy) return;
    clearReferenceMatch();
    setError(''); stopPlayback(); setCapture('requesting');
    const recorder = new MicrophoneRecorder({
      onFrame: frame => {
        if (recorderRef.current !== recorder || !mounted.current) return;
        frameRef.current = frame;
        const now = performance.now();
        if (now - lastFrameUpdate.current > 120 && mounted.current) {
          setElapsed(frame.time); setPitch(frame.pitch); setInputLevel(frame.level); lastFrameUpdate.current = now;
        }
      },
      onNotes: notes => { if (mounted.current && recorderRef.current === recorder && recorder.state !== 'requesting') { revisionRef.current++; setProject(previous => ({ ...previous, notes })); } },
      onAutoStop: result => { void finishRecording(result); },
    });
    recorderRef.current = recorder;
    try {
      await recorder.start();
      if (!mounted.current || recorderRef.current !== recorder) { recorder.dispose(); return; }
      revisionRef.current++;
      analysisGenerationRef.current++; conditioningIdRef.current = null; recordingSourceRef.current = null;
      setInputDevice(recorder.input); setInputLevel(0); setCaptureSummary(null); frameRef.current = null;
      setProject(previous => ({ ...previous, notes: [], settings: { ...previous.settings, sourceBpm: previous.settings.bpm } }));
      setGenerated(false); setAudioUrl(''); setElapsed(0); setCapture('recording'); setDirty(true);
    } catch (err) {
      if (!mounted.current || recorderRef.current !== recorder) return;
      recorder.dispose(); setCapture('idle');
      const messages = {
        NotAllowedError: 'Microphone access was blocked. Allow microphone access for this site in your browser, then try again.',
        NotFoundError: 'No microphone was found. Connect a microphone and try again.',
        NotReadableError: 'Your microphone is busy or unavailable. Close other recording apps and try again.',
        SecurityError: 'Microphone recording needs localhost or a secure HTTPS connection.',
      };
      setError(messages[err.name] || err.message || 'Could not start the microphone. Check your device and browser permissions.');
    }
  }

  function cancelRecordingRequest() {
    if (capture !== 'requesting') return;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    recorder?.dispose();
    setCapture('idle'); notify('Microphone request cancelled. Your existing melody is unchanged.');
  }

  function pauseRecording() {
    if (capture === 'recording') { recorderRef.current?.pause(); setCapture('paused'); setPitch(null); }
    else if (capture === 'paused') { recorderRef.current?.resume(); setCapture('recording'); }
  }

  async function stopRecording() {
    if (!['recording', 'paused'].includes(capture)) return;
    setCapture('stopping');
    try { await finishRecording(await recorderRef.current.stop()); }
    catch (err) { setCapture('idle'); setError(err.message || 'Recording could not be completed. Please try again.'); }
  }

  function changeSettings(changes) {
    try {
      if (Object.hasOwn(changes, 'blueprint')) changes = { ...changes, blueprint: validateBlueprint(changes.blueprint), mood: changes.blueprint.mood };
      else if (project.settings.blueprint && Object.hasOwn(changes, 'mood')) changes = { ...changes, blueprint: validateBlueprint({ ...project.settings.blueprint, mood: changes.mood }) };
    } catch (failure) { setError(failure.message); return; }
    if (changes.leadSource === 'recording') {
      const source = recordingSourceRef.current;
      if (!source?.audioWav?.size) { setError('Attach your original humming recording to use it as the lead.'); return; }
      conditioningIdRef.current = source.conditioningId;
      setProject(previous => ({ ...previous, notes: structuredClone(source.notes) }));
    }
    revisionRef.current++;
    stopPlayback(); setArrangement(null);
    setProject(previous => ({ ...previous, settings: { ...previous.settings, ...changes } })); setDirty(true);
  }

  function updateNote(index, change) {
    const note = project.notes[index];
    if (!note || (change !== 'remove' && (!Number.isInteger(change) || Math.min(127, Math.max(0, note.midi + change)) === note.midi))) return;
    if (change !== 'remove') {
      const midi = Math.min(127, Math.max(0, note.midi + change));
      const ratio = 2 ** ((midi - note.midi) / 12);
      if (note.contour?.some(point => !Number.isFinite(point.frequency * ratio) || point.frequency * ratio <= 0 || point.frequency * ratio > 20000)) {
        setError('That pitch edit would move the melody contour outside the supported audio range (above 0 and up to 20,000 Hz).');
        return;
      }
    }
    clearReferenceMatch();
    conditioningIdRef.current = null;
    revisionRef.current++;
    stopPlayback(); setArrangement(null);
    setProject(previous => ({ ...previous, settings: { ...previous.settings, leadSource: 'instrument' }, notes: previous.notes.flatMap((note, i) => {
      if (i !== index) return [note];
      if (change === 'remove') return [];
      const midi = Math.min(127, Math.max(0, note.midi + change));
      const name = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][midi % 12] + (Math.floor(midi / 12) - 1);
      const pitchRatio = 2 ** ((midi - note.midi) / 12);
      return [{ ...note, midi, name, ...(note.contour ? { contour: note.contour.map(point => ({ ...point, frequency: point.frequency * pitchRatio })) } : {}) }];
    }) })); setDirty(true);
  }

  function generate() {
    if (busy) return;
    if (project.settings.leadSource === 'recording' && !recordingSourceRef.current?.audioWav?.size) {
      setError('Attach your original humming recording before arranging this project. Original audio is not stored in saved projects.'); return;
    }
    if (project.settings.leadSource === 'recording' && !recordingSourceRef.current.hasSignal) {
      setError('This recording has no detectable audio signal. Record a new hum; no substitute melody was generated.'); return;
    }
    if (!project.notes.length && project.settings.leadSource !== 'recording') return;
    stopPlayback(); setGenerated(true); setError('');
  }

  async function play() {
    if (!arrangement || busy) return;
    const generation = ++playbackGenerationRef.current;
    const isCurrent = () => mounted.current && generation === playbackGenerationRef.current;
    setError(''); audioRef.current?.pause(); musicGen.audioRef.current?.pause();
    try {
      if (!playerRef.current) playerRef.current = new CompositionPlayer();
      if (transport === 'paused') { await playerRef.current.resume(); }
      else {
        await playerRef.current.play(arrangement, {
          onEnded: () => { if (mounted.current) { setTransport('stopped'); setPosition(0); } },
          onProgress: value => { if (mounted.current) setPosition(value); },
        });
      }
      if (isCurrent()) setTransport(playerRef.current.status === 'playing' ? 'playing' : playerRef.current.status === 'paused' ? 'paused' : 'stopped');
    } catch (err) { if (isCurrent()) { setTransport('stopped'); setError(err.message || 'Audio playback could not start. Try pressing play again.'); } }
  }

  function pausePlayback() { playerRef.current?.pause(); setTransport('paused'); }

  async function save() {
    if (saving) return false;
    const savedRevision = revisionRef.current;
    setSaving(true);
    try {
      const saved = await api.save({ ...project, title: project.title.trim() || 'Untitled melody' });
      setProject(current => current.id !== saved.id ? current : revisionRef.current === savedRevision ? saved : { ...current, createdAt: saved.createdAt, updatedAt: saved.updatedAt });
      setProjects(current => [saved, ...current.filter(item => item.id !== saved.id)]);
      setServerState('ready');
      if (revisionRef.current === savedRevision) setDirty(false);
      notify(revisionRef.current === savedRevision ? 'Project saved to your local MUSE database.' : 'Saved the earlier version. Your newer edits are kept; save again to store them.'); return true;
    } catch (err) { setError(err.message || 'Could not save the project. Check the local MUSE server and retry.'); return false; }
    finally { setSaving(false); }
  }

  async function newProject() {
    if (busy || saving) return false;
    if (dirty && !(await save())) return false;
    clearReferenceMatch();
    conditioningIdRef.current = null; recordingSourceRef.current = null; analysisGenerationRef.current++;
    stopPlayback(); setProject(createProject()); setGenerated(false); setAudioUrl(''); setElapsed(0); setPitch(null); setDirty(false); setError(''); setCaptureSummary(null); setInputDevice(null); setInputLevel(0); frameRef.current = null;
    return true;
  }

  async function openProject(next) {
    if (busy || saving) return false;
    if (dirty && !(await save())) return false;
    clearReferenceMatch();
    if (next.id === project.id) { stopPlayback(); return true; }
    conditioningIdRef.current = null; recordingSourceRef.current = null; analysisGenerationRef.current++;
    stopPlayback(); setProject(next); setGenerated(false); setAudioUrl(''); setElapsed(0); setPitch(null); setDirty(false); setError(''); setCaptureSummary(null); setInputDevice(null); setInputLevel(0); frameRef.current = null;
    return true;
  }

  async function download() {
    if (!arrangement || exporting) return;
    setExporting(true); setError('');
    try {
      const blob = await exportWav(arrangement);
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `${project.title.replace(/[^\w -]/g, '').trim() || 'MUSE composition'}.wav`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000); notify('WAV exported from your arrangement.');
    } catch (err) { setError(err.message || 'Could not render the WAV. Try again in Chrome or Edge.'); }
    finally { setExporting(false); }
  }

  function downloadMidi() {
    if (busy || !project.notes.length) return;
    setError('');
    try {
      const blob = exportMelodyMidi(project.notes, project.settings.bpm);
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `${project.title.replace(/[^\w -]/g, '').trim() || 'MUSE melody'}-detected-melody.mid`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      notify('Detected melody MIDI exported. It contains estimated notes and timing, not your recorded voice.');
    } catch (failure) { setError(failure.message || 'Could not export the detected melody MIDI.'); }
  }

  return { project, projects, capture, elapsed, pitch, audioUrl, audioFilename, inputDevice, inputLevel, captureSummary, audioRef, musicGen, generated, arrangement, transport, position, error, notice, dirty, busy, exporting, frameRef, serverState, saving, arranging, reference, referenceMatch, refreshReference, compareReference,
    hasMelody: project.notes.length > 0 || Boolean(audioUrl && captureSummary?.hasSignal), transcriptionQuality: captureSummary?.quality,
    startRecording, importRecording, reanalyzeOriginal, cancelRecordingRequest, pauseRecording, stopRecording, stopPlayback, stopCompositionOnly, stopOtherAudio, changeSettings, updateNote, generate, play, pausePlayback, save, newProject, openProject, download, downloadMidi, notify,
    rename: title => { revisionRef.current++; setProject(previous => ({ ...previous, title })); setDirty(true); },
    clearError: () => setError(''),
  };
}
