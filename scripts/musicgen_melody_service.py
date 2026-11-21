"""Opt-in loopback MusicGen inference. Imports/weights load on first generation.

This service never substitutes text-only generation. MusicGen's chroma conditioning
guides a generated full mix; it does not guarantee exact notes or note timing.
"""
import argparse
from array import array
import base64
import binascii
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import multiprocessing
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time
import traceback
import wave

MODEL = "facebook/musicgen-melody"
MAX_WAV_BYTES = 16 * 1024 * 1024
MAX_REQUEST_BYTES = ((MAX_WAV_BYTES + 2) // 3) * 4 + 8192


class RequestError(ValueError):
    pass


class JobConflict(RequestError):
    pass


class JobBusy(RuntimeError):
    pass


class GenerationCancelled(RuntimeError):
    pass


def check_cancel(prepared):
    event = prepared.get('_cancel')
    if event is not None and event.is_set():
        raise GenerationCancelled('Generation cancelled.')
    deadline = prepared.get('_deadline')
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError('Local CPU generation exceeded its deadline.')


def decode_wav(audio_bytes, max_seconds=60):
    if not 46 <= len(audio_bytes) <= MAX_WAV_BYTES:
        raise RequestError("Supply a nonempty PCM16 WAV within the audio size limit.")
    if audio_bytes[:4] != b"RIFF" or audio_bytes[8:12] != b"WAVE" or int.from_bytes(audio_bytes[4:8], "little") != len(audio_bytes) - 8:
        raise RequestError("The recorded WAV has an invalid container length or header.")
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as audio:
            channels, width, rate = audio.getnchannels(), audio.getsampwidth(), audio.getframerate()
            frames = audio.getnframes()
            if channels not in (1, 2) or width != 2 or not 8000 <= rate <= 96000 or not 0 < frames <= rate * max_seconds or audio.getcomptype() != "NONE":
                raise RequestError("Audio must be mono/stereo PCM16 WAV, 8–96 kHz, at most 60 seconds.")
            pcm = audio.readframes(frames)
            if len(pcm) != frames * channels * 2:
                raise RequestError("The WAV data is truncated.")
    except (wave.Error, EOFError) as error:
        raise RequestError("The recorded WAV could not be decoded.") from error
    integers = array("h")
    integers.frombytes(pcm)
    if sys.byteorder != "little":
        integers.byteswap()
    # Preserve every PCM sample and interleaved channel; no pitch or time scaling.
    samples = array("f", (sample / 32768.0 for sample in integers))
    return samples, rate, channels


def prepare_request(payload):
    if not isinstance(payload, dict):
        raise RequestError("A JSON object is required.")
    encoded, prompt, duration = payload.get("audioWavBase64"), payload.get("prompt"), payload.get("duration")
    if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_REQUEST_BYTES:
        raise RequestError("Actual recorded audio is required for melody conditioning.")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000:
        raise RequestError("Supply a music direction of at most 4000 characters.")
    if isinstance(duration, bool) or not isinstance(duration, (float, int)) or not math.isfinite(duration) or not 0 < duration <= 30:
        raise RequestError("Generation duration must be greater than 0 and at most 30 seconds.")
    try:
        audio_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise RequestError("The recorded audio must be valid base64 WAV data.") from error
    samples, rate, channels = decode_wav(audio_bytes)
    return {"audioWav": audio_bytes, "samples": samples, "sampleRate": rate, "channels": channels, "prompt": prompt.strip(), "duration": duration}


def generate_response(payload, inference):
    prepared = prepare_request(payload)
    return response_for(prepared, inference)


def response_for(prepared, inference):
    output, sample_rate = inference(prepared)
    check_cancel(prepared)
    _, actual_rate, _ = decode_wav(output, max_seconds=30)
    if actual_rate != sample_rate:
        raise RuntimeError("The generated sample rate does not match its WAV header.")
    result = {
        "audioWavBase64": base64.b64encode(output).decode("ascii"), "model": MODEL, "sampleRate": sample_rate,
        "conditioning": {"audioSha256": hashlib.sha256(prepared["audioWav"]).hexdigest(), "inputBytes": len(prepared["audioWav"]), "mode": "audio-melody"},
    }
    if prepared.get('_verification'):
        result['conditioning']['pipeline'] = prepared['_verification']
    return result


class AudioCraftGenerator:
    def __init__(self, device="auto"):
        self.device = device
        self.model = None
        self.torch = None

    def __call__(self, prepared):
        check_cancel(prepared)
        if self.model is None:
            prepared.get('_progress', lambda *_: None)('loading', None, None)
            import torch
            from audiocraft.models import MusicGen
            device = ("cuda" if torch.cuda.is_available() else "cpu") if self.device == "auto" else self.device
            model = MusicGen.get_pretrained(MODEL, device=device)
            self.torch, self.model = torch, model
        torch, model = self.torch, self.model
        audio = torch.tensor(prepared["samples"], dtype=torch.float32).reshape(-1, prepared["channels"]).transpose(0, 1).unsqueeze(0)
        model.set_generation_params(duration=prepared["duration"])
        check_cancel(prepared)
        if hasattr(model, 'set_custom_progress_callback'):
            def progress(done, total):
                check_cancel(prepared)
                prepared.get('_progress', lambda *_: None)('generating', done, total)
            model.set_custom_progress_callback(progress)
        with torch.inference_mode():
            kwargs = {'progress': True} if hasattr(model, 'set_custom_progress_callback') else {}
            generated = model.generate_with_chroma([prepared["prompt"]], audio, prepared["sampleRate"], **kwargs)
        waveform = generated[0].detach().cpu().clamp(-1, 1)
        # A signed PCM16 WAV makes the local boundary independent of codec packages.
        pcm = (waveform.transpose(0, 1) * 32767).round().to(torch.int16).contiguous().numpy().astype("<i2").tobytes()
        output = io.BytesIO()
        with wave.open(output, "wb") as audio_file:
            audio_file.setnchannels(waveform.shape[0])
            audio_file.setsampwidth(2)
            audio_file.setframerate(model.sample_rate)
            audio_file.writeframes(pcm)
        return output.getvalue(), model.sample_rate


def conditioning_audio(prepared, target_rate):
    import numpy as np
    from scipy.signal import resample_poly
    channels = np.asarray(prepared['samples'], dtype=np.float32).reshape(-1, prepared['channels'])
    # Stereo microphone channels can be opposite-phase. Match Muse's strongest
    # channel policy instead of cancelling the original hum with a downmix.
    energies = np.mean(channels ** 2, axis=0)
    samples = channels[:, int(np.argmax(energies))]
    if float(np.max(np.abs(samples))) < 1e-5 or float(np.sqrt(np.max(energies))) < 1e-6:
        raise RequestError('The original recording is silent; record an audible melody.')
    if prepared['sampleRate'] != target_rate:
        divisor = math.gcd(target_rate, prepared['sampleRate'])
        samples = resample_poly(samples, target_rate // divisor, prepared['sampleRate'] // divisor).astype(np.float32)
    return samples


class TransformersGenerator:
    """Official implementation of the same checkpoint; no text-only fallback.

    Dynamic int8 decoder weights reduce CPU RAM use. The encoder/codec remain
    floating point. Quantization is opt-in and must be assessed by listening.
    """
    def __init__(self, cache_dir=None, quantize=False, threads=4):
        self.cache_dir = cache_dir
        self.quantize = quantize
        self.threads = threads
        self.model = None
        self.processor = None

    def load(self):
        if self.model is not None:
            return
        import torch
        from transformers import MusicgenMelodyProcessor, MusicgenMelodyForConditionalGeneration
        try:
            from musicgen_compat import install_initial_cache_fix
        except ModuleNotFoundError:
            from scripts.musicgen_compat import install_initial_cache_fix
        torch.set_num_threads(self.threads)
        if torch.get_num_interop_threads() != 1:
            torch.set_num_interop_threads(1)
        processor = MusicgenMelodyProcessor.from_pretrained(MODEL, cache_dir=self.cache_dir)
        model = MusicgenMelodyForConditionalGeneration.from_pretrained(
            MODEL, cache_dir=self.cache_dir, torch_dtype=torch.float32,
            low_cpu_mem_usage=True, use_safetensors=True, attn_implementation='eager',
        ).eval()
        install_initial_cache_fix(model)
        # Only the decoder advertises SDPA; T5/text and EnCodec stay eager.
        model.decoder.set_attn_implementation('sdpa')
        if model.decoder.config._attn_implementation != 'sdpa':
            raise RuntimeError('The installed decoder cannot enable the supported CPU attention implementation.')
        if self.quantize:
            torch.ao.quantization.quantize_dynamic(model.decoder, {torch.nn.Linear}, dtype=torch.qint8, inplace=True)
        self.processor, self.model = processor, model

    def __call__(self, prepared):
        import numpy as np
        import torch
        from transformers import StoppingCriteria, StoppingCriteriaList
        try:
            from musicgen_conditioning import verify_conditioning
        except ModuleNotFoundError:
            from scripts.musicgen_conditioning import verify_conditioning
        callback = prepared.get('_progress', lambda *_: None)
        check_cancel(prepared)
        samples = conditioning_audio(prepared, 32000)
        callback('loading', None, None)
        self.load()
        check_cancel(prepared)
        rate = int(self.processor.feature_extractor.sampling_rate)
        if rate != 32000:
            samples = conditioning_audio(prepared, rate)
        # Raw mono audio and its actual resampled rate enter the official chroma
        # feature extractor. Original WAV remains unchanged in the input receipt.
        inputs = self.processor(audio=samples, sampling_rate=rate, text=[prepared['prompt']], padding=True, return_tensors='pt')
        features = inputs.get('input_features')
        if features is None or not torch.isfinite(features).all() or not torch.count_nonzero(features):
            raise RequestError('The recording produced no usable melody-conditioning features.')
        total = max(1, round(prepared['duration'] * 50))
        class Progress(StoppingCriteria):
            def __call__(self, input_ids, scores, **kwargs):
                check_cancel(prepared)
                callback('generating', min(total, max(0, input_ids.shape[-1] - 1)), total)
                return False
        callback('generating', 0, total)
        self.last_verification = None
        with torch.inference_mode(), verify_conditioning(self.model, inputs) as verification:
            generated = self.model.generate(**inputs, do_sample=True, guidance_scale=3,
                max_new_tokens=total, stopping_criteria=StoppingCriteriaList([Progress()]))
        self.last_verification = dict(verification)
        check_cancel(prepared)
        callback('preparing', None, None)
        waveform = generated[0].detach().float().cpu().numpy()
        sample_rate = int(self.model.config.audio_encoder.sampling_rate)
        if waveform.ndim != 2 or not np.isfinite(waveform).all():
            raise RuntimeError('MusicGen returned invalid audio samples.')
        peak = float(np.max(np.abs(waveform)))
        rms = float(np.sqrt(np.mean(waveform ** 2)))
        if peak < 1e-5 or rms < 1e-6:
            raise RuntimeError('MusicGen returned silent audio; no preview was published.')
        # Basic volume adjustment only: bounded gain and a -1 dBFS peak ceiling.
        gain = min(4.0, .14 / max(rms, 1e-12), .891 / peak)
        pcm = np.rint(np.clip(waveform * gain, -.999, .999).T * 32767).astype('<i2').tobytes()
        stream = io.BytesIO()
        with wave.open(stream, 'wb') as output:
            output.setnchannels(waveform.shape[0])
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(pcm)
        return stream.getvalue(), sample_rate


def inference_process(connection, cancelled, backend, options):
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        pass
    generator = TransformersGenerator(**options) if backend == 'transformers' else AudioCraftGenerator(**options)
    while True:
        try:
            prepared = connection.recv()
        except EOFError:
            return
        prepared['_cancel'] = cancelled
        prepared['_progress'] = lambda stage, done=None, total=None: connection.send(('progress', stage, done, total))
        try:
            output = generator(prepared)
            connection.send(('result', output, getattr(generator, 'last_verification', None)))
        except GenerationCancelled:
            connection.send(('cancelled',))
        except Exception as error:
            traceback.print_exc()
            connection.send(('error', type(error).__name__))


class SupervisedGenerator:
    """Persistent model child with a parent-enforced timeout/cancellation bound."""
    def __init__(self, backend, options, cancel_grace=10):
        self.backend, self.options, self.cancel_grace = backend, options, cancel_grace
        self.model = None
        self.device = 'cpu' if backend == 'transformers' else options.get('device', 'auto')
        self.process = None
        self.connection = None
        self.cancelled = None

    def _stop(self):
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=3)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=2)
            self.process.close()
        if self.connection is not None:
            self.connection.close()
        self.process = self.connection = self.cancelled = None
        self.model = None

    def __call__(self, prepared):
        try:
            return self._generate(prepared)
        except BaseException:
            # Never let an old pipe result enter the next recording's job.
            self._stop()
            raise

    def _generate(self, prepared):
        if self.process is None or not self.process.is_alive():
            self._stop()
            context = multiprocessing.get_context('spawn')
            parent, child = context.Pipe()
            self.cancelled = context.Event()
            self.process = context.Process(target=inference_process, args=(child, self.cancelled, self.backend, self.options), daemon=True)
            self.process.start()
            child.close()
            self.connection = parent
        self.cancelled.clear()
        sent = threading.Event()
        dispatch_error = []
        connection = self.connection
        def dispatch():
            try:
                connection.send({key:value for key,value in prepared.items() if not key.startswith('_')})
            except Exception as error:
                dispatch_error.append(error)
            finally:
                sent.set()
        threading.Thread(target=dispatch, daemon=True).start()
        while not sent.wait(.1):
            # A child stuck before recv must not block the HTTP worker forever.
            check_cancel(prepared)
            if not self.process.is_alive():
                raise RuntimeError('MusicGen worker exited during input dispatch.')
        if dispatch_error:
            raise RuntimeError('MusicGen input dispatch failed.') from dispatch_error[0]
        stopping = None
        while True:
            try:
                check_cancel(prepared)
            except (GenerationCancelled, TimeoutError) as error:
                self.cancelled.set()
                if stopping is None:
                    stopping = (time.monotonic(), error)
                if time.monotonic() - stopping[0] >= self.cancel_grace:
                    self._stop()
                    raise stopping[1]
            if not self.process.is_alive():
                self._stop()
                raise RuntimeError('MusicGen worker exited without a result (possibly insufficient memory).')
            if not self.connection.poll(.1):
                continue
            message = self.connection.recv()
            if message[0] == 'progress':
                if message[1] != 'loading':
                    self.model = True
                if stopping is None:
                    try:
                        prepared.get('_progress', lambda *_: None)(*message[1:])
                    except (GenerationCancelled, TimeoutError):
                        # Observe the stop in the supervising loop, which also
                        # terminates a child stuck inside loading or one token.
                        pass
            else:
                if stopping is not None:
                    raise stopping[1]
                if message[0] == 'result':
                    self.model = True
                    if len(message) > 2 and message[2]:
                        prepared['_verification'] = message[2]
                    return message[1]
                if message[0] == 'cancelled':
                    raise GenerationCancelled('Generation cancelled.')
                raise RuntimeError(f'MusicGen worker failed ({message[1]}).')

    def close(self):
        self._stop()


class GenerationJobs:
    """One compute slot, finite queue/retention, recoverable request IDs."""
    def __init__(self, generator, max_queue=2, max_jobs=12, ttl=1800, timeout=1800):
        self.generator, self.max_queue, self.max_jobs = generator, max_queue, max_jobs
        self.ttl, self.timeout = ttl, timeout
        self.jobs = {}
        self.tombstones = {}
        self.lock = threading.RLock()
        self.closed = False
        self.active = None

    def _expire(self):
        now = time.monotonic()
        for identifier, job in list(self.jobs.items()):
            if job['status'] in ('succeeded', 'failed', 'cancelled') and now - job['_updated'] > self.ttl:
                del self.jobs[identifier]
        self.tombstones = {key:value for key,value in self.tombstones.items() if now - value < self.ttl}

    def _public(self, job):
        value = {key:value for key,value in job.items() if not key.startswith('_')}
        value['elapsedSeconds'] = round(time.monotonic() - job['_started'], 3) if job['status'] in ('running', 'cancelling') else job.get('elapsedSeconds', 0)
        return value

    def submit(self, payload):
        identifier = payload.get('requestId') if isinstance(payload, dict) else None
        if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', identifier):
            raise RequestError('Supply a safe requestId of at most 100 characters.')
        prepared = prepare_request(payload)
        fingerprint = hashlib.sha256(prepared['audioWav'] + json.dumps([prepared['prompt'], prepared['duration']], separators=(',', ':')).encode()).hexdigest()
        with self.lock:
            self._expire()
            if identifier in self.tombstones:
                return {'id':identifier, 'status':'cancelled', 'stage':'loading', 'progress':None, 'error':None, 'elapsedSeconds':0}
            if identifier in self.jobs:
                if self.jobs[identifier]['_fingerprint'] != fingerprint:
                    raise JobConflict('This requestId already belongs to a different request.')
                return self._public(self.jobs[identifier])
            pending = sum(job['status'] in ('queued', 'running', 'cancelling') for job in self.jobs.values())
            while len(self.jobs) >= self.max_jobs:
                old = next((key for key,job in self.jobs.items() if job['status'] in ('succeeded', 'failed', 'cancelled')), None)
                if old is None:
                    break
                del self.jobs[old]
            if self.closed or len(self.jobs) >= self.max_jobs or pending >= 1 + self.max_queue:
                raise JobBusy('Local inference capacity is occupied. Wait and retry.')
            now = time.monotonic()
            self.jobs[identifier] = dict(id=identifier, status='queued', stage='loading', progress=None, error=None,
                elapsedSeconds=0, _prepared=prepared, _fingerprint=fingerprint, _cancel=threading.Event(), _started=now, _updated=now)
            self._start_next()
            return self._public(self.jobs[identifier])

    def _start_next(self):
        if self.active is not None or self.closed:
            return
        for identifier, job in self.jobs.items():
            if job['status'] == 'queued':
                self.active = identifier
                job.update(status='running', _started=time.monotonic())
                threading.Thread(target=self._run, args=(identifier,), daemon=True).start()
                return

    def _run(self, identifier):
        with self.lock:
            job = self.jobs[identifier]
            prepared = job['_prepared']
            prepared.update(_cancel=job['_cancel'], _deadline=time.monotonic() + self.timeout)
            def progress(stage, completed=None, total=None):
                check_cancel(prepared)
                with self.lock:
                    job.update(stage=stage, progress={'completed':int(completed), 'total':int(total)} if completed is not None and total else None, _updated=time.monotonic())
            prepared['_progress'] = progress
        try:
            result = response_for(prepared, self.generator)
            with self.lock:
                check_cancel(prepared)
                job.update(status='succeeded', stage='ready', result=result, progress=None)
        except GenerationCancelled:
            with self.lock:
                job.update(status='cancelled', progress=None)
        except Exception as error:
            print(f'MusicGen job failed ({type(error).__name__}); no fallback audio produced.', file=sys.stderr, flush=True)
            traceback.print_exc()
            with self.lock:
                job.update(status='failed', error='Local MusicGen inference failed. Check the service log and available memory; no substitute audio was generated.', progress=None)
        finally:
            with self.lock:
                prepared.pop('_progress', None)
                prepared.pop('_cancel', None)
                job.update(elapsedSeconds=round(time.monotonic() - job['_started'], 3), _updated=time.monotonic())
                job.pop('_prepared', None)
                self.active = None
                self._start_next()

    def get(self, identifier):
        with self.lock:
            self._expire()
            if identifier not in self.jobs:
                if identifier in self.tombstones:
                    return {'id':identifier, 'status':'cancelled', 'stage':'loading', 'progress':None, 'error':None, 'elapsedSeconds':0}
                raise KeyError(identifier)
            return self._public(self.jobs[identifier])

    def cancel(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            if job is None:
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', identifier):
                    raise KeyError(identifier)
                self._expire()
                if len(self.tombstones) >= 64:
                    del self.tombstones[next(iter(self.tombstones))]
                self.tombstones[identifier] = time.monotonic()
                return self.get(identifier)
            if job['status'] in ('queued', 'running', 'cancelling'):
                job['_cancel'].set()
                if job['status'] == 'queued':
                    job.update(status='cancelled', _updated=time.monotonic())
                    job.pop('_prepared', None)
                else:
                    job['status'] = 'cancelling'
            return self._public(job)

    def close(self):
        with self.lock:
            self.closed = True
            for identifier in self.jobs:
                self.cancel(identifier)


def handler_for(generator, jobs=None):
    jobs = jobs or GenerationJobs(generator)
    class Handler(BaseHTTPRequestHandler):
        def allowed(self):
            host = self.headers.get('Host', '')
            if host != f'127.0.0.1:{self.server.server_port}' or self.headers.get('Origin'):
                self.send_json(403, {'error':'Only the local Muse server may access this inference service.'})
                return False
            return True

        def send_json(self, status, value):
            data = json.dumps(value, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if not self.allowed():
                return
            if self.path == '/health':
                process = getattr(generator, 'process', None)
                loaded = generator.model is not None and (not isinstance(generator, SupervisedGenerator) or (process is not None and process.is_alive()))
                with jobs.lock:
                    identifier = jobs.active
                    active = jobs.get(identifier) if identifier else None
                self.send_json(200, {'model':MODEL, 'conditioning':'audio-melody', 'loaded':loaded,
                    'ready':loaded and not active, 'status':active['stage'] if active else 'ready' if loaded else 'not-loaded',
                    'backend':getattr(generator, 'backend', 'audiocraft'),
                    'device':generator.device,
                    'capabilities':['jobs','progress','cancel']})
            elif self.path.startswith('/jobs/'):
                try:
                    self.send_json(200, jobs.get(self.path[6:]))
                except KeyError:
                    self.send_json(404, {'error':'Job not found or expired.'})
            else:
                self.send_json(404, {'error':'Not found'})

        def do_DELETE(self):
            if not self.allowed():
                return
            try:
                if not self.path.startswith('/jobs/'):
                    raise KeyError()
                self.send_json(200, jobs.cancel(self.path[6:]))
            except KeyError:
                self.send_json(404, {'error':'Job not found or expired.'})

        def do_POST(self):
            if not self.allowed():
                return
            if self.path not in ('/generate', '/jobs'):
                self.send_json(404, {"error": "Not found"})
                return
            try:
                if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json" or self.headers.get("Transfer-Encoding"):
                    raise RequestError("Send a bounded application/json request.")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_REQUEST_BYTES:
                    raise RequestError("The request is empty or exceeds the audio size limit.")
                self.connection.settimeout(15)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise RequestError("The request body is incomplete.")
                payload = json.loads(raw)
                if self.path == '/jobs':
                    self.send_json(202, jobs.submit(payload))
                else:
                    # Compatibility endpoint uses the same single compute slot.
                    import uuid
                    created = jobs.submit({**payload, 'requestId':str(uuid.uuid4())})
                    while created['status'] not in ('succeeded', 'failed', 'cancelled'):
                        time.sleep(.1)
                        created = jobs.get(created['id'])
                    self.send_json(200 if created['status'] == 'succeeded' else 503,
                        created.get('result', {'error':created['error'] or 'Generation cancelled.'}))
            except JobConflict as error:
                self.send_json(409, {'error':str(error)})
            except JobBusy as error:
                self.send_json(503, {'error':str(error)})
            except (RequestError, json.JSONDecodeError, UnicodeDecodeError, ValueError, TimeoutError):
                self.send_json(400, {"error": "Invalid melody request. Supply actual PCM16 WAV audio, a music direction and duration greater than 0 and at most 30 seconds."})
            except Exception as error:
                print(f"MusicGen inference failed ({type(error).__name__}). No fallback audio was produced.", file=sys.stderr)
                self.send_json(503, {"error": "MusicGen Melody inference is unavailable. Install compatible dependencies and weights on a capable machine; no fallback audio was produced."})

        def log_message(self, format, *args):
            # Keep recorded audio and request contents out of access logs.
            return
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3002)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument('--backend', choices=('audiocraft', 'transformers'), default='transformers')
    parser.add_argument('--cache-dir', default=str(Path(__file__).resolve().parents[1] / '.local' / 'musicgen-cache'))
    parser.add_argument('--quantize', action='store_true', help='Dynamic int8 decoder weights for low-memory CPU; quality must be evaluated.')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--timeout', type=int, default=1800)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if not 1 <= args.threads <= 32 or not 10 <= args.timeout <= 3600:
        parser.error('threads must be 1–32 and timeout 10–3600 seconds')
    # Use the OS certificate store without disabling HTTPS verification.
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        pass
    options = dict(cache_dir=args.cache_dir, quantize=args.quantize, threads=args.threads) if args.backend == 'transformers' else dict(device=args.device)
    generator = SupervisedGenerator(args.backend, options)
    jobs = GenerationJobs(generator, timeout=args.timeout)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(generator, jobs))
    server.daemon_threads = True
    print(f"MusicGen Melody listening on http://127.0.0.1:{args.port}; model not loaded. First generation loads dependencies and weights.", flush=True)
    def stop_service(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_service)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        jobs.close()
        generator.close()
        server.server_close()


if __name__ == "__main__":
    main()
