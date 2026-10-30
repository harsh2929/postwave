"""Tests for SDK Idempotency-Key auto-mint + retry-stable behavior.

Audit finding (Week 3-4): the gateway has the idempotency table + middleware,
but no SDK ever sends an Idempotency-Key. An AI agent retrying a failed POST
creates the same subscriber twice. These tests lock in the contract that
the SDK now mints + reuses a key per logical call.
"""

from __future__ import annotations

import re

import httpx

from postwave import Moosewave


UUID_V4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _client(handler, retries: int = 0) -> Moosewave:
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, base_url="http://localhost:8080")
    return Moosewave(
        api_key="sk_test",
        tenant_id="acme",
        http_client=http,
        retries=retries,
        base_url="http://localhost:8080",
    )


def test_post_auto_mints_idempotency_key():
    seen: dict[str, str | None] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["key"] = req.headers.get("idempotency-key")
        return httpx.Response(200, json={"ok": True})

    pw = _client(handler)
    pw.request("POST", "/api/v1/forms", body={"name": "x"})
    assert seen["key"] is not None
    assert UUID_V4_RE.match(seen["key"]), f"got {seen['key']!r}"


def test_patch_and_delete_auto_mint():
    seen: list[str | None] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.headers.get("idempotency-key"))
        return httpx.Response(204)

    pw = _client(handler)
    pw.request("PATCH", "/api/v1/forms/f_1", body={})
    pw.request("DELETE", "/api/v1/forms/f_1")
    assert len(seen) == 2
    assert seen[0] is not None and UUID_V4_RE.match(seen[0])
    assert seen[1] is not None and UUID_V4_RE.match(seen[1])
    assert seen[0] != seen[1], "each logical call should mint a fresh key"


def test_get_does_not_auto_mint():
    seen: dict[str, str | None] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["key"] = req.headers.get("idempotency-key")
        return httpx.Response(200, json={})

    pw = _client(handler)
    pw.request("GET", "/api/v1/me")
    assert seen["key"] is None


def test_explicit_key_wins():
    seen: dict[str, str | None] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["key"] = req.headers.get("idempotency-key")
        return httpx.Response(200, json={})

    pw = _client(handler)
    pw.request(
        "POST",
        "/api/v1/forms",
        body={"name": "x"},
        idempotency_key="caller-supplied-stable-key",
    )
    assert seen["key"] == "caller-supplied-stable-key"


def test_explicit_none_opts_out():
    seen: dict[str, str | None] = {"key": "should-be-overwritten-to-None"}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["key"] = req.headers.get("idempotency-key")
        return httpx.Response(200, json={})

    pw = _client(handler)
    pw.request(
        "POST",
        "/api/v1/forms",
        body={"name": "x"},
        headers={"idempotency-key": "caller-key-must-not-leak"},
        idempotency_key=None,
    )
    assert seen["key"] is None


def test_retries_reuse_the_same_key():
    """The whole point of a per-call key: retries dedup to one server-side row."""
    keys: list[str | None] = []
    attempts = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        keys.append(req.headers.get("idempotency-key"))
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(500, json={"error": "transient"})
        return httpx.Response(200, json={"ok": True})

    pw = _client(handler, retries=3)
    pw.request("POST", "/api/v1/forms", body={})
    assert len(keys) == 3
    assert len(set(keys)) == 1, f"retries must reuse the same key, got {keys}"
    assert keys[0] is not None and UUID_V4_RE.match(keys[0])


def test_header_supplied_idempotency_key_is_respected():
    seen: dict[str, str | None] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["key"] = req.headers.get("idempotency-key")
        return httpx.Response(200, json={})

    pw = _client(handler)
    pw.request(
        "POST",
        "/api/v1/forms",
        body={},
        headers={"Idempotency-Key": "from-headers"},
    )
    assert seen["key"] == "from-headers"
