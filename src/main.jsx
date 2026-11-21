import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './styles/reference-shell.css';
import './styles/reference-studio.css';
import './styles/reference-direction.css';
import './styles/atelier.css';
import './styles/atelier-direction.css';
import './styles/atelier-library.css';
import './styles/reference-match.css';
import './styles/auth.css';
import './styles/production-director.css';
import App from './App.jsx';

class ErrorBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    if (this.state.error) return <main className="fatal"><img src="/muse.svg" alt="MUSE" width="48" /><h1>The studio needs a restart.</h1><p>Reload to reopen your saved projects. Unsaved recordings may be lost.</p><button className="button primary" onClick={() => window.location.reload()}>Reload studio</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
