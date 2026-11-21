# MusicGen Melody jobs

Extend the existing local Muse application. Original recording bytes remain the reference; the strict original-lead arrangement remains available. A separate MusicGen preview uses the actual recording and a compiled production direction, never a substitute track.

## Boundaries

- `server/generation-jobs.js` owns bounded asynchronous jobs, source snapshots, idempotency, cancellation, deadlines and result retention.
- `server/melody-model.js` bridges only an explicit literal-loopback endpoint, validates returned model/audio/source receipts, and polls the Python service with real token progress.
- `scripts/musicgen_melody_service.py` runs one inference worker behind a threaded HTTP server. AudioCraft remains supported; the official Transformers implementation of the identical `facebook/musicgen-melody` checkpoint provides the Windows CPU path. Dependencies and downloaded weights stay in ignored `.local` storage.
- `src/producer/production-prompt.js` translates musical instructions into descriptive conditioning with documented technique references and explicit rule-based provenance.
- `useMusicGenJob` and `MusicGenJobPanel` integrate into the existing Studio with retained original audio and stale-result protection.

## Contract

Node: POST `/api/generation/jobs` takes `{conditioningId,text,duration,requestId,settings?}`. GET and DELETE `/api/generation/jobs/:id` return `{job}`. GET `/api/generation/jobs/:id/audio` returns validated WAV only after success. Repeating an identical request ID returns its original job; conflicting reuse fails. Status is queued, running, cancelling, cancelled, succeeded or failed. Stages are listening, understanding, exploring, arranging, generating, preparing and ready. Progress is absent unless the model reports completed/total tokens.

Python: GET `/health` advertises jobs/progress/cancel. POST `/jobs` takes actual base64 WAV, prompt, duration and requestId; its ID equals requestId. GET/DELETE `/jobs/:id` reports work/cancellation. Successful result includes actual WAV, model identity, sample rate and SHA256/byte-count receipt for the conditioning WAV.

## User-visible truth

Seven loading labels follow the requested wording; preparation explicitly says basic volume normalization, not professional mastering. No invented percentages or artificial waits. CPU inference may take minutes; 20–40 seconds is a target only. Failure/cancellation retains the recording, prompt and previous usable preview. The model provides chroma conditioning, so exact melody fidelity remains unverified.

## Resource and deployment limits

One inference at a time, bounded queues/results, finite CPU deadlines, cooperative token cancellation, no indefinite retries. No paid service or audio upload to an outside provider. Model weights are CC BY-NC 4.0; this installation is a local noncommercial demo, not authorization for commercial deployment.

## Verification

Contract tests cover real byte/tensor handoff separately from genuine model inference. Real testing attempts five distinct original melody fixtures and prompts: emotional acoustic, energetic pop, cinematic orchestra, electronic dance and soft piano. Record actual elapsed time, input/output hashes, playable PCM, instruction variation and chroma comparison; failures and resource limitations remain visible in the final report.
