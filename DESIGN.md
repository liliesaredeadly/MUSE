# MUSE design context

## Overview

MUSE is an approachable music studio for people with a melody in mind and no production training. Capture their own melody, develop it, and hear an editable result. English interface, local Node/SQLite backend, no MUSE accounts.

The user's supplied three-minute reference video remains the visual authority for Home and Discover. On 2026-11-19 the user requested Saint Laurent / PUMA website inspiration for the other screens and explicitly excluded any changes to the homepage and Discover domains page. Studio, HUM, producer direction and Projects now use a scoped black-and-ivory atelier treatment: condensed display type, campaign-scale headings, square controls and restrained surfaces. This is an interpretation of those references, not copied brand assets. Keep all work local: no commits or GitHub pushes.

## Colors

The protected Home/Discover palette lives in `src/styles.css :root` and remains unchanged. The four atelier pages override standard aliases inside their own page roots in `src/styles/atelier.css`; no global token changes are permitted for that treatment. The original values below continue to govern the protected pages.

| Token | Value | Role |
| --- | --- | --- |
| --bg | #24212B | composition and library canvas; cream-screen ink |
| --surface | #2C2732 | dark surfaces |
| --surface-raised | #36303C | dark fields and controls |
| --accent | #F37955 | record, play and primary accents |
| --text | #F7F1E7 | dark-screen text and cream canvas |
| --paper | var(--text) | light surface alias |
| --paper-raised | #EEE6D9 | cream input areas |
| --paper-border | #C9BFB2 | light field/section boundaries |
| --paper-muted | #6B625F | secondary light-screen text |
| --blush | #F3B9A8 | warm details |
| --lavender | #B3A0CF | producer card and melody layers |
| --sand | #E9DBA9 | percussion, record covers and small accents |
| --muted | #C1B4BC | secondary dark-screen text |
| --border | #4B414F | dark controls and dividers |

Atelier tokens are `--atelier-ink: #0B0B0C`, `--atelier-paper: #F3F2ED`, `--atelier-surface: #202021`, `--atelier-muted: #A6A6A0` and `--atelier-line: #3B3B3C`. Orange `#D9684B` is reserved for recording/live state. Standard `--bg`, `--text`, field and border aliases resolve to this palette only under `.reference-page-studio`, `.reference-page-hum`, `.reference-page-direction` or `.reference-page-library`.

Use text and icons with color to express source, status, selected sound and disabled controls. Light pages set `color-scheme: light`; the default is dark. Preserve visible scrollbar and keyboard focus contrast in both.

## Typography

Home and Discover retain Segoe UI Variable / Segoe UI / sans-serif with Georgia italic display accents. Atelier pages use Bahnschrift / Arial Narrow / Arial for condensed uppercase display headings and Arial / Helvetica Neue for body text. Numbers/timing retain Consolas. All fonts are system fallbacks; no external font dependency.

Home display remains as supplied in the video reference. Atelier display headings use tight line spacing and strong weight, while input, result explanations and controls remain readable and wrap naturally. Do not truncate a direction or hide a primary action to match a screenshot.

Studio controls use a consistent 40px desktop height with 12px functional labels; touch controls grow to 44px. Mobile navigation keeps readable 10px labels, and action rows wrap instead of shrinking text. Reserve the document scrollbar gutter so navigation does not shift between short and long pages.

## Layout

The shared shell is full width with a top navigation bar: MUSE/Home, Discover, Studio, Projects and an outlined microphone action. No permanent sidebar. Brand screens use wide margins and hairline rules. Product screens preserve document scrolling and all working controls.

- Home: full-bleed golden-hour stage photograph, left editorial statement, restrained description, three bottom actions HUM / DISCOVER / CREATE.
- HUM: grayscale treatment of the existing photograph, large uppercase statement and ivory recording console. The shared image file is untouched. Capture uses the existing recorder. Real captured data leads to Shape this melody; no fake analysis progress.
- Direction: ivory two-column layout, creative instruction and genuine melody preview left, black proposal panel right. An original recording is decoded locally for its waveform; reopened projects use the actual detected note contour. Narrow screens stack the card below the prompt.
- Composition: deep-black full-width workbench, condensed white heading, actual captured melody and generated track lanes, charcoal controls, transport, Save and Export. The supplementary producer remains available.
- Projects: ivory gallery with fixed-ratio monochrome record sleeves based on actual project metadata and notes. Empty means empty; never seed example projects in the product.
- Discover: cream editorial exploration cards apply only existing supported presets. Genre-like names outside the engine's actual enum are clearly described as exploration presets.

`reference-shell.css`, `reference-studio.css` and `reference-direction.css` retain the existing foundation. `atelier.css`, `atelier-direction.css` and `atelier-library.css` load afterward and exclusively own the four allowed page variants. Every new selector must require one of those allowed page roots; Home/Discover source, styles and shared image assets stay unchanged. The atelier header is sticky and square; the protected pages keep their original header. `src/main.jsx` owns the final import order.

## Elevation & Depth

Use flat surfaces, hairline boundaries and minimal shadows. Photography and monochrome record grooves supply depth. The atelier's ivory input and black direction panel use square corners. Do not add glass panels, ornamental floating controls or fake meters.

## Shapes

Home/Discover preserve the video's existing shapes and accents. Atelier pages use square navigation/actions and monochrome primary controls; the circular microphone control and recording orange retain their functional meaning. Small controls preserve the canonical focus, disabled and hover behavior.

## Components

The 2026-11-21 actual-hum repair uses the existing native lead select with an explicit **Original hum** option and the existing Audio input panel for a native audio-file input. New/imported takes select the recording; producer settings preserve it, while choosing an instrument or editing notes explicitly selects approximate reconstruction. Transcription reliability is persistent inline status, separate from transient errors. Invalid imports retain the prior take. Original audio is session-only and missing saved-project source audio requires reattachment. No visual tokens or Home/Discover composition change for this behavior.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Select/Listbox | Studio CreativeControls native select | DESIGN.md | native | Keyboard/popup and browser checks |
| Form | Producer form and api.js | DESIGN.md | panel, direction; noValidate | Browser producer/API tests |
| Scrollbar | styles.css global baseline | DESIGN.md token table | geometry only | Desktop/narrow inspection |
| Toast | App shared polite status | DESIGN.md | success, info | Save/Apply checks |
| CRUD | useStudio and server/app.js | DESIGN.md | create, read, update | Real HTTP/SQLite and UI checks |

Navigation uses actual buttons and `aria-current`; guide uses native dialog with focus restoration and Escape. Musical editing retains accessible pitch controls. Saved notes/settings use SQLite; original audio remains session-only. New track and open project preserve unsaved work through the existing hook's save behavior.

Dirty projects save before switching even when their final note was removed. Reopening the current project preserves its latest saved edits. The successful save response updates the archive directly, so saving does not depend on a second library request. Drums includes rhythm: its percussion checkbox stays checked and disabled, with an explanation to choose another lead to turn it off; switching lead restores the independent percussion preference.

Capture identifies the actual microphone after permission and shows measured input level while recording. A take with no stable notes retains a persistent explanation and original playback/download; do not equate captured sound with a recognised melody. Original downloads stay local and session-only. Pitch analysis reduces broadband noise without relaxing the periodicity confidence requirement. Grouping tolerates brief missed evidence and small tuning wobble, but unobserved gaps of 120ms or more cannot become held notes. Note edit buttons stop at MIDI 0/127, expose selection, and return keyboard focus to the next/previous note or empty melody area after deletion.

The optional AI producer remains server configured. Source labels distinguish configured AI, actual AI output, rules fallback and unknown status. A cached rules status never promises that the server cannot subsequently enable AI. Every result is reviewed before Apply/Create. Settings or notes changing invalidate pending and completed proposals. Only the instruction, supported settings and bounded detected-note context can go to OpenAI; raw recording stays local.

The AI Production Director owns the first-take direction page and the studio's production panel. Its instruction field generates an editable blueprint; instruction edits require another planning pass before Apply. Direct instrument, role, level, section and variation edits remain drafts until explicit acceptance. Stable catalog layer IDs drive actual arrangement events and independent backing gain paths. The protected original lead is outside this editable catalog. Display blocked pitched layers when transcription cannot support harmony. MIDI exports are explicitly detected-note estimates and do not switch the audible lead or claim to contain the recorded voice. Accepted blueprints save with project settings. Layer controls use native labelled inputs and selects, percentage readouts, keyboard focus restoration after removal and scoped responsive styles.

## Do's and Don'ts

The Studio's `MusicGenJobPanel` and `useMusicGenJob` own a separate session-only neural preview. The verified original recording remains the conditioning source and protected lead. Loading follows actual server stages, with model-token progress only when supplied and an indeterminate indicator otherwise. CPU timing and first-use model loading remain explicit. The preview player compares original/generated audio, cancels competing playback, and exports genuine WAV. Failures retain the original, instructions and previous successful preview. The final preparation stage discloses basic volume normalization only; melody fidelity is unverified. The panel uses scoped atelier tokens and reduced-motion rules.

Provider selection belongs to the server. Replicate previews identify MusicGen Melody Large, disclose that the recording and instructions leave the device and that usage is billed, and use the action label `Generate paid preview`. Local previews keep their CPU and model-loading guidance. Neither provider supplies invented progress percentages or exact-melody claims. No credential is accepted by a browser control.

- Reuse the existing capture, arranging, playback, export and saving callbacks. Keep one studio hook instance across pages.
- Do not modify Home/Discover markup, their existing stylesheets or shared image assets during the atelier treatment. Validate isolation through scoped-selector checks and protected-page screenshot comparison.
- Draw waveforms from actual audio and notes/tracks from actual musical events. Show only measured or indeterminate progress.
- Treat the generated `public/assets/festival-stage.jpg` as atmospheric photography, never as detected audio. It reconstructs the user's video scene without embedded UI.
- Preserve loading, empty, unavailable, fallback, cancellation and stale-result states on desktop and mobile.
- Respect reduced motion. Motion should clarify page entry, hover and real transport movement, not fabricate activity.
- Do not invent saved projects, analysis steps, confidence metrics, keys, tracks, progress percentages or microphone results to imitate the video's demonstration content.
- Do not change backend, audio or persistence semantics for this redesign. Keep truthful live-AI and human-microphone verification limits in documentation.
