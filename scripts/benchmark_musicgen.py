"""Run actual local MusicGen Melody jobs on explicitly synthetic test recordings.

Nothing in this harness produces replacement music: only successful, validated
WAVs returned by the local model are saved as generated outputs. The five source
recordings are new harmonic test signals, not human takes or copyrighted tunes.
Requires NumPy. Do not confuse its acoustic comparison with a listening test or
proof of exact melody preservation.
"""
import argparse
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPDefaultErrorHandler, HTTPErrorProcessor, HTTPHandler, HTTPRedirectHandler, OpenerDirector, ProxyHandler, Request
import uuid
import wave

import numpy as np


MODEL = 'facebook/musicgen-melody'
ROOT = Path(__file__).resolve().parents[1]
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 12 * 1024 * 1024
MAX_RESPONSE_BYTES = ((MAX_OUTPUT_BYTES + 2) // 3) * 4 + 8192
TERMINAL = {'succeeded', 'failed', 'cancelled'}
SYNTHETIC_FIXTURES = ('acoustic', 'pop', 'orchestra', 'edm', 'piano')


class BenchmarkError(RuntimeError):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LocalClient:
    """Literal loopback only; bypass environment proxies and refuse redirects."""
    def __init__(self, base_url):
        parsed = urlsplit(base_url)
        if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', '::1')
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/') or not parsed.port):
            raise ValueError('Use an explicit literal-loopback URL such as http://127.0.0.1:3002.')
        self.base_url = base_url.rstrip('/')
        # This client accepts only HTTP. Avoid constructing urllib's unused
        # HTTPS handler, which can initialize unrelated machine TLS settings.
        self.opener = OpenerDirector()
        for handler in (ProxyHandler({}), HTTPHandler(), HTTPDefaultErrorHandler(), NoRedirect(), HTTPErrorProcessor()):
            self.opener.add_handler(handler)

    def request(self, method, path, payload=None, timeout=15):
        if not path.startswith('/') or path.startswith('//'):
            raise ValueError('Use a local service path.')
        body = json.dumps(payload, allow_nan=False).encode('utf-8') if payload is not None else None
        deadline = time.monotonic() + timeout
        for attempt in range(2):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BenchmarkError('The local service request exceeded its deadline.', 'SERVICE_TIMEOUT')
            request = Request(self.base_url + path, data=body, method=method,
                              headers={'Content-Type': 'application/json'} if body is not None else {})
            try:
                with self.opener.open(request, timeout=remaining) as response:
                    if int(response.headers.get('Content-Length', '0')) > MAX_RESPONSE_BYTES:
                        raise BenchmarkError('The local model response exceeded the output limit.', 'INVALID_MODEL_OUTPUT')
                    raw = response.read(MAX_RESPONSE_BYTES + 1)
                    if len(raw) > MAX_RESPONSE_BYTES:
                        raise BenchmarkError('The local model response exceeded the output limit.', 'INVALID_MODEL_OUTPUT')
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise BenchmarkError('The local service returned an invalid response.', 'INVALID_SERVICE_RESPONSE')
                return value
            except HTTPError as error:
                error.close()
                if error.code == 404:
                    raise BenchmarkError('The existing local inference job is unknown or has expired.', 'JOB_NOT_FOUND') from error
                if error.code in (429, 502, 503, 504) and attempt == 0:
                    continue
                raise BenchmarkError(f'The local service returned HTTP {error.code}.', 'SERVICE_HTTP_ERROR') from error
            except (URLError, TimeoutError, OSError) as error:
                if attempt:
                    timed_out = isinstance(error, TimeoutError) or isinstance(getattr(error, 'reason', None), TimeoutError)
                    raise BenchmarkError('The local model service could not be reached within the request deadline.', 'SERVICE_TIMEOUT' if timed_out else 'SERVICE_UNAVAILABLE') from error
        raise BenchmarkError('The local service request failed.', 'SERVICE_UNAVAILABLE')


def inspect_wav(data, max_seconds=60, max_bytes=MAX_INPUT_BYTES):
    if not 46 <= len(data) <= max_bytes or data[:4] != b'RIFF' or data[8:12] != b'WAVE' or int.from_bytes(data[4:8], 'little') != len(data) - 8:
        raise BenchmarkError('The audio is not a bounded, complete RIFF WAV.', 'INVALID_MODEL_OUTPUT')
    try:
        with wave.open(io.BytesIO(data), 'rb') as audio:
            channels, rate, frames = audio.getnchannels(), audio.getframerate(), audio.getnframes()
            if channels not in (1, 2) or audio.getsampwidth() != 2 or audio.getcomptype() != 'NONE' or not 8000 <= rate <= 96000 or not 0 < frames <= rate * max_seconds:
                raise BenchmarkError('Use PCM16 mono or stereo WAV within the supported audio clock.', 'INVALID_MODEL_OUTPUT')
            raw = audio.readframes(frames)
            if len(raw) != frames * channels * 2:
                raise BenchmarkError('The audio samples are truncated.', 'INVALID_MODEL_OUTPUT')
    except (wave.Error, EOFError) as error:
        raise BenchmarkError('The PCM WAV could not be decoded.', 'INVALID_MODEL_OUTPUT') from error
    samples = np.frombuffer(raw, dtype='<i2').astype(np.float32).reshape(-1, channels) / 32768.0
    # Keep channels separate for quality measurements; a mixdown is used only
    # for the explicitly approximate chroma comparison.
    stats = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'sampleRate': rate,
             'channels': channels, 'frames': frames, 'durationSeconds': frames / rate,
             'rms': float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))),
             'peak': float(np.max(np.abs(samples))), 'clippedSampleFraction': float(np.mean(np.abs(samples) >= 32767 / 32768))}
    return samples.mean(axis=1), stats


def synthetic_cases():
    profiles = [
        ('acoustic', [(60,.10,.55),(64,.85,.55),(67,1.60,.80),(69,2.65,.45),(67,3.35,.55),(64,4.20,.60),(62,5.10,.55)],
         'Warm acoustic folk-pop, fingerpicked steel-string guitar, a gentle upright bass and brushed percussion. Develop the supplied melody into a clear instrumental lead; keep the arrangement intimate with natural dynamics and a quiet ending.'),
        ('pop', [(62,.10,.25),(62,.60,.35),(65,1.15,.45),(69,1.90,.70),(67,2.85,.30),(65,3.40,.55),(64,4.15,.45),(62,4.90,.80)],
         'Bright contemporary instrumental pop, a clear piano melody, elastic electric bass, clean syncopated drums and light supporting strings. Let the supplied melody guide the main phrase; create an energetic, balanced mix without vocals.'),
        ('orchestra', [(55,.15,.95),(62,1.30,.75),(65,2.25,.95),(64,3.45,.60),(60,4.30,1.20)],
         'A lyrical chamber orchestra with a singing cello lead, soft violins, warm low strings and restrained timpani. Build a gentle crescendo around the supplied melody, preserve breathing space between phrases, and finish quietly. Instrumental.'),
        ('edm', [(57,.05,.24),(64,.50,.24),(69,.95,.40),(67,1.55,.24),(64,2.00,.24),(60,2.45,.40),(64,3.05,.24),(67,3.50,.24),(69,3.95,.40),(72,4.55,.24),(69,5.00,.55)],
         'An original melodic electronic dance instrumental, rounded synth lead, tight four-on-the-floor kick, a restrained sub bass and bright rhythmic accents. Use the supplied melody as the main motif; keep transients clear and avoid vocals or a huge noisy wall of sound.'),
        ('piano', [(67,.10,.65),(64,1.00,.45),(60,1.70,.75),(62,2.75,.40),(65,3.40,.60),(64,4.25,.45),(60,4.95,.75)],
         'An intimate solo acoustic piano instrumental, a lyrical right-hand melody guided by the supplied recording, sparse left-hand support, expressive soft dynamics and a natural room sound. Keep clear phrase endings and do not add drums or vocals.'),
    ]
    cases = []
    rate = 32000
    for identifier, melody, prompt in profiles:
        samples = np.zeros(6 * rate, dtype=np.float64)
        for midi, start, duration in melody:
            first, last = round(start * rate), round((start + duration) * rate)
            t = np.arange(last - first, dtype=np.float64) / rate
            frequency = 440 * 2 ** ((midi - 69) / 12)
            vibrato = 4.8
            phase = 2 * math.pi * frequency * (t + .004 * (1 - np.cos(2 * math.pi * vibrato * t)) / (2 * math.pi * vibrato))
            envelope = np.clip(np.minimum(np.minimum(t / .045, (duration - t) / .075), 1), 0, 1)
            samples[first:last] += .28 * envelope * (np.sin(phase) + .22 * np.sin(2 * phase) + .09 * np.sin(3 * phase))
        stream = io.BytesIO()
        with wave.open(stream, 'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(rate)
            audio.writeframes(np.rint(samples * 32767).astype('<i2').tobytes())
        cases.append({'id': identifier, 'audioWav': stream.getvalue(), 'prompt': prompt,
                      'sourceKind': 'original-synthetic-test-recording',
                      'notes': [{'midi': midi, 'start': start, 'duration': duration} for midi, start, duration in melody]})
    return cases


def chroma_frames(samples, rate):
    window = max(256, round(rate * .064))
    hop = max(1, round(rate * .032))
    if len(samples) < window:
        samples = np.pad(samples, (0, window - len(samples)))
    frames = np.lib.stride_tricks.sliding_window_view(samples, window)[::hop]
    n_fft = 1 << (window - 1).bit_length()
    magnitudes = np.abs(np.fft.rfft(frames * np.hanning(window), n=n_fft, axis=1))
    frequencies = np.fft.rfftfreq(n_fft, 1 / rate)
    valid = (frequencies >= 70) & (frequencies <= 4000)
    pitch_classes = np.rint(69 + 12 * np.log2(frequencies[valid] / 440)).astype(int) % 12
    chroma = np.zeros((len(frames), 12), dtype=np.float64)
    for pitch_class in range(12):
        chroma[:, pitch_class] = magnitudes[:, valid][:, pitch_classes == pitch_class].sum(axis=1)
    norms = np.linalg.norm(chroma, axis=1)
    voiced = norms > max(float(norms.max()) * .04, 1e-9)
    chroma /= np.maximum(norms[:, None], 1e-12)
    return chroma, voiced


def compare_chroma(source, source_rate, output, output_rate):
    original, voiced = chroma_frames(source, source_rate)
    generated, _ = chroma_frames(output, output_rate)
    # Compare the same relative positions despite different preview/source
    # lengths. This is a coarse acoustic descriptor, not transcription or DTW.
    positions = np.linspace(0, 1, 64)
    original_indices = np.rint(positions * (len(original) - 1)).astype(int)
    output_indices = np.rint(positions * (len(generated) - 1)).astype(int)
    use = voiced[original_indices]
    similarities = np.sum(original[original_indices] * generated[output_indices], axis=1)[use]
    a, b = original[voiced].mean(axis=0) if voiced.any() else np.zeros(12), generated.mean(axis=0)
    global_cosine = float(np.dot(a, b) / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-12))
    return {'method': 'NumPy STFT pitch-class energy; relative-time frame cosine',
            'meanRelativeFrameCosine': float(similarities.mean()) if len(similarities) else None,
            'globalChromaCosine': global_cosine, 'comparedRelativeFrames': int(use.sum()),
            'notProofOfExactMelody': True,
            'limitations': 'Chroma discards octave, timbre and exact notes. Polyphonic backing and relative-time alignment affect this score; it does not establish melody fidelity or musical quality.'}


def cancel_and_wait(client, identifier, poll):
    deadline = time.monotonic() + 60
    try:
        job = client.request('DELETE', '/jobs/' + identifier, timeout=10)
        if job.get('id') != identifier:
            return 'cancellation-unconfirmed'
        while job.get('status') not in TERMINAL and time.monotonic() < deadline:
            time.sleep(min(poll, max(0, deadline - time.monotonic())))
            job = client.request('GET', '/jobs/' + identifier, timeout=min(10, max(.1, deadline - time.monotonic())))
            if job.get('id') != identifier:
                return 'cancellation-unconfirmed'
        return job.get('status') if job.get('status') in TERMINAL else 'cancellation-unconfirmed'
    except Exception:
        return 'cancellation-unconfirmed'


def report_progress(message):
    print(message, flush=True)


def verified_pipeline(receipt, backend_status):
    pipeline = receipt.get('pipeline')
    if pipeline is None and (backend_status or {}).get('backend') == 'audiocraft':
        return False
    if not isinstance(pipeline, dict) or not all(pipeline.get(key) is True for key in
            ('textEncoderVerified', 'audioProjectionVerified', 'initialDecoderPrefixVerified')):
        raise BenchmarkError('The model output has no verified text, chroma-projection and initial-decoder conditioning path.', 'INVALID_CONDITIONING')
    feature_hash = pipeline.get('featureSha256')
    if not isinstance(feature_hash, str) or re.fullmatch(r'[0-9a-fA-F]{64}', feature_hash) is None:
        raise BenchmarkError('The model output has no valid conditioning-feature SHA-256.', 'INVALID_CONDITIONING')
    if not all(type(pipeline.get(key)) is int and pipeline[key] > 0 for key in
               ('textTokens', 'chromaFrames', 'decoderPrefixFrames')):
        raise BenchmarkError('The model output has no positive text/chroma/decoder-prefix frame counts.', 'INVALID_CONDITIONING')
    return True


def variety_report(cases):
    fixtures = [case for case in cases if case.get('fixtureId') in SYNTHETIC_FIXTURES
                and case.get('sourceKind') == 'original-synthetic-test-recording']
    successful = [case for case in fixtures if case.get('status') == 'succeeded']
    sources = {case['fixtureId']: case['source']['sha256'] for case in fixtures}
    outputs = {case['fixtureId']: case['output']['sha256'] for case in successful}
    features = {case['fixtureId']: case['conditioning']['pipeline']['featureSha256'].lower() for case in successful if case.get('pipelineVerified') is True}
    return {'expectedFixtureCount': 5, 'attemptedFixtureCount': len(fixtures), 'successfulFixtureCount': len(successful),
            'sourceHashes': sources, 'outputHashes': outputs, 'featureHashes': features,
            'uniqueSourceHashCount': len(set(sources.values())), 'uniqueOutputHashCount': len(set(outputs.values())),
            'uniqueFeatureHashCount': len(set(features.values())),
            'allFiveSourcesDistinct': len(sources) == 5 and len(set(sources.values())) == 5,
            'allFiveOutputsDistinct': len(outputs) == 5 and len(set(outputs.values())) == 5,
            'allFiveConditioningFeaturesDistinct': len(features) == 5 and len(set(features.values())) == 5,
            'notProofOfMelodyFidelity': True,
            'interpretation': 'Different source, output or feature hashes establish byte-level variety only. Pipeline checks establish which conditioning path executed; neither establishes exact notes, timing or perceptual musical quality.'}


def validate_result(result, source, duration, backend_status):
    """Pure validation shared by fresh inference and GET-only recovery."""
    if not isinstance(result, dict) or not isinstance(result.get('conditioning'), dict):
        raise BenchmarkError('The actual model result has no conditioning receipt.', 'INVALID_MODEL_OUTPUT')
    receipt = result['conditioning']
    if result.get('model') != MODEL or receipt.get('audioSha256') != source['sha256'] or receipt.get('inputBytes') != source['bytes'] or receipt.get('mode') != 'audio-melody':
        raise BenchmarkError('The actual model result does not match the original conditioning receipt.', 'INVALID_MODEL_OUTPUT')
    pipeline_verified = verified_pipeline(receipt, backend_status)
    try:
        output = base64.b64decode(result.get('audioWavBase64', ''), validate=True)
        generated, stats = inspect_wav(output, max_seconds=30, max_bytes=MAX_OUTPUT_BYTES)
    except Exception as error:
        raise BenchmarkError('The actual model returned invalid PCM16 audio.', 'INVALID_MODEL_OUTPUT') from error
    if result.get('sampleRate') != stats['sampleRate'] or abs(stats['durationSeconds'] - duration) > .15 or stats['rms'] <= 1 / 32768:
        raise BenchmarkError('The generated sample clock, duration or audio signal failed validation.', 'INVALID_MODEL_OUTPUT')
    return output, generated, stats, receipt, pipeline_verified


def save_validated_output(case, output_dir, original, source, validated):
    output, generated, stats, receipt, pipeline_verified = validated
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / (case['id'] + '-generated.wav')
    target.write_bytes(output)
    value = {'status': 'succeeded', 'conditioning': receipt, 'pipelineVerified': pipeline_verified,
             'output': {**stats, 'path': str(target.resolve())}}
    try:
        value['chromaComparison'] = compare_chroma(original, source['sampleRate'], generated, stats['sampleRate'])
    except Exception as error:
        value['chromaComparison'] = {'available': False, 'errorType': type(error).__name__, 'notProofOfExactMelody': True}
    return value


def run_case(client, case, output_dir, duration=8, timeout=1800, poll=2, log=report_progress, backend_status=None):
    original, source = inspect_wav(case['audioWav'])
    identifier = 'bench-' + case['id'] + '-' + uuid.uuid4().hex[:16]
    report = {'fixtureId': case['id'], 'sourceKind': case['sourceKind'], 'source': source,
              'prompt': case['prompt'], 'requestId': identifier, 'requestedPreviewSeconds': duration,
              'timeoutSeconds': timeout, 'backendStatus': backend_status, 'model': MODEL,
              'status': 'running', 'exactMelodyVerified': False, 'syntheticMelodyNotes': case.get('notes')}
    started = time.monotonic()
    deadline = started + timeout
    payload = {'requestId': identifier, 'audioWavBase64': base64.b64encode(case['audioWav']).decode('ascii'), 'prompt': case['prompt'], 'duration': duration}
    previous = None
    last_log = 0
    try:
        log(f"[{case['id']}] actual local inference: {duration:g}s preview from {source['durationSeconds']:g}s {case['sourceKind']} ({source['bytes']} bytes)")
        job = client.request('POST', '/jobs', payload, timeout=min(15, timeout))
        while True:
            if job.get('id') != identifier or job.get('status') not in TERMINAL | {'queued', 'running', 'cancelling'}:
                raise BenchmarkError('The service returned an inconsistent job identity or state.', 'INVALID_SERVICE_RESPONSE')
            report['providerTerminalStatus'] = job['status']
            state = (job.get('status'), job.get('stage'))
            now = time.monotonic()
            if state != previous or now - last_log >= 15:
                progress = job.get('progress')
                tokens = f" tokens {progress['completed']}/{progress['total']}" if isinstance(progress, dict) and 'completed' in progress and 'total' in progress else ''
                log(f"[{case['id']}] {job['status']}/{job.get('stage', 'unknown')}{tokens}; {now - started:.1f}s elapsed")
                previous, last_log = state, now
            if job['status'] in TERMINAL:
                break
            if now >= deadline:
                raise BenchmarkError('The benchmark wall-clock deadline expired; cancellation was requested.', 'BENCHMARK_TIMEOUT')
            time.sleep(min(poll, deadline - now))
            job = client.request('GET', '/jobs/' + identifier, timeout=min(60, max(.1, deadline - time.monotonic())))
        report['modelSeconds'] = job.get('elapsedSeconds')
        if job['status'] != 'succeeded':
            raise BenchmarkError(job.get('error') or f"The actual model job ended {job['status']}.", 'MODEL_' + job['status'].upper())
        result = job.get('result', {})
        report['conditioning'] = result.get('conditioning') if isinstance(result, dict) else None
        report.update(save_validated_output(case, output_dir, original, source, validate_result(result, source, duration, backend_status)))
        stats = report['output']
        log(f"[{case['id']}] saved actual model WAV: {stats['durationSeconds']:.2f}s, RMS {stats['rms']:.4f}, peak {stats['peak']:.4f}")
    except Exception as error:
        code = error.code if isinstance(error, BenchmarkError) else 'SERVICE_TIMEOUT' if isinstance(error, TimeoutError) else 'BENCHMARK_ERROR'
        report.update(status='failed', error={'code': code, 'message': str(error)[:500]}, fallbackAudioProduced=False)
        # Even a malformed/ambiguous response can follow accepted inference.
        # Cancel by the stable identity unless a terminal state was confirmed.
        if report.get('providerTerminalStatus') not in TERMINAL:
            report['providerTerminalStatus'] = cancel_and_wait(client, identifier, poll)
        log(f"[{case['id']}] failed: {code}; no fallback audio saved")
    finally:
        report['wallSeconds'] = round(time.monotonic() - started, 3)
    return report


def recorded_run(report):
    """For an aggregate choose its latest run; direct per-run reports also work."""
    if isinstance(report, dict) and isinstance(report.get('cases'), list):
        return report
    if isinstance(report, dict) and isinstance(report.get('runs'), list) and report['runs']:
        return recorded_run(report['runs'][-1])
    raise ValueError('The recovery source must contain a benchmark run with recorded cases.')


def recover_case(client, record, case, output_dir, timeout=300, poll=2, log=report_progress):
    """GET existing compute only. Never submit, cancel or replace inference."""
    started = time.monotonic()
    identifier = record.get('requestId')
    report = {'fixtureId': record.get('fixtureId'), 'requestId': identifier, 'status': 'running',
              'sourceKind': record.get('sourceKind'), 'originalStatus': record.get('status'),
              'originalError': record.get('error'), 'recoveredExistingJob': True, 'newInferenceSubmitted': False,
              'backendStatus': record.get('backendStatus'), 'exactMelodyVerified': False}
    try:
        if not case:
            raise BenchmarkError('The original source fixture is unavailable; no request was sent.', 'SOURCE_UNAVAILABLE')
        original, source = inspect_wav(case['audioWav'])
        duration = record.get('requestedPreviewSeconds')
        recorded_source = record.get('source') or {}
        if (record.get('fixtureId') != case['id'] or record.get('sourceKind') != case['sourceKind']
                or record.get('prompt') != case['prompt'] or recorded_source.get('sha256') != source['sha256']
                or recorded_source.get('bytes') != source['bytes'] or type(duration) not in (int, float)
                or not math.isfinite(duration) or not 0 < duration <= 30
                or not isinstance(identifier, str) or re.fullmatch(r'[A-Za-z0-9_-]{1,100}', identifier) is None):
            raise BenchmarkError('The reconstructed source, prompt, duration or request identity does not match the recorded benchmark.', 'RECORD_MISMATCH')
        report.update(source=source, prompt=case['prompt'], requestedPreviewSeconds=duration, model=MODEL,
                      syntheticMelodyNotes=case.get('notes'))
        deadline = time.monotonic() + min(timeout, 300)
        previous = None
        last_log = 0
        while True:
            now = time.monotonic()
            if now >= deadline:
                raise BenchmarkError('The finite recovery wait expired; the existing job was left unchanged.', 'RECOVERY_TIMEOUT')
            job = client.request('GET', '/jobs/' + identifier, timeout=min(60, max(.1, deadline - now)))
            if job.get('id') != identifier or job.get('status') not in TERMINAL | {'queued', 'running', 'cancelling'}:
                raise BenchmarkError('The existing job returned an inconsistent identity or state.', 'INVALID_SERVICE_RESPONSE')
            report['providerTerminalStatus'] = job['status']
            state = (job['status'], job.get('stage'))
            now = time.monotonic()
            if state != previous or now - last_log >= 15:
                log(f"[{case['id']}] recovering existing {job['status']}/{job.get('stage', 'unknown')}; {now - started:.1f}s elapsed; no new inference")
                previous, last_log = state, now
            if job['status'] in TERMINAL:
                break
            time.sleep(min(poll, max(0, deadline - now)))
        report['modelSeconds'] = job.get('elapsedSeconds')
        if job['status'] != 'succeeded':
            raise BenchmarkError(job.get('error') or f"The existing job ended {job['status']}.", 'EXISTING_JOB_' + job['status'].upper())
        result = job.get('result', {})
        report['conditioning'] = result.get('conditioning') if isinstance(result, dict) else None
        validated = validate_result(result, source, duration, record.get('backendStatus'))
        expected_output_hash = (record.get('output') or {}).get('sha256')
        if expected_output_hash is not None and expected_output_hash != validated[2]['sha256']:
            raise BenchmarkError('The existing result differs from its previously recorded output hash.', 'INVALID_MODEL_OUTPUT')
        report.update(save_validated_output(case, output_dir, original, source, validated))
        log(f"[{case['id']}] recovered and verified existing WAV; no model generation requested")
    except Exception as error:
        code = error.code if isinstance(error, BenchmarkError) else 'SERVICE_TIMEOUT' if isinstance(error, TimeoutError) else 'RECOVERY_ERROR'
        report.update(status='failed', error={'code': code, 'message': str(error)[:500]}, fallbackAudioProduced=False)
        log(f"[{record.get('fixtureId', 'unknown')}] recovery failed: {code}; existing compute unchanged")
    finally:
        report['wallSeconds'] = round(time.monotonic() - started, 3)
    return report


def recover_report(client, source_report, cases, output_root, target_report, timeout=300, poll=2, log=report_progress):
    source_report, target_report = Path(source_report), Path(target_report)
    if source_report.resolve() == target_report.resolve():
        raise ValueError('Recovery must write a separate report; the original benchmark report cannot be overwritten.')
    original = recorded_run(json.loads(source_report.read_text(encoding='utf-8-sig')))
    run_id = 'recovery-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:6]
    output_dir = Path(output_root) / 'recovery' / run_id
    run = {'runId': run_id, 'sourceRunId': original.get('runId'), 'sourceReport': str(source_report.resolve()),
           'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'newInferenceSubmitted': False,
           'description': 'GET-only recovery of recorded local model jobs. Original benchmark failures remain unchanged.', 'cases': []}
    try:
        aggregate = json.loads(target_report.read_text(encoding='utf-8')) if target_report.exists() else {}
        if not isinstance(aggregate.get('runs'), list):
            aggregate = {}
    except (ValueError, OSError):
        aggregate = {}
    aggregate.update(schemaVersion=1, benchmark='existing-local-musicgen-job-recovery', metricsAreNotProofOfExactMelody=True)
    aggregate.setdefault('runs', []).append(run)
    aggregate['runs'] = aggregate['runs'][-20:]
    lookup = {case['id']: case for case in cases}
    for record in original['cases']:
        if not isinstance(record, dict):
            continue
        run['cases'].append(recover_case(client, record, lookup.get(record.get('fixtureId')), output_dir, min(timeout, 300), poll, log))
        run['variety'] = variety_report([case for case in run['cases'] if 'source' in case])
        save_report(output_dir / 'results.json', run)
        save_report(target_report, aggregate)
    run.update(finishedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               succeeded=sum(case['status'] == 'succeeded' for case in run['cases']))
    run['failed'] = len(run['cases']) - run['succeeded']
    save_report(output_dir / 'results.json', run)
    save_report(target_report, aggregate)
    log(f"Recovery finished: {run['succeeded']}/{len(run['cases'])} recovered; zero new inference jobs. Report: {target_report}")
    return run


def save_report(path, aggregate):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(aggregate, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:3002')
    parser.add_argument('--duration', type=float, default=8, help='Actual preview seconds per job; use 4 for a shorter CPU smoke benchmark.')
    parser.add_argument('--timeout', type=float, default=1800, help='Finite wall-clock deadline per actual job, excluding up to 60 seconds of cancellation confirmation.')
    parser.add_argument('--poll', type=float, default=2)
    parser.add_argument('--source', type=Path, help='Optional actual user PCM16 WAV. It is read locally and never copied into the benchmark outputs.')
    parser.add_argument('--source-prompt', default='An original expressive instrumental arrangement guided by the supplied melody, with warm acoustic piano, soft strings and restrained percussion. Keep breathing room and clear melodic phrases. No vocals.')
    parser.add_argument('--output-dir', type=Path, default=ROOT / '.local' / 'musicgen-benchmark')
    parser.add_argument('--report', type=Path, default=ROOT / 'docs' / 'verification' / 'musicgen-real-results.json')
    parser.add_argument('--recover-report', type=Path, help='GET-only recovery of the latest run in an existing report (or a direct per-run results.json); never generates or cancels.')
    parser.add_argument('--recovery-report', type=Path, default=ROOT / 'docs' / 'verification' / 'musicgen-recovery-results.json')
    args = parser.parse_args()
    if not 0 < args.duration <= 30 or not 0 < args.timeout <= 3600 or not .001 <= args.poll <= 30:
        parser.error('Use duration greater than 0 up to 30 seconds, timeout greater than 0 up to 3600 seconds, and poll from .001 to 30 seconds.')
    client = LocalClient(args.base_url)
    cases = synthetic_cases()
    if args.source:
        if args.source.stat().st_size > MAX_INPUT_BYTES:
            parser.error('The optional source WAV exceeds 16 MiB.')
        data = args.source.read_bytes()
        inspect_wav(data)
        cases.append({'id': 'user-source', 'audioWav': data, 'prompt': args.source_prompt,
                      'sourceKind': 'actual-user-supplied-WAV-not-a-synthetic-fixture'})
    if args.recover_report:
        recovered = recover_report(client, args.recover_report, cases, args.output_dir, args.recovery_report, min(args.timeout, 300), args.poll)
        return 0 if not recovered['failed'] else 1
    run_id = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:6]
    output_dir = args.output_dir / run_id
    run = {'runId': run_id, 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'description': 'Actual local MusicGen Melody inference. The five named sources are original synthetic test recordings, not human performances.',
           'previewLengthNote': 'Short CPU benchmark previews; musical quality and human-hum fidelity require separate listening and actual-user tests.',
           'requestedPreviewSeconds': args.duration, 'perJobDeadlineSeconds': args.timeout, 'cases': []}
    try:
        aggregate = json.loads(args.report.read_text(encoding='utf-8')) if args.report.exists() else {}
        if not isinstance(aggregate.get('runs'), list):
            aggregate = {}
    except (ValueError, OSError):
        aggregate = {}
    aggregate.update(schemaVersion=1, benchmark='actual-local-musicgen-melody', metricsAreNotProofOfExactMelody=True)
    aggregate.setdefault('runs', []).append(run)
    aggregate['runs'] = aggregate['runs'][-20:]
    for case in cases:
        try:
            backend = client.request('GET', '/health', timeout=10)
        except Exception as error:
            backend = {'reachable': False, 'error': str(error)[:300]}
        run['cases'].append(run_case(client, case, output_dir, args.duration, args.timeout, args.poll, backend_status=backend))
        try:
            run['cases'][-1]['backendStatusAfter'] = client.request('GET', '/health', timeout=10)
        except Exception as error:
            run['cases'][-1]['backendStatusAfter'] = {'reachable': False, 'error': str(error)[:300]}
        run['variety'] = variety_report(run['cases'])
        save_report(output_dir / 'results.json', run)
        save_report(args.report, aggregate)
    run['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    run['succeeded'] = sum(case['status'] == 'succeeded' for case in run['cases'])
    run['failed'] = len(run['cases']) - run['succeeded']
    run['variety'] = variety_report(run['cases'])
    save_report(output_dir / 'results.json', run)
    save_report(args.report, aggregate)
    print(f"Actual benchmark finished: {run['succeeded']}/{len(run['cases'])} succeeded. Report: {args.report}", flush=True)
    return 0 if not run['failed'] else 1


if __name__ == '__main__':
    sys.exit(main())
