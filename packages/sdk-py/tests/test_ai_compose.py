"""AI compose resource tests.

Asserts the request method + path + body shaping for compose_broadcast and
compose_variants against the first-party /api/v1/ai/compose/* endpoints.
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


def test_compose_broadcast_posts_brief_body():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["method"] = req.method
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content.decode()) if req.content else None
        return httpx.Response(
            200,
            json={
                "primary": {"subject": "Hello"},
                "subject_variants": ["Hello", "Hey"],
                "generated_at": "2026-06-22T00:00:00Z",
            },
        )

    pw = _client(handler)
    out = pw.ai_compose.compose_broadcast(
        {"brief": "announce our pricing change", "variant_count": 3, "tone": "formal"}
    )

    assert seen["method"] == "POST"
    assert seen["url"] == "http://localhost:8080/api/v1/ai/compose/broadcast"
    assert seen["body"] == {
        "brief": "announce our pricing change",
        "variant_count": 3,
        "tone": "formal",
    }
    assert out["subject_variants"] == ["Hello", "Hey"]


def test_compose_variants_posts_subject_body():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["method"] = req.method
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content.decode()) if req.content else None
        return httpx.Response(
            200,
            json={"subject_variants": ["A", "B", "C"], "generated_at": "2026-06-22T00:00:00Z"},
        )

    pw = _client(handler)
    out = pw.ai_compose.compose_variants({"subject": "Hello", "body": "<p>hi</p>", "variant_count": 3})

    assert seen["method"] == "POST"
    assert seen["url"] == "http://localhost:8080/api/v1/ai/compose/variants"
    assert seen["body"] == {"subject": "Hello", "body": "<p>hi</p>", "variant_count": 3}
    assert out["subject_variants"] == ["A", "B", "C"]


@pytest.mark.asyncio
async def test_async_compose_broadcast():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["method"] = req.method
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content.decode()) if req.content else None
        return httpx.Response(
            200,
            json={"primary": {}, "subject_variants": [], "generated_at": "2026-06-22T00:00:00Z"},
        )

    pw = _async_client(handler)
    await pw.ai_compose.compose_broadcast({"brief": "hi"})

    assert seen["method"] == "POST"
    assert seen["url"] == "http://localhost:8080/api/v1/ai/compose/broadcast"
    assert seen["body"] == {"brief": "hi"}
    await pw.aclose()
