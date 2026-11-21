"""Exercise installed official preparation code with tiny tensors; no weights/inference."""
import importlib.util
import inspect
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('musicgen_compat', Path(__file__).parents[1] / 'scripts' / 'musicgen_compat.py')
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)

try:
    import torch
    from transformers.cache_utils import DynamicCache
    from transformers.models.musicgen_melody.modeling_musicgen_melody import MusicgenMelodyForConditionalGeneration, MusicgenMelodyForCausalLM
    HAS_OFFICIAL_IMPLEMENTATION = True
except ImportError:
    HAS_OFFICIAL_IMPLEMENTATION = False


@unittest.skipUnless(HAS_OFFICIAL_IMPLEMENTATION, 'requires installed official PyTorch/Transformers; no checkpoint is loaded')
class InitialCacheCompatibilityTests(unittest.TestCase):
    def setUp(self):
        class Harness:
            # The actual installed Transformers method, not a reimplementation.
            prepare_inputs_for_generation = MusicgenMelodyForConditionalGeneration.prepare_inputs_for_generation
            decoder = SimpleNamespace(apply_delay_pattern_mask=MusicgenMelodyForCausalLM.apply_delay_pattern_mask)
        self.harness_class = Harness
        self.model = Harness()
        self.ids = torch.tensor([[5, 7, 9]])
        self.prefix = torch.arange(24, dtype=torch.float32).reshape(1, 6, 4)
        self.mask = torch.full_like(self.ids, -1)

    def prepare(self, cache, model=None):
        return (model or self.model).prepare_inputs_for_generation(
            self.ids, encoder_hidden_states=self.prefix, past_key_values=cache,
            decoder_delay_pattern_mask=self.mask, use_cache=True)

    def test_original_official_method_drops_empty_cache_prefix_and_instance_fix_preserves_it(self):
        empty = DynamicCache()
        self.assertEqual(empty.get_seq_length(), 0)
        original = self.prepare(empty)
        self.assertIsNone(original['encoder_hidden_states'], 'reproduces the installed official empty-cache bug')
        self.assertIs(original['past_key_values'], empty)
        compat.install_initial_cache_fix(self.model)
        fixed = self.prepare(empty)
        self.assertIs(fixed['encoder_hidden_states'], self.prefix)
        self.assertIsNone(fixed['past_key_values'])
        self.assertTrue(fixed['use_cache'], 'decoder creates and returns the first real cache normally')
        self.assertIsNone(self.prepare(empty, self.harness_class())['encoder_hidden_states'], 'another instance remains untouched')

    def test_nonempty_cache_and_later_token_slicing_keep_original_official_behavior(self):
        cache = DynamicCache()
        cache.update(torch.ones(1, 1, 6, 4), torch.ones(1, 1, 6, 4), 0)
        original = self.prepare(cache)
        compat.install_initial_cache_fix(self.model)
        fixed = self.prepare(cache)
        self.assertIs(fixed['past_key_values'], cache)
        self.assertIsNone(fixed['encoder_hidden_states'])
        self.assertTrue(torch.equal(fixed['decoder_input_ids'], original['decoder_input_ids']))
        self.assertTrue(torch.equal(fixed['decoder_input_ids'], self.ids[:, -1:]))

    def test_hugging_face_argument_validation_sees_the_original_signature_and_install_is_idempotent(self):
        original_signature = inspect.signature(self.model.prepare_inputs_for_generation)
        original_name = self.model.prepare_inputs_for_generation.__name__
        self.assertTrue(compat.install_initial_cache_fix(self.model))
        wrapped = self.model.prepare_inputs_for_generation
        self.assertEqual(inspect.signature(wrapped), original_signature)
        self.assertEqual(wrapped.__name__, original_name)
        self.assertFalse(compat.install_initial_cache_fix(self.model))
        self.assertIs(self.model.prepare_inputs_for_generation, wrapped)

    def test_none_and_positionally_supplied_empty_cache_preserve_the_prefix(self):
        compat.install_initial_cache_fix(self.model)
        self.assertIs(self.prepare(None)['encoder_hidden_states'], self.prefix)
        result = self.model.prepare_inputs_for_generation(
            self.ids, self.prefix, DynamicCache(), decoder_delay_pattern_mask=self.mask, use_cache=True)
        self.assertIs(result['encoder_hidden_states'], self.prefix)
        self.assertIsNone(result['past_key_values'])

    def test_unexpected_cache_shapes_fail_closed_instead_of_silently_removing_conditioning(self):
        compat.install_initial_cache_fix(self.model)
        for cache in (object(), SimpleNamespace(get_seq_length=lambda: None), SimpleNamespace(get_seq_length=lambda: -1),
                      SimpleNamespace(get_seq_length=lambda: 0.0), SimpleNamespace(get_seq_length=lambda: True)):
            with self.subTest(cache=cache), self.assertRaises((TypeError, ValueError, RuntimeError)):
                self.prepare(cache)


if __name__ == '__main__':
    unittest.main()
