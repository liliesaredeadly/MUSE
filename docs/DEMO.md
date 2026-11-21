# MUSE: three-minute demo

**Pitch:** “MUSE turns the melody in your head into an editable musical starting point. Hum a phrase, choose its character, and hear it arranged. Your own notes remain the lead.”

The protected-original demo uses a real human microphone take. There is no bundled demo song or seeded project. Its producer uses local rules by default, with an optional OpenAI mode; the backing instruments remain synthesised in both proposal modes. A separate local MusicGen panel generates a neural interpretation. Describe which output and mode you are demonstrating.

## Protected-original demonstration

Use **Original hum** as the lead for the actual-voice demo. New takes select it automatically. You can also reattach your own previously downloaded take with **Use a humming audio file** in Audio input. Both production requests keep this actual waveform, including portions the note detector missed. If the persistent message says pitch evidence is limited, guessed chords/bass stay off; rhythm can still develop around the voice. Selecting Piano/Strings/etc. or editing a detected note explicitly uses estimated instrumental reconstruction and may differ from the hum. Save the final audio with **Export WAV**; reopened projects need the original file again.

The earlier original-waveform repair recorded **337 Node tests, 8 Python tests, 31 studio browser checks and 4 actual-take waveform checks**. Its [actual-take evidence](verification/actual-hum-repair-results.json) remains useful for the protected lead. Latest automated verification is **464 Node tests, 48 Python tests and a passing production build**; actual neural evidence is reported separately below.

Hum an original, unfamiliar phrase and inspect the detected notes. For step 1:05–1:30 below, use **“Beauty and a Beat production”** for generic dance-pop or **“Shape of You production”** for sparse percussive pop. Review and apply the proposal. Replay the same captured melody with the other production request to demonstrate different backing around the same lead. Neither request downloads, identifies or recreates the song. Generic **“dance-pop production”** and **“percussive-pop production”** also work. Explicit solo instruments and excluded layers take priority; a benchmark alone does not change the lead or tempo.

Say: “These references guide broad production choices. The actual notes and contours come from my hum, and unfamiliar melodies follow the same input-driven path.” Avoid promising perfect recognition of every microphone recording. The new character summary describes measured register, movement, density, tempo evidence and phrases; ambiguous rhythm may have no confident BPM.

## Optional neural preview demonstration

Follow [local MusicGen setup](MUSICGEN_LOCAL.md) and rehearse before presenting.
The official checkpoint and CPU generation have now run successfully; loading
weights or generating a new preview may exceed this three-minute walkthrough.
Show a previously completed, clearly identified preview if time is limited.
Never describe a saved result as a fresh live generation.

In **Hear another direction**, describe genre, mood, instrument roles and texture,
then select **Generate preview**. Explain that the actual recorded WAV and a
locally compiled direction go to the loopback MusicGen service. Show its current
stage; only genuine audio-token counts produce determinate progress. Demonstrate
**Cancel generation** or **Reconnect to this job** when relevant, rather than
starting duplicate work. On success, compare **Original hum** with **Generated
preview**, replay it, and select **Download preview WAV** to retain the session
output. The [production library](PRODUCER_KNOWLEDGE.md) explains general technique
references without copying artist identities or song hooks.

Say: “This separate neural preview uses the official MusicGen Melody checkpoint.
It can reinterpret the melody; my protected original composition is still
available.” The real 7.62-second take produced a 4.94-second preview in 305.666
seconds. Native playback completed both clips and the WAV download succeeded.
Five distinct synthetic melody/style cases also produced validated conditioned
output. Do not promise 20–40 second CPU generation, exact melody fidelity or
professional mastering: the preview uses basic RMS/peak normalization. See the
[measurements and rejected-trial history](MUSICGEN_VERIFICATION.md).

This path requires no paid API and does not upload the recording to an external
provider. Model files are downloaded separately. Meta's weights are
[CC BY-NC 4.0](https://huggingface.co/facebook/musicgen-melody); the local demo is
not evidence of a commercial deployment license.

## Before presenting

- Use Node 22.13 or newer. Run `npm install`, then `npm run dev`, and open [http://localhost:5173](http://localhost:5173). For a built demo, run `npm run build`, then `npm start`, and open [http://127.0.0.1:3001](http://127.0.0.1:3001).
- Keep the server terminal open. Confirm **Local server connected** in the footer. Check [http://127.0.0.1:3001/api/health](http://127.0.0.1:3001/api/health) if needed.
- For an AI demo, copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell), set `OPENAI_API_KEY` locally, and restart the server. `OPENAI_MODEL` defaults to `gpt-5.4-mini`. API access and billing are required and calls may incur charges. Never paste the key into chat or the browser. Confirm configuration at `/api/producer/status`, then rehearse a request and check its actual source; configuration alone does not prove a working connection. With no key, the complete rules-based demo still works.
- Check the selected microphone and speaker volume. Use a quiet room and headphones when practical. Rehearse a simple four-to-six-note phrase, holding each note for about half a second with small gaps.
- Rehearse permission handling with the actual browser. Begin the presentation on **Home**, reached through the **MUSE** wordmark. The top navigation contains **DISCOVER**, **STUDIO**, **PROJECTS** and **HUM A MELODY**. **CREATE** opens the manual empty studio. Existing saved projects are real user data; there are no seeded examples or video-reference tracks.
- Leave enough time for a short retake. If recognition yields no usable notes, show that result honestly and retry. Never replace the capture with a synthetic fixture while calling it a microphone result.

## Timed walkthrough — 180 seconds

| Time | Action | What to say |
| --- | --- | --- |
| **0:00–0:20** | Show the golden-hour drummer Home and select **HUM**. | “A musical idea can disappear before you know how to produce it. MUSE starts with a melody you can hum, then gives you control over how it sounds.” |
| **0:20–0:45** | Select **Record your melody**. Allow microphone access. Hum the rehearsed phrase for 5–10 seconds, then select **Finish take**. | “This is live microphone input. The browser estimates one pitch at a time and groups stable pitches into notes. The raw audio stays on this device.” |
| **0:45–1:05** | Show the cream captured-idea page, actual note count and phrase timing. Briefly play **Original take**, then pause it. Select a note and show its edit controls. | “These notes come from the take we just recorded. Detection is approximate, so I can inspect the notes and correct a pitch. Silence produces no invented melody.” |
| **1:05–1:30** | Select **Shape this melody**. In **Your creative direction**, enter **“Make it cinematic with strings at 100 BPM, add percussion.”** Submit with **Get producer recommendations**, then show the lavender proposal and its source. | With a rules response: “Local musical rules proposed these supported settings.” With an AI response: “OpenAI interpreted this direction into controls MUSE supports.” In either case: “This is a proposal for review; it has not changed the sound yet.” |
| **1:30–1:55** | Select **Create my composition**. In the dark studio, wait for the arrangement, then **Play composition** for several seconds and pause it. Show the actual track lanes and sound controls. | “I explicitly apply the direction to create this arrangement. The local backend preserves my captured melody and creates timed backing events. The browser plays synthesised instruments. Key and chord labels are approximate suggestions.” |
| **1:55–2:20** | Pause playback. Select a captured note and raise it one semitone. Wait for the arrangement to refresh and play that section briefly. Select **Export WAV**. | “The result stays editable. A pitch edit changes the arrangement, and the WAV is rendered from those musical events. These are synthesised timbres, rather than a studio sample library.” |
| **2:20–2:45** | Rename the project **Live melody**, select **Save project**, and wait for the saved confirmation. Open **PROJECTS**, select that project, then select **Create arrangement** again. | “The backend validates the project and saves it in SQLite. This archive contains real saved ideas. Reopening restores the notes and settings. The original microphone recording is session-only, so it is not in the saved project.” |
| **2:45–3:00** | Finish on the reopened melody or show the architecture diagram in the README. | “The engineering foundation is real capture, testable musical rules, a validated HTTP API and restart-persistent local storage. The next step is improving transcription and musical depth while keeping the user's melody in control.” |

## Recovery during a live demo

**No clear notes:** finish the take, show the empty timeline, and say, “This input was not clear enough to recognise.” Record 3–4 slower notes closer to the microphone. Use the time allocated to the editing/export step for the retake.

**Microphone blocked:** allow microphone access in the browser's site controls, confirm OS permissions, and retry. Recording requires localhost/127.0.0.1 or HTTPS. If the device remains unavailable, show the workflow and state that the live capture could not be completed; do not claim recognition worked.

**Server unavailable:** check the terminal and `/api/health`. The full development command is `npm run dev`; Vite alone cannot arrange or save. Resolve any port conflict before restarting. If a save fails, leave the unsaved idea open and report the error.

**No sound:** press Play after a user gesture, check the tab/system output volume and the output device, and stop original-take playback before playing the composition. The app also stops composition playback when a new capture starts.

**Unknown creative request:** in rules mode, show the supported examples or the two generic production requests above. AI can interpret broader wording into supported production, mood, instrument, genre, backing tempo and layer controls. Do not imply it trains a model or generates a finished song from prose.

**AI unavailable or rules fallback:** show the source and notice. Say, “This request used the local rules fallback.” Provider errors, refusals, invalid output or an eight-second timeout do not stop the local workflow. Use the exact supported request above and apply it after review. A status showing AI configured is not proof that this response came from AI.

For a rehearsed AI variant, try **“Give this melody a quiet, reflective character with a slower pace and no drums.”** Compare the proposed settings with the request before applying them. Only call the result AI-backed when that response is labelled AI. Removing or blanking the local key and restarting restores rules-only mode.

## Technical questions judges may ask

**What runs on the backend?** Node's built-in HTTP server validates JSON, stores projects through SQLite prepared statements, and invokes the arrangement and producer modules. With a local API key, it can call the OpenAI Responses API for a validated producer proposal. It binds to `127.0.0.1:3001`. Production builds are served by the same process.

**Where does the audio go?** The original microphone take stays in the browser for the session. A decoded PCM WAV is sent to the local server for full-recording extraction and source binding, retained in a bounded temporary cache. Notes, contours, settings and project metadata can be saved in `data/muse.sqlite`. When OpenAI is enabled, a producer request sends the instruction, supported settings and a bounded detected-MIDI summary; microphone audio is not sent to OpenAI. Protected-composition WAV export is rendered in the browser. The separate neural preview sends the recorded WAV to the configured loopback Python service and downloads its validated generated WAV; no remote hum upload is used.

**Is the producer AI?** It is optional. With no key, local rules handle requests. With a server-side key, OpenAI can interpret a direction into a strict proposal for mood, instrument, genre, tempo, accompaniment and percussion. Each response identifies AI or rules; failures fall back to rules with a notice. The user must review and apply changes through **Create my composition** on the direction page or **Apply direction** in the studio. Neither mode trains a model, generates audio or saves a project automatically.

**What is actually tested?** As of **2026-11-21**, the latest automated run passed **464 Node tests and 48 Python tests**, and the production build passed. Genuine local MusicGen produced a source-bound actual-hum preview plus five distinct synthetic melody/style outputs, with runtime text, audio-projection and first-decoder-prefix checks. Native playback and WAV download also succeeded. Earlier [instrumental-production checks](verification/original-pop-production-results.json) cover unfamiliar PCM, exact symbolic lead comparisons and decoded stems; they are separate from learned-model evidence. Neither those tests nor coarse chroma similarity establish exact neural melody preservation, human transcription ground truth or subjective polish. See [current MusicGen verification](MUSICGEN_VERIFICATION.md). Live OpenAI response quality remains unverified.

**What remains limited?** Recognition is monophonic, bounded to 60-second takes and sensitive to input quality; the supported detector range is 65–1400 Hz. Key, harmony, tempo and character are estimates. The protected arranger's instruments are synthesised approximations. Optional OpenAI proposes settings; local MusicGen separately generates audio with variable musical fidelity and multi-minute CPU latency. Neither path guarantees a finished studio recording. Accounts are local, projects remain in the installation's shared local archive, and there is no cloud sync. Download neural previews to keep session-only output.

## Verification note for submission

**Documentation status, 2026-11-21:** current music verification is recorded above and in the linked results. The original benchmark's client failures and rejected unconditioned trial remain preserved as historical evidence; later recovery and successful guarded inference are documented separately. Synthetic fixtures are confined to developer QA and must not be presented as microphone input. Rehearse with a real hum on the presentation device and check the original take against its detected notes. This update remains local; it has not been pushed to GitHub.
