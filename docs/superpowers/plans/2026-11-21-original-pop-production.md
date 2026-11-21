# Original melody production implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement each task and verify it.

**Goal:** Improve original melody arrangements using two generic pop production approaches while preserving unfamiliar user melodies.

**Architecture:** Keep the source-bound strict lead and add fresh-input character analysis, original backing generation and profile-aware synthesis. Extend the existing optional settings schema; reference names select sound traits only.

**Tech stack:** Existing JavaScript/Node, React controls, Web Audio, Python model contract tests; no new dependencies.

**Spec:** ../specs/2026-11-21-original-pop-production-design.md

## Constraints and review focus

- Strict pitch, timing and contour preservation; no reference tune or sample data.
- Empty/noisy audio must not invent a lead. Sparse/rubato tempo evidence must remain qualified.
- Explicit instruments and negative bass/drums override profile defaults.
- Old projects normalize to production:auto and remain editable.
- Dense/high/low melodies, leading rests and long arrangements must stay bounded and renderable.

## Tasks

- [x] Fresh-input descriptors: `describeMelody(notes)` and independent unfamiliar waveform tests implemented.
- [x] Controls: production enum and reference-title/generic aliases validated through producer, server and persistence; exclusions take priority.
- [x] Backing: input-derived voicing/register/density, phrase-aware dynamics and distinct generic grooves, with exact source-event checks.
- [x] Synthesis: original percussion/pluck/pad articulation, bounded stereo, dry low end and backing-only kick ducking; lead remains protected.
- [x] Verify: 310 Node, 8 Python and 42 browser checks, production build and smoke passed. Native render rounding, listening and neural limits recorded in verification/original-pop-production-results.json.

Implementation uses independent file ownership in the existing authorized checkout. Root handles integration and fresh full-suite/browser verification; no commit or publication is requested.
