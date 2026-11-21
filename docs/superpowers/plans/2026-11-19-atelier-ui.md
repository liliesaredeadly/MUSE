# MUSE Atelier Interface Implementation Plan

**Goal:** Redesign Studio, HUM, producer direction and Projects with the requested brand references while preserving Home and Discover.

**Architecture:** Add explicitly page-scoped stylesheet modules after the existing CSS. Retain component behavior and shared assets. Home/Discover source and rendering are protected from the new selectors.

**Tech stack:** Existing React, CSS and Lucide. No added dependencies or remote fonts.

**Spec:** `docs/superpowers/specs/2026-11-19-atelier-ui-design.md`

## Global constraints

- Home and Discover pages are untouched.
- No global token or existing image changes.
- All capture, playback, editing, proposal and persistence callbacks retain their semantics.
- No fake projects or microphone results; no API-key work.
- Keep work local; no commits or pushes.

## Tasks

- [x] Snapshot protected source, assets and representative rendering.
- [x] Implement common allowed-page theme plus Studio/HUM styling in `src/styles/atelier.css`.
- [x] Implement producer-direction styling in `src/styles/atelier-direction.css`.
- [x] Implement Projects styling in `src/styles/atelier-library.css`.
- [x] Import modules and reconcile `DESIGN.md` with the scoped new direction.
- [x] Review every new selector for protected-page leakage.
- [x] Run automated tests, production build, UI audit and available rendering checks; address failures.

## Review focus

- Shared header/footer and guide must not leak styling into protected pages.
- Disabled/no-note/error/loading states remain readable and truthful.
- Long project titles and producer text wrap at 320px.
- Local audio playback/download controls remain operable on both dark and ivory surfaces.
- Keyboard focus and reduced-motion behavior survive the visual redesign.
