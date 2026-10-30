"""Mobile push resource request-contract tests."""

from __future__ import annotations

import json

import httpx
import pytest

from postwave import AsyncPostwave, Moosewave


def _client(handler) -> Moosewave:
    http = httpx.Client(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    return Moosewave(
        api_key="sk_test",
        tenant_id="acme",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def _async_client(handler) -> AsyncPostwave:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    return AsyncPostwave(
        api_key="sk_test",
        tenant_id="acme",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def test_mobile_push_routes_and_never_requires_a_token_for_revocation():
    seen: list[tuple[str, str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, json.loads(req.content)))
        return httpx.Response(200, json={"registered": False})

    pw = _client(handler)
    pw.mobile_push.register(
        {
            "device_key": "ab" * 32,
            "expo_push_token": "ExponentPushToken[test]",
            "platform": "ios",
        }
    )
    pw.mobile_push.status("cd" * 32)
    pw.mobile_push.revoke("ef" * 32)
    pw.mobile_push.revoke_possession("01" * 32)

    assert seen == [
        (
            "POST",
            "/api/v1/mobile/push/devices",
            {
                "device_key": "ab" * 32,
                "expo_push_token": "ExponentPushToken[test]",
                "platform": "ios",
            },
        ),
        ("POST", "/api/v1/mobile/push/devices/status", {"device_key": "cd" * 32}),
        ("POST", "/api/v1/mobile/push/devices/revoke", {"device_key": "ef" * 32}),
        ("POST", "/api/public/mobile/push/revoke", {"device_key": "01" * 32}),
    ]


@pytest.mark.asyncio
async def test_async_mobile_push_status():
    seen: list[tuple[str, str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, json.loads(req.content)))
        return httpx.Response(200, json={"registered": True})

    pw = _async_client(handler)
    result = await pw.mobile_push.status("23" * 32)
    assert result == {"registered": True}
    assert seen == [
        ("POST", "/api/v1/mobile/push/devices/status", {"device_key": "23" * 32})
    ]
    await pw.aclose()
