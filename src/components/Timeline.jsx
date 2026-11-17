import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, AudioLines, ChevronDown, Music2, Trash2 } from 'lucide-react';

export default function Timeline({ notes, arrangement, position, updateNote, busy }) {
  const [selected, setSelected] = useState(null);
  const empty = notes.length === 0;
  useEffect(() => { if (busy || empty) setSelected(null); }, [busy, empty]);
  const selectedNote = selected === null ? null : notes[selected];
  const duration = arrangement?.duration || Math.max(4, ...notes.map(note => note.start + note.duration));
  const scale = arrangement?.settings ? arrangement.settings.sourceBpm / arrangement.bpm : 1;
  const midis = notes.map(note => note.midi);
  const low = Math.min(57, ...midis) - 2;
  const high = Math.max(72, ...midis) + 2;
  return <section className="panel timeline-panel"><div className="panel-heading"><span className="panel-icon"><Music2 size={17} /></span><h2>Your melody</h2><span className="note-count">{notes.length ? `${notes.length} notes captured` : 'Waiting for a spark'}</span>{arrangement && <span className="key-label">{typeof arrangement.key === 'string' ? arrangement.key : 'Key estimated'}</span>}</div>
    <div className={`timeline ${!notes.length ? 'timeline-empty' : ''}`}>
      <div className="piano-labels" aria-hidden="true">{[1, .67, .33, 0].map((ratio, index) => { const midi = Math.round(low + (high - low) * ratio); return <span key={index}>{['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][midi % 12]}{Math.floor(midi / 12) - 1}</span>; })}</div>
      <div className="timeline-content"><div className="timeline-ruler" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i}>{(duration / 4 * i).toFixed(1)}s</span>)}</div><div className="piano-roll" role="group" aria-label="Detected melody notes, select a note to edit pitch">
        {!notes.length && <div className="timeline-placeholder"><AudioLines size={28} strokeWidth={1.2} /><p>Your voice becomes the notes.</p><span>Record a melody to see it take shape here.</span></div>}
        {notes.map((note, index) => <button key={index} disabled={busy} className={`midi-note ${selected === index ? 'selected' : ''}`} onClick={() => setSelected(selected === index ? null : index)} aria-label={`${note.name}, ${note.duration.toFixed(2)} seconds, edit note`} style={{ left: `${note.start * scale / duration * 100}%`, width: `${Math.max(.8, note.duration * scale / duration * 100)}%`, bottom: `${8 + (note.midi - low) / (high - low) * 78}%` }}><span>{note.name}</span></button>)}
        {position > 0 && <div className="playhead" style={{ left: `${Math.min(100, position / duration * 100)}%` }} />}
      </div>{arrangement?.chords?.length > 0 && <div className="chord-lane" aria-label="Generated chord accompaniment">{arrangement.chords.map((chord, index) => <span key={index} style={{ left: `${chord.start / duration * 100}%`, width: `${Math.min(100, chord.duration / duration * 100)}%` }}>{chord.name}</span>)}</div>}</div>
    </div>
    {selectedNote && !busy && <div className="note-editor"><span><strong>{selectedNote.name}</strong> at {selectedNote.start.toFixed(1)}s <span className="muted">· {Math.round((selectedNote.confidence || 0) * 100)}% periodicity</span></span><div><button className="button small subtle" onClick={() => updateNote(selected, -1)} aria-label="Lower selected note one semitone"><ArrowDown size={13} /> Semitone</button><button className="button small subtle" onClick={() => updateNote(selected, 1)} aria-label="Raise selected note one semitone"><ArrowUp size={13} /> Semitone</button><button className="icon-button danger" aria-label="Remove selected note" onClick={() => { updateNote(selected, 'remove'); setSelected(null); }}><Trash2 size={15} /></button></div></div>}
    <div className="timeline-footnote"><span><span className="legend-dot" /> Captured melody</span><span>{notes.length ? 'Select a note to fine-tune its pitch.' : 'Only notes detected from your recording appear here.'}</span></div>
  </section>;
}
