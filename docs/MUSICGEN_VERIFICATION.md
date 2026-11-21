# MusicGen verification — 21 November 2026

Genuine local inference with the official `facebook/musicgen-melody` checkpoint
has completed on this CPU machine. A real human take and five distinct synthetic
melody/style cases produced validated PCM output. This verifies the exercised
conditioning path and usable audio files; exact neural melody fidelity and
professional production quality remain unverified.

## Actual recording and native playback

The user's original take is 7.62 seconds. A five-second preview request completed
in **305.666 Node-job seconds**, returning **4.94 seconds** of mono 32 kHz PCM WAV
(316,204 bytes), with finite samples and no clipping. The generated export is
retained locally at `.local/exports/MUSE-musicgen-actual-hum.wav`; private source
audio and model assets are not bundled with the repository.

Native browser playback reached the end of both the 7.62-second original and
4.94-second preview. Transfer of the finished WAV took **0.4161 seconds**, which
is distinct from generation time. The WAV was downloaded to the local Downloads
folder. Evidence: [actual-hum result](verification/musicgen-actual-hum-results.json)
and [playback/download result](verification/musicgen-playback-results.json).

Exploratory pitch-class comparison measured approximately **0.736 relative-frame
cosine** and **0.930 global chroma cosine** against the matching-duration beginning
of the source. Chroma discards octave, exact notes, timing and timbre; backing also
affects the scores. These values do not prove isolated melody preservation or
musical quality. The protected original-hum composition remains unchanged and
separate from the neural preview.

## Five melody/style cases

The latest [GET-only recovery report](verification/musicgen-recovery-results.json)
records **5 succeeded, 0 failed**, with all three runtime conditioning checks true
for every case. Each four-second request produced a 3.94-second mono 32 kHz WAV.
The sources are original synthetic test recordings, not human performances.

| Direction | Provider model seconds |
| --- | ---: |
| Acoustic | 154.469 |
| Pop | 172.031 |
| Orchestra | 150.844 |
| EDM | 299.953 |
| Piano | 286.640 |

These provider timings exclude queue waiting and model download. The five source
hashes, output hashes and feature hashes are each distinct. That establishes
byte-level variety only; it does not establish genre adherence, exact melody
fidelity or perceived quality. The measurements do not support a 20–40 second CPU
generation claim.

## Rejected trial, recovery and runtime checks

The initial **483.657-second** WAV trial is **rejected** as melody-conditioned
evidence. Transformers 4.57.3's initial empty-cache path discarded its conditioning
prefix. The [historical browser result](verification/musicgen-browser-results.json)
retains the rejected trial and its reason. It is not included among successful
conditioned runs.

A compatibility correction now preserves initial conditioning and is regression
tested against the installed official preparation method. Runtime hooks fail
closed unless all of the following are observed:

- `textEncoderVerified`: the text encoder receives the original positive text IDs.
- `audioProjectionVerified`: the projection receives the original positive-batch
  audio features, including the supported classifier-free-guidance batch layout.
- `initialDecoderPrefixVerified`: the first decoder prefix contains the expected
  projected/repeated chroma frames and nonzero text conditioning.

The plain receipt includes feature SHA-256 and text/chroma/prefix lengths; hooks
are removed after each guarded call. Source WAV SHA/byte receipts, model identity,
PCM format and requested duration are also checked before audio is published.
These checks establish which inputs and initial conditioning path executed, not
the perceptual accuracy of the generated melody.

The [original benchmark report](verification/musicgen-real-results.json) remains
unchanged: it recorded **one client success and four client timeouts**. Subsequent
GET-only recovery found all five provider jobs succeeded and retrieved five valid
guarded outputs without rerunning inference. The recovered result does not erase
the original client failure history.

## Reproduction, tests and limits

Follow [local setup](MUSICGEN_LOCAL.md). This run used Transformers 4.57.3, the same
official checkpoint, CPU int8 decoder quantization and decoder SDPA. It loaded
pretrained weights; it did not train a model. The [production knowledge library](PRODUCER_KNOWLEDGE.md)
documents local prompt heuristics and primary musical references.

Latest validation passed **464 Node tests, 48 Python tests and the production
build**. Automated doubles and boundary tests complement the genuine inference
and native playback evidence; they do not establish listening quality.

The [final test summary](verification/musicgen-test-summary.json) records the
observed command results and current endpoint state. Finished-WAV reads now have
a 12 MiB limit, a 60-second deadline per attempt and at most two safe GET attempts;
they never regenerate music. Repeated status failures pause after three checks
and offer manual recovery of the same job. Native mobile visual QA was not performed.

The final lifecycle fix is applied to the restarted service. The endpoint is
configured and reachable, and the verified weights are cached locally; it is
currently idle with weights unloaded until the next generation request.

No paid API or external recording upload was used. Only the local service
receives the hum; downloading model assets is a separate operation. Meta's
[model card](https://huggingface.co/facebook/musicgen-melody) marks the weights
**CC BY-NC 4.0**. This local noncommercial demo does not establish a commercial
deployment license. Short neural previews may change pitches, note timing,
instrumentation or form. Basic RMS/peak normalization is not professional
mastering. Download session-only WAVs to retain them.
