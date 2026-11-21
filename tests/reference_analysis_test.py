"""Generated-tone checks for the offline reference preparation boundary."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "analyze-reference.py"


class ReferenceAnalysisTests(unittest.TestCase):
    def analyze(self, samples, rate=22050):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "tone.wav"
            target = Path(directory) / "features.json"
            with wave.open(str(source), "wb") as stream:
                stream.setnchannels(1)
                stream.setsampwidth(2)
                stream.setframerate(rate)
                stream.writeframes((samples * 32767).astype("<i2").tobytes())
            subprocess.run([sys.executable, str(SCRIPT), str(source), str(target),
                            "--id", "generated-tone", "--title", "Generated fixture",
                            "--artist", "QA", "--source-url", "https://example.com/fixture"],
                           check=True, capture_output=True, text=True)
            return json.loads(target.read_text(encoding="utf-8"))

    def test_a440_keeps_its_pitch_class_in_a_normalized_reference(self):
        time = np.arange(22050 * 2) / 22050
        result = self.analyze(0.3 * np.sin(2 * np.pi * 440 * time))
        frames = np.asarray(result["chroma"])
        self.assertEqual(int(np.argmax(frames[5:-5].mean(axis=0))), 9)
        self.assertTrue(np.allclose(np.linalg.norm(frames[5:-5], axis=1), 1, atol=0.001))
        self.assertAlmostEqual(result["duration"], 2, places=3)
        self.assertFalse(result["notesVerified"])
        self.assertEqual(result["sourceUrl"], "https://example.com/fixture")

    def test_silence_does_not_acquire_a_fabricated_pitch(self):
        result = self.analyze(np.zeros(22050))
        self.assertEqual(np.count_nonzero(result["chroma"]), 0)

    def test_a_changed_tone_changes_the_reference_pitch_class(self):
        time = np.arange(22050 * 2) / 22050
        result = self.analyze(0.3 * np.sin(2 * np.pi * 261.625565 * time))
        frames = np.asarray(result["chroma"])
        self.assertEqual(int(np.argmax(frames[5:-5].mean(axis=0))), 0)


if __name__ == "__main__":
    unittest.main()
