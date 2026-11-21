# Optional AI Producer Implementation Plan

> **For agentic workers:** Use test-first changes and independent review. Tasks are split by file ownership to preserve the existing backend and studio.

**Goal:** Add optional real AI proposals with safe rule fallback and explicit user Apply.

**Architecture:** A server-only adapter implements the existing proposal contract. The HTTP route validates input before invoking it. The existing music engine and persistence paths stay independent.

**Tech Stack:** Node 22 native HTTP/fetch, React, Vite, node:test, developer browser checks.

**Spec:** `docs/superpowers/specs/2026-11-17-producer-ai-design.md`

## Global constraints

- No API key in browser code, storage, responses or version control.
- No automatic Apply, project writes, raw audio uploads or sourceBpm changes.
- Missing or failing AI preserves the deterministic producer.
- No push or publication for this change.

## Review focus

Provider refusal/incomplete JSON; timeout and concurrent requests; stale results after take/settings changes; unsupported settings and render duration; honest configured versus actual response labels.

### Task 1: Server adapter

- [x] Write failing `tests/producer-brain.test.js` checks for success, missing key, privacy, output validation, provider failures, timeouts and concurrency.
- [x] Implement `createProducerBrain(options).status()` and `.propose({text,settings,notes})` in `server/producer-brain.js`; run focused tests.

### Task 2: HTTP integration and local configuration

- [x] Add failing HTTP checks for status, context validation and AI proposal round trip without project mutation.
- [x] Integrate an injectable producer brain into `server/app.js` while preserving existing endpoints.
- [x] Add `.env.example` and native optional environment-file loading to backend launch commands.

### Task 3: Studio behavior and reference

- [x] Add rendered checks for actual AI source, fallback, explicit Apply and stale result protection.
- [x] Extend `api.js` and `Producer.jsx` with mode/status/context and existing visual styling. Inspect the supplied video before adopting visual details.

### Task 4: Documentation and verification

- [x] Update README and demo guide for activation, data sent, fallback and unverified live-provider status.
- [x] Run full Node tests, production build, HTTP smoke and browser integration checks.
- [x] Independently review the final change for regressions; address findings and record evidence.
