"""CPU tensor/PCM boundary checks with controlled processor/model doubles.

These exercise TransformersGenerator, not genuine neural inference or its musical
quality. No checkpoint or weights are loaded. The installed Transformers stopping
criteria, PyTorch tensors and SciPy audio resampling remain real.
"""
import base64
import hashlib
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
import wave

import numpy as np
import torch
from transformers import StoppingCriteria, StoppingCriteriaList
from transformers.modeling_outputs import BaseModelOutput


spec = importlib.util.spec_from_file_location(
    "musicgen_transformers_boundary", Path(__file__).parents[1] / "scripts" / "musicgen_melody_service.py"
)
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


def recording(left_gain=.15, right_gain=.6, silent=False):
    clock = np.arange(1600, dtype=np.float64) / 16000
    melody = np.sin(2 * np.pi * 440 * clock)
    samples = np.zeros((1600, 2)) if silent else np.column_stack((-left_gain * melody, right_gain * melody))
    pcm = np.rint(samples * 32767).astype("<i2")
    stream = io.BytesIO()
    with wave.open(stream, "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(pcm.tobytes())
    return stream.getvalue(), pcm


class ProcessorDouble:
    """Capture raw audio/text and provide explicit synthetic feature tensors."""
    def __init__(self, empty_features=False):
        self.feature_extractor = SimpleNamespace(sampling_rate=32000)
        self.calls = []
        self.inputs = {
            "input_features": torch.zeros((1, 8, 12)) if empty_features else torch.arange(1, 97, dtype=torch.float32).reshape(1, 8, 12) / 100,
            "input_ids": torch.tensor([[3, 4, 5]], dtype=torch.long),
            "attention_mask": torch.ones((1, 3), dtype=torch.long),
        }

    def __call__(self, **kwargs):
        self.calls.append({**kwargs, "audio": kwargs["audio"].copy()})
        return self.inputs


class TextEncoderDouble(torch.nn.Module):
    def forward(self, input_ids=None, attention_mask=None, **kwargs):
        hidden = input_ids.to(torch.float32).unsqueeze(-1) + torch.arange(4, dtype=torch.float32) / 10
        return BaseModelOutput(last_hidden_state=hidden * attention_mask.unsqueeze(-1))


class DecoderDouble(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.prefixes = []

    def forward(self, encoder_hidden_states=None, **kwargs):
        self.prefixes.append(encoder_hidden_states.detach().clone())
        return encoder_hidden_states


class ModelDouble(torch.nn.Module):
    """Exercise real module hooks with controlled text/audio prefixes and output."""
    def __init__(self, corruption=None):
        super().__init__()
        self.config = SimpleNamespace(audio_encoder=SimpleNamespace(sampling_rate=32000), chroma_length=12)
        self.text_encoder = TextEncoderDouble()
        self.audio_enc_to_dec_proj = torch.nn.Linear(12, 4)
        with torch.no_grad():
            self.audio_enc_to_dec_proj.weight.copy_(torch.arange(1, 49, dtype=torch.float32).reshape(4, 12) / 48)
            self.audio_enc_to_dec_proj.bias.copy_(torch.tensor([.1, .2, .3, .4]))
        self.decoder = DecoderDouble()
        self.corruption = corruption
        self.calls = []
        self.stop_results = []
        self.inference_mode = False

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        self.inference_mode = torch.is_inference_mode_enabled()
        token_ids = kwargs["input_ids"]
        if self.corruption == "alter-text-ids":
            token_ids = torch.zeros_like(token_ids)
        text = self.text_encoder(input_ids=token_ids, attention_mask=kwargs["attention_mask"]).last_hidden_state
        features = kwargs["input_features"]
        if self.corruption == "alter-audio-features":
            features = torch.zeros_like(features)
        chroma = self.audio_enc_to_dec_proj(features)
        repeats = (self.config.chroma_length + chroma.shape[1] - 1) // chroma.shape[1]
        chroma = chroma.repeat(1, repeats, 1)[:, :self.config.chroma_length]
        prefix = text if self.corruption == "drop-audio" else chroma if self.corruption == "drop-text" else torch.cat((chroma, text), dim=1)
        if self.corruption == "corrupt-audio-prefix":
            prefix = prefix.clone()
            prefix[:, :self.config.chroma_length] = 0
        self.decoder(encoder_hidden_states=prefix)
        for length in (2, 26, 51):
            result = kwargs["stopping_criteria"](torch.ones((1, length), dtype=torch.long), scores=None)
            self.stop_results.append(result)
        clock = torch.arange(32000, dtype=torch.float32) / 32000
        return (.3 * torch.sin(2 * torch.pi * 220 * clock)).reshape(1, 1, -1)


class TransformersBoundaryTest(unittest.TestCase):
    def generator(self, empty_features=False, corruption=None):
        generator = service.TransformersGenerator()
        generator.processor = ProcessorDouble(empty_features=empty_features)
        generator.model = ModelDouble(corruption=corruption).eval()
        # The real load() returns immediately for this injected model. Neither
        # from_pretrained method is called and no weights are downloaded/loaded.
        return generator

    def prepared(self, original):
        return service.prepare_request({
            "audioWavBase64": base64.b64encode(original).decode("ascii"),
            "prompt": "  gentle piano around my melody  ",
            "duration": 1,
        })

    def test_actual_stereo_audio_and_text_reach_the_cpu_generation_boundary(self):
        for left, right, selected in ((.15, .6, 1), (.6, .6, 0)):
            with self.subTest(stronger_right=selected == 1, opposite_phase=left == right):
                original, pcm = recording(left_gain=left, right_gain=right)
                prepared = self.prepared(original)
                original_samples = prepared["samples"].tolist()
                progress = []
                prepared["_progress"] = lambda *values: progress.append(values)
                generator = self.generator()

                response = service.response_for(prepared, generator)

                self.assertEqual(len(generator.processor.calls), 1)
                received = generator.processor.calls[0]
                self.assertEqual(received["sampling_rate"], 32000)
                self.assertEqual(received["text"], ["gentle piano around my melody"])
                self.assertTrue(received["padding"])
                self.assertEqual(received["return_tensors"], "pt")
                self.assertEqual(received["audio"].dtype, np.float32)
                self.assertEqual(received["audio"].shape, (3200,))
                # At 2x resampling the original sample instants must remain at
                # the same pitch/time. This expectation uses the actual PCM,
                # independently of the production conditioning helper.
                expected_channel = pcm[:, selected].astype(np.float32) / 32768
                np.testing.assert_allclose(received["audio"][::2], expected_channel, atol=.001, rtol=0)
                self.assertGreater(float(np.max(np.abs(received["audio"]))), .5)

                self.assertEqual(len(generator.model.calls), 1)
                generated = generator.model.calls[0]
                self.assertIs(generated["input_features"], generator.processor.inputs["input_features"])
                self.assertGreater(int(torch.count_nonzero(generated["input_features"])), 0)
                self.assertIs(generated["input_ids"], generator.processor.inputs["input_ids"])
                self.assertIs(generated["attention_mask"], generator.processor.inputs["attention_mask"])
                self.assertEqual(generated["max_new_tokens"], 50)
                self.assertTrue(generated["do_sample"])
                self.assertEqual(generated["guidance_scale"], 3)
                self.assertIsInstance(generated["stopping_criteria"], StoppingCriteriaList)
                self.assertIsInstance(generated["stopping_criteria"][0], StoppingCriteria)
                self.assertTrue(generator.model.inference_mode)
                self.assertTrue(all(not bool(result.any()) for result in generator.model.stop_results))
                self.assertEqual(generator.last_verification, {
                    "textEncoderVerified": True, "audioProjectionVerified": True,
                    "initialDecoderPrefixVerified": True,
                    "featureSha256": hashlib.sha256(generator.processor.inputs["input_features"].numpy().tobytes()).hexdigest(),
                    "textTokens": 3, "chromaFrames": 8, "decoderPrefixFrames": 15,
                })
                prefix = generator.model.decoder.prefixes[0]
                self.assertEqual(tuple(prefix.shape), (1, 15, 4))
                self.assertTrue(torch.equal(prefix[:, 0], prefix[:, 8]))
                torch.testing.assert_close(prefix[:, 12:], torch.tensor([[
                    [3, 3.1, 3.2, 3.3], [4, 4.1, 4.2, 4.3], [5, 5.1, 5.2, 5.3],
                ]]))
                self.assertEqual(progress, [
                    ("loading", None, None), ("generating", 0, 50), ("generating", 1, 50),
                    ("generating", 25, 50), ("generating", 50, 50), ("preparing", None, None),
                ])

                output = base64.b64decode(response["audioWavBase64"], validate=True)
                samples, rate, channels = service.decode_wav(output)
                self.assertEqual((rate, channels, len(samples)), (32000, 1, 32000))
                self.assertGreater(max(abs(sample) for sample in samples), .1)
                self.assertLessEqual(max(abs(sample) for sample in samples), .891 + 1 / 32768)
                self.assertEqual(response["model"], "facebook/musicgen-melody")
                self.assertEqual(response["sampleRate"], 32000)
                self.assertEqual(response["conditioning"], {
                    "audioSha256": hashlib.sha256(original).hexdigest(),
                    "inputBytes": len(original), "mode": "audio-melody",
                })
                self.assertEqual(prepared["audioWav"], original)
                self.assertEqual(prepared["samples"].tolist(), original_samples)
                self.assertEqual((prepared["sampleRate"], prepared["channels"], prepared["duration"]), (16000, 2, 1))

    def test_silent_recording_is_rejected_before_processor_or_model_generation(self):
        original, _ = recording(silent=True)
        generator = self.generator()
        with self.assertRaisesRegex(service.RequestError, "silent|audible"):
            generator(self.prepared(original))
        self.assertEqual(generator.processor.calls, [])
        self.assertEqual(generator.model.calls, [])

    def test_zero_conditioning_features_never_become_text_only_generation(self):
        original, _ = recording()
        generator = self.generator(empty_features=True)
        with self.assertRaisesRegex(service.RequestError, "conditioning features"):
            generator(self.prepared(original))
        self.assertEqual(len(generator.processor.calls), 1)
        self.assertEqual(generator.model.calls, [])

    def test_dropped_or_changed_text_and_audio_fail_before_publishing_a_preview(self):
        original, _ = recording()
        for corruption in ("drop-audio", "drop-text", "alter-text-ids", "alter-audio-features", "corrupt-audio-prefix"):
            with self.subTest(corruption=corruption):
                generator = self.generator(corruption=corruption)
                prepared = self.prepared(original)
                progress = []
                prepared["_progress"] = lambda *values: progress.append(values)
                with self.assertRaises(RuntimeError):
                    service.response_for(prepared, generator)
                self.assertIsNone(getattr(generator, "last_verification", None))
                self.assertNotIn(("preparing", None, None), progress)

                # A rejected call must not leave old-source hooks behind. Reuse
                # the controlled modules with changed text/features afterward.
                generator.model.corruption = None
                generator.processor.inputs["input_ids"] = torch.tensor([[6, 7, 8]], dtype=torch.long)
                generator.processor.inputs["input_features"] = generator.processor.inputs["input_features"] / 2
                repaired = service.response_for(self.prepared(original), generator)
                self.assertTrue(generator.last_verification["initialDecoderPrefixVerified"])
                self.assertGreater(len(base64.b64decode(repaired["audioWavBase64"])), 44)


if __name__ == "__main__":
    unittest.main()
