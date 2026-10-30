"""Campaigns resource tests (pause/resume/cancel lifecycle).

Mirrors the TS SDK's POST /api/v1/campaigns/{id}/pause|resume|cancel methods,
which each return the updated campaign.
"""

from __future__ import annotations

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


@pytest.mark.parametrize(
    ("action", "expected_status"),
    [
        ("pause", "paused"),
        ("resume", "sending"),
        ("cancel", "cancelled"),
    ],
)
def test_pause_resume_cancel_post_and_return_campaign(action, expected_status):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["method"] = req.method
        seen["url"] = str(req.url)
        return httpx.Response(200, json={"id": "camp 1", "status": expected_status})

    pw = _client(handler)
    out = getattr(pw.campaigns, action)("camp 1")

    assert seen["method"] == "POST"
    # The space in the id must be percent-encoded by quote(..., safe='').
    assert seen["url"] == f"http://localhost:8080/api/v1/campaigns/camp%201/{action}"
    assert out == {"id": "camp 1", "status": expected_status}


@pytest.mark.parametrize(
    ("action", "expected_status"),
    [
        ("pause", "paused"),
        ("resume", "sending"),
        ("cancel", "cancelled"),
    ],
)
@pytest.mark.asyncio
async def test_async_pause_resume_cancel(action, expected_status):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["method"] = req.method
        seen["url"] = str(req.url)
        return httpx.Response(200, json={"id": "abc", "status": expected_status})

    pw = _async_client(handler)
    out = await getattr(pw.campaigns, action)("abc")

    assert seen["method"] == "POST"
    assert seen["url"] == f"http://localhost:8080/api/v1/campaigns/abc/{action}"
    assert out == {"id": "abc", "status": expected_status}
    await pw.aclose()
