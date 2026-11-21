import React, { useId } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';

function sourceLink(value, start) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (Number.isFinite(start)) url.searchParams.set('t', `${Math.max(0, Math.floor(start))}s`);
    return url.href;
  } catch { return null; }
}

export default function ReferenceMatch({ studio }) {
  const headingId = useId();
  const helpId = useId();
  const reference = studio.reference || { status: 'unavailable', available: false };
  const match = studio.referenceMatch || { status: 'idle' };
  const checking = reference.status === 'loading';
  const matching = match.status === 'matching';
  const enoughNotes = studio.project.notes.length >= 8;
  const canCompare = reference.available && enoughNotes && !studio.busy && !matching;
  const candidate = match.status === 'candidate' ? match.candidate : null;
  const referenceUrl = sourceLink(reference.sourceUrl);
  const candidateUrl = candidate && sourceLink(candidate.sourceUrl, candidate.start);
  const segment = candidate && Number.isFinite(candidate.start) && Number.isFinite(candidate.end) ? `${candidate.start.toFixed(1)}–${candidate.end.toFixed(1)} seconds` : null;

  return <section className="reference-match" aria-labelledby={headingId}>
    <div className="reference-match-heading"><h3 id={headingId}>Reference match</h3><span>{checking ? 'Checking reference…' : reference.available ? 'Local reference ready' : reference.status === 'error' ? 'Connection issue' : 'Reference unavailable'}</span></div>
    {reference.available && <div className="reference-match-source"><strong>{reference.title}{reference.artist ? ` · ${reference.artist}` : ''}</strong>{referenceUrl && <a href={referenceUrl} target="_blank" rel="noopener noreferrer">Original source<ExternalLink size={12} aria-hidden="true" /></a>}</div>}
    <p id={helpId} className="reference-match-help">Compare a 5–15 second hum. Listen to any suggested match to check it.</p>
    {reference.available ? <div className="reference-match-actions"><button type="button" className="button subtle" disabled={!canCompare} aria-busy={matching} aria-describedby={helpId} onClick={studio.compareReference}>{matching ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}<span>{matching ? 'Comparing…' : match.status === 'error' || match.status === 'no-match' ? 'Compare my hum again' : 'Compare my hum'}</span></button>{!enoughNotes && <span>Record at least 8 clear notes to compare.</span>}</div> : <div className="reference-match-availability" role={reference.status === 'error' ? 'alert' : undefined}><p>{checking ? 'Looking for a reference on this device.' : reference.reason || 'No local reference is available in this session.'}</p>{!checking && studio.refreshReference && <button type="button" className="text-button" disabled={studio.busy} onClick={studio.refreshReference}>{reference.status === 'error' ? 'Retry reference check' : 'Check again'}</button>}</div>}
    <div className="reference-match-result" role="status" aria-live="polite" aria-atomic="true">
      {matching && <p>Comparing your detected notes with the local reference…</p>}
      {candidate && <div className="reference-match-candidate"><span className="reference-match-label">Possible match</span><h4>{candidate.title}{candidate.artist ? ` · ${candidate.artist}` : ''}</h4>{segment && <div className="reference-match-details">{segment}</div>}{candidateUrl && <a href={candidateUrl} target="_blank" rel="noopener noreferrer">Listen at this point<ExternalLink size={13} aria-hidden="true" /></a>}<p>Your composition uses the notes from your hum. Exact reference notes have not been verified.</p></div>}
      {['no-match', 'unavailable', 'error'].includes(match.status) && <p>{match.reason || 'No possible match found. Try a clear phrase from the reference.'}</p>}
    </div>
  </section>;
}
