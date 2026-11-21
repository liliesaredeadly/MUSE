"""CPU-only contract tests. These do not load or run MusicGen."""
import base64
import importlib.util
import io
from pathlib import Path
import unittest
import wave
from array import array

spec = importlib.util.spec_from_file_location("musicgen_melody_service", Path(__file__).parents[1] / "scripts" / "musicgen_melody_service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


def wav_bytes():
    stream = io.BytesIO()
    with wave.open(stream, "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x80\xff\x7f\x00\x20\x00\xc0")
    return stream.getvalue()


class MelodyServiceContractTest(unittest.TestCase):
    def test_opposite_phase_stereo_retains_an_audible_conditioning_channel(self):
        prepared = {'samples':array('f', [.25, -.25, -.5, .5] * 800), 'channels':2, 'sampleRate':16000}
        samples = service.conditioning_audio(prepared, 32000)
        self.assertEqual(len(samples), 3200)
        self.assertGreater(float(max(abs(samples))), .4)
        with self.assertRaises(service.RequestError):
            service.conditioning_audio({'samples':array('f', [0] * 100), 'channels':1, 'sampleRate':16000}, 32000)

    def test_actual_interleaved_pcm_is_decoded_without_pitch_or_time_changes(self):
        original = wav_bytes()
        parsed = service.prepare_request({"audioWavBase64": base64.b64encode(original).decode("ascii"), "prompt": "strings", "duration": 8})
        self.assertEqual(parsed["audioWav"], original)
        self.assertEqual(parsed["samples"].tolist(), [-1.0, 32767 / 32768, 0.25, -0.5])
        self.assertEqual(parsed["sampleRate"], 16000)
        self.assertEqual(parsed["channels"], 2)
        self.assertEqual(parsed["duration"], 8)

    def test_no_missing_audio_or_out_of_range_generation_duration(self):
        valid = {"audioWavBase64": base64.b64encode(wav_bytes()).decode("ascii"), "prompt": "strings", "duration": 8}
        for updates in ({"audioWavBase64": ""}, {"audioWavBase64": "%%%="}, {"duration": 0}, {"duration": 31}, {"duration": True}, {"prompt": ""}):
            with self.subTest(updates=updates), self.assertRaises(service.RequestError):
                service.prepare_request({**valid, **updates})

    def test_generated_response_retains_conditioning_fingerprint(self):
        original = wav_bytes()
        calls = []
        def inference(parsed):
            calls.append(parsed)
            return original, 16000
        payload = {"audioWavBase64": base64.b64encode(original).decode("ascii"), "prompt": "strings", "duration": 8}
        result = service.generate_response(payload, inference)
        self.assertEqual(calls[0]["samples"].tolist(), [-1.0, 32767 / 32768, 0.25, -0.5])
        self.assertEqual(result["model"], "facebook/musicgen-melody")
        self.assertEqual(base64.b64decode(result["audioWavBase64"]), original)
        self.assertEqual(result["conditioning"]["inputBytes"], len(original))
        self.assertEqual(len(result["conditioning"]["audioSha256"]), 64)

    def test_inconsistent_riff_length_is_rejected(self):
        for delta in (-1, 1):
            original = bytearray(wav_bytes())
            original[4:8] = (len(original) - 8 + delta).to_bytes(4, "little")
            with self.subTest(delta=delta), self.assertRaises(service.RequestError):
                service.decode_wav(bytes(original))
        with self.assertRaises(service.RequestError):
            service.decode_wav(wav_bytes() + b"unexpected trailing data")

    @unittest.skipUnless(importlib.util.find_spec("torch"), "optional PyTorch tensor boundary check")
    def test_actual_tensor_reaches_chroma_generation_with_original_rate(self):
        import torch
        calls = {}
        class ModelDouble:
            sample_rate = 16000
            def set_generation_params(self, **parameters):
                calls["parameters"] = parameters
            def generate_with_chroma(self, descriptions, audio, sample_rate):
                calls.update(descriptions=descriptions, audio=audio.clone(), sample_rate=sample_rate)
                return audio.clone()
        generator = service.AudioCraftGenerator()
        generator.torch, generator.model = torch, ModelDouble()
        original = wav_bytes()
        parsed = service.prepare_request({"audioWavBase64": base64.b64encode(original).decode("ascii"), "prompt": "strings", "duration": 8})
        output, sample_rate = generator(parsed)
        self.assertEqual(calls["parameters"], {"duration": 8})
        self.assertEqual(calls["descriptions"], ["strings"])
        self.assertEqual(calls["sample_rate"], 16000)
        self.assertEqual(calls["audio"].dtype, torch.float32)
        self.assertEqual(tuple(calls["audio"].shape), (1, 2, 2))
        self.assertTrue(torch.equal(calls["audio"], torch.tensor([[[-1.0, 0.25], [32767 / 32768, -0.5]]], dtype=torch.float32)))
        self.assertEqual(sample_rate, 16000)
        self.assertEqual(service.decode_wav(output)[1:], (16000, 2))


if __name__ == "__main__":
    unittest.main()
