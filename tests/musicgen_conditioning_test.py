"""Observe real nn.Module hooks with controlled tensors, without checkpoints."""
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

try:
    import torch
except ImportError:
    torch = None

spec = importlib.util.spec_from_file_location('musicgen_conditioning_test_target', Path(__file__).parents[1] / 'scripts' / 'musicgen_conditioning.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


if torch is not None:
    class Text(torch.nn.Module):
        def forward(self, input_ids=None, attention_mask=None):
            return (input_ids.to(torch.float32).unsqueeze(-1) + 1).repeat(1, 1, 4)


    class Projection(torch.nn.Module):
        def forward(self, features):
            return features[:, :, :4] * 2 + 1


    class Decoder(torch.nn.Module):
        def forward(self, input_ids=None, attention_mask=None, encoder_hidden_states=None):
            return encoder_hidden_states


    class Model(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.config = SimpleNamespace(chroma_length=5)
            self.text_encoder = Text()
            self.audio_enc_to_dec_proj = Projection()
            self.decoder = Decoder()

        def forward(self, inputs, corruption=None, cfg=True, positional=False):
            ids, mask = inputs['input_ids'], inputs['attention_mask']
            if corruption == 'wrong-text':
                ids = ids + 1
            if corruption == 'wrong-mask':
                mask = torch.zeros_like(mask)
            if corruption == 'drop-text':
                text = torch.ones((*ids.shape, 4))
            else:
                text = self.text_encoder(ids, mask) if positional else self.text_encoder(input_ids=ids, attention_mask=mask)
            features = inputs['input_features']
            if corruption == 'wrong-audio':
                features = features + .25
            if cfg:
                features = torch.cat([torch.zeros_like(features), features]) if corruption == 'cfg-reordered' else torch.cat([features, torch.zeros_like(features)])
                text = torch.cat([text, torch.zeros_like(text)])
            projected = torch.ones((*features.shape[:2], 4)) if corruption == 'drop-audio' else self.audio_enc_to_dec_proj(features)
            audio = projected.repeat(1, 3, 1)[:, :self.config.chroma_length]
            prefix = torch.cat([audio, torch.zeros_like(text) if corruption == 'zero-text-prefix' else text], dim=1)
            if corruption == 'wrong-audio-prefix':
                prefix[0, 0, 0] += .25
            if corruption == 'wrong-length':
                prefix = prefix[:, :-1]
            if corruption == 'nonfinite-prefix':
                prefix[0, 0, 0] = float('nan')
            if corruption == 'missing-prefix':
                prefix = None
            result = self.decoder(None, None, prefix) if positional else self.decoder(encoder_hidden_states=prefix)
            self.decoder(encoder_hidden_states=None)  # Cached later calls may omit the prefix.
            return result


@unittest.skipIf(torch is None, 'PyTorch is unavailable; no dependencies are installed by this test.')
class ConditioningTests(unittest.TestCase):
    def setUp(self):
        self.model = Model()
        self.inputs = {
            'input_ids': torch.tensor([[3, 4, 5], [6, 7, 8]], dtype=torch.long),
            'attention_mask': torch.ones((2, 3), dtype=torch.long),
            'input_features': torch.arange(48, dtype=torch.float32).reshape(2, 2, 12) / 100,
        }

    def assert_no_hooks(self):
        for module in (self.model.text_encoder, self.model.audio_enc_to_dec_proj, self.model.decoder):
            self.assertFalse(module._forward_pre_hooks)
            self.assertFalse(module._forward_hooks)

    def test_genuine_cfg_path_reports_plain_verified_receipt_and_removes_hooks(self):
        with guard.verify_conditioning(self.model, self.inputs) as report:
            self.assertFalse(report['initialDecoderPrefixVerified'])
            self.model(self.inputs)
        self.assertEqual(report, {
            'textEncoderVerified': True, 'audioProjectionVerified': True, 'initialDecoderPrefixVerified': True,
            'featureSha256': hashlib.sha256(self.inputs['input_features'].numpy().tobytes()).hexdigest(),
            'textTokens': 3, 'chromaFrames': 2, 'decoderPrefixFrames': 8,
        })
        self.assertEqual(json.loads(json.dumps(report)), report)
        self.assert_no_hooks()

    def test_positional_calls_and_non_cfg_generation_preserve_the_same_boundaries(self):
        with guard.verify_conditioning(self.model, self.inputs) as report:
            self.model(self.inputs, cfg=False, positional=True)
        self.assertTrue(report['initialDecoderPrefixVerified'])
        self.assert_no_hooks()

    def test_missing_or_corrupted_conditions_fail_closed_and_remove_hooks(self):
        for corruption in ('drop-text', 'wrong-text', 'wrong-mask', 'drop-audio', 'wrong-audio', 'cfg-reordered',
                           'wrong-audio-prefix', 'zero-text-prefix', 'wrong-length', 'nonfinite-prefix', 'missing-prefix'):
            with self.subTest(corruption=corruption):
                with self.assertRaisesRegex(RuntimeError, 'conditioning verification failed'):
                    with guard.verify_conditioning(self.model, self.inputs):
                        self.model(self.inputs, corruption=corruption)
                self.assert_no_hooks()

    def test_skipped_generation_rejects_normal_exit(self):
        with self.assertRaisesRegex(RuntimeError, 'every required conditioning boundary'):
            with guard.verify_conditioning(self.model, self.inputs):
                pass
        self.assert_no_hooks()

    def test_original_generation_error_is_preserved_and_hooks_are_removed(self):
        with self.assertRaisesRegex(ValueError, 'original generation failure'):
            with guard.verify_conditioning(self.model, self.inputs):
                raise ValueError('original generation failure')
        self.assert_no_hooks()

    def test_rejects_invalid_feature_tensor_before_installing_hooks(self):
        for features in (None, torch.zeros((2, 0, 12)), torch.full((2, 2, 12), float('inf'))):
            with self.subTest(features=features):
                with self.assertRaises(RuntimeError):
                    with guard.verify_conditioning(self.model, {**self.inputs, 'input_features': features}):
                        pass
                self.assert_no_hooks()


if __name__ == '__main__':
    unittest.main()
