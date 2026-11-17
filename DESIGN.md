# MUSE design context

## Product and audience
An approachable music studio for people with a melody in mind and no production training. Capture their own melody, develop it, and hear an editable result. English, browser-local hackathon prototype.

## Direction
Desert sessions: an independent record label meets a sunset festival and a music laboratory. Editorial cream typography, original desert artwork, sunset-orange actions and blush/lavender musical accents sit on deep warm charcoal. The homepage invites HUM / DISCOVER / CREATE; the studio keeps a compact recording console and large timeline between navigation/instruments and the producer. No artwork represents detected audio.

## Tokens and ownership
Canonical values live in src/styles.css :root; all components consume these variables.
| Token | Value | Role |
| --- | --- | --- |
| --bg | #24202B | canvas |
| --surface | #2C2732 | panels |
| --surface-raised | #36303C | inputs and raised controls |
| --accent | #F47B55 | primary actions |
| --blush | #F3B9A8 | warmth and secondary accents |
| --lavender | #B5A0D5 | melodic layers |
| --sand | #E7D9A8 | percussion and labels |
| --text | #F8F0E5 | primary copy |
| --muted | #C1B4BC | secondary copy |
| --border | #4B414F | panel boundaries |
Typography: Segoe UI Variable / Segoe UI for bold editorial MUSE and clean interface text; Georgia for restrained expressive headings; Consolas for timers, pitches and tempo. Body 13px, controls 12–13px, section headings 14px, metadata at least 10px. No external font dependency.

## Layout
Desktop: 208px navigation/instruments, flexible central workspace and a 300px producer/analysis panel. A compact input console sits above a 250px note grid; sound controls and transport remain grouped below. The separate Hum view reuses the same recording component and hook; Discover applies supported setting presets and never advertises recorded sound libraries. Below 1100px the producer flows beneath the workspace; below 700px navigation becomes a compact top bar and controls stack. Document owns scrolling. All saved projects remain accessible on narrow screens.

## Canonical UI map
| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Select/Listbox | Studio CreativeControls native select | DESIGN.md | native | Browser keyboard and popup checks |
| Form | Producer form and api.js | DESIGN.md | noValidate with explicit submit rules | Browser producer and API tests |
| Scrollbar | src/styles.css global baseline | DESIGN.md CSS token table | thin with visible track | Browser desktop and narrow checks |
| Toast | App shared polite status region | DESIGN.md | success, info | Browser save and producer checks |
| CRUD | useStudio and server/app.js | DESIGN.md | create, read, update only | tests/server.test.js |

- Navigation: App shell buttons with aria-current, one page state.
- Action buttons: button class variants; same focus and disabled behavior.
- Single select: native select, visible label; native keyboard and popup behavior.
- Status feedback: persistent inline errors and shared polite status toast.
- Permission: native microphone prompt triggered only by Record.
- Dialog: native HTML dialog for guide, modal focus and Escape.
- Musical editing: note editor with labeled semitone actions and remove; regenerated sound reflects edits.
- Persistence: explicit Save project stores notes/settings in the local Node/SQLite backend; original audio exists only for the current session. New track keeps saved projects; no project deletion action in MVP.

## Interaction contract
Record -> requesting -> recording -> paused or stopped. Permission and device errors return to idle with recovery guidance. Record maximum 60 seconds, stop releases microphone. Capture and synthesis are mutually exclusive. Generation requires recognised notes. Apply producer changes regenerates current arrangement. Saving reports failure if the local server or database is unavailable. No fake projects, statistics or recognition data.

## Accessibility and motion
Native controls, visible focus, text plus icons for state, polite announcements, 44px primary controls, legible contrast and global scrollbar tokens. Audio starts only after an explicit user gesture. Motion uses 160–240ms easing for hover, focus and panel entry; transport follows the real audio position. Reduced motion disables decorative entry and pulse effects. No fabricated level meters, tracks or playback data.

## 2026-11-17 visual refinement scope
User requested a more professional studio and cleaner layout. Only presentation components, styles, this design context and verification screenshots change. Keep server, persistence, audio analysis/synthesis, producer rules, API client and useStudio state coordination intact. GitHub publication is explicitly on hold.
