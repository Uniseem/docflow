#!/usr/bin/env python3
"""Exercise runtime settings and native PDF contracts on a disposable CI API.

Uses only Python's standard library and docker exec/psql. Never starts a Worker,
calls a provider configuration endpoint, or prints credentials/prompt contents.
Tiny, deterministic PDF outputs are injected into the confirmed API test
container solely to exercise authenticated downloads, not actual translation.
The API and PostgreSQL database must both be fresh, dedicated test instances.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import http.cookiejar
import io
import json
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from typing import Any


SETTINGS_PATH = "/api/admin/settings"
RUNTIME_PATH = f"{SETTINGS_PATH}/translation-runtime"
EXPECTED_LIMITS = {
    "google": {
        "concurrency_max": 256,
        "chunk_chars_max": 4000,
        "max_segments_per_request_max": 100,
    },
    "deepseek": {
        "concurrency_max": 2000,
        "chunk_chars_max": 12000,
        "max_segments_per_request_max": 64,
    },
    "min_chunk_chars": 100,
    "per_document_concurrency_max": 32,
    "system_prompt_max_chars": 12000,
}
PRIVATE_FIELDS = {
    "system_prompt",
    "translation_runtime",
    "translation_runtime_snapshot",
    "translation_runtime_defaults",
    "access_token_hash",
    "source_path",
    "pdf_path",
    "dual_pdf_path",
    "local_archive_path",
    "storage_key",
    "r2_prefix",
    "source_r2_key",
}


class SmokeFailure(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: Any, response: Any, code: int, message: str, headers: Any, new_url: str) -> None:
        # No API call in this test should redirect, especially to an external
        # provider. Do not follow or print a Location containing secret data.
        raise SmokeFailure("the disposable API unexpectedly redirected a request")


class Client:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            NoRedirect(),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )

    def request(
        self,
        method: str,
        path: str,
        payload: Any = None,
        *,
        expected: int = 200,
        raw: bytes | None = None,
        content_type: str = "application/json",
        binary: bool = False,
    ) -> Any:
        body = raw
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "*/*" if binary else "application/json"}
        if body is not None:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(
            self.base_url + path, data=body, headers=headers, method=method
        )
        try:
            with self.opener.open(request, timeout=15) as response:
                status, data = response.status, response.read()
                response_headers = {key.lower(): value for key, value in response.headers.items()}
        except urllib.error.HTTPError as response:
            status, data = response.code, response.read()
            response_headers = {key.lower(): value for key, value in response.headers.items()}
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise SmokeFailure(f"{method} {path}: local API unavailable") from error
        require(
            status == expected,
            f"{method} {path}: expected HTTP {expected}, got HTTP {status}",
        )
        if binary:
            return response_headers, data
        if not data:
            return None
        try:
            return json.loads(data)
        except (ValueError, UnicodeError) as error:
            raise SmokeFailure(f"{method} {path}: invalid JSON response") from error


class Database:
    def __init__(self, container: str) -> None:
        self.container = container

    def query(self, statement: str) -> str:
        # No shell invocation or interpolation of arbitrary identifiers. Only
        # validated UUIDs and constant CI fixtures are used in statements below.
        result = subprocess.run(
            [
                "docker", "exec", "-i", self.container,
                "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
                "-U", "docflow", "-d", "docflow",
            ],
            input=statement + "\n",
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
            check=False,
        )
        require(result.returncode == 0, "disposable PostgreSQL assertion failed")
        return result.stdout.strip()

    def snapshot(self, document_id: str) -> Any:
        document_id = str(uuid.UUID(document_id))
        text = self.query(
            "SELECT translation_runtime_snapshot::text FROM documents "
            f"WHERE id='{document_id}';"
        )
        require(bool(text), "created document is missing its runtime snapshot")
        return json.loads(text)

    def document_record(self, document_id: str) -> dict[str, Any]:
        document_id = str(uuid.UUID(document_id))
        text = self.query(
            "SELECT row_to_json(record)::text FROM ("
            "SELECT id,storage_key,source_path,upload_sha256,processing_mode "
            f"FROM documents WHERE id='{document_id}') record;"
        )
        require(bool(text), "test upload is not present in the confirmed CI database")
        record = json.loads(text)
        require(record["id"] == document_id, "unexpected fixture document identity")
        require(
            bool(re.fullmatch(r"[a-f0-9]{32}", record["storage_key"])),
            "unexpected fixture storage key",
        )
        require(
            record["source_path"] == f"archives/{record['storage_key']}/source/source.pdf",
            "fixture source path is not the expected permanent PDF path",
        )
        require(
            bool(re.fullmatch(r"[a-f0-9]{64}", record["upload_sha256"] or "")),
            "fixture is missing its upload checksum",
        )
        return record

    def upload_counts(self) -> str:
        return self.query(
            "SELECT (SELECT count(*) FROM documents)::text || ':' || "
            "(SELECT count(*) FROM processing_events)::text;"
        )


class ApiFilesystem:
    """Read/write only the fresh smoke API's isolated /tmp/docflow archive."""

    SCRIPT = r'''
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys

payload = json.load(sys.stdin)
if os.environ.get("DATA_ROOT") != "/tmp/docflow":
    raise SystemExit("not the disposable API data directory")
data_root = Path("/tmp/docflow").resolve(strict=True)
archive_root = data_root / "archives"
if archive_root.is_symlink() or archive_root.resolve(strict=True) != archive_root:
    raise SystemExit("unexpected archive directory")

if payload["operation"] == "inventory":
    items = []
    for path in sorted(archive_root.rglob("*")):
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(archive_root):
            raise SystemExit("unsafe archive entry")
        if not (path.is_file() or path.is_dir()):
            raise SystemExit("unexpected archive entry type")
        items.append([
            path.relative_to(archive_root).as_posix(),
            "file" if path.is_file() else "directory",
            path.stat().st_size if path.is_file() else 0,
        ])
    print(json.dumps(items))
elif payload["operation"] == "materialize":
    storage_key = payload["storage_key"]
    if not re.fullmatch(r"[a-f0-9]{32}", storage_key):
        raise SystemExit("invalid storage key")
    root = archive_root / storage_key
    if root.is_symlink() or root.resolve(strict=True) != root:
        raise SystemExit("unexpected task archive directory")
    expected_source = f"archives/{storage_key}/source/source.pdf"
    if payload["source_path"] != expected_source:
        raise SystemExit("unexpected source path")
    source = root / "source/source.pdf"
    if source.is_symlink() or source.resolve(strict=True) != source or not source.is_file():
        raise SystemExit("unexpected fixture source")
    if hashlib.sha256(source.read_bytes()).hexdigest() != payload["sha256"]:
        raise SystemExit("API container does not own the confirmed upload")
    allowed = {
        "mineru": {"article/article.pdf"},
        "pdf2zh": {"pdf2zh/mono.pdf", "pdf2zh/dual.pdf"},
    }.get(payload["processing_mode"])
    if allowed is None or set(payload["artifacts"]) != allowed:
        raise SystemExit("unexpected fixture artifact set")
    prepared = []
    for relative, encoded in payload["artifacts"].items():
        content = base64.b64decode(encoded, validate=True)
        if not content.startswith(b"%PDF-") or len(content) > 65536:
            raise SystemExit("unexpected fixture PDF bytes")
        destination = root / relative
        if destination.exists() or destination.is_symlink():
            raise SystemExit("refusing to overwrite an existing artifact")
        if destination.parent.is_symlink():
            raise SystemExit("unexpected output directory")
        prepared.append((relative, destination, content))
    created = []
    for relative, destination, content in prepared:
        destination.parent.mkdir(mode=0o700, exist_ok=True)
        if destination.parent.resolve(strict=True) != destination.parent:
            raise SystemExit("output directory escaped the archive")
        with destination.open("xb") as output:
            output.write(content)
        created.append({"path": f"archives/{storage_key}/{relative}", "bytes": len(content)})
    print(json.dumps(created))
else:
    raise SystemExit("unknown fixture operation")
'''

    def __init__(self, container: str) -> None:
        require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", container)), "invalid API container ID")
        self.container = container

    def confirm_instance(self) -> None:
        result = subprocess.run(
            ["docker", "container", "inspect", self.container],
            capture_output=True, text=True, encoding="utf-8", timeout=20, check=False,
        )
        require(result.returncode == 0, "could not inspect the disposable API container")
        records = json.loads(result.stdout)
        require(len(records) == 1, "ambiguous API fixture container")
        container = records[0]
        require(container["State"]["Running"] is True, "API fixture container is not running")
        require(
            container["Config"]["Image"] == "docflow-server:smoke"
            and container["Config"]["Cmd"] == ["api"],
            "refusing an unrelated image or non-API container",
        )
        require(
            "DATA_ROOT=/tmp/docflow" in container["Config"].get("Env", []),
            "API fixture must use the isolated /tmp/docflow data directory",
        )

    def operation(self, payload: dict[str, Any]) -> Any:
        # No shell or generated command text: only this fixed stdlib program is
        # executed, as the image's normal application user. Payload data is stdin.
        result = subprocess.run(
            ["docker", "exec", "-i", self.container, "python3", "-c", self.SCRIPT],
            input=json.dumps(payload), capture_output=True, text=True,
            encoding="utf-8", timeout=20, check=False,
        )
        require(result.returncode == 0, "isolated API archive fixture operation failed")
        return json.loads(result.stdout)

    def inventory(self) -> Any:
        return self.operation({"operation": "inventory"})

    def materialize(self, record: dict[str, Any], artifacts: dict[str, bytes]) -> None:
        created = self.operation({
            "operation": "materialize",
            "storage_key": record["storage_key"],
            "source_path": record["source_path"],
            "sha256": record["upload_sha256"],
            "processing_mode": record["processing_mode"],
            "artifacts": {
                name: base64.b64encode(content).decode("ascii")
                for name, content in artifacts.items()
            },
        })
        expected = [
            {"path": f"archives/{record['storage_key']}/{name}", "bytes": len(content)}
            for name, content in artifacts.items()
        ]
        require(created == expected, "unexpected materialized API artifact paths")


def assert_private_fields_absent(value: Any) -> None:
    if isinstance(value, dict):
        require(
            not PRIVATE_FIELDS.intersection(value),
            "non-settings response exposes a private runtime/prompt field",
        )
        for child in value.values():
            assert_private_fields_absent(child)
    elif isinstance(value, list):
        for child in value:
            assert_private_fields_absent(child)


def pdf_fixture(label: str = "DocFlow native PDF smoke fixture") -> bytes:
    # A real one-page PDF with an extractable text layer, constructed without a
    # renderer or third-party library. No Worker ever processes this fixture.
    escaped = label.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 72 760 Td ({escaped}) Tj ET\n".encode("ascii")
    objects = [
        b"<</Type /Catalog /Pages 2 0 R>>",
        b"<</Type /Pages /Kids [3 0 R] /Count 1>>",
        b"<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>",
        f"<</Length {len(stream)}>>\nstream\n".encode("ascii") + stream + b"endstream",
        b"<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
    ]
    pdf = b"%PDF-1.4\n"
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += f"{index} 0 obj\n".encode("ascii") + obj + b"\nendobj\n"
    xref_offset = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii")
    for offset in offsets[1:]:
        pdf += f"{offset:010} 00000 n \n".encode("ascii")
    pdf += f"trailer\n<</Size {len(objects) + 1} /Root 1 0 R>>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    return pdf


def multipart_fixture(
    *,
    processing_mode: str | None = None,
    mode_after_file: bool = False,
    filename: str = "runtime-smoke.pdf",
    source: bytes | None = None,
    source_content_type: str = "application/pdf",
) -> tuple[bytes, str]:
    boundary = "docflow-runtime-smoke-" + secrets.token_hex(12)
    require(not any(character in filename for character in '\r\n"'), "invalid fixture filename")
    require(not any(character in source_content_type for character in "\r\n"), "invalid fixture MIME")

    def field(name: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
            f"{value}\r\n"
        ).encode("utf-8")

    parts = [field("title", "CI runtime snapshot"), field("translation_tier", "1")]
    if processing_mode is not None and not mode_after_file:
        parts.append(field("processing_mode", processing_mode))
    parts.append(
        (
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {source_content_type}\r\n\r\n"
        ).encode("ascii")
        + (pdf_fixture() if source is None else source)
        + b"\r\n"
    )
    if processing_mode is not None and mode_after_file:
        parts.append(field("processing_mode", processing_mode))
    parts.append(f"--{boundary}--\r\n".encode("ascii"))
    body = b"".join(parts)
    return body, f"multipart/form-data; boundary={boundary}"


def require_api_only(db: Database) -> None:
    require(
        db.query(
            "SELECT count(*) FROM pg_locks WHERE locktype='advisory' "
            "AND classid=0 AND objid=381001337 AND granted;"
        ) == "0",
        "a Worker owns this database; the test must be API-only",
    )


def rejected_upload_has_no_residue(
    client: Client,
    db: Database,
    api_files: ApiFilesystem,
    *,
    expected: int,
    **fixture: Any,
) -> None:
    require_api_only(db)
    previous_counts = db.upload_counts()
    previous_files = api_files.inventory()
    raw, content_type = multipart_fixture(**fixture)
    rejected = client.request(
        "POST", "/api/v1/jobs", raw=raw, content_type=content_type, expected=expected,
    )
    assert_private_fields_absent(rejected)
    require(db.upload_counts() == previous_counts, "rejected upload left a document or processing-event row")
    require(api_files.inventory() == previous_files, "rejected upload left a source or temporary archive directory")


def seed_pdf_artifacts(
    db: Database, api_files: ApiFilesystem, document_id: str, mode: str,
) -> dict[str, bytes]:
    require_api_only(db)
    record = db.document_record(document_id)
    require(record["processing_mode"] == mode, "fixture persisted the wrong processing mode")
    if mode == "pdf2zh":
        outputs = {
            "mono": pdf_fixture("CI simulated mono output; no provider was called"),
            "dual": pdf_fixture("CI simulated dual output with original and translation; no provider was called"),
        }
        artifacts = {f"pdf2zh/{variant}.pdf": content for variant, content in outputs.items()}
        primary_relative = "pdf2zh/mono.pdf"
        dual_relative = "pdf2zh/dual.pdf"
    else:
        require(mode == "mineru", "unsupported fixture processing mode")
        outputs = {"journal": pdf_fixture("CI simulated journal output; no renderer or provider was called")}
        artifacts = {"article/article.pdf": outputs["journal"]}
        primary_relative = "article/article.pdf"
        dual_relative = None
    api_files.materialize(record, artifacts)
    prefix = f"archives/{record['storage_key']}"
    # Every interpolated string is a UUID, checked lowercase-hex storage key, or
    # one of the constant artifact names above. The queue is deliberately left
    # untouched: these are HTTP download fixtures, not completed translations.
    dual_sql = (
        f"dual_pdf_path='{prefix}/{dual_relative}',dual_pdf_size={len(outputs['dual'])}"
        if dual_relative else "dual_pdf_path=NULL,dual_pdf_size=NULL"
    )
    updated = db.query(
        f"UPDATE documents SET pdf_path='{prefix}/{primary_relative}',"
        f"pdf_size={len(artifacts[primary_relative])},{dual_sql} "
        f"WHERE id='{record['id']}' AND processing_mode='{mode}' "
        "AND status='queued' AND queue_attempts=0 RETURNING id;"
    )
    require(updated == record["id"], "fixture state changed before PDF metadata injection")
    return outputs


def assert_pdf_download(client: Client, path: str, expected_pdf: bytes, *, inline: bool = False) -> None:
    headers, content = client.request("GET", path, binary=True)
    require(content == expected_pdf, "PDF endpoint returned the wrong variant bytes")
    require(headers.get("content-type", "").split(";", 1)[0] == "application/pdf", "PDF endpoint returned the wrong media type")
    require(
        headers.get("content-disposition", "").startswith("inline;" if inline else "attachment;"),
        "PDF preview/download disposition differs from the requested mode",
    )
    require(
        "private" in headers.get("cache-control", "")
        and "no-store" in headers.get("cache-control", ""),
        "authenticated PDF response is publicly cacheable",
    )
    require(headers.get("x-content-type-options") == "nosniff", "PDF response is missing nosniff")


def run(base_url: str, db: Database, api_files: ApiFilesystem) -> None:
    anonymous = Client(base_url)
    admin = Client(base_url)
    deadline = time.monotonic() + 45
    while True:
        try:
            health = anonymous.request("GET", "/api/health")
            require(health.get("status") == "ok", "unexpected API health response")
            break
        except SmokeFailure:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)

    require(
        anonymous.request("GET", "/api/admin/status").get("initialized") is False,
        "refusing to modify an initialized instance; use a fresh CI database",
    )
    require(db.query("SELECT count(*) FROM documents;") == "0", "test database is not empty")
    require(
        db.query(
            "SELECT count(*) FROM app_settings WHERE key IN "
            "('mineru_api_key','google_translate_api_key','deepseek_api_key',"
            "'r2_access_key_id','r2_secret_access_key','translation_runtime');"
        ) == "0",
        "refusing an instance containing provider credentials or saved runtime settings",
    )
    require_api_only(db)
    api_files.confirm_instance()
    require(api_files.inventory() == [], "API archive directory is not empty")

    anonymous.request("GET", SETTINGS_PATH, expected=401)
    anonymous.request("PUT", RUNTIME_PATH, {}, expected=401)
    registration = admin.request(
        "POST", "/api/admin/register",
        {"username": "ci-runtime-admin", "password": secrets.token_urlsafe(32)},
        expected=201,
    )
    require(isinstance(registration.get("token"), str), "admin registration did not return a token")
    current = admin.request("GET", SETTINGS_PATH)
    defaults = current["translation_runtime_defaults"]
    require(current["translation_runtime"] == defaults, "fresh runtime does not match defaults")
    require(current["translation_runtime_limits"] == EXPECTED_LIMITS, "runtime limits differ from API contract")
    require(defaults["google"] == {"concurrency": 32, "chunk_chars": 4000, "max_segments_per_request": 4}, "unexpected Google defaults")
    require(defaults["deepseek"] == {"concurrency": 64, "chunk_chars": 10000, "max_segments_per_request": 4}, "unexpected DeepSeek defaults")
    require(defaults["per_document_concurrency"] == 8, "unexpected per-document default")
    require(0 < len(defaults["system_prompt"]) <= 12000, "missing or oversized default prompt")
    print("PASS: administrator protection, fresh defaults and limits")

    minimum_runtime = {
        "google": {"concurrency": 1, "chunk_chars": 100, "max_segments_per_request": 1},
        "deepseek": {"concurrency": 1, "chunk_chars": 100, "max_segments_per_request": 1},
        "per_document_concurrency": 1,
        "system_prompt": "译",
    }
    require(
        admin.request("PUT", RUNTIME_PATH, minimum_runtime)["translation_runtime"] == minimum_runtime,
        "valid minimum settings were rejected or altered",
    )
    # Exactly 12,000 Unicode code points, well above 12,000 UTF-8 bytes. This
    # catches accidental byte/UTF-16-code-unit validation in multilingual text.
    boundary_runtime = {
        "google": {"concurrency": 256, "chunk_chars": 4000, "max_segments_per_request": 100},
        "deepseek": {"concurrency": 2000, "chunk_chars": 12000, "max_segments_per_request": 64},
        "per_document_concurrency": 32,
        "system_prompt": "译🙂" * 6000,
    }
    # Escaped Unicode is also valid JSON and can be considerably larger than
    # its decoded UTF-8 form; body limits must not reject the legal character limit.
    saved = admin.request(
        "PUT", RUNTIME_PATH,
        raw=json.dumps(boundary_runtime, ensure_ascii=True).encode("ascii"),
    )
    require(saved["translation_runtime"] == boundary_runtime, "valid Unicode/boundary settings were altered")
    require(saved["translation_runtime_defaults"] == defaults, "saved settings changed the defaults")
    require(saved["translation_runtime_limits"] == EXPECTED_LIMITS, "saved settings changed the limits")
    require(admin.request("GET", SETTINGS_PATH)["translation_runtime"] == boundary_runtime, "runtime save did not persist")

    invalid_cases: list[tuple[str, Any]] = []
    for provider, field, values in (
        ("google", "concurrency", [0, 257, -1, 1.5, "32"]),
        ("deepseek", "concurrency", [0, 2001]),
        ("google", "chunk_chars", [99, 4001]),
        ("deepseek", "chunk_chars", [99, 12001]),
        ("google", "max_segments_per_request", [0, 101]),
        ("deepseek", "max_segments_per_request", [0, 65]),
    ):
        for value in values:
            invalid = copy.deepcopy(boundary_runtime)
            invalid[provider][field] = value
            invalid_cases.append((f"{provider}.{field}", invalid))
    for value in (0, 33):
        invalid = copy.deepcopy(boundary_runtime)
        invalid["per_document_concurrency"] = value
        invalid_cases.append(("per_document_concurrency", invalid))
    for value in ("", " \n\t ", "译" * 12001, "译\0文", None):
        invalid = copy.deepcopy(boundary_runtime)
        invalid["system_prompt"] = value
        invalid_cases.append(("system_prompt", invalid))
    missing = copy.deepcopy(boundary_runtime)
    del missing["deepseek"]
    invalid_cases.append(("missing provider", missing))
    unknown = copy.deepcopy(boundary_runtime)
    unknown["ignored_typo"] = 1
    invalid_cases.append(("unknown top-level field", unknown))
    nested_unknown = copy.deepcopy(boundary_runtime)
    nested_unknown["google"]["ignored_typo"] = 1
    invalid_cases.append(("unknown provider field", nested_unknown))
    invalid_cases.append(("unexpected wrapper", {"translation_runtime": boundary_runtime}))
    for label, invalid in invalid_cases:
        admin.request("PUT", RUNTIME_PATH, invalid, expected=400)
        require(
            admin.request("GET", SETTINGS_PATH)["translation_runtime"] == boundary_runtime,
            f"invalid {label} partially changed the persisted runtime",
        )
    print("PASS: Unicode boundaries, invalid settings return 400, atomic persistence")

    runtime_a = {
        "google": {"concurrency": 3, "chunk_chars": 1200, "max_segments_per_request": 3},
        "deepseek": {"concurrency": 7, "chunk_chars": 3200, "max_segments_per_request": 2},
        "per_document_concurrency": 5,
        "system_prompt": "CI 私有提示词 A：请忠实翻译并保留术语。🙂",
    }
    admin.request("PUT", RUNTIME_PATH, runtime_a)
    # Deliberately not a real key. Do not use /settings/google: that endpoint
    # validates against a real provider. MinerU remains completely unconfigured
    # for the first native upload. No Worker is running.
    db.query(
        "INSERT INTO app_settings(key,value,encrypted,updated_at) VALUES "
        "('google_translate_api_key','ci-not-a-real-google-key',false,NOW());"
    )
    capabilities = anonymous.request("GET", "/api/config/public")
    assert_private_fields_absent(capabilities)
    require(capabilities["default_processing_mode"] == "mineru", "legacy default processing mode changed")
    require(capabilities["mineru_configured"] is False, "MinerU was configured before the native test")
    require(capabilities["accepting_uploads"] is False, "legacy upload readiness no longer describes MinerU")
    require(capabilities["translation_available"] is True, "shared translation readiness ignored the fixture key")
    require(capabilities["processing_modes"]["mineru"]["available"] is False, "MinerU capability ignored its missing key")
    require(capabilities["processing_modes"]["mineru"]["native_pdf_only"] is False, "MinerU was incorrectly limited to native PDFs")
    require(".docx" in capabilities["processing_modes"]["mineru"]["accepted_extensions"], "MinerU lost Office upload compatibility")
    require(
        capabilities["processing_modes"]["pdf2zh"] == {
            "available": True, "accepted_extensions": [".pdf"], "native_pdf_only": True,
        },
        "native capability is unavailable or differs from the API contract; check bundled runtime assets",
    )

    native_uploader = Client(base_url)
    native_source = pdf_fixture("CI native upload with processing_mode after the file")
    raw, content_type = multipart_fixture(
        processing_mode="pdf2zh", mode_after_file=True, source=native_source,
        source_content_type="application/octet-stream",
    )
    native_document = native_uploader.request(
        "POST", "/api/v1/jobs", raw=raw, content_type=content_type, expected=202,
    )
    native_id = str(uuid.UUID(native_document["id"]))
    require(native_document["processing_mode"] == "pdf2zh", "native mode after the file was ignored")
    require(native_document["status"] == "queued", "native fixture unexpectedly started processing")
    require(native_document["is_public"] is False, "native upload was public by default")
    require(native_document["mime_type"] == "application/pdf", "native PDF MIME was taken from the untrusted upload header")
    require(native_document["translation_tier"] == 1 and native_document["translation_provider"] == "google", "native upload did not use the shared translation tier")
    require(db.snapshot(native_id) == runtime_a, "native upload did not snapshot the shared runtime A")
    require(
        db.document_record(native_id)["upload_sha256"] == hashlib.sha256(native_source).hexdigest(),
        "native source bytes or checksum changed during upload",
    )
    assert_private_fields_absent(native_document)
    anonymous.request("GET", f"/api/v1/jobs/{native_id}", expected=404)
    anonymous.request("GET", f"/api/documents/{native_id}", expected=404)

    rejected_upload_has_no_residue(
        anonymous, db, api_files, expected=415, processing_mode="pdf2zh",
        mode_after_file=True, filename="not-native.docx", source=b"CI office fixture",
        source_content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    rejected_upload_has_no_residue(
        anonymous, db, api_files, expected=415, processing_mode="pdf2zh",
        filename="not-native.png", source=b"\x89PNG\r\n\x1a\nCI image fixture",
        source_content_type="image/png",
    )
    rejected_upload_has_no_residue(
        anonymous, db, api_files, expected=415, processing_mode="pdf2zh",
        mode_after_file=True, filename="renamed-image.pdf", source=b"\x89PNG\r\n\x1a\nnot a PDF",
    )
    rejected_upload_has_no_residue(
        anonymous, db, api_files, expected=400, processing_mode="native",
        mode_after_file=True,
    )
    # Omitted mode must not silently switch to native when MinerU is unavailable.
    rejected_upload_has_no_residue(anonymous, db, api_files, expected=503)
    require(
        db.query("SELECT count(*) FROM app_settings WHERE key='mineru_api_key';") == "0",
        "native test unexpectedly configured a MinerU key",
    )
    print("PASS: native PDF upload without MinerU, per-mode capabilities and rejection cleanup")

    # Only now enable the legacy/default branch, still with an inert fake key.
    db.query(
        "INSERT INTO app_settings(key,value,encrypted,updated_at) VALUES "
        "('mineru_api_key','ci-not-a-real-mineru-key',false,NOW());"
    )
    require(anonymous.request("GET", "/api/config/public")["accepting_uploads"] is True, "legacy readiness did not recover after its key was configured")
    uploader = Client(base_url)
    raw, content_type = multipart_fixture()
    document = uploader.request(
        "POST", "/api/v1/jobs", raw=raw, content_type=content_type, expected=202
    )
    document_id = str(uuid.UUID(document["id"]))
    require(document["status"] == "queued", "API fixture unexpectedly started processing")
    require(document["processing_mode"] == "mineru", "old client without a mode did not retain MinerU")
    require(document["is_public"] is False, "legacy/default upload was public by default")
    require(document["translation_tier"] == 1, "fixture used an unexpected translation tier")
    require(db.snapshot(document_id) == runtime_a, "upload did not snapshot runtime A")
    assert_private_fields_absent(document)
    anonymous.request("GET", f"/api/v1/jobs/{document_id}", expected=404)
    native_uploader.request("GET", f"/api/v1/jobs/{document_id}", expected=404)

    runtime_b = copy.deepcopy(runtime_a)
    runtime_b["google"] = {"concurrency": 4, "chunk_chars": 1600, "max_segments_per_request": 2}
    runtime_b["system_prompt"] = "CI 私有提示词 B：请统一译为简体中文。🧪"
    admin.request("PUT", RUNTIME_PATH, runtime_b)
    require(db.snapshot(document_id) == runtime_a, "saving runtime B mutated an existing task snapshot")
    require(db.snapshot(native_id) == runtime_a, "saving runtime B mutated an existing native snapshot")
    require(
        json.loads(db.query("SELECT value FROM app_settings WHERE key='translation_runtime';")) == runtime_b,
        "saved runtime is not one complete database JSON value",
    )

    # The other field order and the legacy route alias use the same creation
    # handler. A distinct cookie jar also proves document-scoped permissions.
    native_peer = Client(base_url)
    raw, content_type = multipart_fixture(processing_mode="pdf2zh", mode_after_file=False)
    native_peer_document = native_peer.request(
        "POST", "/api/documents", raw=raw, content_type=content_type, expected=202,
    )
    native_peer_id = str(uuid.UUID(native_peer_document["id"]))
    require(native_peer_document["processing_mode"] == "pdf2zh", "native mode before the file was ignored by the route alias")
    require(native_peer_document["is_public"] is False, "native route alias made an upload public")
    require(db.snapshot(native_peer_id) == runtime_b, "new native upload did not share runtime B")
    require(db.snapshot(native_id) == runtime_a, "another native upload mutated the earlier task snapshot")
    assert_private_fields_absent(native_peer_document)
    native_peer.request("GET", f"/api/v1/jobs/{native_id}", expected=404)
    native_uploader.request("GET", f"/api/documents/{native_peer_id}", expected=404)

    for response in (
        anonymous.request("GET", "/api/config/public"),
        uploader.request("GET", f"/api/v1/jobs/{document_id}"),
        uploader.request("GET", f"/api/v1/jobs/{document_id}/events"),
        native_uploader.request("GET", f"/api/v1/jobs/{native_id}"),
        native_uploader.request("GET", f"/api/v1/jobs/{native_id}/events"),
        native_peer.request("GET", f"/api/documents/{native_peer_id}"),
    ):
        assert_private_fields_absent(response)
        encoded = json.dumps(response, ensure_ascii=False)
        require(
            runtime_a["system_prompt"] not in encoded and runtime_b["system_prompt"] not in encoded,
            "a public/document/event response leaked the private prompt",
        )
    public_list = anonymous.request("GET", "/api/v1/jobs")
    require(public_list["total"] == 0 and public_list["items"] == [], "private fixtures leaked into the public library")
    assert_private_fields_absent(public_list)
    print("PASS: both processing modes share immutable runtime snapshots; prompts and uploads stay private")

    native_outputs = seed_pdf_artifacts(db, api_files, native_id, "pdf2zh")
    journal_outputs = seed_pdf_artifacts(db, api_files, document_id, "mineru")
    native_detail = native_uploader.request("GET", f"/api/v1/jobs/{native_id}")
    require(native_detail["pdf_available"] is True, "native primary PDF availability was not exposed")
    require(native_detail["pdf_variants_available"] == {"journal": False, "mono": True, "dual": True}, "native PDF variant availability is incorrect")
    require(native_detail["markdown_available"] == {"original": False, "translated": False, "normalized": False}, "native fixture advertised nonexistent Markdown")
    require(native_detail["content_html"] is None, "native fixture unexpectedly required an HTML article")
    assert_private_fields_absent(native_detail)
    legacy_detail = uploader.request("GET", f"/api/v1/jobs/{document_id}")
    require(legacy_detail["pdf_variants_available"] == {"journal": True, "mono": False, "dual": False}, "legacy journal capability changed")

    for prefix, source_suffix in (
        (f"/api/v1/jobs/{native_id}", "source"),
        (f"/api/documents/{native_id}", "download"),
    ):
        for query, variant, inline in (
            ("", "mono", False),
            ("?variant=mono", "mono", False),
            ("?variant=dual", "dual", False),
            ("?variant=dual&inline=true", "dual", True),
            ("?inline=true", "mono", True),
        ):
            path = f"{prefix}/pdf{query}"
            anonymous.request("GET", path, expected=404)
            native_peer.request("GET", path, expected=404)
            assert_pdf_download(native_uploader, path, native_outputs[variant], inline=inline)
        assert_pdf_download(admin, f"{prefix}/pdf?variant=dual&inline=true", native_outputs["dual"], inline=True)
        native_uploader.request("GET", f"{prefix}/pdf?variant=journal", expected=404)
        native_uploader.request("GET", f"{prefix}/pdf?variant=unknown", expected=400)
        native_uploader.request("GET", f"{prefix}/markdown?variant=normalized", expected=404)
        for suffix in (source_suffix, "bundle", "markdown?variant=normalized"):
            anonymous.request("GET", f"{prefix}/{suffix}", expected=404)
            native_peer.request("GET", f"{prefix}/{suffix}", expected=404)
        _, source_bytes = native_uploader.request("GET", f"{prefix}/{source_suffix}", binary=True)
        require(source_bytes == native_source, "private source download changed the uploaded bytes")
        bundle_headers, bundle_bytes = native_uploader.request("GET", f"{prefix}/bundle", binary=True)
        require(bundle_headers.get("content-type") == "application/zip", "native bundle is not a ZIP response")
        with zipfile.ZipFile(io.BytesIO(bundle_bytes)) as bundle:
            require(bundle.read("source/source.pdf") == native_source, "native bundle omitted its source PDF")
            require(bundle.read("pdf2zh/mono.pdf") == native_outputs["mono"], "native bundle omitted or mixed the mono PDF")
            require(bundle.read("pdf2zh/dual.pdf") == native_outputs["dual"], "native bundle omitted or mixed the dual PDF")
            require(not any(name.startswith("markdown/") for name in bundle.namelist()), "native bundle fabricated Markdown")
            require("article/article.pdf" not in bundle.namelist(), "native bundle fabricated a journal PDF")
            metadata = json.loads(bundle.read("metadata/document.json"))
            require(metadata["processing_mode"] == "pdf2zh", "native bundle lost its processing mode")
            require(metadata["pdf_variants_available"] == {"journal": False, "mono": True, "dual": True}, "native bundle misreported PDF variants")
            for value in (metadata, json.loads(bundle.read("metadata/events.json"))):
                assert_private_fields_absent(value)
                encoded = json.dumps(value, ensure_ascii=False)
                require(runtime_a["system_prompt"] not in encoded and runtime_b["system_prompt"] not in encoded, "native bundle leaked a private administrator prompt")

    for prefix in (f"/api/v1/jobs/{document_id}", f"/api/documents/{document_id}"):
        for query, inline in (("", False), ("?variant=journal", False), ("?inline=true", True)):
            path = f"{prefix}/pdf{query}"
            anonymous.request("GET", path, expected=404)
            native_uploader.request("GET", path, expected=404)
            assert_pdf_download(uploader, path, journal_outputs["journal"], inline=inline)
        for invalid_variant in ("mono", "dual"):
            uploader.request("GET", f"{prefix}/pdf?variant={invalid_variant}", expected=404)
        uploader.request("GET", f"{prefix}/pdf?variant=unknown", expected=400)
    print("PASS: private native/journal variants, inline previews and no-Markdown bundles on both route aliases")

    # Public PDF access is granted only by the administrator's explicit action.
    admin.request("PATCH", f"/api/admin/documents/{native_id}/visibility", {"is_public": True})
    for prefix in (f"/api/v1/jobs/{native_id}", f"/api/documents/{native_id}"):
        assert_pdf_download(anonymous, f"{prefix}/pdf?variant=dual&inline=true", native_outputs["dual"], inline=True)
    admin.request("PATCH", f"/api/admin/documents/{native_id}/visibility", {"is_public": False})
    for prefix in (f"/api/v1/jobs/{native_id}", f"/api/documents/{native_id}"):
        anonymous.request("GET", f"{prefix}/pdf?variant=dual&inline=true", expected=404)
    admin.request("PATCH", f"/api/admin/documents/{document_id}/visibility", {"is_public": True})
    assert_private_fields_absent(anonymous.request("GET", f"/api/v1/jobs/{document_id}"))
    public_list = anonymous.request("GET", "/api/v1/jobs")
    require(public_list["total"] == 1 and {item["id"] for item in public_list["items"]} == {document_id}, "public library ignored explicit per-document visibility")
    assert_private_fields_absent(public_list)
    print("PASS: visibility changes govern PDF previews; native uploads remain private unless published")

    for fixture_id, expected_mode in ((document_id, "mineru"), (native_id, "pdf2zh")):
        anonymous.request("POST", f"/api/admin/documents/{fixture_id}/retry", expected=401)
        db.query(
            "UPDATE documents SET status='failed',stage='failed',"
            "failure_reason='CI fixture, no provider called' "
            f"WHERE id='{fixture_id}';"
        )
        retried = admin.request("POST", f"/api/admin/documents/{fixture_id}/retry")
        require(retried["status"] == "queued", "manual retry did not queue the failed fixture")
        require(retried["processing_mode"] == expected_mode, "manual retry changed the processing mode")
        require(retried["translation_tier"] == 1, "manual retry changed the selected tier")
        require(db.snapshot(fixture_id) == runtime_b, "manual retry did not adopt the shared latest runtime snapshot")
        assert_private_fields_absent(retried)
    require(db.snapshot(native_peer_id) == runtime_b, "retrying other fixtures changed the peer snapshot")
    require(db.query("SELECT count(*) FROM documents;") == "3", "rejected requests left unexpected document rows")
    require(db.query("SELECT count(*) FROM documents WHERE status <> 'queued';") == "0", "a fixture was processed; check for an unintended Worker")
    require(db.query("SELECT count(*) FROM documents WHERE queue_attempts <> 0 OR mineru_task_id IS NOT NULL;") == "0", "a Worker claimed an inert API fixture")
    require_api_only(db)
    print("PASS: manual retry preserves both modes and takes shared latest runtime; no provider called")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--postgres-container", required=True, help="fresh CI PostgreSQL service container ID")
    parser.add_argument(
        "--api-container", default="docflow-runtime-api-smoke",
        help="fresh docflow-server:smoke API container using DATA_ROOT=/tmp/docflow",
    )
    parser.add_argument("--confirm-disposable-instance", action="store_true", required=True)
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.base_url)
    require(
        parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        and parsed.path in {"", "/"}
        and not (parsed.username or parsed.password or parsed.query or parsed.fragment),
        "only a local, disposable HTTP API is permitted",
    )
    require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.postgres_container)), "invalid PostgreSQL container ID")
    run(args.base_url.rstrip("/"), Database(args.postgres_container), ApiFilesystem(args.api_container))
    print("Translation runtime and native PDF API smoke test passed.")


if __name__ == "__main__":
    try:
        main()
    except (SmokeFailure, KeyError, ValueError, OSError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        # Never dump HTTP bodies, SQL output, authentication tokens or prompts.
        message = str(error) if isinstance(error, SmokeFailure) else type(error).__name__
        print(f"Translation runtime smoke test failed: {message}", file=sys.stderr)
        raise SystemExit(1) from None
