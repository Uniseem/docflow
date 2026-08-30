import io
import json
import os
import queue
import re
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge import (
    MAX_LINE_BYTES,
    FailureState,
    JsonlWriter,
    NativePdfError,
    PoolTranslator,
    TranslationBridge,
)


class CapturingWriter(JsonlWriter):
    def __init__(self):
        self.output = io.StringIO()
        super().__init__(self.output)
        self.messages = queue.Queue()

    def emit(self, message):
        super().emit(message)
        self.messages.put(message)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.failure = FailureState()
        self.writer = CapturingWriter()
        self.bridge = TranslationBridge(io.BytesIO(), self.writer, self.failure, 4)
        self.threads = []

    def tearDown(self):
        self.failure.fail(NativePdfError("test_shutdown", "test shutdown"))
        for thread in self.threads:
            thread.join(1)
            self.assertFalse(
                thread.is_alive(), "callback did not wake after cancellation"
            )

    def submit(self, text="Source {v7}"):
        result, errors = [], []

        def work():
            try:
                result.append(self.bridge.translate(text))
            except BaseException as exc:  # noqa: BLE001 -- Capture thread failures for assertions.
                errors.append(exc)

        thread = threading.Thread(target=work, daemon=True)
        self.threads.append(thread)
        thread.start()
        return thread, result, errors

    def test_callback_and_exact_protocol_shape(self):
        thread, result, errors = self.submit()
        request = self.writer.messages.get(timeout=1)
        self.assertEqual(
            request, {"type": "translate", "request_id": 1, "text": "Source {v7}"}
        )
        self.bridge.accept(
            {"type": "translation", "request_id": 1, "text": "译文 { V 7 }"}
        )
        thread.join(1)
        self.assertEqual(result, ["译文 {v7}"])
        self.assertEqual(errors, [])
        self.bridge.seal_success()
        self.assertEqual(json.loads(self.writer.output.getvalue()), request)

    def test_out_of_order_replies_are_matched_by_id(self):
        first = self.submit("first")
        one = self.writer.messages.get(timeout=1)
        second = self.submit("second")
        two = self.writer.messages.get(timeout=1)
        self.bridge.accept(
            {"type": "translation", "request_id": two["request_id"], "text": "第二"}
        )
        self.bridge.accept(
            {"type": "translation", "request_id": one["request_id"], "text": "第一"}
        )
        first[0].join(1)
        second[0].join(1)
        self.assertEqual(first[1], ["第一"])
        self.assertEqual(second[1], ["第二"])

    def test_provider_error_is_fatal_and_never_echoes_message(self):
        thread, result, errors = self.submit()
        self.writer.messages.get(timeout=1)
        with self.assertRaises(NativePdfError):
            self.bridge.accept(
                {"type": "error", "request_id": 1, "message": "PRIVATE_SOURCE_OR_KEY"}
            )
        thread.join(1)
        self.assertFalse(result)
        self.assertTrue(errors)
        self.assertNotIn("PRIVATE_SOURCE", str(errors[0]))
        with self.assertRaises(NativePdfError):
            self.bridge.seal_success()

    def test_formula_loss_is_fatal(self):
        thread, _, errors = self.submit()
        self.writer.messages.get(timeout=1)
        with self.assertRaisesRegex(NativePdfError, "公式"):
            self.bridge.accept({"type": "translation", "request_id": 1, "text": "译文"})
        thread.join(1)
        self.assertTrue(errors)

    def test_unknown_id_cancels_all_waiters(self):
        jobs = [self.submit("source") for _ in range(2)]
        for _ in jobs:
            self.writer.messages.get(timeout=1)
        with self.assertRaises(NativePdfError):
            self.bridge.accept(
                {"type": "translation", "request_id": 999, "text": "译文"}
            )
        for thread, _, errors in jobs:
            thread.join(1)
            self.assertTrue(errors)

    def test_callback_limit_is_enforced(self):
        self.bridge.max_pending = 1
        first = self.submit("one")
        self.writer.messages.get(timeout=1)
        second = self.submit("two")
        second[0].join(1)
        first[0].join(1)
        self.assertTrue(first[2])
        self.assertTrue(second[2])

    def test_eof_wakes_callback_and_invokes_cancellation(self):
        read_fd, write_fd = os.pipe()
        reader = os.fdopen(read_fd, "rb")
        cancel = threading.Event()
        self.failure.add_listener(cancel.set)
        self.bridge.reader = reader
        try:
            self.bridge.start()
            thread, _, errors = self.submit()
            self.writer.messages.get(timeout=1)
            os.close(write_fd)
            write_fd = None
            thread.join(1)
            self.assertTrue(cancel.is_set())
            self.assertTrue(errors)
            self.bridge._thread.join(1)
        finally:
            if write_fd is not None:
                os.close(write_fd)
            reader.close()

    def test_invalid_json_and_oversized_lines_fail_closed(self):
        for payload in (b"not-json\n", b"\xff\n", b"{}", b"a" * (MAX_LINE_BYTES + 1)):
            with self.subTest(size=len(payload)):
                failure = FailureState()
                bridge = TranslationBridge(
                    io.BytesIO(payload), CapturingWriter(), failure, 1
                )
                bridge._read_loop()
                self.assertTrue(failure.failed)

    def test_sealed_result_accepts_parent_eof_before_interpreter_shutdown(self):
        read_fd, write_fd = os.pipe()
        reader = os.fdopen(read_fd, "rb")
        self.bridge.reader = reader
        try:
            self.bridge.start()
            thread, result, errors = self.submit("source")
            self.writer.messages.get(timeout=1)
            self.bridge.accept({"type": "translation", "request_id": 1, "text": "译文"})
            thread.join(1)
            self.assertEqual(result, ["译文"])
            self.assertFalse(errors)
            self.bridge.seal_success()
            os.close(write_fd)
            write_fd = None
            self.bridge.wait_closed(timeout=1)
            self.assertFalse(self.failure.failed)
            self.assertFalse(self.bridge._thread.is_alive())
        finally:
            if write_fd is not None:
                os.close(write_fd)
            self.bridge._thread.join(1)
            reader.close()

    def test_parent_missing_eof_is_a_bounded_failure(self):
        read_fd, write_fd = os.pipe()
        reader = os.fdopen(read_fd, "rb")
        self.bridge.reader = reader
        try:
            self.bridge.start()
            with self.assertRaisesRegex(NativePdfError, "确认连接"):
                self.bridge.wait_closed(timeout=0.01)
            self.assertTrue(self.failure.failed)
        finally:
            os.close(write_fd)
            self.bridge._thread.join(1)
            self.assertFalse(self.bridge._thread.is_alive())
            reader.close()

    def test_bool_is_not_a_request_id(self):
        with self.assertRaises(NativePdfError):
            self.bridge.accept(
                {"type": "translation", "request_id": True, "text": "译文"}
            )

    def test_pure_formula_does_not_use_cloud(self):
        self.assertEqual(self.bridge.translate(" {v2} "), " {v2} ")
        self.assertTrue(self.writer.messages.empty())

    def test_writer_limits_utf8_not_just_character_count(self):
        with self.assertRaises(NativePdfError):
            self.writer.emit({"text": "汉" * MAX_LINE_BYTES})

    def test_translator_disables_llm_and_has_tuple_placeholders(self):
        translator = PoolTranslator(self.bridge)
        with self.assertRaises(NotImplementedError):
            translator.do_llm_translate(None)
        self.assertFalse(hasattr(translator, "cache"))
        for getter in (
            translator.get_formular_placeholder,
            translator.get_rich_text_left_placeholder,
            translator.get_rich_text_right_placeholder,
        ):
            literal, pattern = getter(12)
            self.assertIsNotNone(re.fullmatch(pattern, literal))
            re.compile(getter(r"\d+")[1])


if __name__ == "__main__":
    unittest.main()
