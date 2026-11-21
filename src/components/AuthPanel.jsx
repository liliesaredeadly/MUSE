import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, Eye, EyeOff, LoaderCircle, LogOut, RotateCcw, X } from 'lucide-react';

export default function AuthPanel({ auth, onClose, busy = false }) {
  const [mode, setMode] = useState('signin');
  const [values, setValues] = useState({ email: '', password: '', username: '', displayName: '' });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState('');
  const [dismissedError, setDismissedError] = useState('');
  const [revealed, setRevealed] = useState(false);
  const dialogRef = useRef(null);
  const alertRef = useRef(null);
  const submitting = useRef(false);
  const id = useId();
  const signup = mode === 'signup';
  const blocked = busy || auth.pending || auth.status === 'loading';
  const message = failure || (auth.error === dismissedError ? '' : auth.error);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const target = dialogRef.current?.querySelector(auth.status === 'authenticated' ? '[data-auth-summary]' : 'input');
    target?.focus();
  }, [auth.status, mode]);

  function update(name, value) {
    setValues(current => ({ ...current, [name]: value }));
    setErrors(current => ({ ...current, [name]: '' }));
    setFailure(''); setDismissedError(auth.error);
  }

  function switchMode() {
    setMode(signup ? 'signin' : 'signup'); setErrors({}); setFailure(''); setDismissedError(auth.error); setRevealed(false);
    setValues(current => ({ ...current, password: '' }));
  }

  async function submit(event) {
    event.preventDefault();
    if (blocked || submitting.current || event.nativeEvent?.isComposing) return;
    const next = {};
    if (signup && (!values.displayName.trim() || [...values.displayName.trim()].length > 60)) next.displayName = 'Enter a display name from 1 to 60 characters.';
    if (signup && !/^[a-z0-9_]{3,24}$/.test(values.username.trim())) next.username = 'Use 3–24 lowercase letters, numbers or underscores.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim()) || values.email.trim().length > 254) next.email = 'Enter a valid email address.';
    const passwordLength = [...values.password].length;
    if (!passwordLength || passwordLength > 128 || (signup && passwordLength < 12)) next.password = signup ? 'Use a password from 12 to 128 characters.' : 'Enter your password.';
    setErrors(next); setFailure('');
    const first = Object.keys(next)[0];
    if (first) { dialogRef.current.querySelector(`[name="${first}"]`)?.focus(); return; }
    submitting.current = true;
    try {
      const credentials = { email: values.email.trim(), password: values.password };
      if (signup) await auth.signUp({ ...credentials, username: values.username.trim(), displayName: values.displayName.trim() });
      else await auth.signIn(credentials);
      setValues(current => ({ ...current, password: '' })); setRevealed(false);
    } catch (error) {
      setFailure(error.message || 'Your account request could not be completed. Please try again.');
      setValues(current => ({ ...current, password: '' })); setRevealed(false);
      requestAnimationFrame(() => alertRef.current?.focus());
    } finally { submitting.current = false; }
  }

  async function act(operation) {
    if (auth.pending || submitting.current) return;
    submitting.current = true; setFailure('');
    try { await operation(); }
    catch (error) { setFailure(error.message || 'Your account request could not be completed. Please try again.'); }
    finally { submitting.current = false; }
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const items = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
    const first = items[0]; const last = items.at(-1);
    if (!first) { event.preventDefault(); dialogRef.current.focus(); }
    else if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  }

  function field(name, label, attributes = {}, help = '') {
    const inputId = `${id}-${name}`;
    return <div className="muse-auth-field">
      <label htmlFor={inputId}>{label}</label>
      <div className={name === 'password' ? 'muse-auth-password' : undefined}>
        <input id={inputId} name={name} value={values[name]} disabled={blocked} onChange={event => update(name, event.target.value)} required
          aria-invalid={Boolean(errors[name])} aria-describedby={errors[name] ? `${inputId}-error` : help ? `${inputId}-help` : undefined} {...attributes} />
        {name === 'password' && <button type="button" className="muse-auth-reveal" aria-label={revealed ? 'Hide password' : 'Show password'} aria-pressed={revealed} disabled={blocked} onClick={() => setRevealed(current => !current)}>{revealed ? <EyeOff size={18} /> : <Eye size={18} />}</button>}
      </div>
      {help && <p className="muse-auth-help" id={`${inputId}-help`}>{help}</p>}
      {errors[name] && <p className="muse-auth-field-error" id={`${inputId}-error`}>{errors[name]}</p>}
    </div>;
  }

  return <dialog ref={dialogRef} className="muse-auth-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={trapFocus} onClick={event => {
    if (event.target !== dialogRef.current) return;
    const rect = dialogRef.current.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <div className="muse-auth-topline"><span>MUSE˚ / YOUR ACCOUNT</span><button type="button" className="muse-auth-close" aria-label="Close account" onClick={onClose}><X size={20} /></button></div>
    <div className="muse-auth-content">
      <span className="muse-auth-kicker">A SPACE FOR YOUR SOUND</span>
      <h2 id={`${id}-title`}>{auth.user ? 'You’re signed in.' : signup ? <>Make room<br /><em>for your ideas.</em></> : <>Good to<br /><em>hear you again.</em></>}</h2>
      <p id={`${id}-description`} className="muse-auth-description">{auth.user ? 'Your MUSE account is ready. Keep creating at your own pace.' : signup ? 'Create your MUSE account with an email and password.' : 'Sign in to your MUSE account. Your studio stays right where you left it.'}</p>
      {message && <div className="muse-auth-error" role="alert" tabIndex={-1} ref={alertRef}>{message}</div>}
      {busy && <p className="muse-auth-busy" role="status">Finish your recording or save before changing your account.</p>}
      {auth.status === 'loading' ? <div className="muse-auth-loading" role="status"><LoaderCircle size={18} className="spin" />Checking your session…</div> : auth.user ? <div className="muse-auth-account">
        <div className="muse-auth-identity" data-auth-summary tabIndex={-1}><span className="muse-auth-avatar" aria-hidden="true">{(auth.user.displayName || auth.user.username).slice(0, 1).toUpperCase()}</span><div><h3>{auth.user.displayName}</h3><p>@{auth.user.username}</p><p>{auth.user.email}</p></div><Check size={19} aria-label="Signed in" /></div>
        <button type="button" className="muse-auth-primary" disabled={blocked} aria-busy={auth.pending} onClick={() => { if (!busy) act(auth.signOut); }}>{auth.pending ? <LoaderCircle size={17} className="spin" /> : <LogOut size={17} />}{auth.pending ? 'Signing out…' : 'Sign out'}</button>
      </div> : <>
        <form noValidate className="muse-auth-form" onSubmit={submit} aria-busy={auth.pending}>
          {signup && field('displayName', 'Display name', { type: 'text', autoComplete: 'name', maxLength: 120 })}
          {signup && field('username', 'Username', { type: 'text', autoComplete: 'username', autoCapitalize: 'none', spellCheck: false, maxLength: 24 }, '3–24 lowercase letters, numbers or underscores.')}
          {field('email', 'Email address', { type: 'email', autoComplete: signup ? 'email' : 'username', autoCapitalize: 'none', spellCheck: false, maxLength: 254 })}
          {field('password', 'Password', { type: revealed ? 'text' : 'password', autoComplete: signup ? 'new-password' : 'current-password', maxLength: 256 }, signup ? 'Use 12–128 characters. Password managers and paste are welcome.' : '')}
          <button type="submit" className="muse-auth-primary" disabled={blocked}>{auth.pending ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}{auth.pending ? signup ? 'Creating account…' : 'Signing in…' : signup ? 'Create account' : 'Sign in'}</button>
        </form>
        <div className="muse-auth-switch"><span>{signup ? 'Already have an account?' : 'New to MUSE?'}</span><button type="button" disabled={blocked} onClick={switchMode}>{signup ? 'Back to sign in' : 'Create an account'}<ArrowRight size={13} /></button></div>
      </>}
      {(auth.status === 'error' || auth.user) && <button type="button" className="muse-auth-refresh" disabled={auth.pending} onClick={() => act(auth.refresh)}><RotateCcw size={13} />{auth.pending ? 'Checking session…' : 'Check session'}</button>}
      <p className="muse-auth-local-note">Your music projects stay in this installation’s local archive.</p>
    </div>
  </dialog>;
}
