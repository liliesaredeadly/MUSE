async function request(path, body) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('The MUSE server is unavailable. Start the app with npm run dev, then retry.');
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('The server returned an unreadable response. Restart the MUSE server and retry.'); }
  if (!response.ok) throw new Error(result.error || `The request failed (${response.status}).`);
  return result;
}

export const api = {
  health: () => request('/health'),
  projects: async () => (await request('/projects')).projects,
  save: async project => (await request('/projects', project)).project,
  arrange: async (notes, settings) => (await request('/arrange', { notes, settings })).arrangement,
  producer: (text, settings) => request('/producer', { text, settings }),
};
