"""Hosted preference request-shape contracts for sync and async clients."""

from __future__ import annotations

import json

import httpx
import pytest

from postwave import AsyncPostwave, Moosewave


def test_sync_public_preference_update_uses_runtime_post_contract() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = Moosewave(
        api_key="test",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )

    client.preferences.update_public("token-value", {"frequency": "weekly"})

    assert seen == {
        "method": "POST",
        "path": "/api/public/preferences/token-value",
        "body": {"frequency": "weekly"},
    }
    client.close()


@pytest.mark.asyncio
async def test_async_public_preference_update_uses_runtime_post_contract() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncPostwave(
        api_key="test",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )

    await client.preferences.update_public("token-value", {"frequency": "weekly"})

    assert seen == {
        "method": "POST",
        "path": "/api/public/preferences/token-value",
        "body": {"frequency": "weekly"},
    }
    await client.aclose()
