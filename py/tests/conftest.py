"""Shared pytest fixtures for witness_client tests.

The Python client tests exercise the real TypeScript HTTP server —
spawning ``npx tsx server/http.ts`` and waiting for /v1/health to
respond before yielding the base URL. This is the closest we get to
a contract test for the wire format without mocking the server.

If ``WITNESS_BASE_URL`` is set in the environment, fixtures defer to
that and skip spawning a server. Useful for CI that runs the server
out-of-band.
"""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest


def _free_port() -> int:
    """Bind, capture, release; the OS won't reuse this port immediately."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_for_health(base_url: str, timeout_s: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{base_url}/v1/health", timeout=0.5)
            if r.status_code == 200:
                return
        except Exception as err:  # noqa: BLE001 — best-effort polling
            last_err = err
        time.sleep(0.1)
    raise RuntimeError(f"witness server did not become healthy: {last_err!r}")


@pytest.fixture(scope="session")
def witness_base_url() -> Iterator[str]:
    """Spin up the TS witness HTTP server for the test session.

    Honors WITNESS_BASE_URL when set so contributors can point tests
    at an already-running server.
    """
    override = os.environ.get("WITNESS_BASE_URL")
    if override:
        yield override.rstrip("/")
        return

    port = _free_port()
    repo_root = Path(__file__).resolve().parents[2]
    server_path = repo_root / "server" / "http.ts"
    if not server_path.exists():
        pytest.fail(f"missing server/http.ts at {server_path}")

    env = {**os.environ, "WITNESS_PORT": str(port), "NODE_ENV": "test"}
    proc = subprocess.Popen(
        ["npx", "tsx", str(server_path)],
        cwd=str(repo_root),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        _wait_for_health(base)
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture
def event_loop() -> Iterator[asyncio.AbstractEventLoop]:
    """Per-test event loop — pytest-asyncio default is module-scoped."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
