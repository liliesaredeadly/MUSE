# Muse production knowledge

Muse's local production compiler turns a creative direction and the applied
settings into an English musical description for MusicGen. It is a small,
inspectable rule library, rather than a trained producer model. It makes no
network requests, uses no API key and incurs no inference charge. It does not
claim to hear a recording or to reproduce a particular producer's work.

## Shared contract

```js
import { compileProductionPrompt } from '../src/producer/production-prompt.js';

const production = compileProductionPrompt({
  text: 'Warm melancholic jazz at 84 BPM. Only piano and cello. Start sparse and build gradually.',
  settings: { genre: 'Jazz', mood: 'Melancholic', bpm: 84 },
  notes: [],       // Optional detected note metadata, never audio bytes.
  analysis: null, // Only analysis.notes is read, if notes is empty.
});
// { prompt, analysis, techniques, sources, warnings }
```

`prompt` is a bounded instrumental music description of at most 2,000
characters. Arbitrary sentences are never forwarded: the compiler emits fixed
musical phrases from recognized direction words and validated settings. A
direction is limited to 4,000 characters. When no new text is supplied, the
applied blueprint's saved direction is used.

`analysis` contains `genre`, `mood`, `bpm` (number or null), `energy`,
`instrumentation`, `structure`, `texture`, `atmosphere`, `melody`,
`interpretation: 'local-rules'`, and a `provenance` map. Instrumentation contains
the enabled backing layers with their instrument, role, gain and section. The
existing blueprint stays unchanged. The compiler reads the same seven supported
backing instruments as the local arranger: acoustic guitar, piano, violin,
cello, synthesizer, bass and drums. It does not claim that additional named
instruments have been added to the editable blueprint.

`techniques` explains each selected rule with an ID, label, description,
`sourceIds` and a reason. `sources` contains the referenced primary educational
sources. `warnings` identifies ignored malformed data, input limits, reference
interpretation and requested behavior the model cannot promise.

## How directions become production decisions

An explicit recognized genre, emotion or BPM takes priority over the selected
setting. The existing local blueprint planner handles instrument additions,
exclusions, “only” restrictions, roles, gain refinements and ending entries.
Disabled layers remain absent unless a direction enables them. A soft layer is
described as soft; an ending layer is described as entering late. A four-on-the-
floor or backbeat description is emitted only when percussion is enabled.

The vocabulary recognizes broad genres such as ambient, pop, dance-pop,
electronic, classical, cinematic, orchestral, jazz, rock, folk, hip-hop, lo-fi,
house, techno, synth-pop, synthwave, drum and bass, R&B, acoustic and experimental.
It also recognizes bounded emotion, texture and atmosphere words. This is not
open-ended natural-language understanding; a detail outside the vocabulary may
be omitted. When several recognized genres are stated, the last distinct genre
is used. A compound term such as dance-pop takes priority over the overlapping
word pop.

Muse's editorial defaults connect calm or intimate moods to restrained energy,
dreamy or melancholic moods to softer texture, and dreamy or cinematic moods to
space around the backing. Dance genres can suggest a steady kick; pop, rock,
hip-hop and lo-fi can suggest a supporting backbeat. A sparse opening, gradual
build, contrasting passage, central high point or quiet ending is described
when recognized in the direction. These choices are **Muse heuristics**. The
sources below explain the musical concepts; they do not prescribe this mapping,
endorse Muse, or guarantee a particular result. Explicit dry production suppresses
the reverb suggestion. Genre tempo ranges are not imposed on the user.

Detected notes can contribute note count, duration, register, motion, density
and an uncertain tempo suggestion. The suggestion is used only when no BPM was
selected or requested and its confidence is at least 0.5. Notes do not establish
emotion, genre, production quality or perceived loudness. The compiler never
places the source note sequence, pitch contour, recording bytes or arbitrary
analysis fields in its model description. Invalid note metadata is omitted with
a warning. No source waveform is sent to OpenAI by this module.

Named artists, producers and song references are not included in the output.
General qualities supplied alongside a reference can still inform the result:
for example, “warm intimate pop with soft piano” remains useful after the name
is omitted. The compiler stores no song hooks, artist-specific recipes, samples
or recognizable melodic templates.

## Primary references and technique boundaries

References were reviewed on 21 November 2026. The library contains concise
paraphrases of general concepts, rather than copied tutorials or song examples.

| Source | Concept used by the library |
| --- | --- |
| [Meta AI — MusicGen examples](https://audiocraft.metademolab.com/musicgen.html) | `descriptive-conditioning`: descriptions combine genre, instrumentation, rhythmic qualities and atmosphere. The examples demonstrate inputs, without promising exact adherence. |
| [Ableton Learning Music — Beat and tempo](https://learningmusic.ableton.com/make-beats/beat-and-tempo.html) | `tempo-direction` and `steady-pulse`: BPM describes pulse rate; a kick on each beat creates a steady pulse. |
| [Ableton Learning Music — Tempo and genre](https://learningmusic.ableton.com/make-beats/tempo-and-genre.html) | `tempo-direction`: tempo interacts with sound and pattern choices. Typical genre ranges are examples rather than constraints. |
| [Ableton Learning Music — Backbeats](https://learningmusic.ableton.com/make-beats/backbeats.html) | `backbeat`: snare or clap accents on beats two and four are a common rhythmic feature. |
| [Ableton Learning Music — Song structure](https://learningmusic.ableton.com/song-structure/song-structure.html) | `section-development`: larger arrangements are assembled from shorter patterns and sections. |
| [Ableton Learning Music — Voicings](https://learningmusic.ableton.com/advanced-topics/voicings.html) | `open-voicings`: chord tones can be distributed or doubled in different registers. This suggestion requires a harmonic layer and an explicit request. |
| [iZotope — How to Create Better Transitions in Your Mix](https://www.izotope.com/community/blog/how-to-create-better-transitions-in-your-mix) | `section-contrast` and `gradual-build`: instrument entries/exits, density changes and gradual builds can distinguish sections. |
| [Ableton — Live Audio Effect Reference](https://www.ableton.com/en/manual/live-audio-effect-reference/) | `spatial-depth`: reverb and its decay describe spatial ambience around supporting parts. |
| [Meta AI — MusicGen model card](https://github.com/facebookresearch/audiocraft/blob/main/model_cards/MUSICGEN_MODEL_CARD.md) | Capability limits: realistic vocals are unreliable, English descriptions are favored, styles are not equally represented and prompt results vary. |

The generated prompt is a direction for a probabilistic model. Exact tempo,
instrument exclusions, section timing, sound quality and form are not guaranteed
by a text description. Melody-conditioned MusicGen guides generation through
musical features; it does not prove waveform or note-for-note preservation.
The local compiler and its provenance remain available even when a generation
provider is unavailable.

## Focused verification

Run `node --test tests/production-prompt.test.js` to verify explicit direction
priority, disabled layers and ending entries, note provenance, omission of named
references and arbitrary commands, bounded deterministic output and resolvable
technique citations. This check uses no network or paid provider.
