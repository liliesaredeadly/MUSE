import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, AudioLines, Music2, Trash2 } from 'lucide-react';

const pitchName = midi => `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][midi % 12]}${Math.floor(midi / 12) - 1}`;

function EventLane({ events, type, title, subtitle, duration, position, chords, blockedReason }) {
  const pitches = events.map(event => event.midi);
  const low = Math.min(...pitches) - 1;
  const high = Math.max(...pitches) + 1;
  return <div className={`arrangement-track track-${type}`}>
    <div className="track-identity"><span className="track-colour" /><div><h3>{title}</h3><p>{blockedReason ? 'Not playing · limited pitch evidence' : subtitle}</p></div><span className="track-event-count">{events.length}</span></div>
    <div className={`arrangement-lane ${type === 'chords' ? 'chord-lane' : ''}`} role="img" aria-label={blockedReason ? `${title} not playing: ${blockedReason}` : type === 'chords' && title === 'Chord accompaniment' ? 'Generated chord accompaniment' : `${title}, ${events.length} generated events`}>
      {events.map((event, index) => <span key={index} className="arrangement-event" title={`${pitchName(event.midi)} · ${event.start.toFixed(2)}s · ${event.duration.toFixed(2)}s`} style={{ left: `${event.start / duration * 100}%`, width: `${event.duration / duration * 100}%`, bottom: `${18 + (event.midi - low) / (high - low) * 60}%` }} />)}
      {type === 'chords' && chords?.map((chord, index) => <span className="arrangement-chord-name" key={index} style={{ left: `${chord.start / duration * 100}%` }}>{chord.name}</span>)}
      {position > 0 && <div className="playhead" style={{ left: `${Math.min(100, position / duration * 100)}%` }} />}
    </div>
  </div>;
}

export default function Timeline({ notes, arrangement, position, updateNote, busy }) {
  const [selected, setSelected] = useState(null);
  const melodyRef = useRef(null);
  const removedIndex = useRef(null);
  const empty = notes.length === 0;
  useEffect(() => { if (busy || empty) setSelected(null); }, [busy, empty]);
  useLayoutEffect(() => {
    if (removedIndex.current === null) return;
    const remaining = melodyRef.current?.querySelectorAll('.midi-note');
    const target = remaining?.[Math.min(removedIndex.current, remaining.length - 1)] || melodyRef.current;
    target?.focus();
    removedIndex.current = null;
  }, [notes]);
  function removeSelected() {
    removedIndex.current = selected;
    updateNote(selected, 'remove');
    setSelected(null);
  }
  const selectedNote = selected === null ? null : notes[selected];
  const duration = arrangement?.duration || Math.max(4, ...notes.map(note => note.start + note.duration));
  const requestedScale = arrangement?.settings?.preserveMelodyTiming === false ? arrangement.settings.sourceBpm / arrangement.bpm : 1;
  const scale = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1;
  const midis = notes.map(note => note.midi);
  const low = Math.min(57, ...midis) - 2;
  const high = Math.max(72, ...midis) + 2;
  const events = arrangement?.events || [];
  const legacyLayers = [
    { type: 'melody', title: arrangement?.settings?.instrument === 'Drums' ? 'Synthesizer lead' : `${arrangement?.settings?.instrument || 'Melody'} lead`, subtitle: 'Your melody, arranged' },
    { type: 'chords', title: 'Chord accompaniment', subtitle: 'Generated harmony' },
    { type: 'bass', title: 'Bass', subtitle: 'Generated bass line' },
    { type: 'percussion', title: 'Percussion', subtitle: 'Generated rhythm' },
  ].map(layer => ({ ...layer, events: events.filter(event => event.track === layer.type) })).filter(layer => layer.events.length);
  const layers = arrangement?.layers ? [
    ...legacyLayers.filter(layer => layer.type === 'melody'),
    ...arrangement.layers.filter(layer => layer.enabled).map(layer => ({
      id: layer.id, type: layer.role === 'percussion' ? 'percussion' : layer.role === 'bass' ? 'bass' : 'chords',
      title: layer.instrument,
      subtitle: `${layer.role} · ${layer.section === 'ending' ? 'final quarter' : 'full arrangement'} · ${Math.round(layer.gain * 100)}%`,
      blockedReason: layer.blocked ? layer.reason || layer.blockedReason || 'Reliable harmony is required before this layer can play.' : null,
      events: events.filter(event => event.layerId === layer.id),
    })),
  ] : legacyLayers;
  return <section className="panel timeline-panel reference-timeline" aria-labelledby="melody-heading">
    <div className="panel-heading"><span className="panel-icon"><Music2 size={15} /></span><h2 id="melody-heading">Your melody</h2><span className="note-count">{notes.length ? `${notes.length} notes captured` : 'Waiting for a spark'}</span>{arrangement && <span className="key-label">{typeof arrangement.key === 'string' ? arrangement.key : 'Key estimated'}</span>}</div>
    <div className="arrangement-column-headings" aria-hidden="true"><span>TRACKS</span><span>ARRANGEMENT <small>SECONDS</small></span></div>
    <div className="arrangement-ruler-row" aria-hidden="true"><span /><div className="timeline-ruler">{Array.from({ length: 5 }, (_, index) => <span key={index}>{(duration / 4 * index).toFixed(1)}</span>)}</div></div>
    <div className={`arrangement-track captured-track ${empty ? 'timeline-empty' : ''}`}>
      <div className="track-identity"><span className="track-colour" /><div><h3>Hummed idea</h3><p>Captured melody · editable</p></div><span className="track-event-count">{notes.length}</span></div>
      <div className="piano-roll" ref={melodyRef} tabIndex={-1} role="group" aria-label="Detected melody notes, select a note to edit pitch">
        {!notes.length && <div className="timeline-placeholder"><AudioLines size={24} strokeWidth={1.2} /><p>Your voice becomes the notes.</p><span>Record a melody to see it take shape here.</span></div>}
        {notes.map((note, index) => <button key={index} disabled={busy} className={`midi-note ${selected === index ? 'selected' : ''}`} onClick={() => setSelected(selected === index ? null : index)} aria-pressed={selected === index} aria-label={`${note.name}, ${note.duration.toFixed(2)} seconds, edit note`} aria-describedby="melody-timing-hint" style={{ left: `${note.start * scale / duration * 100}%`, width: `${note.duration * scale / duration * 100}%`, bottom: `${12 + (note.midi - low) / (high - low) * 65}%` }}><span>{note.name}</span></button>)}
        {position > 0 && <div className="playhead" style={{ left: `${Math.min(100, position / duration * 100)}%` }} />}
      </div>
    </div>
    {arrangement?.recordingLead && <div className="arrangement-track track-melody">
      <div className="track-identity"><span className="track-colour" /><div><h3>Original hum</h3><p>Your recorded voice · full take</p></div><span className="track-event-count">{arrangement.recordingLead.duration.toFixed(1)}s</span></div>
      <div className="arrangement-lane" role="img" aria-label={`Original hum, ${arrangement.recordingLead.duration.toFixed(1)} seconds, original timing`}>
        <span className="arrangement-event" style={{ left: 0, width: '100%', bottom: '45%' }} />
        {position > 0 && <div className="playhead" style={{ left: `${Math.min(100, position / duration * 100)}%` }} />}
      </div>
    </div>}
    {layers.map(layer => <EventLane key={layer.id || layer.type} {...layer} duration={duration} position={position} chords={layer.id ? undefined : arrangement.chords} />)}
    {selectedNote && !busy && <div className="note-editor"><span><strong>{selectedNote.name}</strong> at {selectedNote.start.toFixed(1)}s in the original take <span className="muted">· {Math.round((selectedNote.confidence || 0) * 100)}% periodicity</span></span><div><button className="button small subtle" disabled={selectedNote.midi <= 0} onClick={() => updateNote(selected, -1)} aria-label="Lower selected note one semitone"><ArrowDown size={13} /> Semitone</button><button className="button small subtle" disabled={selectedNote.midi >= 127} onClick={() => updateNote(selected, 1)} aria-label="Raise selected note one semitone"><ArrowUp size={13} /> Semitone</button><button className="icon-button danger" aria-label="Remove selected note" onClick={removeSelected}><Trash2 size={15} /></button></div></div>}
    <div className="timeline-footnote"><span><span className="legend-dot" /> Captured melody</span><span id="melody-timing-hint">{notes.length ? 'Note labels use recorded timing. Select a note to fine-tune its pitch.' : 'Only notes detected from your recording appear here.'}</span></div>
  </section>;
}
