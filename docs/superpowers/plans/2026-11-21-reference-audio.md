# Local Reference Audio Implementation Plan

> **For agentic workers:** Use focused parallel implementation with independent file ownership and a final combined review. Verify changes in the existing checkout; preserve its prior edits.

**Goal:** Use the downloaded Alone recording as a genuine local comparison reference without claiming a verified melody transcription.

**Architecture:** A Python preparation script converts mono PCM audio into normalized chroma frames stored in `.local/`. A pure JavaScript matcher and private server loader expose metadata and bounded candidate searches. A small shared capture panel requests comparisons and presents source timestamps.

**Tech Stack:** Existing Node/React/Web Audio, Python/NumPy for offline preparation; no added production dependency.

**Spec:** `docs/superpowers/specs/2026-11-21-reference-audio-design.md`

## Global constraints

- No raw reference audio or full note transcription in tracked/public files.
- Candidates are suggestions; preserve captured notes and require separate verification for exact notes.
- Missing references, stale queries, silence and unrelated input must be handled explicitly.
- Reuse the existing checkout and preserve prior user changes; no commit or publishing required.

## Tasks

- [x] Preparation: write and run generated-tone/silence tests; implement `scripts/analyze-reference.py`; generate and validate the local reference features and provenance.
- [x] Matching/API: tests for tempo/transposition, varied evidence, negatives, missing/corrupt references and HTTP bounds; implement `reference-match.js`, `reference-library.js`, routes and client methods.
- [x] UI: add status/compare/retry/candidate panel with invalidation and stale response protection; exercise keyboard and narrow layout.
- [x] Integration: run Python checks, complete Node suite, build and browser checks. Review the changed paths and document limits for the presentation.

## Review focus

- An unavailable library cannot prevent capture or composition.
- One reference cannot label every hum as Alone.
- A late result cannot be applied to a new take or project.
- Local filesystem paths and reference audio are not exposed through API metadata.
- Automated/synthetic checks do not establish recognition accuracy for a real physical-microphone hum.

## Verification

Final checks: 187 Node tests, 3 Python preparation checks, 5 reference workflow browser checks and 27 existing browser/audio checks passed. Production build passed; strict UI audit has zero findings. The real source is available in the live HUM panel, and its 390px layout has no horizontal overflow. Twenty-four independently generated minor-scale negative queries against the actual reference returned no candidates.

Review fixes: reject static and pulsing four-tone chords using a tonal-active pitch baseline; cap queries at 30 seconds and 20 million estimated spectral lookups. Recorder analysis now follows 40ms deadlines instead of rounding to 50ms on 60Hz displays; generated 120ms notes survive while blips and stalls remain rejected. Physical microphone transcription and song-match accuracy remain unverified.
