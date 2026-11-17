import { useEffect, useRef, useState } from 'react';
import { MicrophoneRecorder } from '../audio/recorder.js';
import { CompositionPlayer, exportWav } from '../audio/synth.js';
import { createProject } from '../lib/projects.js';
import { api } from '../lib/api.js';

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
  const [generated, setGenerated] = useState(false);
  const [transport, setTransport] = useState('stopped');
  const [position, setPosition] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [exporting, setExporting] = useState(false);
  const frameRef = useRef(null);
  const recorderRef = useRef(null);
  const playerRef = useRef(null);
  const audioRef = useRef(null);
  const lastFrameUpdate = useRef(0);
  const revisionRef = useRef(0);
  const mounted = useRef(true);
  const busy = saving || capture === 'recording' || capture === 'paused' || capture === 'requesting' || capture === 'stopping';

  function notify(message) { setNotice(message); }
  function stopPlayback() {
    stopCompositionOnly();
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
  }
  function stopCompositionOnly() { playerRef.current?.stop(); setTransport('stopped'); setPosition(0); }

  useEffect(() => {
    mounted.current = true;
    Promise.all([api.health(), api.projects()]).then(([, saved]) => {
      if (mounted.current) { setProjects(saved); setServerState('ready'); }
    }).catch(err => { if (mounted.current) { setServerState('error'); setError(err.message); } });
    return () => { mounted.current = false; recorderRef.current?.dispose(); playerRef.current?.dispose(); };
  }, []);
  useEffect(() => {
    let current = true;
    if (!generated || !project.notes.length) { setArrangement(null); setArranging(false); return; }
    setArranging(true);
    const timer = setTimeout(() => {
      api.arrange(project.notes, project.settings).then(next => {
        if (current) { setArrangement(next); setArranging(false); }
      }).catch(err => { if (current) { setArrangement(null); setArranging(false); setGenerated(false); setError(err.message); } });
    }, 160);
    return () => { current = false; clearTimeout(timer); };
  }, [generated, project.notes, project.settings]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(''), 5500); return () => clearTimeout(timeout); }, [notice]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);

  function finishRecording(result) {
    if (!mounted.current) return;
    setCapture('idle'); setPitch(null); setElapsed(result.duration || 0);
    revisionRef.current++;
    setProject(previous => ({ ...previous, notes: result.notes }));
    setDirty(true);
    if (result.error) setError(result.error.message || 'The microphone stopped unexpectedly. Captured notes have been kept.');
    if (result.blob?.size) setAudioUrl(URL.createObjectURL(result.blob));
    notify(result.notes.length ? `${result.notes.length} notes captured. Shape your sound, then create an arrangement.` : 'No clear notes detected. Try humming one steady note at a time, closer to the microphone.');
  }

  async function startRecording() {
    if (busy) return;
    setError(''); stopPlayback(); setCapture('requesting');
    const recorder = new MicrophoneRecorder({
      onFrame: frame => {
        if (recorderRef.current !== recorder || !mounted.current) return;
        frameRef.current = frame;
        const now = performance.now();
        if (now - lastFrameUpdate.current > 120 && mounted.current) {
          setElapsed(frame.time); setPitch(frame.pitch); lastFrameUpdate.current = now;
        }
      },
      onNotes: notes => { if (mounted.current && recorderRef.current === recorder && recorder.state !== 'requesting') { revisionRef.current++; setProject(previous => ({ ...previous, notes })); } },
      onAutoStop: result => { finishRecording(result); if (!result.error) notify('The 60-second take is complete. Your melody is ready to arrange.'); },
    });
    recorderRef.current = recorder;
    try {
      await recorder.start();
      if (!mounted.current || recorderRef.current !== recorder) { recorder.dispose(); return; }
      revisionRef.current++;
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
    try { finishRecording(await recorderRef.current.stop()); }
    catch (err) { setCapture('idle'); setError(err.message || 'Recording could not be completed. Please try again.'); }
  }

  function changeSettings(changes) {
    revisionRef.current++;
    stopPlayback(); setArrangement(null);
    setProject(previous => ({ ...previous, settings: { ...previous.settings, ...changes } })); setDirty(true);
  }

  function updateNote(index, change) {
    revisionRef.current++;
    stopPlayback(); setArrangement(null);
    setProject(previous => ({ ...previous, notes: previous.notes.flatMap((note, i) => {
      if (i !== index) return [note];
      if (change === 'remove') return [];
      const midi = Math.min(96, Math.max(28, note.midi + change));
      const name = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][midi % 12] + (Math.floor(midi / 12) - 1);
      return [{ ...note, midi, name }];
    }) })); setDirty(true);
  }

  function generate() {
    if (!project.notes.length || busy) return;
    stopPlayback(); setGenerated(true); setError('');
  }

  async function play() {
    if (!arrangement || busy) return;
    setError(''); audioRef.current?.pause();
    try {
      if (!playerRef.current) playerRef.current = new CompositionPlayer();
      if (transport === 'paused') { await playerRef.current.resume(); }
      else {
        await playerRef.current.play(arrangement, {
          onEnded: () => { if (mounted.current) { setTransport('stopped'); setPosition(0); } },
          onProgress: value => { if (mounted.current) setPosition(value); },
        });
      }
      if (mounted.current) setTransport(playerRef.current.status === 'playing' ? 'playing' : playerRef.current.status === 'paused' ? 'paused' : 'stopped');
    } catch (err) { setTransport('stopped'); setError(err.message || 'Audio playback could not start. Try pressing play again.'); }
  }

  function pausePlayback() { playerRef.current?.pause(); setTransport('paused'); }

  async function save() {
    if (saving) return false;
    const savedRevision = revisionRef.current;
    setSaving(true);
    try {
      const saved = await api.save({ ...project, title: project.title.trim() || 'Untitled melody' });
      setProject(current => current.id !== saved.id ? current : revisionRef.current === savedRevision ? saved : { ...current, createdAt: saved.createdAt, updatedAt: saved.updatedAt });
      setProjects(await api.projects()); setServerState('ready');
      if (revisionRef.current === savedRevision) setDirty(false);
      notify(revisionRef.current === savedRevision ? 'Project saved to your local MUSE database.' : 'Saved the earlier version. Your newer edits are kept; save again to store them.'); return true;
    } catch (err) { setError(err.message || 'Could not save the project. Check the local MUSE server and retry.'); return false; }
    finally { setSaving(false); }
  }

  async function newProject() {
    if (busy || saving) return false;
    if (dirty && project.notes.length && !(await save())) return false;
    stopPlayback(); setProject(createProject()); setGenerated(false); setAudioUrl(''); setElapsed(0); setPitch(null); setDirty(false); setError(''); frameRef.current = null;
    return true;
  }

  async function openProject(next) {
    if (busy || saving) return false;
    if (dirty && project.notes.length && !(await save())) return false;
    stopPlayback(); setProject(next); setGenerated(false); setAudioUrl(''); setElapsed(0); setPitch(null); setDirty(false); setError(''); frameRef.current = null;
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

  return { project, projects, capture, elapsed, pitch, audioUrl, audioRef, generated, arrangement, transport, position, error, notice, dirty, busy, exporting, frameRef, serverState, saving, arranging,
    startRecording, cancelRecordingRequest, pauseRecording, stopRecording, stopPlayback, stopCompositionOnly, changeSettings, updateNote, generate, play, pausePlayback, save, newProject, openProject, download, notify,
    rename: title => { revisionRef.current++; setProject(previous => ({ ...previous, title })); setDirty(true); },
    clearError: () => setError(''),
  };
}
