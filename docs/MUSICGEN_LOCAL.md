# Local MusicGen Melody

Muse has an optional neural preview alongside its protected-original-lead arrangement. It sends the original PCM WAV and a compiled music direction to the official `facebook/musicgen-melody` checkpoint. Text alone is never substituted for audio conditioning. This model uses chroma features: exact pitches, note timing, requested instruments and sound quality are not guaranteed.

## Free CPU setup on Windows

Use Python 3.12 in an isolated environment. The implementation was integrated against Transformers 4.57.3 and the matching PyTorch/torchaudio 2.11.0 CPU pair. A system-site-packages environment may also need matching torchvision 0.26.0 if an incompatible global torchvision is installed. A fully isolated environment avoids that interaction.

```powershell
python -m venv .local/musicgen-venv
.local/musicgen-venv/Scripts/python.exe -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cpu
.local/musicgen-venv/Scripts/python.exe -m pip install -r requirements/musicgen-cpu.txt
.local/musicgen-venv/Scripts/python.exe scripts/download_musicgen.py
npm run dev:musicgen
```

With an enterprise certificate authority, recent pip supports `--use-feature=truststore`. The download/service scripts use the Windows certificate store via truststore without disabling HTTPS verification. No API key, subscription, paid inference or outward transmission of a recording is involved. Model assets download from Hugging Face; cached weights stay in ignored `.local/musicgen-cache`.

The combined launcher starts the existing Vite client, Node server, and loopback Python service at port 3002. Do not run another Muse instance on the same ports. Existing `npm run dev` remains available without starting the large model. Set `MUSE_MELODY_MODEL_URL=http://127.0.0.1:3002/generate` when launching the service separately. Only literal loopback HTTP model endpoints are accepted.

## Hardware and quality limits

The official Transformers checkpoint has approximately 6.23 GB of safetensor weights. First use must download/cache and load them. This laptop has approximately 7.34 GiB physical RAM and no CUDA GPU. The launcher opts into dynamic int8 decoder quantization to reduce memory pressure; encoder/codec remain floating point. Quantized audio quality requires actual listening tests. CPU generation may take minutes and cannot be advertised as meeting a 20–40 second target without measurements.

The separate preview does not replace the retained original voice or the precise original-lead arrangement. Basic RMS/peak volume adjustment is not professional mastering. Downloads are session-only; save generated WAVs to retain them.

Actual local generation and browser playback are now verified: see [measured results and limitations](MUSICGEN_VERIFICATION.md). Five four-second test requests took 150.844–299.953 provider seconds; the actual-hum five-second request took 305.666 Node-job seconds. These are different timing scopes, and neither establishes a 20–40 second CPU target.

## Job reliability

- Node: POST `/api/generation/jobs`, GET/DELETE `/api/generation/jobs/:id`, successful WAV at `/api/generation/jobs/:id/audio`.
- Stable request IDs deduplicate lost acknowledgements. Conflicting reuse fails. One active generation and a bounded queue prevent duplicate compute.
- Python uses threaded request handling and a persistent supervised model process. Cancellation is checked between tokens; the supervisor terminates unresponsive loading/inference after the cancellation grace period. Node retains its slot during cancellation acknowledgement.
- Finite request/job deadlines, bounded retries, terminal TTL/history eviction and prompt release of source buffers constrain resources. No temporary user-audio files are needed by the service.
- SHA256/byte-count receipts must match the original WAV. Model identity, PCM structure, duration and sample rate are checked before publishing output.
- An instance-local Transformers 4.57.3 cache compatibility correction preserves the first conditioning prefix. Runtime checks reject output unless the original text IDs, original audio features and combined decoder prefix were observed. Source-level and controlled-module tests cover the previously dropped-prefix path.
- Seven visual stages reflect actual operations. Only model token counts become determinate progress. No completed result is artificially delayed.

## Verification

`npm test` covers source binding, HTTP jobs, cancellation, deduplication, invalid results, lifecycle recovery and production compilation. Python service/Transformers boundary tests use explicit inference doubles and **do not establish genuine model operation**.

```powershell
.local/musicgen-venv/Scripts/python.exe -m unittest discover -s tests -p 'musicgen*test.py'
.local/musicgen-venv/Scripts/python.exe scripts/benchmark_musicgen.py --duration 4 --timeout 1800
```

The benchmark attempts five distinct original synthetic hum-like melodies and production directions. Generated output alone may be written to `.local/musicgen-benchmark`; results, failures, elapsed times and exploratory chroma comparisons are recorded in `docs/verification/musicgen-real-results.json`. Synthetic fixtures are not presented as human recordings, and chroma comparison does not prove exact melody preservation. Use `--source PATH` to additionally test a real PCM16 recording locally.

## Licensing and availability

[Meta's model card](https://huggingface.co/facebook/musicgen-melody) lists **CC BY-NC 4.0** for weights and MIT for code. This local noncommercial demo is not a commercial deployment license. The model page currently lists no deployed Hugging Face Inference Provider. No paid provider was selected. Verify licensing and provider availability again before deployment.

Official references: [AudioCraft](https://github.com/facebookresearch/audiocraft), [MusicGen guidance](https://github.com/facebookresearch/audiocraft/blob/main/docs/MUSICGEN.md), [Transformers melody conditioning](https://huggingface.co/docs/transformers/v4.57.3/en/model_doc/musicgen_melody), [PyTorch version pairs](https://pytorch.org/get-started/previous-versions/).
