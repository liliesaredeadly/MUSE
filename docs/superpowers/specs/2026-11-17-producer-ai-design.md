# Optional AI producer

The user wants a real AI producer without regressions in capture, arranging, playback, export or persistence. The existing producer proposes settings that the user explicitly applies. Keep that boundary and the deterministic musical rules.

## Approach

Use an optional server-only OpenAI Responses API adapter, selected when `OPENAI_API_KEY` is configured. This is an implementation choice: replacing the rules would remove offline resilience, while sending raw audio would add transcription scope and change privacy expectations. No new dependency is needed with Node 22 native fetch.

- Preserve `POST /api/producer` and its `message`, `changes`, `suggestions` fields. Accept optional validated notes; add `source` and an optional fallback `notice`.
- Add `GET /api/producer/status` with configured mode, provider and model; it does not claim a successful live connection.
- Accept only BPM 40–200, supported instrument/mood/genre, accompaniment and percussion. Never let the model edit notes, sourceBpm, projects or audio.
- Strict JSON Schema plus local validation reject malformed, unsupported or unsafe output. An eight-second timeout, bounded concurrency and no retries limit paid requests. Failures use the existing rules and disclose the fallback.
- When note context proves a fallback tempo would exceed the 600-second arrangement limit, omit that tempo change and explain the limit. Preserve other proposed controls and the legacy rules output for safe or absent context.
- Send only the direction, supported settings and bounded detected-note metadata. Keep raw recordings local, and keep credentials in a private server environment file.
- Preserve explicit Apply. Discard stale results when the current take or settings change. Show actual response source and configuration honestly.
- Use the supplied video as visual reference after inspecting it. Retain existing studio layout, design tokens and working flows.

Live model verification requires a locally configured API key. Tests must distinguish a mocked provider from a live OpenAI response. Existing human-microphone and listening limitations remain documented. These changes are local until the user asks to publish them.
