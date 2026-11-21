/** Cookie credentials and CSRF stay in memory; no account secrets enter browser storage. */
export function createAuthApi() {
  let csrfToken = null;

  async function request(path, body) {
    let response;
    try {
      response = await fetch(`/api/auth/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', cache: 'no-store',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(path === 'logout' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('The MUSE account server is unavailable. Check that the local server is running, then try again.');
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error('The account server returned an unreadable response. Try checking your session again.'); }
    if (!response.ok) {
      const message = response.status === 401
        ? path === 'login' ? 'Email or password is incorrect.' : 'Your session has expired. Sign in again.'
        : response.status >= 500 ? 'Your account request could not be completed. Please try again.'
          : typeof result?.error === 'string' ? result.error : 'Your account request could not be completed. Please try again.';
      const error = new Error(message); error.status = response.status; throw error;
    }
    const user = result?.user;
    const validUser = user && !Array.isArray(user) && ['id', 'username', 'displayName', 'email', 'createdAt']
      .every(key => typeof user[key] === 'string' && user[key].trim().length > 0);
    const authenticated = validUser && typeof result.csrfToken === 'string' && result.csrfToken.length > 0;
    const anonymous = user === null && result.csrfToken === null;
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || !(authenticated || anonymous) || ((path === 'login' || path === 'register') && !authenticated)
      || (path === 'logout' && !anonymous)) {
      throw new Error('The account server returned an invalid response. Try checking your session again.');
    }
    csrfToken = result.csrfToken;
    return result;
  }

  return {
    session: () => request('session'),
    signIn: credentials => request('login', credentials),
    signUp: details => request('register', details),
    async signOut() {
      if (!csrfToken) {
        const session = await request('session');
        if (!session.user) return { user: null, csrfToken: null };
      }
      let result;
      try { result = await request('logout', {}); }
      catch (error) {
        if (error.status !== 403) throw error;
        // Another tab may have rotated the shared cookie since we cached its CSRF token.
        const session = await request('session');
        if (!session.user) return { user: null, csrfToken: null };
        result = await request('logout', {});
      }
      csrfToken = null;
      return { ...result, user: null };
    },
  };
}
