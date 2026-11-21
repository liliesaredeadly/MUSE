import { useEffect, useRef, useState } from 'react';
import { createAuthApi } from '../lib/auth-api.js';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const apiRef = useRef(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pendingRef = useRef(false);
  const userRef = useRef(null);
  if (!apiRef.current) apiRef.current = createAuthApi();

  async function run(operation, checkingSession = false) {
    if (pendingRef.current) throw new Error('An account request is already in progress.');
    const current = ++generation.current;
    const isCurrent = () => mounted.current && generation.current === current;
    pendingRef.current = true; setPending(true); setError('');
    try {
      const result = await operation();
      if (isCurrent()) {
        userRef.current = result.user || null;
        setUser(userRef.current);
        setStatus(userRef.current ? 'authenticated' : 'anonymous');
      }
      return result.user || null;
    } catch (failure) {
      if (isCurrent()) {
        setError(failure.message || 'Your account request could not be completed. Please try again.');
        if (checkingSession && !userRef.current) setStatus('error');
      }
      throw failure;
    } finally {
      if (isCurrent()) { pendingRef.current = false; setPending(false); }
    }
  }

  function refresh() { return run(() => apiRef.current.session(), true); }
  function signIn(credentials) { return run(() => apiRef.current.signIn(credentials)); }
  function signUp(details) { return run(() => apiRef.current.signUp(details)); }
  function signOut() { return run(() => apiRef.current.signOut()); }

  useEffect(() => {
    mounted.current = true;
    refresh().catch(() => { /* The account UI exposes recovery; music remains usable. */ });
    return () => { mounted.current = false; generation.current++; pendingRef.current = false; };
  }, []);

  return { user, status, error, pending, signIn, signUp, signOut, refresh };
}
