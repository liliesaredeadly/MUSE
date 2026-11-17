# Visual redesign verification — 2026-11-17

The redesign was made in the existing React/Vite application after inspecting the component tree, project coordinator, HTTP client, musical modules, API routes, database and tests. It changes presentation and adds views that call existing studio operations. No new application dependency was added.

## Preserved implementation

Compared against the committed pre-redesign MVP snapshot, no changes exist in:

- `server/`: HTTP validation, API routes, SQLite persistence and static serving.
- `src/audio/`: microphone recording, YIN detection, synthesis, transport and export.
- `src/hooks/useStudio.js`: project state, capture lifecycle and API orchestration.
- `src/lib/`: API client, project defaults and persistence helpers.
- `src/music/` and `src/producer/`: arrangement engine and producer rules.

The new Hum view reuses the same capture component and hook as Studio. Discover cards apply supported settings; they do not create detected notes or stand in for recorded music. Upload is clearly marked as a future capability.

## Observed results

- `npm test`: **67 passed**, zero failures.
- `npm run build`: passed.
- `npm run smoke`: passed against the running production server; new artwork also returns HTTP 200.
- Browser runner: **10 passed**, including actual rendered Studio controls for note editing, instrument/BPM changes, explicit producer Apply, real playback transport, save/reopen, capture-state guards and all three homepage actions.
- Real OfflineAudioContext rendered nonzero PCM; the actual recorder recognised an isolated synthetic C–E–G input. Fixtures are confined to the developer test page.
- Desktop: 1440×1000. Mobile: 390×844. Home, discovery, Hum and Studio fit the document width; mobile navigation has its own visible horizontal scrollbar.
- Manual UI: actual backend producer request/apply, supported preset selection, native instrument select, keyboard BPM adjustment and guide Escape dismissal.
- Navigation resets document scroll to the top. The transport stays in normal layout flow and does not cover timeline controls.
- Static UI audit: zero findings. Final browser console: no observed warnings or errors.

Updated screenshots are `dashboard.jpg`, `studio.jpg`, `discovery.jpg`, `hum.jpg` and `mobile-studio.jpg` in this directory. The exact browser results are in `browser-results.json`.

Physical-microphone humming, subjective listening quality and the system download dialog retain the previously documented verification limits. GitHub publication was held during the visual redesign and verification; publication is a separate step.
