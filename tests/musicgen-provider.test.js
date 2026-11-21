import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMusicGenProvider } from '../server/musicgen-provider.js';
import { validateGeneratedAudio } from '../server/melody-model.js';
import { encodePcmWav } from '../src/audio/pcm-wav.js';

const token = 'r8_' + 'x'.repeat(37);

test('auto provider selection uses a saved server token without exposing it in status', () => {
  const model = createMusicGenProvider({ provider: 'auto', token, endpoint: 'http://127.0.0.1:3002/generate' });
  try {
    assert.equal(model.status().provider, 'replicate');
    assert.equal(model.status().model, 'facebook/musicgen-melody-large');
    assert.equal(model.status().paid, true);
    assert.doesNotMatch(JSON.stringify(model.status()), new RegExp(token));
  } finally { model.close(); }
});

test('an explicit local provider retains loopback generation even with a cloud token', () => {
  const model = createMusicGenProvider({ provider: 'local', token, endpoint: 'http://127.0.0.1:3002/generate' });
  try {
    assert.equal(model.status().provider, 'local-audiocraft');
    assert.equal(model.status().model, 'facebook/musicgen-melody');
  } finally { model.close(); }
});

test('auto without a token keeps existing local behavior and an explicit cloud selection fails closed', async () => {
  const local = createMusicGenProvider({ provider: 'auto', token: '', endpoint: 'http://127.0.0.1:3002/generate' });
  const cloud = createMusicGenProvider({ provider: 'replicate', token: '', endpoint: 'http://127.0.0.1:3002/generate' });
  try {
    assert.equal(local.status().configured, true);
    assert.equal(cloud.status().provider, 'replicate');
    assert.equal(cloud.status().configured, false);
    await assert.rejects(cloud.generate({}), { code: 'MODEL_NOT_CONFIGURED' });
  } finally { local.close(); cloud.close(); }
});

test('invalid provider selection cannot silently send private audio to another service', async () => {
  const model = createMusicGenProvider({ provider: 'typo', token, endpoint: 'http://127.0.0.1:3002/generate' });
  assert.equal(model.status().configured, false);
  assert.equal(model.status().reason, 'invalid-provider');
  await assert.rejects(model.generate({}), { code: 'MODEL_NOT_CONFIGURED' });
});

test('hosted audio must match the explicitly selected checkpoint and local validation stays strict', () => {
  const audioWav = Buffer.from(encodePcmWav(Float32Array.from({ length: 32000 }, (_, i) => Math.sin(i / 10) * .2), 32000));
  const conditioning = { audioSha256: createHash('sha256').update(audioWav).digest('hex'), inputBytes: audioWav.length, mode: 'audio-melody' };
  const output = { model: 'facebook/musicgen-melody-large', sampleRate: 32000, audioWavBase64: audioWav.toString('base64'), conditioning };
  assert.throws(() => validateGeneratedAudio(output, conditioning, 1));
  const value = validateGeneratedAudio(output, conditioning, 1, 'facebook/musicgen-melody-large');
  assert.equal(value.model, output.model);
  assert.deepEqual(value.audioWav, audioWav);
  assert.throws(() => validateGeneratedAudio({ ...output, model: 'text-only-model' }, conditioning, 1, 'text-only-model'));
});
