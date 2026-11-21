"""Job behavior tests with a controlled inference double, not a neural benchmark."""
import base64
import importlib.util
import io
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location('service', Path(__file__).parents[1] / 'scripts/musicgen_melody_service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

def fixture():
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b'\x01\x10' * 1600)
    return output.getvalue()

def payload(identifier='test-one'):
    return dict(requestId=identifier, audioWavBase64=base64.b64encode(fixture()).decode(), prompt='gentle piano', duration=1)

def terminal(manager, identifier):
    limit = time.monotonic() + 3
    while time.monotonic() < limit:
        result = manager.get(identifier)
        if result['status'] in ('succeeded', 'failed', 'cancelled'):
            return result
        time.sleep(.005)
    raise AssertionError('job never reached terminal state')

class JobsTest(unittest.TestCase):
    def test_cancel_before_submission_prevents_inference(self):
        seen = []
        manager = service.GenerationJobs(lambda prepared: seen.append(prepared))
        try:
            self.assertEqual(manager.cancel('test-one')['status'], 'cancelled')
            self.assertEqual(manager.submit(payload())['status'], 'cancelled')
            self.assertEqual(seen, [])
        finally:
            manager.close()

class SupervisorTest(unittest.TestCase):
    def test_delayed_dispatch_cannot_send_old_source_into_a_new_worker_pipe(self):
        delayed = []
        class DeferredThread:
            def __init__(self, target, daemon): self.target = target
            def start(self): delayed.append(self.target)
        class NewConnection:
            def __init__(self): self.received = []
            def send(self, value): self.received.append(value)
        generator = self.supervisor([])
        prepared = service.prepare_request(payload())
        prepared['_deadline'] = time.monotonic() - 1
        with patch.object(service.threading, 'Thread', DeferredThread):
            with self.assertRaises(TimeoutError): generator(prepared)
        next_pipe = NewConnection()
        generator.connection = next_pipe
        delayed[0]()
        self.assertEqual(len(next_pipe.received), 0, 'A cancelled source reached a replacement worker pipe')

    def supervisor(self, messages):
        class Process:
            alive = True
            def is_alive(self): return self.alive
            def terminate(self): self.alive = False
            def kill(self): self.alive = False
            def join(self, timeout=None): pass
            def close(self): pass
        class Connection:
            closed = False
            def send(self, value): pass
            def poll(self, timeout): return bool(messages)
            def recv(self): return messages.pop(0)
            def close(self): self.closed = True
        generator = service.SupervisedGenerator('transformers', {}, cancel_grace=0)
        generator.process, generator.connection, generator.cancelled = Process(), Connection(), threading.Event()
        return generator

    def test_cancel_during_progress_resets_child_before_another_source(self):
        generator = self.supervisor([('progress', 'generating', 1, 50), ('result', (fixture(), 16000))])
        process, connection = generator.process, generator.connection
        cancellation = threading.Event()
        def progress(*args):
            cancellation.set()
            raise service.GenerationCancelled('cancel at progress boundary')
        prepared = service.prepare_request(payload())
        prepared.update(_cancel=cancellation, _progress=progress)
        with self.assertRaises(service.GenerationCancelled):
            generator(prepared)
        self.assertFalse(process.alive)
        self.assertTrue(connection.closed)
        self.assertIsNone(generator.process)

    def test_parent_deadline_terminates_worker_even_without_token_callbacks(self):
        generator = self.supervisor([])
        process = generator.process
        prepared = service.prepare_request(payload())
        prepared['_deadline'] = time.monotonic() - 1
        with self.assertRaises(TimeoutError):
            generator(prepared)
        self.assertFalse(process.alive)
        self.assertIsNone(generator.process)

    def test_terminal_history_is_evicted_instead_of_blocking_new_work(self):
        manager = service.GenerationJobs(lambda _: (fixture(), 16000), max_jobs=2)
        try:
            for index in range(4):
                identifier = f'job-{index}'
                manager.submit(payload(identifier))
                self.assertEqual(terminal(manager, identifier)['status'], 'succeeded')
            self.assertLessEqual(len(manager.jobs), 2)
        finally:
            manager.close()

    def test_real_input_receipt_result_and_idempotence(self):
        seen = []
        def inference(prepared):
            seen.append(prepared['audioWav'])
            prepared['_progress']('generating', 1, 2)
            return fixture(), 16000
        manager = service.GenerationJobs(inference)
        try:
            created = manager.submit(payload())
            self.assertEqual(created['id'], 'test-one')
            self.assertEqual(manager.submit(payload())['id'], 'test-one')
            result = terminal(manager, 'test-one')
            self.assertEqual(result['status'], 'succeeded')
            self.assertEqual(seen, [fixture()])
            self.assertEqual(result['result']['conditioning']['inputBytes'], len(fixture()))
            self.assertEqual(base64.b64decode(result['result']['audioWavBase64']), fixture())
            with self.assertRaises(service.JobConflict):
                manager.submit({**payload(), 'prompt':'different'})
        finally:
            manager.close()

    def test_cancel_keeps_slot_until_worker_stops(self):
        entered, release = threading.Event(), threading.Event()
        def inference(prepared):
            entered.set()
            release.wait(2)
            service.check_cancel(prepared)
            return fixture(), 16000
        manager = service.GenerationJobs(inference, max_queue=0)
        try:
            manager.submit(payload())
            self.assertTrue(entered.wait(1))
            self.assertEqual(manager.cancel('test-one')['status'], 'cancelling')
            with self.assertRaises(service.JobBusy):
                manager.submit(payload('test-two'))
            release.set()
            self.assertEqual(terminal(manager, 'test-one')['status'], 'cancelled')
            self.assertNotIn('result', manager.get('test-one'))
        finally:
            release.set()
            manager.close()

    def test_failure_does_not_create_audio_and_future_jobs_survive(self):
        count = 0
        def inference(prepared):
            nonlocal count
            count += 1
            if count == 1:
                raise RuntimeError('controlled failure')
            return fixture(), 16000
        manager = service.GenerationJobs(inference)
        try:
            manager.submit(payload())
            self.assertEqual(terminal(manager, 'test-one')['status'], 'failed')
            manager.submit(payload('test-two'))
            self.assertEqual(terminal(manager, 'test-two')['status'], 'succeeded')
        finally:
            manager.close()

    def test_invalid_identifier_or_audio_rejected_before_inference(self):
        manager = service.GenerationJobs(lambda _: (_ for _ in ()).throw(AssertionError('called')))
        try:
            for update in ({'requestId':'../escape'}, {'audioWavBase64':''}, {'prompt':''}):
                with self.assertRaises(service.RequestError):
                    manager.submit({**payload(), **update})
        finally:
            manager.close()

if __name__ == '__main__':
    unittest.main()
