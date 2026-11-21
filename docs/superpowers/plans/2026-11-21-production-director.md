# AI Production Director Implementation Plan

> **For agentic workers:** Use the current session with independent scoped agents. Preserve the existing checkout and all previous changes; do not commit or push.

**Goal:** Turn instructions into an editable, audible layered arrangement around the source-bound melody.

**Architecture:** Validated blueprint -> deterministic independent backing layers -> shared native Web Audio/MIDI rendering. Extraction and protected lead paths remain separate.

**Tech stack:** Existing React, Node HTTP/SQLite, Web Audio and Node test runner; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-21-production-director-design.md`.

## Global constraints

- Original audio remains the default lead; preserve its source hash, complete duration and playback rate 1.
- Blueprint cannot edit source notes, timing, contours or leadSource.
- Weak pitch evidence blocks pitched backing; show why.
- Source audio remains local and session-only. Never commit private takes or exports.
- Preserve legacy projects with no blueprint. Optional model preview cannot replace strict output.

## Review focus

- Refining one instrument must not replace the lead or alter other layer events.
- Negations and reductions must not accidentally select a new lead or re-enable removed layers.
- Malformed/stale AI output must not overwrite an edited draft or new source.
- Reloaded projects retain the plan but require their original recording before voice rendering.
- MIDI must retain estimated source note timing and use non-colliding instrument channels.

## Task 1: Blueprint and planning

- [x] Add failing schema/parser tests for the supplied examples, exclusions, refinements, bounds and no lead edits.
- [x] Implement `validateBlueprint`, catalog/default factories and natural-language local refinement in `src/producer/production-blueprint.js`.
- [x] Add `server/production-director.js` with optional strict structured-output AI proposal and explicit local fallback.
- [x] Verify planning tests before integrating HTTP.

## Task 2: Arrangement and synthesis

- [x] Add failing independent layer, blocked harmony, source preservation and MIDI tests.
- [x] Implement blueprint layer event generation; retain legacy arrangement behavior when absent.
- [x] Implement distinct synthesized guitar/violin/cello, per-layer gains and collision-free MIDI mapping plus estimated melody export.
- [x] Verify affected Node tests, then native-rendered instrument/gain/lead comparisons.

## Task 3: Integration and studio

- [x] Validate and persist `settings.blueprint` in client/server settings owners; add Director HTTP/API path.
- [x] Add a draft/apply/refine Production Director to the current studio using existing controls and style tokens.
- [x] Add labelled detected-melody MIDI export and layer event visibility without changing the audible lead.
- [x] Verify stale/error/draft handling, editing, acceptance, saving, mobile flow and original source behavior.

## Task 4: Verification and handoff

- [x] Run full Node suite, production build, smoke and native browser checks on multiple unfamiliar melody fixtures.
- [x] Independently review the integrated patch and correct actionable findings.
- [x] Document actual evidence and remaining transcription/neural-inference limits; leave Muse runnable for user testing.
