"""Real process/audit-hook checks, without opening or producing a PDF."""

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class GuardRuntimeTests(unittest.TestCase):
    def run_guard_script(self, code):
        result = subprocess.run(
            [sys.executable, "-B", "-c", code],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "guarded")

    def test_subprocess_and_multiprocessing_attempts_are_blocked_at_runtime(self):
        self.run_guard_script("""
import multiprocessing
import subprocess
import sys
from asset_bundle import install_process_guard
from bridge import FailureState, NativePdfError
failure = FailureState()
install_process_guard(failure)
attempts = [lambda: subprocess.Popen([sys.executable, '-c', 'pass']),
            lambda: multiprocessing.Process(target=print).start()]
for attempt in attempts:
    try:
        attempt()
    except NativePdfError as error:
        assert error.code == 'engine_process'
    else:
        raise AssertionError('a grandchild was allowed')
assert failure.failed
assert multiprocessing.active_children() == []
print('guarded')
""")

    def test_remote_socket_is_rejected_before_connect(self):
        self.run_guard_script("""
import socket
from asset_bundle import install_network_guard
from bridge import FailureState, NativePdfError
failure = FailureState()
install_network_guard(failure)
with socket.socket() as connection:
    try:
        connection.connect(('203.0.113.1', 80))
    except NativePdfError as error:
        assert error.code == 'engine_network'
    else:
        raise AssertionError('remote connection was allowed')
assert failure.failed
print('guarded')
""")

    def test_cpu_budget_avoids_hardware_probe_subprocesses(self):
        self.run_guard_script("""
from unittest.mock import patch
from asset_bundle import configure_cpu_runtime, install_process_guard
from bridge import FailureState
configure_cpu_runtime()
from joblib.externals.loky.backend import context
failure = FailureState()
install_process_guard(failure)
for cores in [1, 8]:
    with patch.object(context.os, 'cpu_count', return_value=cores):
        assert context.cpu_count(only_physical_cores=True) == 1
assert not failure.failed
print('guarded')
""")


if __name__ == "__main__":
    unittest.main()
