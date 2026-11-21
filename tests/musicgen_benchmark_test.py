"""Benchmark harness checks only; these tests never load or run MusicGen."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('musicgen_benchmark', Path(__file__).parents[1] / 'scripts' / 'benchmark_musicgen.py')
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class ProtocolDouble:
    def __init__(self, mismatch=False, never_finish=False, pipeline=None):
        self.calls = []
        self.mismatch = mismatch
        self.never_finish = never_finish
        self.pipeline = pipeline

    def request(self, method, path, payload=None, timeout=15):
        self.calls.append((method, path, payload))
        if method == 'POST':
            self.payload = payload
            return {'id': payload['requestId'], 'status': 'running', 'stage': 'generating', 'progress': {'completed': 1, 'total': 5}}
        if method == 'DELETE':
            return {'id': self.payload['requestId'], 'status': 'cancelled'}
        if self.never_finish:
            return {'id': self.payload['requestId'], 'status': 'running', 'stage': 'loading'}
        original = base64.b64decode(self.payload['audioWavBase64'])
        receipt = {'audioSha256': '0' * 64 if self.mismatch else hashlib.sha256(original).hexdigest(),
                   'inputBytes': len(original), 'mode': 'audio-melody'}
        if self.pipeline is not None:
            receipt['pipeline'] = self.pipeline
        return {'id': self.payload['requestId'], 'status': 'succeeded', 'stage': 'ready', 'elapsedSeconds': 1.25,
                'result': {'model': 'facebook/musicgen-melody', 'sampleRate': 32000, 'audioWavBase64': self.payload['audioWavBase64'],
                           'conditioning': receipt}}


class BenchmarkHarnessTests(unittest.TestCase):
    def recorded_case(self, fixture):
        _, source = benchmark.inspect_wav(fixture['audioWav'])
        return {'fixtureId': fixture['id'], 'sourceKind': fixture['sourceKind'], 'source': source, 'prompt': fixture['prompt'],
                'requestId': 'bench-existing-recording', 'requestedPreviewSeconds': 6, 'status': 'failed',
                'error': {'code': 'BENCHMARK_ERROR', 'message': 'original acknowledgement timeout'},
                'backendStatus': {'backend': 'transformers'}}

    def existing_client(self, fixture, record, **options):
        pipeline = {'textEncoderVerified': True, 'audioProjectionVerified': True, 'initialDecoderPrefixVerified': True,
                    'featureSha256': 'a' * 64, 'textTokens': 12, 'chromaFrames': 235, 'decoderPrefixFrames': 247}
        client = ProtocolDouble(pipeline=pipeline, **options)
        client.payload = {'requestId': record['requestId'], 'audioWavBase64': base64.b64encode(fixture['audioWav']).decode('ascii')}
        return client

    def test_five_distinct_original_synthetic_recordings_have_audio_clocks_and_rests(self):
        fixtures = benchmark.synthetic_cases()
        self.assertEqual([item['id'] for item in fixtures], ['acoustic', 'pop', 'orchestra', 'edm', 'piano'])
        self.assertEqual(len({hashlib.sha256(item['audioWav']).hexdigest() for item in fixtures}), 5)
        self.assertEqual(len({tuple((note['start'], note['duration']) for note in item['notes']) for item in fixtures}), 5)
        for fixture in fixtures:
            pcm, stats = benchmark.inspect_wav(fixture['audioWav'])
            self.assertEqual(stats['durationSeconds'], 6)
            self.assertEqual(stats['sampleRate'], 32000)
            self.assertEqual(stats['channels'], 1)
            self.assertGreater(stats['rms'], 0.03)
            self.assertGreater(float((pcm == 0).mean()), 0.1)
            self.assertEqual(fixture['sourceKind'], 'original-synthetic-test-recording')

    def test_protocol_waits_for_actual_terminal_and_verifies_receipt_before_saving(self):
        fixture = benchmark.synthetic_cases()[0]
        with tempfile.TemporaryDirectory() as directory:
            client = ProtocolDouble()
            result = benchmark.run_case(client, fixture, Path(directory), duration=6, timeout=1, poll=0.001, log=lambda _: None, backend_status={'backend': 'audiocraft'})
            self.assertEqual(result['status'], 'succeeded')
            self.assertEqual(result['source']['sha256'], result['conditioning']['audioSha256'])
            self.assertEqual(result['conditioning']['inputBytes'], len(fixture['audioWav']))
            self.assertTrue(Path(result['output']['path']).is_file())
            self.assertEqual(result['modelSeconds'], 1.25)
            self.assertTrue(any(method == 'GET' for method, _, _ in client.calls))
            self.assertTrue(result['chromaComparison']['notProofOfExactMelody'])

    def test_transformers_outputs_require_all_actual_pipeline_proofs_before_any_wav_is_saved(self):
        fixture = benchmark.synthetic_cases()[0]
        valid = {'textEncoderVerified': True, 'audioProjectionVerified': True, 'initialDecoderPrefixVerified': True,
                 'featureSha256': 'a' * 64, 'textTokens': 12, 'chromaFrames': 235, 'decoderPrefixFrames': 247}
        broken = [None, {}, {**valid, 'textEncoderVerified': False}, {**valid, 'audioProjectionVerified': 1},
                  {**valid, 'initialDecoderPrefixVerified': False}, {**valid, 'featureSha256': 'bad'},
                  {**valid, 'textTokens': 0}, {**valid, 'chromaFrames': True}, {**valid, 'decoderPrefixFrames': -1}]
        for pipeline in broken:
            with self.subTest(pipeline=pipeline), tempfile.TemporaryDirectory() as directory:
                result = benchmark.run_case(ProtocolDouble(pipeline=pipeline), fixture, Path(directory), duration=6, timeout=1,
                                            poll=0.001, log=lambda _: None, backend_status={'backend': 'transformers'})
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['error']['code'], 'INVALID_CONDITIONING')
                self.assertNotIn('output', result)
                self.assertEqual(list(Path(directory).glob('*.wav')), [])
        with tempfile.TemporaryDirectory() as directory:
            result = benchmark.run_case(ProtocolDouble(pipeline=valid), fixture, Path(directory), duration=6, timeout=1,
                                        poll=0.001, log=lambda _: None, backend_status={'backend': 'transformers'})
            self.assertEqual(result['status'], 'succeeded')
            self.assertTrue(result['pipelineVerified'])
            self.assertEqual(result['conditioning']['pipeline']['featureSha256'], valid['featureSha256'])

    def test_variety_report_counts_byte_and_feature_hashes_without_a_fidelity_claim(self):
        cases = [{'fixtureId': fixture, 'sourceKind': 'original-synthetic-test-recording', 'status': 'succeeded',
                  'source': {'sha256': f'{index:064x}'}, 'output': {'sha256': f'{index + 10:064x}'},
                  'pipelineVerified': True, 'conditioning': {'pipeline': {'featureSha256': f'{index + 20:064x}'}}}
                 for index, fixture in enumerate(['acoustic', 'pop', 'orchestra', 'edm', 'piano'])]
        variety = benchmark.variety_report(cases)
        self.assertEqual(variety['uniqueSourceHashCount'], 5)
        self.assertEqual(variety['uniqueOutputHashCount'], 5)
        self.assertEqual(variety['uniqueFeatureHashCount'], 5)
        self.assertTrue(variety['allFiveOutputsDistinct'])
        self.assertTrue(variety['notProofOfMelodyFidelity'])
        cases[-1]['status'] = 'failed'
        partial = benchmark.variety_report(cases)
        self.assertEqual(partial['uniqueOutputHashCount'], 4)
        self.assertEqual(partial['uniqueFeatureHashCount'], 4)
        self.assertFalse(partial['allFiveOutputsDistinct'])

    def test_invalid_receipt_records_failure_without_output_substitution(self):
        with tempfile.TemporaryDirectory() as directory:
            result = benchmark.run_case(ProtocolDouble(mismatch=True), benchmark.synthetic_cases()[0], Path(directory), duration=6, timeout=1, poll=0.001, log=lambda _: None)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['error']['code'], 'INVALID_MODEL_OUTPUT')
            self.assertNotIn('output', result)
            self.assertEqual(list(Path(directory).glob('*.wav')), [])

    def test_a_finite_deadline_cancels_the_real_job_without_generating_a_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ProtocolDouble(never_finish=True)
            result = benchmark.run_case(client, benchmark.synthetic_cases()[0], Path(directory), duration=6, timeout=0.01, poll=0.001, log=lambda _: None)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['error']['code'], 'BENCHMARK_TIMEOUT')
            self.assertEqual(result['providerTerminalStatus'], 'cancelled')
            self.assertTrue(any(method == 'DELETE' for method, _, _ in client.calls))
            self.assertNotIn('output', result)

    def test_private_audio_client_accepts_literal_loopback_only(self):
        for url in ['https://example.com', 'http://example.com', 'http://localhost:3002', 'http://127.0.0.1@example.com', 'http://user:pass@127.0.0.1:3002']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                benchmark.LocalClient(url)

    def test_status_timeouts_and_unexpected_request_errors_cancel_an_accepted_job(self):
        fixture = benchmark.synthetic_cases()[0]
        for failure, expected_code in [(TimeoutError('local request timed out'), 'SERVICE_TIMEOUT'), (RuntimeError('unexpected response failure'), 'BENCHMARK_ERROR')]:
            class FailedStatusClient(ProtocolDouble):
                def request(self, method, path, payload=None, timeout=15):
                    if method == 'GET':
                        self.status_timeout = timeout
                        raise failure
                    return super().request(method, path, payload, timeout)
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                client = FailedStatusClient()
                result = benchmark.run_case(client, fixture, Path(directory), duration=6, timeout=120, poll=0.001, log=lambda _: None)
                self.assertEqual(result['error']['code'], expected_code)
                self.assertEqual(client.status_timeout, 60)
                self.assertEqual(result['providerTerminalStatus'], 'cancelled')
                self.assertTrue(any(method == 'DELETE' for method, _, _ in client.calls))
                self.assertNotIn('output', result)

    def test_ambiguous_submission_timeout_cancels_by_the_same_request_identity(self):
        class LostAcknowledgementClient(ProtocolDouble):
            def request(self, method, path, payload=None, timeout=15):
                if method == 'POST':
                    self.payload = payload
                    self.post_timeout = timeout
                    raise TimeoutError('accepted acknowledgement was lost')
                return super().request(method, path, payload, timeout)
        with tempfile.TemporaryDirectory() as directory:
            client = LostAcknowledgementClient()
            result = benchmark.run_case(client, benchmark.synthetic_cases()[0], Path(directory), timeout=120, log=lambda _: None)
            self.assertEqual(result['error']['code'], 'SERVICE_TIMEOUT')
            self.assertEqual(client.post_timeout, 15)
            self.assertIn(('DELETE', '/jobs/' + result['requestId'], None), client.calls)
            self.assertEqual(result['providerTerminalStatus'], 'cancelled')

    def test_exhausted_local_request_budget_is_classified_instead_of_leaking_raw_timeout(self):
        class TimedOutOpener:
            def open(self, request, timeout):
                raise TimeoutError('response read timed out')
        client = benchmark.LocalClient('http://127.0.0.1:3002')
        client.opener = TimedOutOpener()
        with patch.object(benchmark.time, 'monotonic', side_effect=[0, 0, 16]):
            with self.assertRaises(benchmark.BenchmarkError) as caught:
                client.request('GET', '/jobs/accepted-id', timeout=15)
        self.assertEqual(caught.exception.code, 'SERVICE_TIMEOUT')

    def test_transient_status_retry_keeps_the_same_job_and_is_bounded_to_two_attempts(self):
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'{"id":"accepted-id","status":"running"}'
        class RetryOpener:
            def __init__(self): self.requests = []
            def open(self, request, timeout):
                self.requests.append((request.full_url, request.get_method(), request.data, timeout))
                if len(self.requests) == 1:
                    raise TimeoutError('transient local timeout')
                return Response()
        client = benchmark.LocalClient('http://127.0.0.1:3002')
        client.opener = RetryOpener()
        self.assertEqual(client.request('GET', '/jobs/accepted-id', timeout=60)['id'], 'accepted-id')
        self.assertEqual(len(client.opener.requests), 2)
        self.assertTrue(all(url.endswith('/jobs/accepted-id') and method == 'GET' and body is None and 0 < timeout <= 60 for url, method, body, timeout in client.opener.requests))

    def test_recovery_gets_an_existing_success_without_submitting_or_changing_the_failed_record(self):
        fixture = benchmark.synthetic_cases()[0]
        record = self.recorded_case(fixture)
        before = dict(record)
        client = self.existing_client(fixture, record)
        with tempfile.TemporaryDirectory() as directory:
            recovered = benchmark.recover_case(client, record, fixture, Path(directory), timeout=1, poll=.001, log=lambda _: None)
            self.assertEqual(recovered['status'], 'succeeded')
            self.assertTrue(recovered['recoveredExistingJob'])
            self.assertEqual(recovered['originalStatus'], 'failed')
            self.assertTrue(recovered['pipelineVerified'])
            self.assertTrue(Path(recovered['output']['path']).is_file())
        self.assertEqual(record, before)
        self.assertTrue(client.calls)
        self.assertTrue(all(method == 'GET' and path == '/jobs/' + record['requestId'] for method, path, _ in client.calls))

    def test_recovery_refuses_recorded_source_or_prompt_mismatches_before_requesting_audio(self):
        fixture = benchmark.synthetic_cases()[0]
        for change in ({'source': {'sha256': '0' * 64, 'bytes': len(fixture['audioWav'])}}, {'prompt': 'a different instruction'}, {'requestedPreviewSeconds': 0}):
            record = {**self.recorded_case(fixture), **change}
            client = self.existing_client(fixture, record)
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                recovered = benchmark.recover_case(client, record, fixture, Path(directory), timeout=1, poll=.001, log=lambda _: None)
                self.assertEqual(recovered['status'], 'failed')
                self.assertEqual(recovered['error']['code'], 'RECORD_MISMATCH')
                self.assertFalse(client.calls)
                self.assertNotIn('output', recovered)

    def test_recovery_never_cancels_or_resubmits_an_active_job_after_its_finite_wait(self):
        fixture = benchmark.synthetic_cases()[0]
        record = self.recorded_case(fixture)
        client = self.existing_client(fixture, record, never_finish=True)
        with tempfile.TemporaryDirectory() as directory:
            recovered = benchmark.recover_case(client, record, fixture, Path(directory), timeout=.01, poll=.001, log=lambda _: None)
            self.assertEqual(recovered['error']['code'], 'RECOVERY_TIMEOUT')
            self.assertEqual(recovered['providerTerminalStatus'], 'running')
            self.assertTrue(all(method == 'GET' for method, _, _ in client.calls))
            self.assertNotIn('output', recovered)

    def test_recovery_uses_the_same_validator_and_rejects_missing_transformers_proof(self):
        fixture = benchmark.synthetic_cases()[0]
        record = self.recorded_case(fixture)
        client = self.existing_client(fixture, record)
        client.pipeline = None
        with tempfile.TemporaryDirectory() as directory:
            recovered = benchmark.recover_case(client, record, fixture, Path(directory), timeout=1, poll=.001, log=lambda _: None)
            self.assertEqual(recovered['error']['code'], 'INVALID_CONDITIONING')
            self.assertEqual(list(Path(directory).glob('*.wav')), [])

    def test_recovery_selects_the_latest_aggregate_run_and_can_read_a_direct_run(self):
        first = {'runId': 'older', 'cases': [{'requestId': 'first'}]}
        latest = {'runId': 'latest', 'cases': [{'requestId': 'last'}]}
        self.assertEqual(benchmark.recorded_run({'runs': [first, latest]})['runId'], 'latest')
        self.assertEqual(benchmark.recorded_run(first), first)

    def test_recovery_report_is_separate_and_preserves_original_failed_records(self):
        fixture = benchmark.synthetic_cases()[0]
        record = self.recorded_case(fixture)
        client = self.existing_client(fixture, record)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path, target_path = root / 'original.json', root / 'recovery.json'
            original = json.dumps({'runs': [{'runId': 'original-run', 'cases': [record]}]})
            source_path.write_text(original, encoding='utf-8')
            run = benchmark.recover_report(client, source_path, [fixture], root / 'outputs', target_path, timeout=1, poll=.001, log=lambda _: None)
            self.assertEqual(source_path.read_text(encoding='utf-8'), original)
            self.assertEqual(run['succeeded'], 1)
            saved = json.loads(target_path.read_text(encoding='utf-8'))
            self.assertEqual(saved['runs'][-1]['sourceRunId'], 'original-run')
            self.assertEqual(saved['runs'][-1]['cases'][0]['originalStatus'], 'failed')
            self.assertFalse(run['newInferenceSubmitted'])
            self.assertTrue(all(method == 'GET' for method, _, _ in client.calls))
            with self.assertRaises(ValueError):
                benchmark.recover_report(client, source_path, [fixture], root, source_path)

    def test_recovery_records_failed_cancelled_and_unknown_jobs_without_new_compute(self):
        fixture = benchmark.synthetic_cases()[0]
        record = self.recorded_case(fixture)
        for status in ['failed', 'cancelled', 'unknown']:
            class TerminalClient:
                def __init__(self): self.calls = []
                def request(self, method, path, payload=None, timeout=15):
                    self.calls.append(method)
                    if status == 'unknown':
                        raise benchmark.BenchmarkError('Job expired', 'JOB_NOT_FOUND')
                    return {'id': record['requestId'], 'status': status, 'error': 'Existing job ended.'}
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                client = TerminalClient()
                recovered = benchmark.recover_case(client, record, fixture, Path(directory), timeout=1, poll=.001, log=lambda _: None)
                self.assertEqual(recovered['status'], 'failed')
                self.assertEqual(recovered['error']['code'], 'JOB_NOT_FOUND' if status == 'unknown' else 'EXISTING_JOB_' + status.upper())
                self.assertEqual(client.calls, ['GET'])
                self.assertNotIn('output', recovered)


if __name__ == '__main__':
    unittest.main()
