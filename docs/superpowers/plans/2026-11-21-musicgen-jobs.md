# MusicGen Melody Implementation Plan

> **For agentic workers:** Use subagent-driven development for the independent backend, producer compiler and UI work; root implements Python inference and verifies integration.

**Goal:** Connect original humming and written production instructions to genuine local MusicGen Melody previews through reliable asynchronous jobs.

**Architecture:** Preserve the current app and original-lead pipeline. Add bounded Node jobs, a cancellable threaded Python service, a deterministic production compiler, and an isolated neural preview panel.

**Tech Stack:** Node HTTP, React, Python/PyTorch, official Transformers MusicGen Melody and optional AudioCraft.

**Spec:** `docs/superpowers/specs/2026-11-21-musicgen-jobs-design.md`

## Global constraints

- No paid API, external recording upload, fake output, guaranteed exact melody or professional mastering claim.
- Preserve existing dirty workspace edits and the original recording.
- Progress comes from backend transitions/token counts only; CPU deadline is finite.

## Review focus

- Ambiguous submission: same request ID must recover the accepted job without duplicate inference.
- Cancellation: the compute slot remains occupied until inference actually exits.
- Changed original/project: late responses cannot attach to another melody.
- Invalid/silent/short output: fail instead of showing success.
- Low-memory CPU: report actual readiness, errors and elapsed time without fallback audio.

### Task 1: Local inference service (root)

- [x] Add failing unit tests for threaded jobs, receipts, idempotency, cancellation and queue bounds.
- [x] Implement service jobs and official Transformers text-plus-audio conditioning with sample-rate conversion.
- [x] Install isolated free dependencies and checkpoint; measure genuine inference under the laptop's resource limits.
- [x] Run Python tests, including original tensor handoff and invalid/silent audio handling.

### Task 2: Backend jobs (backend agent)

- [x] Test and implement `server/generation-jobs.js`, adapter health/progress/cancel, source snapshot and routes.
- [x] Enforce bounded jobs, exact input receipts, validated output duration and no duplicate requests.
- [x] Run targeted Node contract tests.

### Task 3: Producer intelligence (producer agent)

- [x] Test and implement `compileProductionPrompt({text,settings,notes,analysis})` in `src/producer/production-prompt.js`.
- [x] Cover five production directions, exclusions, section roles, artist-reference handling and bounded output.
- [x] Document sources and the distinction between documented techniques and Muse heuristics.

### Task 4: Loading and playback (UI agent)

- [x] Test and implement `useMusicGenJob` and `MusicGenJobPanel` in the current Studio.
- [x] Add honest stage/progress, cancel/retry, original comparison, playback and WAV download.
- [x] Verify stale responses and failure recovery with tests; verify desktop native playback/download and inspect native-control semantics and reduced-motion CSS.

Native mobile visual QA was not performed and is not claimed by this desktop verification.

### Task 5: Integration and report (root)

- [x] Run full Node/Python tests and production build after integration.
- [x] Exercise native browser workflow and service status/cancellation.
- [x] Attempt five real conditioned generations; record times, hashes, validity and melody comparisons separately from mocked tests.
- [x] Review final changes and document operational status, remaining errors, licensing and reproducible local launch.

Final evidence: `docs/MUSICGEN_VERIFICATION.md` and `docs/verification/musicgen-test-summary.json`. The rejected initial conditioning trial and original client timeouts remain in their historical reports. Five cached model outputs were recovered and validated without another inference submission.
