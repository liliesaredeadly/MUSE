import { createMelodyModel, MelodyModelError } from './melody-model.js';
import { createReplicateMelodyModel } from './replicate-melody-model.js';

/** Credentials and provider selection are server-only; status never contains keys. */
export function createMusicGenProvider({ provider = process.env.MUSE_MELODY_PROVIDER || 'auto',
  token = process.env.REPLICATE_API_TOKEN, ...options } = {}) {
  const selected = String(provider).trim().toLowerCase();
  if (selected === 'replicate' || (selected === 'auto' && typeof token === 'string' && token.trim())) {
    return createReplicateMelodyModel({ ...options, token });
  }
  if (selected === 'local' || selected === 'auto') return createMelodyModel(options);
  const status = () => ({ mode: 'unavailable', configured: false, ready: false, provider: null, model: null,
    reason: 'invalid-provider' });
  return { status, probe: async () => status(), close() {},
    async generate() { throw new MelodyModelError('Choose auto, local or replicate for MUSE_MELODY_PROVIDER on the server.', 503, 'MODEL_NOT_CONFIGURED'); } };
}
