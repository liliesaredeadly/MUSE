# MUSE: three-minute demo

**Pitch:** “MUSE turns the melody in your head into an editable musical starting point. Hum a phrase, choose its character, and hear it arranged. Your own notes remain the lead.”

The demo uses a real human microphone take. There is no bundled demo song or seeded project. The producer is rule-based, and the instruments are synthesised; describe those limits directly.

## Before presenting

- Use Node 22.13 or newer. Run `npm install`, then `npm run dev`, and open [http://localhost:5173](http://localhost:5173). For a built demo, run `npm run build`, then `npm start`, and open [http://127.0.0.1:3001](http://127.0.0.1:3001).
- Keep the server terminal open. Confirm **Local server connected** in the sidebar. Check [http://127.0.0.1:3001/api/health](http://127.0.0.1:3001/api/health) if needed.
- Check the selected microphone and speaker volume. Use a quiet room and headphones when practical. Rehearse a simple four-to-six-note phrase, holding each note for about half a second with small gaps.
- Rehearse permission handling with the actual browser. Begin the presentation on **Home**. Existing saved projects are real user data; do not describe them as generated demo examples.
- Leave enough time for a short retake. If recognition yields no usable notes, show that result honestly and retry. Never replace the capture with a synthetic fixture while calling it a microphone result.

## Timed walkthrough — 180 seconds

| Time | Action | What to say |
| --- | --- | --- |
| **0:00–0:20** | On Home, select **CREATE**. | “A musical idea can disappear before you know how to produce it. MUSE starts with a melody you can hum, then gives you control over how it sounds.” |
| **0:20–0:45** | Select **Record your melody**. Allow microphone access. Hum the rehearsed phrase for 5–10 seconds, then select **Finish take**. | “This is live microphone input. The browser estimates one pitch at a time and groups stable pitches into notes. The raw audio stays on this device.” |
| **0:45–1:05** | Show **Your melody** and its captured note count. Briefly play **Original take**, then pause it. Select a note and show its edit controls. | “These notes come from the take we just recorded. Detection is approximate, so I can inspect the notes and correct a pitch. Silence produces no invented melody.” |
| **1:05–1:30** | Keep Piano, Dreamy and Ambient for the first pass. Select **Create arrangement**, wait for the response, then **Play composition** for several seconds. Pause it. | “The local backend preserves the captured melody and creates timed chord and bass events. The browser plays synthesised instruments. The displayed key and chords are approximate suggestions.” |
| **1:30–1:55** | In the producer, enter **“Make it cinematic with strings at 100 BPM, add percussion.”** Submit, show the proposal, select **Apply direction**, then play the regenerated arrangement. | “The producer uses musical rules, with no external AI model connected. It proposes supported settings first. Applying them changes the instrument, dynamics, tempo and backing we actually hear.” |
| **1:55–2:20** | Pause playback. Select a captured note and raise it one semitone. Wait for the arrangement to refresh and play that section briefly. Select **Export WAV**. | “The result stays editable. A pitch edit changes the arrangement, and the WAV is rendered from those musical events. These are synthesised timbres, rather than a studio sample library.” |
| **2:20–2:45** | Rename the project **Live melody**, select **Save project**, and wait for the saved confirmation. Open **My projects**, select that project, then select **Create arrangement** again. | “The backend validates the project and saves it in SQLite. Reopening restores the notes and settings. The original microphone recording is session-only, so it is not in the saved project.” |
| **2:45–3:00** | Finish on the reopened melody or show the architecture diagram in the README. | “The engineering foundation is real capture, testable musical rules, a validated HTTP API and restart-persistent local storage. The next step is improving transcription and musical depth while keeping the user's melody in control.” |

## Recovery during a live demo

**No clear notes:** finish the take, show the empty timeline, and say, “This input was not clear enough to recognise.” Record 3–4 slower notes closer to the microphone. Use the time allocated to the editing/export step for the retake.

**Microphone blocked:** allow microphone access in the browser's site controls, confirm OS permissions, and retry. Recording requires localhost/127.0.0.1 or HTTPS. If the device remains unavailable, show the workflow and state that the live capture could not be completed; do not claim recognition worked.

**Server unavailable:** check the terminal and `/api/health`. The full development command is `npm run dev`; Vite alone cannot arrange or save. Resolve any port conflict before restarting. If a save fails, leave the unsaved idea open and report the error.

**No sound:** press Play after a user gesture, check the tab/system output volume and the output device, and stop original-take playback before playing the composition. The app also stops composition playback when a new capture starts.

**Unknown creative request:** show the supported examples. Use the exact cinematic/strings/100 BPM/percussion request above. Do not imply the producer can understand arbitrary scenes, train a model or generate a finished song from prose.

## Technical questions judges may ask

**What runs on the backend?** Node's built-in HTTP server validates JSON, stores projects through SQLite prepared statements, and invokes the arrangement and producer modules. It binds to `127.0.0.1:3001`. Production builds are served by the same process.

**Where does the audio go?** The original microphone take stays in the browser for the session. Notes, settings and project metadata are sent to the local server and saved in `data/muse.sqlite`. Exported WAV audio is synthesised in the browser.

**Is the producer AI?** No model is connected. The interface explicitly labels it **RULE-BASED**. Supported requests map to real settings, and the user reviews and applies the proposal.

**What is actually tested?** As of **2026-11-17**, the automated suite has **67 passing tests** plus **10 passing browser integration checks**. It covers signal fixtures, capture lifecycle, musical arrangements, synthesis/encoding helpers, producer rules, storage recovery and real HTTP/SQLite restart persistence. Real browser checks render non-silent WAV audio, distinguish instruments/tempo, capture synthetic C–E–G through the actual recorder and exercise permission/save/transport races. Actual rendered controls additionally cover note edits, producer Apply, playback, save/reopen and navigation. Those tests do not establish physical microphone accuracy or subjective audio quality.

**What remains limited?** Recognition is monophonic and sensitive to input quality. Key and harmony suggestions are simple estimates. Instruments are synthesised approximations. There are no accounts, cloud sync, advanced ML or production deployment features.

## Verification note for submission

**Documentation status, 2026-11-17:** automated and browser audio checks passed; desktop/mobile controls and production HTTP smoke checks passed. Human microphone capture and subjective listening remain unverified and are explicitly documented. Synthetic test signals are confined to a developer QA page and are not product/demo melodies. Rehearse with a real hum in Chrome or Edge before presenting.
