"""Instance-local compatibility for MusicGen Melody's first decoder step.

Transformers 4.57.3 preinitializes an empty generation cache, but MusicGen's
preparation method treats any non-None cache as an already conditioned step.
Forwarding None for that empty cache lets the official decoder ingest the
original text/chroma prefix and construct its first real cache normally.
"""
from functools import wraps
import inspect
import operator


def install_initial_cache_fix(model):
    """Install once on this instance; return True only for a new installation.

    Preserve the bound method signature for Hugging Face argument validation.
    Unexpected cache protocols fail explicitly rather than risk dropping the
    conditioning signal. No model classes, weights or package files are changed.
    """
    original = model.prepare_inputs_for_generation
    if getattr(original, '_muse_initial_cache_fix', False):
        return False
    signature = inspect.signature(original)
    if 'past_key_values' not in signature.parameters:
        raise TypeError('The MusicGen preparation method has no supported past_key_values parameter.')

    @wraps(original)
    def prepare_with_initial_cache(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        cache = bound.arguments.get('past_key_values')
        if cache is not None:
            get_length = getattr(cache, 'get_seq_length', None)
            if not callable(get_length):
                raise TypeError('The MusicGen cache does not expose get_seq_length().')
            length = get_length()
            if isinstance(length, bool):
                raise TypeError('The MusicGen cache sequence length must be an integer.')
            length = operator.index(length)
            if length < 0:
                raise ValueError('The MusicGen cache sequence length cannot be negative.')
            if length == 0:
                bound.arguments['past_key_values'] = None
        return original(*bound.args, **bound.kwargs)

    prepare_with_initial_cache._muse_initial_cache_fix = True
    model.prepare_inputs_for_generation = prepare_with_initial_cache
    return True
