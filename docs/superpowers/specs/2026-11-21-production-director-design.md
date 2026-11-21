# AI Production Director

The user requested an implementation of the supplied Advanced AI Music Production specification. Continue in the existing checkout and preserve all previous edits and original recordings. The earlier choice of original recorded voice as the default lead remains in force.

## Approach

Extend the source-bound arrangement engine with an editable production blueprint and independent MIDI-style backing layers. A text-only full-song generator cannot enforce the melody. The existing waveform-conditioned MusicGen adapter remains a separate optional preview, never a replacement for the protected lead. No model installation, paid inference, or external audio upload is implied by this change.

Extraction, planning, and rendering stay separate. Existing complete-PCM pitch/rhythm/tempo analysis supplies estimated notes and contours. Original audio remains available throughout the session, with source SHA and duration checked during rendering. Symbolic melody preservation and waveform preservation are separate claims; neither proves accurate human transcription. Limited pitch evidence continues to suppress inferred pitched harmony and exposes a reason for each blocked pitched layer.

## Blueprint contract

`settings.blueprint` is optional for backward compatibility. Its schema is `{version:1,prompt:string,mood:string,intensity:number,layers:Layer[]}`. Prompt is bounded to 4000 characters. Intensity and layer gain are finite numbers from 0 to 1. Mood uses the existing five moods. At most seven unique catalog layers are allowed.

Layers use stable IDs `guitar`, `piano`, `violin`, `cello`, `synth`, `bass`, `drums`; canonical instruments are `Acoustic Guitar`, `Piano`, `Violin`, `Cello`, `Synthesizer`, `Bass`, `Drums`. Each layer stores `{id,instrument,role,enabled,gain,section,variant}`. Section is `full` or `ending` (final quarter of the original duration). Variant is an integer 0–999. Roles are catalog-constrained: guitar rhythm/arpeggio; piano chords/arpeggio; violin sustain; cello sustain/bass; synth texture/arpeggio; bass bass; drums percussion.

The Director accepts natural language, produces a validated draft, and allows prompt edits, mood/intensity changes, instrument enable/removal, roles, levels, section entries and Apply. A configured OpenAI structured-output planner may propose the blueprint; local planning is explicitly labelled when AI is unavailable. Requests send instructions, settings and detected notes only; source audio stays local. Refinements start from the current blueprint and modify target layers. Unsupported requests produce actionable feedback rather than a claim of execution.

## Rendering and refinement

Blueprint backing replaces the legacy backing when present; legacy projects keep their previous behavior. Lead generation is unchanged. Each generated backing event has a stable `layerId`, a catalog instrument and its existing track category. Layer event generation is deterministic from the source, shared harmony and that layer's variant, so a targeted regeneration leaves every other layer's event sequence unchanged. Gain is applied in an isolated backing layer bus; the dry protected lead remains separate. Real instrument branches distinguish synthesized guitar, violin and cello; these are synthesized approximations, not sampled instruments or mastered studio recordings.

MIDI export of detected melody is available without switching the audible lead. It is explicitly an estimated transcription and cannot contain recorded voice or continuous sung pitch. Arrangement/backing MIDI assigns non-colliding channels and programs. Save/reopen retains blueprint and notes, while existing session-only original audio still requires reattachment.

## Interface and verification

Extend the current studio visual language with one AI Production Director panel and layer controls, replacing its duplicate studio producer panel. The existing direction screen remains compatible. Preserve keyboard operation, clear pending/error/stale states and mobile layout. No wholesale redesign.

Verify parser intent and exclusions, strict schema/persistence, server source binding, exact source note/contour equality across refinements, selective event changes, new synth branches, MIDI pitches/timing/channels, real native rendered audio differences for instruments/gain, no clipping, and original waveform alignment on multiple original fixtures. Run existing regression tests and production build. Keep commercial audio quality, universal transcription accuracy and unrun neural inference explicitly unverified.
