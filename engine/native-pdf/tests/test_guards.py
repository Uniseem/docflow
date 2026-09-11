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

    def test_linux_libc_bootstrap_never_probes_external_libraries(self):
        self.run_guard_script("""
import ctypes
from types import SimpleNamespace
from unittest.mock import patch
import threadpoolctl
import asset_bundle
from bridge import FailureState
failure = FailureState()
asset_bundle.install_process_guard(failure)
libc = SimpleNamespace(dl_iterate_phdr=object())
with patch.object(asset_bundle.sys, 'platform', 'linux'), \
     patch.dict(threadpoolctl.ThreadpoolController._system_libraries, {}, clear=True), \
     patch.object(threadpoolctl, 'find_library', side_effect=AssertionError('external probe')), \
     patch.object(ctypes, 'CDLL', return_value=libc) as loader:
    asset_bundle.configure_threadpool_runtime()
    assert threadpoolctl.ThreadpoolController._get_libc() is libc
    asset_bundle.configure_threadpool_runtime()
    loader.assert_called_once_with(None)
assert not failure.failed
print('guarded')
""")

    def test_linux_libc_bootstrap_rejects_missing_symbols(self):
        self.run_guard_script("""
from unittest.mock import patch
import threadpoolctl
import asset_bundle
from bridge import NativePdfError
with patch.object(asset_bundle.sys, 'platform', 'linux'), \
     patch.dict(threadpoolctl.ThreadpoolController._system_libraries, {}, clear=True), \
     patch.object(asset_bundle.ctypes, 'CDLL', return_value=object()):
    try:
        asset_bundle.configure_threadpool_runtime()
    except NativePdfError as error:
        assert error.code == 'engine_threadpool'
    else:
        raise AssertionError('missing dl_iterate_phdr was accepted')
print('guarded')
""")

    def test_layout_dbscan_and_threadpool_inspection_work_under_process_guard(self):
        self.run_guard_script("""
from unittest.mock import patch
import threadpoolctl
from asset_bundle import configure_cpu_runtime, install_process_guard
from bridge import FailureState
with patch.object(threadpoolctl, 'find_library', side_effect=AssertionError('external probe')):
    configure_cpu_runtime()
    failure = FailureState()
    install_process_guard(failure)
    # Import the numerical libraries after libc bootstrap, as the runner does.
    # A Linux subprocess here reproduces the former CI-only layout failure.
    import numpy as np
    from sklearn.cluster import DBSCAN
    info = threadpoolctl.threadpool_info()
    assert any(item['user_api'] == 'blas' for item in info)
    labels = DBSCAN(eps=0.4, min_samples=1, metric='manhattan', algorithm='brute').fit_predict(
        np.array([[0.0, 0.0], [0.2, 0.0], [8.0, 8.0]])
    )
    assert labels.tolist() == [0, 0, 1]
    assert not failure.failed
print('guarded')
""")


if __name__ == "__main__":
    unittest.main()
