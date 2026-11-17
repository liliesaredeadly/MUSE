# Verification record — 2026-11-17

Environment: Windows, Node 22.14.0, React 19, Vite 6.2.3, built-in SQLite. API tests use real temporary SQLite databases and ephemeral HTTP servers. Browser audio checks use the in-app Chromium browser.

| Check | Observed result |
| --- | --- |
| `npm test` | 67 passed, 0 failed; full log in automated-tests.txt |
| `npm run build` | Pass; JS 263.37 kB and CSS 45.44 kB before gzip |
| `npm run smoke` | Pass: built HTML/assets, SQLite health, SPA path, source containment and project API |
| Strict UI static audit | 0 findings; ui-redesign-audit.json |
| Browser audio and rendered UI integration | 10 passed, 0 failed; browser-results.json |
| Actual PCM rendering | Non-silent WAV, RMS 0.02288, peak 0.17981 |
| Instrument/tempo audio | 199,550 differing Piano/Strings samples; doubled BPM shortens phrase |
| Actual recorder signal chain | Synthetic C4/E4/G4 detected, original encoded audio 38,005 bytes, tracks released |
| Desktop / phone | 1440×1000 and 390×844; mobile document width 380, viewport 390, no horizontal overflow |
| Producer UI / backend | Actual request, proposal, apply, selected Cinematic state confirmed |
| Keyboard / controls | Native instrument select, keyboard BPM adjustment, dialog Escape and restored focus |
| Permission wait | In-app hardware request remains pending; Cancel restores ready state |
| Rendered studio workflow | Real components edited a note, selected Strings/120 BPM, applied Cinematic, played/paused/resumed/stopped, saved and reopened |
| New navigation and presets | HUM, DISCOVER and CREATE work; Ambient preset updates supported controls without creating recognised notes |
| Core preservation | Git comparison shows no changes in server, audio, hooks, API/persistence, producer or arrangement modules |
| Visual redesign | Home, discovery, Hum and three-panel studio inspected at 1440×1000; all four views checked at 390px without document overflow |
| Production artwork | Original desert illustration serves with HTTP 200 as image/png, 2,103,830 bytes |
| Browser console | No error or warning entries observed in the final preview |

No real projects were seeded. Synthetic fixtures exist only in tests. Physical-microphone humming, subjective listening quality and the system WAV download dialog remain unverified. User requested completion with that limitation documented.

Regression fixes verified: permission denial preserves prior notes; cancelled late permissions cannot affect a new take; newer edits survive an older save response; stopped pending audio cannot change the UI to playing.
