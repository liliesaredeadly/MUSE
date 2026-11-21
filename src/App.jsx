import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleHelp, FolderOpen, Headphones, Mic2, Plus, ShieldCheck, UserRound, X } from 'lucide-react';
import { useStudio } from './hooks/useStudio.js';
import { useAuth } from './hooks/useAuth.js';
import AuthPanel from './components/AuthPanel.jsx';
import Studio, { HumExperience } from './components/Studio.jsx';
import DirectionExperience from './components/DirectionExperience.jsx';

const discoveryStages = [
  { name: 'Indie', slug: 'indie', line: 'A little rough around the edges. All your own.', label: 'Dreamy · Piano / Pop', settings: { genre: 'Pop', mood: 'Dreamy', instrument: 'Piano' } },
  { name: 'Electronic', slug: 'electronic', line: 'Find the pulse. Follow it somewhere new.', label: 'Energetic · Synthesizer', settings: { genre: 'Electronic', mood: 'Energetic', instrument: 'Synthesizer', percussion: true } },
  { name: 'Classical', slug: 'classical', line: 'Give a simple phrase room to unfold.', label: 'Peaceful · Piano', settings: { genre: 'Classical', mood: 'Peaceful', instrument: 'Piano' } },
  { name: 'Ambient', slug: 'ambient', line: 'Let your melody become a landscape.', label: 'Dreamy · Strings', settings: { genre: 'Ambient', mood: 'Dreamy', instrument: 'Strings' } },
  { name: 'Hip-hop', slug: 'hiphop', line: 'Low frequencies. An unhurried groove.', label: 'Exploration preset · Electronic / Bass', settings: { genre: 'Electronic', mood: 'Energetic', instrument: 'Bass', percussion: true, bpm: 90 } },
  { name: 'Jazz', slug: 'jazz', line: 'Take your next phrase in a different direction.', label: 'Exploration preset · Piano / Classical', settings: { genre: 'Classical', mood: 'Peaceful', instrument: 'Piano', bpm: 100 } },
  { name: 'Cinematic', slug: 'cinematic', line: 'Write the feeling before the scene.', label: 'Cinematic · Strings / Ambient', settings: { genre: 'Ambient', mood: 'Cinematic', instrument: 'Strings' } },
  { name: 'Experimental', slug: 'experimental', line: 'The interesting part is what happens next.', label: 'Dreamy · Synthesizer', settings: { genre: 'Experimental', mood: 'Dreamy', instrument: 'Synthesizer' } },
];

const pageLabels = { home: 'Home', hum: 'Hum a melody', discover: 'Sound library', studio: 'Music studio', direction: 'Give your sound a feeling', library: 'My projects' };
const projectDate = value => new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function MelodyPreview({ notes }) {
  if (!notes.length) return null;
  const lowest = Math.min(...notes.map(note => note.midi));
  const pitchRange = Math.max(1, Math.max(...notes.map(note => note.midi)) - lowest);
  const duration = Math.max(1, ...notes.map(note => note.start + note.duration));

  return <svg className="reference-cover-melody" viewBox="0 0 260 55" role="img" aria-label="Saved melody preview">
    {notes.map((note, index) => {
      const x = 10 + note.start / duration * 240;
      const y = 42 - (note.midi - lowest) / pitchRange * 29;
      return <line key={index} x1={x} y1={y} x2={Math.min(250, x + Math.max(2, note.duration / duration * 240))} y2={y} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />;
    })}
  </svg>;
}

export function MuseMark({ small = false }) {
  return <span className={`reference-wordmark${small ? ' reference-wordmark-small' : ''}`}>MUSE<span aria-hidden="true">˚</span></span>;
}

function ProjectCards({ projects, open, create, busy, serverState }) {
  return <section className="reference-projects" aria-labelledby="projects-title">
    <div className="reference-page-kicker"><span>YOUR ARCHIVE</span><span>{serverState === 'ready' ? `${projects.length} SAVED ${projects.length === 1 ? 'IDEA' : 'IDEAS'}` : serverState === 'error' ? 'LIBRARY UNAVAILABLE' : 'LOADING LIBRARY'}</span></div>
    <div className="reference-page-heading">
      <h1 id="projects-title">Ideas worth<br /><em>keeping.</em></h1>
      <button className="reference-text-action" disabled={busy} onClick={create}><Plus size={14} /> Create something new</button>
    </div>
    {!projects.length ? <div className="reference-projects-empty">
      <FolderOpen size={30} strokeWidth={1} aria-hidden="true" />
      <div><h2>{serverState === 'connecting' ? 'Opening your archive…' : serverState === 'error' ? 'Your archive is unavailable.' : 'Your first idea belongs here.'}</h2><p>{serverState === 'connecting' ? 'Loading projects from your local MUSE database.' : serverState === 'error' ? 'Check that your local MUSE server is running, then reload to open your saved projects.' : 'Record a melody, make it your own and save your project to come back to it.'}</p></div>
      {serverState !== 'connecting' && <button className="reference-text-action" disabled={busy} onClick={create}>Create your first track <ArrowRight size={17} /></button>}
    </div> : <div className="reference-project-grid">
      {projects.map((project, index) => <article className="reference-project-card" key={project.id}>
        <div className={`reference-project-cover reference-cover-${index % 3}`}>
          <div className="reference-cover-top"><span>MUSE˚</span><span>{project.settings.genre}<br />{project.settings.bpm} BPM</span></div>
          <div className="reference-cover-figure" aria-hidden="true"><i /><i /><i /></div>
          <MelodyPreview notes={project.notes} />
          <h2>{project.title}</h2>
          <div className="reference-cover-bottom"><span>{project.settings.mood}<br />{project.settings.instrument}</span><span>AN IDEA<br />IN PROGRESS</span></div>
        </div>
        <div className="reference-project-info">
          <div><span className="reference-project-kicker">{project.settings.genre} / {project.notes.length} {project.notes.length === 1 ? 'NOTE' : 'NOTES'}</span><h3>{project.title}</h3><p>Edited <time dateTime={project.updatedAt}>{projectDate(project.updatedAt)}</time></p></div>
          <button className="reference-project-open" disabled={busy} aria-label={`Open project ${project.title}`} onClick={() => open(project)}><ArrowRight size={16} /></button>
        </div>
      </article>)}
    </div>}
    <div className="reference-archive-note"><span className="reference-live-dot" aria-hidden="true" /><span>Saved to your local MUSE database.</span></div>
  </section>;
}

function Dashboard({ studio, create, navigate }) {
  return <section className="reference-home" aria-labelledby="home-title">
    <div className="reference-home-photo" aria-hidden="true"><img src="/assets/festival-stage.jpg" alt="" fetchPriority="high" /><span /></div>
    <div className="reference-home-body">
      <span className="reference-home-eyebrow">FOR THE SOUND YOU CAN FEEL, BUT CAN’T EXPLAIN.</span>
      <h1 id="home-title">Find the sound<br />you haven’t<br /><em>heard yet.</em></h1>
      <p>Hum what’s in your head. MUSE turns unfinished melodies<br className="reference-desktop-break" /> and fleeting ideas into musical possibilities.<br className="reference-desktop-break" /> Follow the feeling before it disappears.</p>
    </div>
    <div className="hero-actions reference-home-actions">
      <button className="reference-home-action" disabled={studio.busy} aria-label="Hum a melody" onClick={() => navigate('hum')}><span className="reference-action-kicker">YOUR STARTING POINT</span><span className="reference-action-title"><strong>HUM</strong><ArrowRight size={20} strokeWidth={1} /></span><span className="reference-action-description">Record what’s in your head</span></button>
      <button className="reference-home-action" disabled={studio.busy} onClick={() => navigate('discover')}><span className="reference-action-kicker">FIND A DIRECTION</span><span className="reference-action-title"><strong>DISCOVER</strong><ArrowRight size={20} strokeWidth={1} /></span><span className="reference-action-description">Wander through new sounds</span></button>
      <button className="reference-home-action" disabled={studio.busy} aria-label="Start creating" onClick={create}><span className="reference-action-kicker">MAKE IT YOURS</span><span className="reference-action-title"><strong>CREATE</strong><ArrowRight size={20} strokeWidth={1} /></span><span className="reference-action-description">Enter the music studio</span></button>
    </div>
  </section>;
}

function Discover({ studio, applyPreset }) {
  return <section className="reference-discover" aria-labelledby="discover-title">
    <div className="reference-page-kicker"><span>THE SOUND LIBRARY</span><span>EDITABLE STARTING POINTS</span></div>
    <div className="reference-page-heading"><h1 id="discover-title">Follow your<br /><em>curiosity.</em></h1><p>A new texture. A different pulse.<br />Find a starting point, then make it yours.</p></div>
    <div className="reference-discovery-grid">
      {discoveryStages.map(stage => <button className={`reference-discovery-card reference-discovery-${stage.slug}`} key={stage.slug} disabled={studio.busy || studio.arranging} aria-label={`Explore ${stage.name}`} onClick={() => applyPreset(stage.settings)}>
        <span className="reference-discovery-art" aria-hidden="true"><i /><i /><i /><i /><span>{stage.name.slice(0, 1)}</span></span>
        <span className="reference-discovery-type">MUSE / EXPLORATIONS</span>
        <span className="reference-discovery-name">{stage.name}</span>
        <span className="reference-discovery-line">{stage.line}</span>
        <span className="reference-discovery-bottom"><span>{stage.label}</span><ArrowUpRight size={20} /></span>
      </button>)}
    </div>
    <div className="reference-discovery-note"><Headphones size={17} /><p>Each starting point applies the sound settings shown. These are editable synthesis presets; record your own melody in the studio to hear them.</p></div>
  </section>;
}

function Guide({ dialogRef }) {
  return <dialog ref={dialogRef} className="guide-dialog reference-guide" aria-labelledby="guide-title">
    <div className="dialog-heading"><MuseMark small /><button className="icon-button" aria-label="Close guide" onClick={() => dialogRef.current.close()}><X size={19} /></button></div>
    <span className="eyebrow">FROM YOUR FIRST NOTE</span><h2 id="guide-title">Your voice is the starting point.</h2>
    <ol className="guide-steps">
      <li><strong>Capture a short melody.</strong><span>Allow your microphone. Hum one clear note at a time for 5–10 seconds in a quiet room. Takes can be up to 60 seconds.</span></li>
      <li><strong>Find its character.</strong><span>Choose a mood, genre and instrument. Check the detected notes; you can adjust a pitch or remove a stray note.</span></li>
      <li><strong>Hear your arrangement.</strong><span>Create the arrangement, then press play. Ask the producer for a direction, review its proposal and apply the changes.</span></li>
      <li><strong>Keep your idea.</strong><span>Save the project to this computer’s MUSE database, or export a WAV. The original microphone recording only lasts for this session.</span></li>
    </ol>
    <div className="guide-honesty"><ShieldCheck size={18} /><p>Pitch detection is approximate and works best with a single voice. The producer proposes supported settings using local rules or an optional AI connection. Each direction shows its source; review it before applying. Instruments are synthesised sounds. On an AI request, your direction and detected notes may be sent to the configured provider. Your raw microphone recording stays on this device.</p></div>
    <button className="button primary full" onClick={() => dialogRef.current.close()}>Let’s make music <ArrowRight size={16} /></button>
  </dialog>;
}

export default function App() {
  const [page, setPage] = useState('home');
  const studio = useStudio();
  const auth = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  const guideRef = useRef(null);
  const mainRef = useRef(null);
  const previousPage = useRef(page);
  const capturedHum = page === 'hum' && (studio.hasMelody ?? studio.project.notes.length > 0) && !studio.busy;
  const photoPage = page === 'home' || (page === 'hum' && !capturedHum);
  const lightPage = page === 'direction' || page === 'discover' || capturedHum;
  const connectionClass = studio.serverState === 'error' ? 'connection-error' : studio.serverState === 'ready' ? '' : 'connection-pending';

  useEffect(() => {
    window.scrollTo(0, 0);
    if (previousPage.current !== page) mainRef.current?.focus({ preventScroll: true });
    previousPage.current = page;
  }, [page]);

  useEffect(() => {
    document.title = page === 'studio' ? `${studio.project.title || 'Untitled melody'} — MUSE Studio` : `MUSE — ${pageLabels[page]}`;
  }, [page, studio.project.title]);

  const create = async () => { if (await studio.newProject()) setPage('studio'); };
  const open = async project => { if (await studio.openProject(project)) setPage('studio'); };
  const navigate = next => { if (studio.busy) return; studio.stopPlayback(); setPage(next); };
  const applyPreset = settings => {
    if (studio.busy || studio.arranging) return;
    studio.changeSettings(settings);
    navigate('studio');
  };

  return <div className={`muse-reference-shell reference-page-${page}${photoPage ? ' reference-photo-shell' : ''}${lightPage ? ' reference-light-shell' : ''}`}>
    <a href="#main-content" className="skip-link">Skip to workspace</a>
    <header className="reference-header">
      <button className="reference-home-link" aria-label="Home" disabled={studio.busy} onClick={() => navigate('home')}><MuseMark /></button>
      <nav className="reference-navigation" aria-label="Main navigation">
        <button className={page === 'discover' ? 'reference-nav-current' : ''} aria-label="Discover sound library" aria-current={page === 'discover' ? 'page' : undefined} disabled={studio.busy} onClick={() => navigate('discover')}>DISCOVER</button>
        <button className={page === 'studio' || page === 'direction' ? 'reference-nav-current' : ''} aria-label="Music studio" aria-current={page === 'studio' || page === 'direction' ? 'page' : undefined} disabled={studio.busy} onClick={() => navigate('studio')}>STUDIO</button>
        <button className={page === 'library' ? 'reference-nav-current' : ''} aria-label="My projects" aria-current={page === 'library' ? 'page' : undefined} disabled={studio.busy} onClick={() => navigate('library')}>PROJECTS</button>
      </nav>
      <button className="reference-hum-link" aria-label="Hum a melody" aria-current={page === 'hum' ? 'page' : undefined} disabled={studio.busy} onClick={() => navigate('hum')}><Mic2 size={17} strokeWidth={1.3} /><span>HUM A MELODY</span></button>
      <button className="reference-account-button" aria-label={auth.user ? 'Account' : 'Sign in'} aria-haspopup="dialog" disabled={studio.busy} onClick={() => setAccountOpen(true)}><UserRound size={18} strokeWidth={1.3} /><span>{auth.user ? 'ACCOUNT' : 'SIGN IN'}</span></button>
    </header>
    <main id="main-content" className="reference-main" tabIndex={-1} ref={mainRef}>
      {studio.error && <div className="error-banner reference-error" role="alert"><div><strong>Something needs your attention</strong><p>{studio.error}</p></div><button className="icon-button" aria-label="Dismiss error" onClick={studio.clearError}><X size={16} /></button></div>}
      <div className="reference-page-content" key={page}>
        {page === 'home' && <Dashboard studio={studio} create={create} navigate={navigate} />}
        {page === 'discover' && <Discover studio={studio} applyPreset={applyPreset} />}
        {page === 'hum' && <HumExperience studio={studio} onOpenStudio={() => navigate('studio')} onOpenDirection={() => navigate('direction')} />}
        {page === 'direction' && <DirectionExperience studio={studio} onOpenStudio={() => navigate('studio')} onRecord={() => navigate('hum')} />}
        {page === 'library' && <ProjectCards projects={studio.projects} open={open} create={create} busy={studio.busy} serverState={studio.serverState} />}
        {page === 'studio' && <Studio studio={studio} onOpenProducer={() => navigate('direction')} />}
      </div>
    </main>
    <footer className="reference-footer">
      <div className={`local-label reference-connection ${connectionClass}`}><span className="status-dot" />{studio.serverState === 'ready' ? 'Local server connected' : studio.serverState === 'error' ? 'Server unavailable' : 'Connecting to studio…'}</div>
      <span className="reference-privacy"><ShieldCheck size={12} /> Raw audio stays on this device.</span>
      <button className="reference-guide-link" aria-label="Open getting started guide" onClick={() => guideRef.current.showModal()}><CircleHelp size={13} /> Getting started</button>
    </footer>
    <Guide dialogRef={guideRef} />
    {accountOpen && <AuthPanel auth={auth} onClose={() => setAccountOpen(false)} busy={studio.busy} />}
    <div className={`toast reference-toast ${studio.notice ? 'visible' : ''}`} role="status" aria-live="polite">{studio.notice && <><Check size={17} /><span>{studio.notice}</span></>}</div>
  </div>;
}
