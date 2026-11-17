import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronRight, CircleHelp, Compass, FolderOpen, Headphones, Home, Library, Mic2, Music2, Plus, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import { useStudio } from './hooks/useStudio.js';
import Studio, { HumExperience, instruments } from './components/Studio.jsx';

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

const pageLabels = { home: 'Home', hum: 'Hum', discover: 'Sound library', studio: 'Music studio', library: 'My projects' };
const projectDate = value => new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function MelodyPreview({ notes }) {
  if (!notes.length) return <Music2 className="project-art-empty" size={48} strokeWidth={1} aria-hidden="true" />;
  const lowest = Math.min(...notes.map(note => note.midi));
  const pitchRange = Math.max(1, Math.max(...notes.map(note => note.midi)) - lowest);
  const duration = Math.max(1, ...notes.map(note => note.start + note.duration));

  return (
    <>
      <svg className="project-melody-preview" viewBox="0 0 260 120" role="img" aria-label="Melody preview">
        {notes.map((note, index) => {
          const x = 12 + note.start / duration * 236;
          const y = 95 - (note.midi - lowest) / pitchRange * 70;
          return <line key={index} x1={x} y1={y} x2={Math.min(248, x + Math.max(2, note.duration / duration * 236))} y2={y} stroke="currentColor" strokeWidth="4" strokeLinecap="round" />;
        })}
      </svg>
      <span className="cover-preview-label">Melody preview</span>
    </>
  );
}

export function MuseMark({ small = false }) {
  return (
    <div className={`muse-brand ${small ? 'small' : ''}`}>
      <span className="brand-symbol" aria-hidden="true"><i /><i /><i /><i /></span>
      <span>MUSE<span className="brand-dot">.</span></span>
    </div>
  );
}

function ProjectCards({ projects, open, create, library = false, busy = false }) {
  return (
    <section className="projects-section">
      <div className="section-heading">
        <div>
          <span className="eyebrow">THE WORK IN PROGRESS</span>
          <h2>{library ? 'Your collection.' : 'Ideas worth coming back to.'} <span className="count">{projects.length}</span></h2>
          <p>{library ? 'Your saved sessions, ready for the next idea.' : 'Pick up a saved session and see where it takes you.'}</p>
        </div>
        <button className="button subtle" disabled={busy} onClick={create}><Plus size={16} /> New track</button>
      </div>
      {!projects.length ? (
        <div className="empty-projects">
          <div className="empty-icon"><FolderOpen size={26} /></div>
          <div>
            <h3>Your first session starts with a sound.</h3>
            <p>Hum a melody, shape an arrangement and save a little piece of your world.</p>
          </div>
          <button className="text-button" disabled={busy} onClick={create}>Create your first track <ArrowUpRight size={18} /></button>
        </div>
      ) : (
        <div className="project-grid">
          {projects.slice(0, library ? 30 : 6).map((project, index) => (
            <article className="project-card" key={project.id}>
              <div className={`project-art art-${index % 4}`}>
                <span className="cover-label">MUSE / SESSION</span>
                <span className="cover-orbit" aria-hidden="true" /><span className="cover-orbit second" aria-hidden="true" />
                <MelodyPreview notes={project.notes} />
                <span className="cover-genre">{project.settings.genre}</span>
              </div>
              <div className="project-info">
                <h3>{project.title}</h3>
                <p>{project.settings.mood} <span>·</span> {project.settings.bpm} BPM <span>·</span> {project.notes.length} notes</p>
                <div className="project-meta">
                  <span className="project-created">Created <time dateTime={project.createdAt}>{projectDate(project.createdAt)}</time></span>
                  <span className="project-edited">Last edited <time dateTime={project.updatedAt}>{projectDate(project.updatedAt)}</time></span>
                </div>
                <button className="project-open-action text-button" disabled={busy} aria-label={`Open project ${project.title}`} onClick={() => open(project)}>Open project <ArrowUpRight size={17} /></button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Dashboard({ studio, create, open, navigate }) {
  return (
    <>
      <section className="festival-hero" aria-labelledby="home-title">
        <div className="hero-art" aria-hidden="true"><img src="/desert-session.png" alt="" /><span className="hero-art-shade" /></div>
        <div className="hero-editorial">
          <div className="hero-topline"><span className="eyebrow">A PLACE FOR THE SOUND IN YOUR HEAD</span><span className="hero-edition">EST. IN YOUR IMAGINATION</span></div>
          <div className="hero-wordmark" aria-hidden="true">MUSE<span>✳</span></div>
          <div className="hero-statement">
            <h1 id="home-title">Find the sound you haven't heard yet.</h1>
            <p>A hum. A half-formed melody. A feeling you can't quite name. Turn your musical ideas into notes, new textures and arrangements that are yours to explore.</p>
          </div>
          <div className="hero-actions">
            <button className="hero-action action-hum" disabled={studio.busy} onClick={() => navigate('hum')}><span className="hero-action-icon"><Mic2 size={22} /></span><span><strong>HUM</strong><small>Start with your voice</small></span><ArrowUpRight size={23} /></button>
            <button className="hero-action action-discover" disabled={studio.busy} onClick={() => navigate('discover')}><span className="hero-action-icon"><Compass size={22} /></span><span><strong>DISCOVER</strong><small>Find a new direction</small></span><ArrowUpRight size={23} /></button>
            <button className="hero-action action-create" aria-label="Start creating" disabled={studio.busy} onClick={create}><span className="hero-action-icon"><SlidersHorizontal size={22} /></span><span><strong>CREATE</strong><small>Enter the music studio</small></span><ArrowUpRight size={23} /></button>
          </div>
          <div className="hero-bottomline"><span>INDEPENDENT IDEAS. ENDLESS DIRECTIONS.</span><span><ShieldCheck size={13} /> Your audio stays on this device.</span></div>
        </div>
      </section>
      <div className="home-interlude"><span className="interlude-mark" aria-hidden="true">✳</span><p>Somewhere between <em>an idea</em><br />and your next favourite sound.</p><button className="text-button" disabled={studio.busy} onClick={() => navigate('discover')}>Explore the sound library <ArrowUpRight size={19} /></button></div>
      <ProjectCards projects={studio.projects} open={open} create={create} busy={studio.busy} />
    </>
  );
}

function Discover({ studio, applyPreset }) {
  return (
    <>
      <div className="page-title discovery-heading">
        <div>
          <span className="eyebrow">THE SOUND LIBRARY / EIGHT WAYS IN</span>
          <h1>Follow your curiosity.</h1>
          <p>Different stages. Different possibilities. Find a starting point, then make it sound like you.</p>
        </div>
        <span className="discovery-heading-mark" aria-hidden="true">✳</span>
      </div>
      <div className="discovery-grid">
        {discoveryStages.map(stage => (
          <button className={`discovery-card stage-${stage.slug}`} key={stage.slug} disabled={studio.busy || studio.arranging} aria-label={`Explore ${stage.name}`} onClick={() => applyPreset(stage.settings)}>
            <span className="discovery-art" aria-hidden="true"><i /><i /><i /><i /><i /></span>
            <span className="discovery-kicker">MUSE / EXPLORATIONS</span>
            <span className="discovery-name">{stage.name}</span>
            <span className="discovery-line">{stage.line}</span>
            <span className="discovery-bottom"><span>{stage.label}</span><ArrowUpRight size={22} /></span>
          </button>
        ))}
      </div>
      <div className="discovery-note"><Headphones size={20} /><p>These are editable starting points for the current synthesis engine, rather than prerecorded tracks or complete genre productions. Each card applies the instrument, mood and arrangement style shown; you can change them in the studio.</p></div>
    </>
  );
}

function Guide({ dialogRef }) {
  return (
    <dialog ref={dialogRef} className="guide-dialog" aria-labelledby="guide-title">
      <div className="dialog-heading">
        <MuseMark small />
        <button className="icon-button" aria-label="Close guide" onClick={() => dialogRef.current.close()}><X size={19} /></button>
      </div>
      <span className="eyebrow">FROM YOUR FIRST NOTE</span>
      <h2 id="guide-title">Your voice is the starting point.</h2>
      <ol className="guide-steps">
        <li><strong>Capture a short melody.</strong><span>Allow your microphone. Hum one clear note at a time for 5–10 seconds in a quiet room. Takes can be up to 60 seconds.</span></li>
        <li><strong>Find its character.</strong><span>Choose a mood, genre and instrument. Check the detected notes; you can adjust a pitch or remove a stray note.</span></li>
        <li><strong>Hear your arrangement.</strong><span>Create the arrangement, then press play. Ask the producer for a direction, review its proposal and apply the changes.</span></li>
        <li><strong>Keep your idea.</strong><span>Save the project to this computer’s MUSE database, or export a WAV. The original microphone recording only lasts for this session.</span></li>
      </ol>
      <div className="guide-honesty"><ShieldCheck size={18} /><p>Pitch detection is approximate and works best with a single voice. The producer uses musical rules; no external AI model is connected. Piano, strings and other instruments are synthesised sounds.</p></div>
      <button className="button primary full" onClick={() => dialogRef.current.close()}>Let’s make music <ArrowRight size={16} /></button>
    </dialog>
  );
}

export default function App() {
  const [page, setPage] = useState('home');
  const studio = useStudio();
  const guideRef = useRef(null);
  const connectionClass = studio.serverState === 'error' ? 'connection-error' : studio.serverState === 'ready' ? '' : 'connection-pending';
  const workspacePage = page === 'studio' || page === 'hum';

  useEffect(() => { window.scrollTo(0, 0); }, [page]);

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

  return (
    <div className={`app-shell page-${page}`}>
      <a href="#main-content" className="skip-link">Skip to workspace</a>
      <aside className="sidebar">
        <MuseMark />
        <div className="workspace-label"><span className="workspace-avatar">M</span><div>Personal workspace<small>Independent by nature</small></div></div>
        <button className="button primary new-track" disabled={studio.busy} onClick={create}><Plus size={17} /> Create new track</button>
        <span className="nav-label">YOUR CREATIVE WORLD</span>
        <nav aria-label="Main navigation">
          <button className={`nav-item ${page === 'home' ? 'active' : ''}`} aria-current={page === 'home' ? 'page' : undefined} disabled={studio.busy} onClick={() => navigate('home')}><Home size={18} /> Home</button>
          <button className={`nav-item ${page === 'hum' ? 'active' : ''}`} aria-current={page === 'hum' ? 'page' : undefined} disabled={studio.busy} onClick={() => navigate('hum')}><Mic2 size={18} /> Hum a melody</button>
          <button className={`nav-item ${page === 'studio' ? 'active' : ''}`} aria-current={page === 'studio' ? 'page' : undefined} disabled={studio.busy} onClick={() => navigate('studio')}><SlidersHorizontal size={18} /> Music studio</button>
          <button className={`nav-item ${page === 'library' ? 'active' : ''}`} aria-current={page === 'library' ? 'page' : undefined} disabled={studio.busy} onClick={() => navigate('library')}><Library size={18} /> My projects <span className="nav-count">{studio.projects.length}</span></button>
          <button className={`nav-item ${page === 'discover' ? 'active' : ''}`} aria-current={page === 'discover' ? 'page' : undefined} disabled={studio.busy} onClick={() => navigate('discover')}><Compass size={18} /> Sound library</button>
        </nav>
        {workspacePage && (
          <div className="sidebar-instruments">
            <span className="nav-label">LEAD INSTRUMENT</span>
            <div className="instrument-list">
              {instruments.map(instrument => <button className={`instrument-choice ${studio.project.settings.instrument === instrument ? 'selected' : ''}`} key={instrument} aria-pressed={studio.project.settings.instrument === instrument} disabled={studio.busy || studio.arranging} onClick={() => studio.changeSettings({ instrument })}><Music2 size={15} /><span>{instrument}</span><span className="instrument-indicator" /></button>)}
            </div>
            <span className="instrument-caption">Synthesised voices for your melody</span>
          </div>
        )}
        <div className="sidebar-bottom">
          {!workspacePage && <div className="idea-note"><span className="sidebar-flower" aria-hidden="true">✳</span><h3>Good things start<br />with a little noise.</h3><p>Make something only you could make.</p></div>}
          <button className="nav-item" onClick={() => guideRef.current.showModal()}><CircleHelp size={18} /> Getting started <ArrowUpRight size={15} /></button>
          <div className={`local-label ${connectionClass}`}><span className="status-dot" />{studio.serverState === 'ready' ? 'Local server connected' : studio.serverState === 'error' ? 'Server unavailable' : 'Connecting to studio…'}</div>
        </div>
      </aside>
      <div className="app-content">
        <header className="topbar">
          <div className="breadcrumb">Your creative world <ChevronRight size={13} /><span>{pageLabels[page]}</span></div>
          <div className="topbar-right"><span className="prototype-tag">MADE OF <span>✳</span> POSSIBILITIES</span><button className="icon-button help-button" aria-label="Open getting started guide" onClick={() => guideRef.current.showModal()}><CircleHelp size={18} /></button><div className="profile-avatar" aria-label="Personal workspace">M</div></div>
        </header>
        <main id="main-content" className={`main-content ${workspacePage ? 'studio-main' : ''}`}>
          {studio.error && <div className="error-banner" role="alert"><div><strong>Something needs your attention</strong><p>{studio.error}</p></div><button className="icon-button" aria-label="Dismiss error" onClick={studio.clearError}><X size={16} /></button></div>}
          <div className="page-inner page-enter" key={page}>
            {page === 'home' && <Dashboard studio={studio} create={create} open={open} navigate={navigate} />}
            {page === 'discover' && <Discover studio={studio} applyPreset={applyPreset} />}
            {page === 'hum' && <HumExperience studio={studio} onOpenStudio={() => navigate('studio')} />}
            {page === 'library' && <><div className="page-title library-heading"><div><span className="eyebrow">YOUR PERSONAL ARCHIVE</span><h1>Keep the good ideas.</h1><p>Projects saved to the MUSE server on this computer. Yours to revisit, reshape and make into something new.</p></div><span className="library-heading-mark" aria-hidden="true">✳</span></div><ProjectCards library projects={studio.projects} open={open} create={create} busy={studio.busy} /></>}
            {page === 'studio' && <Studio studio={studio} />}
          </div>
          <footer className="page-footer"><span>MUSE <span className="footer-dot">✳</span> Independent ideas. Your sound.</span><span><ShieldCheck size={13} /> Your audio stays on this device.</span></footer>
        </main>
      </div>
      <Guide dialogRef={guideRef} />
      <div className={`toast ${studio.notice ? 'visible' : ''}`} role="status" aria-live="polite">{studio.notice && <><Check size={17} /><span>{studio.notice}</span></>}</div>
    </div>
  );
}
