"""Audiences (lookalike) resource tests.

Asserts the request method + path + body/query shaping for the SUB-033
/api/v1/audiences/lookalike surface.
"""

from __future__ import annotations

import json

import httpx
import pytest

from postwave import AsyncPostwave, Moosewave


def _client(handler) -> Moosewave:
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, base_url="http://localhost:8080")
    return Moosewave(
        api_key="sk_test",
        tenant_id="acme",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def _async_client(handler) -> AsyncPostwave:
    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport, base_url="http://localhost:8080")
    return AsyncPostwave(
        api_key="sk_test",
        tenant_id="acme",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def test_generate_posts_to_lookalike():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["method"] = req.method
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content.decode()) if req.content else None
        return httpx.Response(201, json={"id": "look_1", "status": "ready"})

    pw = _client(handler)
    out = pw.audiences.generate({"seed_segment_id": "seg_1", "size": 2000})

    assert seen["method"] == "POST"
    assert seen["url"] == "http://localhost:8080/api/v1/audiences/lookalike"
    assert seen["body"] == {"seed_segment_id": "seg_1", "size": 2000}
    assert out == {"id": "look_1", "status": "ready"}


def test_get_lookalike_encodes_id():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["method"] = req.method
        seen["url"] = str(req.url)
        return httpx.Response(200, json={"id": "look 1"})

    pw = _client(handler)
    pw.audiences.get("look 1")

    assert seen["method"] == "GET"
    assert seen["url"] == "http://localhost:8080/api/v1/audiences/lookalike/look%201"


def test_members_passes_pagination_query():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["method"] = req.method
        seen["url"] = str(req.url)
        return httpx.Response(200, json={"items": [], "total": 0, "page": 2, "per_page": 50})

    pw = _client(handler)
    pw.audiences.members("look_1", page=2, per_page=50)

    assert seen["method"] == "GET"
    assert seen["url"] == (
        "http://localhost:8080/api/v1/audiences/lookalike/look_1/members?page=2&per_page=50"
    )


def test_members_omits_none_query():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        return httpx.Response(200, json={"items": []})

    pw = _client(handler)
    pw.audiences.members("look_1")

    # None page/per_page must be dropped -> no query string.
    assert seen["url"] == "http://localhost:8080/api/v1/audiences/lookalike/look_1/members"


def test_discard_deletes_lookalike():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["method"] = req.method
        seen["url"] = str(req.url)
        return httpx.Response(204)

    pw = _client(handler)
    pw.audiences.discard("look_1")

    assert seen["method"] == "DELETE"
    assert seen["url"] == "http://localhost:8080/api/v1/audiences/lookalike/look_1"


def test_get_rejects_empty_id():
    pw = _client(lambda req: httpx.Response(200, json={}))
    with pytest.raises(ValueError, match="lookalike audience id is required"):
        pw.audiences.get(" ")


@pytest.mark.asyncio
async def test_async_generate_and_members():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.setdefault("calls", []).append((req.method, str(req.url)))
        return httpx.Response(200, json={"id": "look_1"})

    pw = _async_client(handler)
    await pw.audiences.generate({"seed_segment_id": "seg_1"})
    await pw.audiences.members("look_1", page=1, per_page=10)

    assert seen["calls"] == [
        ("POST", "http://localhost:8080/api/v1/audiences/lookalike"),
        ("GET", "http://localhost:8080/api/v1/audiences/lookalike/look_1/members?page=1&per_page=10"),
    ]
    await pw.aclose()
