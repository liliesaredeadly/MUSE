import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

class ErrorBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    if (this.state.error) return <main className="fatal"><img src="/muse.svg" alt="MUSE" width="48" /><h1>The studio needs a restart.</h1><p>Reload to reopen your saved projects. Unsaved recordings may be lost.</p><button className="button primary" onClick={() => window.location.reload()}>Reload studio</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
