# Hosted MusicGen previews with Replicate

Muse keeps its existing original-recording analysis, production director, asynchronous jobs, comparison player and WAV downloads. The optional Replicate adapter sends the verified PCM recording and the compiled music direction to the pinned `meta/musicgen` deployment, with `model_version: melody-large`, `continuation: false` and `output_format: wav`.

The hosted checkpoint is **facebook/musicgen-melody-large**. It differs from the local **facebook/musicgen-melody** checkpoint; public status and job metadata identify the selected checkpoint. Neither provides guaranteed exact melody preservation.

## Private setup

Create a token in [Replicate's token dashboard](https://replicate.com/account/api-tokens). Add it to the project's local `.env`, keeping all existing settings:

```dotenv
REPLICATE_API_TOKEN=replace_with_your_private_token
MUSE_MELODY_PROVIDER=auto
```

The `.env` file is Git-ignored. Never put the real token in `.env.example`, a `VITE_` variable, the browser, a screenshot, or a chat. The Node backend reads the credential; public status contains only configuration/authentication state, never its value. A local `.env` is private configuration rather than encrypted storage; people with access to the machine can still read it.

Restart the backend after editing `.env`. `npm run dev` starts the normal app; a configured token selects Replicate in `auto` mode. Set `MUSE_MELODY_PROVIDER=local` to explicitly retain local inference, or `replicate` to require the hosted provider and show a setup error when the token is missing. The existing `npm run dev:musicgen` additionally starts the local CPU service; provider selection still follows the same server configuration.

Checking the model connection performs only the non-generating `GET /v1/account` authentication request. It does not create a prediction or establish that billing credit or inference capacity is available. The panel shows the cloud provider, audio-upload disclosure and **Generate paid preview** action. A generation sends the original audio to Replicate and can incur charges; no generation starts from a status check.

## Reliability and verification limits

- The existing Node job IDs deduplicate repeated client submissions. The adapter also reuses a bounded session request cache. Prediction creation is never automatically retried after an ambiguous response; check Replicate's dashboard before deliberately starting another request in that situation.
- Read-only prediction polling has bounded retries. Finite request deadlines, a provider `Cancel-After` header and best-effort cancellation bound provider work. Cancellation can still incur charges for work already performed.
- Only the fixed HTTPS Replicate API receives the credential. Prediction output downloads are limited to HTTPS `replicate.delivery` hosts, have no credential header, reject redirects and enforce a byte limit.
- The backend validates PCM16 WAV structure, duration and non-silence before exposing a completed preview. Failed generations do not become demo or synthetic substitutes.
- The source fingerprint proves which recording the adapter submitted. Replicate does not expose the local Python runtime hooks used for chroma/text-conditioning verification; adapter provenance is not a provider-attested fidelity measurement.
- Tests simulate provider responses at the network boundary. No paid hosted inference was performed during implementation. Existing local CPU inference measurements are not hosted latency or quality measurements.

Official references: [pinned model schema](https://replicate.com/meta/musicgen/versions/671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb/api), [tokens](https://replicate.com/docs/topics/security/api-tokens), [input files](https://replicate.com/docs/topics/predictions/input-files), [billing](https://replicate.com/docs/topics/billing), [MusicGen model and licence](https://huggingface.co/facebook/musicgen-melody-large).
