# Full video-reference interface

The user requests the same interface as the supplied three-minute MUSE video, expanding the previous producer-only reference treatment. This supersedes the prior sidebar/three-panel visual layout. All work stays local; no GitHub pushes or commits.

## Visual direction

- Top navigation with MUSE wordmark, Discover, Studio, Projects and outlined microphone action.
- Full-bleed golden-hour festival photo, white editorial headline with italic serif words, and bottom HUM / DISCOVER / CREATE actions.
- Photo-backed HUM page with a large left statement and cream recording console. Real captured notes lead to the direction screen.
- Cream direction screen: oversized editorial heading and prompt on the left, actual melody preview below, large lavender proposal card on the right. The user explicitly selects Create my composition to apply and arrange.
- Dark composition screen: spacious heading, actual arrangement track lanes, captured note editing, compact sound controls and transport.
- Dark saved-project library with orange/lavender/cream record artwork derived from real saved metadata. No seeded projects.

Colors: dark #24212B, cream #F7F1E7, orange #F37955, lavender #B3A0CF and sand #E9DBA9. Interface type remains system sans; expressive words use Georgia italic; timing and labels use Consolas. Photography is a generated clean reconstruction of the video's drummer scene, not a screenshot with embedded controls.

## Behavior and architecture

Retain useStudio as the single state owner and preserve microphone lifecycle, original take, note editing, mood/genre/instrument/tempo/layers, audio transport, WAV export, local SQLite saving and optional AI fallback. The new direction page composes the existing Producer state machine with a layout variant. Apply stays explicit. Settings and notes changing still invalidate pending and completed directions.

Only display genuine waveforms, note data, arrangement events and request/capture states. Do not invent analysis stages, progress percentages, tracks, keys or melodies to copy the video. Display source/connection/privacy information truthfully. Preserve all accessible control names and usable controls on narrow screens.

Do not change backend, audio engine or persistence behavior for this visual work. Existing tests must keep exercising real visible user controls; update assertions tied specifically to the removed sidebar. Verify the complete new gallery -> direction -> composition -> save journey, all prior regressions, production build, desktop/mobile layouts and failure states.
