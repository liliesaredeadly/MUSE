"""Prepare local comparison features, not a melody transcription.

Requires NumPy only. Input is bounded mono 16-bit PCM WAV; media decoding is a
separate preparation step. The source and output belong in ignored local data,
never public assets. Chroma collapses octaves and cannot recover verified notes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import wave

import numpy as np


def analyze(source):
    with wave.open(str(source), "rb") as stream:
        rate = stream.getframerate()
        count = stream.getnframes()
        if stream.getnchannels() != 1 or stream.getsampwidth() != 2:
            raise ValueError("Decode the reference to mono 16-bit PCM WAV first.")
        if not 8000 <= rate <= 48000 or not 0 < count / rate <= 600:
            raise ValueError("Reference must be 0–600 seconds at 8–48 kHz.")
        samples = np.frombuffer(stream.readframes(count), dtype="<i2").astype(float) / 32768

    size = 4096
    hop = round(rate / 10)
    frequency = np.fft.rfftfreq(size, 1 / rate)
    supported = (frequency >= 130) & (frequency <= min(5000, rate * 0.45))
    midi = 69 + 12 * np.log2(np.maximum(frequency, 1) / 440)
    nearest = np.rint(midi).astype(int)
    # Soft assignment near semitone centers suppresses inter-note leakage.
    tuning_weight = np.maximum(0, 1 - np.abs(midi - nearest) / 0.5)
    window = np.hanning(size)
    padded = np.pad(samples, (size // 2, size // 2))
    chroma = []
    for center in range(0, len(samples), hop):
        frame = padded[center:center + size]
        if np.sqrt(np.mean(frame * frame)) < 0.001:
            chroma.append([0.0] * 12)
            continue
        spectrum = np.abs(np.fft.rfft((frame - np.mean(frame)) * window))
        # Keep tonal local maxima rather than distributing broadband drum noise
        # across all pitch classes. No single peak is treated as a lead note.
        peaks = np.zeros_like(spectrum, dtype=bool)
        peaks[1:-1] = (spectrum[1:-1] > spectrum[:-2]) & (spectrum[1:-1] >= spectrum[2:])
        selected = peaks & supported & (spectrum >= max(0.02, spectrum.max() * 0.015))
        weights = np.sqrt(spectrum[selected]) * tuning_weight[selected]
        classes = nearest[selected] % 12
        vector = np.bincount(classes, weights=weights, minlength=12)
        length = np.linalg.norm(vector)
        if length > 0:
            vector /= length
        chroma.append(np.round(vector, 6).tolist())
    return {"duration": round(count / rate, 6), "frameSeconds": hop / rate,
            "sampleRate": rate, "chroma": chroma}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--artist", required=True)
    parser.add_argument("--source-url", required=True)
    args = parser.parse_args()
    try:
        features = analyze(args.input)
    except (ValueError, wave.Error) as error:
        parser.error(str(error))
    result = {"version": 1, "id": args.id, "title": args.title, "artist": args.artist,
              "sourceUrl": args.source_url, "method": "spectral-chroma",
              "notesVerified": False, "audioSha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
              **features}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"id": args.id, "frames": len(features["chroma"]),
                      "duration": features["duration"], "notesVerified": False}))


if __name__ == "__main__":
    main()
