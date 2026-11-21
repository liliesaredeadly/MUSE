"""Fail-closed verification of MusicGen Melody's initial conditioning path.

The guard observes genuine module calls; it neither supplies missing features
nor changes generation. PyTorch is imported only when verification is requested.
"""
from contextlib import contextmanager
import hashlib
import math


@contextmanager
def verify_conditioning(model, inputs):
    """Yield a plain receipt after observing text, audio and decoder boundaries.

    Transformers may append a null CFG batch before audio projection. Only the
    first original batch is compared. Subsequent cached decoder calls may omit
    the encoder prefix; the first decoder call must contain both conditions.
    """
    import torch

    def fail(message):
        raise RuntimeError('MusicGen conditioning verification failed: ' + message)

    features = inputs.get('input_features')
    token_ids = inputs.get('input_ids')
    if not isinstance(features, torch.Tensor) or features.ndim != 3 or min(features.shape) <= 0 or not torch.isfinite(features).all().item():
        fail('original audio features must be a finite nonempty 3D tensor.')
    if not isinstance(token_ids, torch.Tensor) or token_ids.ndim != 2 or min(token_ids.shape) <= 0 or token_ids.shape[0] != features.shape[0]:
        fail('original text IDs must be a nonempty batch matching the audio.')
    expected_features = features.detach().clone()
    expected_ids = token_ids.detach().clone()
    mask = inputs.get('attention_mask')
    expected_mask = mask.detach().clone() if isinstance(mask, torch.Tensor) else None
    chroma_length = getattr(getattr(model, 'config', None), 'chroma_length', None)
    if not isinstance(chroma_length, int) or isinstance(chroma_length, bool) or chroma_length <= 0:
        fail('the configured chroma prefix length is invalid.')
    batch, frames = features.shape[:2]
    tokens = token_ids.shape[1]
    report = {
        'textEncoderVerified': False,
        'audioProjectionVerified': False,
        'initialDecoderPrefixVerified': False,
        'featureSha256': hashlib.sha256(expected_features.cpu().contiguous().view(torch.uint8).numpy().tobytes()).hexdigest(),
        'textTokens': int(tokens), 'chromaFrames': int(frames),
        'decoderPrefixFrames': int(chroma_length + tokens),
    }
    captured = {}
    handles = []

    def argument(args, kwargs, name, position):
        return kwargs[name] if name in kwargs else args[position] if len(args) > position else None

    def positive_equal(actual, expected):
        return isinstance(actual, torch.Tensor) and actual.ndim == expected.ndim and actual.shape[0] >= batch and torch.equal(actual[:batch], expected)

    def text_hook(module, args, kwargs):
        actual_ids = argument(args, kwargs, 'input_ids', 0)
        if not positive_equal(actual_ids, expected_ids):
            fail('the text encoder did not receive the original positive text IDs.')
        actual_mask = argument(args, kwargs, 'attention_mask', 1)
        if actual_mask is not None and (expected_mask is None or not positive_equal(actual_mask, expected_mask)):
            fail('the text encoder attention mask differs from the original.')
        report['textEncoderVerified'] = True

    def audio_hook(module, args, output):
        if not args or not positive_equal(args[0], expected_features):
            fail('the audio projection did not receive the original positive audio features.')
        if not isinstance(output, torch.Tensor) or output.ndim != 3 or output.shape[0] < batch or output.shape[1] != frames or not torch.isfinite(output).all().item():
            fail('the audio projection returned an invalid tensor.')
        captured['projected'] = output[:batch].detach().clone()
        report['audioProjectionVerified'] = True

    def decoder_hook(module, args, kwargs):
        if report['initialDecoderPrefixVerified']:
            return
        if not report['textEncoderVerified'] or not report['audioProjectionVerified']:
            fail('the first decoder call bypassed the text encoder or audio projection.')
        prefix = argument(args, kwargs, 'encoder_hidden_states', 2)
        if not isinstance(prefix, torch.Tensor) or prefix.ndim != 3 or prefix.shape[0] < batch or prefix.shape[1] != chroma_length + tokens or not torch.isfinite(prefix).all().item():
            fail('the initial decoder prefix is missing, nonfinite or has the wrong length.')
        projected = captured['projected']
        expected_audio = projected.repeat(1, math.ceil(chroma_length / frames), 1)[:, :chroma_length]
        if not torch.equal(prefix[:batch, :chroma_length], expected_audio):
            fail('the initial decoder audio prefix differs from the projected original features.')
        text_part = prefix[:batch, chroma_length:]
        if not torch.any(text_part != 0, dim=(1, 2)).all().item():
            fail('the initial decoder text prefix is empty for a positive batch item.')
        report['initialDecoderPrefixVerified'] = True

    try:
        handles.append(model.text_encoder.register_forward_pre_hook(text_hook, with_kwargs=True))
        handles.append(model.audio_enc_to_dec_proj.register_forward_hook(audio_hook))
        handles.append(model.decoder.register_forward_pre_hook(decoder_hook, with_kwargs=True))
        yield report
        if not all(report[key] for key in ('textEncoderVerified', 'audioProjectionVerified', 'initialDecoderPrefixVerified')):
            fail('generation did not traverse every required conditioning boundary.')
    finally:
        for handle in handles:
            handle.remove()
        captured.clear()
