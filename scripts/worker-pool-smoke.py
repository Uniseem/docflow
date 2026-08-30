#!/usr/bin/env python3
"""Test Worker exclusivity and fail-closed lock loss on a disposable CI database.

Starts only locally built smoke containers, with no restart policy and no input
documents or provider keys. Terminates exactly the confirmed advisory-lock
session belonging to this test's uniquely named Worker, never arbitrary sessions.
"""

from __future__ import annotations

import argparse
import json
import re
import secrets
import subprocess
import sys
import time
from typing import Any, Callable


LOCK_ID = 381001337
IMAGE = "docflow-server:smoke"
LABEL = "docflow.ci.worker-pool-smoke"


class SmokeFailure(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def docker(*arguments: str, input_text: str | None = None) -> str:
    result = subprocess.run(
        ["docker", *arguments],
        input=input_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=20,
        check=False,
    )
    # Deliberately do not print subprocess output; it may contain configuration.
    require(result.returncode == 0, f"Docker {arguments[0]} failed during the isolated Worker test")
    return result.stdout.strip()


class Fixture:
    def __init__(self, postgres_container: str) -> None:
        self.postgres_container = postgres_container
        self.nonce = secrets.token_hex(8)
        self.created: list[str] = []

    def query(self, statement: str) -> str:
        return docker(
            "exec", "-i", self.postgres_container,
            "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
            "-U", "docflow", "-d", "docflow",
            input_text=statement + "\n",
        )

    def require_empty_database(self) -> None:
        require(
            self.query(
                "SELECT (SELECT count(*) FROM documents) = 0 "
                "AND (SELECT count(*) FROM admin_users) = 0 "
                "AND NOT EXISTS (SELECT 1 FROM app_settings "
                "WHERE key <> 'deepseek_model');"
            ) == "t",
            "refusing a populated database; run this before admin/provider/runtime fixtures",
        )

    def lock_owner(self, application_name: str) -> str:
        # Names are generated internally from a hex nonce, never from input.
        return self.query(
            "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid "
            "WHERE l.locktype='advisory' AND l.classid=0 "
            f"AND l.objid={LOCK_ID} AND l.granted "
            "AND a.datname='docflow' AND a.usename='docflow' "
            f"AND a.application_name='{application_name}' "
            "AND a.backend_type='client backend' AND a.pid<>pg_backend_pid();"
        )

    def inspect(self, name: str) -> dict[str, Any]:
        records = json.loads(docker("container", "inspect", name))
        require(len(records) == 1, "ambiguous test container identity")
        container = records[0]
        require(
            container["Config"].get("Labels", {}).get(LABEL) == self.nonce,
            "refusing an unrelated container without this test's ownership label",
        )
        return container

    def logs(self, name: str) -> str:
        # The Rust binary logs normal messages to stdout and final errors to
        # stderr, so collect both but never expose raw logs in test output.
        result = subprocess.run(
            ["docker", "logs", name], capture_output=True, text=True,
            encoding="utf-8", timeout=15, check=False,
        )
        require(result.returncode == 0, "could not read isolated Worker readiness")
        return result.stdout + result.stderr

    def start_worker(self, role: str) -> tuple[str, str]:
        name = f"docflow-pool-smoke-{self.nonce}-{role}"
        application_name = f"docflow_pool_smoke_{self.nonce}_{role}"
        # Sharing this specific service container's network namespace guarantees
        # that 127.0.0.1:5432 is the same database validated with docker exec.
        database_url = (
            "postgres://docflow:docflow-test-password@127.0.0.1:5432/docflow"
            f"?application_name={application_name}"
        )
        self.created.append(name)
        docker(
            "run", "--detach", "--pull=never", "--restart=no",
            "--name", name, "--label", f"{LABEL}={self.nonce}",
            "--network", f"container:{self.postgres_container}",
            "-e", f"DATABASE_URL={database_url}",
            "-e", "DATABASE_POOL_SIZE=1",
            "-e", "WORKER_CONCURRENCY=3",
            "-e", "SECRET_KEY=docflow-test-secret-key",
            "-e", "DATA_ROOT=/tmp/docflow",
            "-e", "RUST_LOG=docflow_server=info",
            IMAGE, "worker",
        )
        container = self.inspect(name)
        require(container["HostConfig"]["RestartPolicy"]["Name"] == "no", "test Worker must not auto-restart")
        return name, application_name

    def cleanup(self) -> None:
        failures = []
        for name in reversed(self.created):
            try:
                # Check the exact name plus random label before stopping/removing
                # only the temporary containers created by this invocation.
                container = self.inspect(name)
                docker("rm", "--force", container["Id"])
            except (SmokeFailure, ValueError, KeyError, OSError, subprocess.SubprocessError):
                failures.append(name)
        require(not failures, "could not clean up one or more isolated Worker containers")


def wait_for(description: str, predicate: Callable[[], Any], seconds: float = 20) -> Any:
    deadline = time.monotonic() + seconds
    while True:
        value = predicate()
        if value:
            return value
        require(time.monotonic() < deadline, f"timed out: {description}")
        time.sleep(0.25)


def run(fixture: Fixture) -> None:
    fixture.require_empty_database()
    require(
        fixture.query(
            "SELECT count(*) FROM pg_locks WHERE locktype='advisory' "
            f"AND classid=0 AND objid={LOCK_ID} AND granted;"
        ) == "0",
        "refusing to interfere with an existing translation-pool owner",
    )
    owner, owner_application = fixture.start_worker("owner")

    def owner_ready() -> str | None:
        require(fixture.inspect(owner)["State"]["Running"], "first Worker exited before becoming ready")
        pid = fixture.lock_owner(owner_application)
        if pid and "PostgreSQL worker started" in fixture.logs(owner):
            require(pid.isdecimal(), "expected exactly one confirmed advisory-lock owner PID")
            return pid
        return None

    owner_pid = wait_for("Worker startup with DATABASE_POOL_SIZE=1", owner_ready)
    print("PASS: Worker starts with one pooled connection and owns a separate advisory lock")

    contender, _ = fixture.start_worker("contender")
    wait_for(
        "second Worker must reject the already-owned translation pool",
        lambda: not fixture.inspect(contender)["State"]["Running"],
    )
    require(fixture.inspect(contender)["State"]["ExitCode"] != 0, "second Worker incorrectly exited successfully")
    require(
        "已有 Worker 持有全站翻译任务池" in fixture.logs(contender),
        "second Worker failed for a reason other than confirmed lock contention",
    )
    require(fixture.inspect(owner)["State"]["Running"], "first Worker stopped during contention test")
    require(fixture.lock_owner(owner_application) == owner_pid, "lock owner changed unexpectedly")
    print("PASS: a second Worker cannot create another site-wide translation pool")

    # Revalidate the empty, credential-free instance immediately before fault
    # injection. Terminate only the previously identified PID while it still owns
    # our lock and has this invocation's unguessable application_name.
    fixture.require_empty_database()
    terminated = fixture.query(
        "SELECT pg_terminate_backend(a.pid) FROM pg_stat_activity a "
        f"WHERE a.pid={int(owner_pid)} AND a.datname='docflow' AND a.usename='docflow' "
        f"AND a.application_name='{owner_application}' AND a.backend_type='client backend' "
        "AND a.pid<>pg_backend_pid() AND EXISTS (SELECT 1 FROM pg_locks l "
        "WHERE l.pid=a.pid AND l.locktype='advisory' AND l.classid=0 "
        f"AND l.objid={LOCK_ID} AND l.granted);"
    )
    require(terminated == "t", "confirmed test lock-owner connection was not terminated")
    wait_for(
        "Worker must stop within 20 seconds of losing its lock connection",
        lambda: not fixture.inspect(owner)["State"]["Running"],
    )
    stopped = fixture.inspect(owner)
    require(stopped["State"]["ExitCode"] != 0, "lock loss must produce a nonzero Worker exit")
    require(stopped.get("RestartCount") == 0, "test Worker restarted unexpectedly")
    require(
        "全站翻译池锁连接失效" in fixture.logs(owner),
        "Worker stopped without reporting the lost ownership connection",
    )
    require(not fixture.lock_owner(owner_application), "test advisory lock was not released")
    fixture.require_empty_database()
    print("PASS: losing the lock connection shuts down the Worker, without any translation calls")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-container", required=True, help="fresh CI PostgreSQL service container ID")
    parser.add_argument("--confirm-disposable-instance", action="store_true", required=True)
    args = parser.parse_args()
    require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.postgres_container)), "invalid PostgreSQL container ID")
    fixture = Fixture(args.postgres_container)
    try:
        run(fixture)
    finally:
        fixture.cleanup()
    print("Worker pool ownership smoke test passed.")


if __name__ == "__main__":
    try:
        main()
    except (SmokeFailure, KeyError, ValueError, OSError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, SmokeFailure) else type(error).__name__
        print(f"Worker pool smoke test failed: {message}", file=sys.stderr)
        raise SystemExit(1) from None
