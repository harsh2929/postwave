"""Request-contract tests for the session-only agent mandate surface."""

from __future__ import annotations

import json

import httpx
import pytest

from postwave import (
    AgentMandateGrant,
    AgentMandatesResource,
    AsyncAgentMandatesResource,
    AsyncPostwave,
    Moosewave,
)


GRANT: AgentMandateGrant = {
    "purpose": "Reconcile campaign evidence",
    "actions": ["campaign.read", "report.read"],
    "resources": ["campaign:cmp_123"],
    "uses": 3,
    "ttl_seconds": 3600,
}


def _sync_client(handler) -> Moosewave:
    http = httpx.Client(
        transport=httpx.MockTransport(handler),
        base_url="http://localhost:8080",
        cookies={"postwave_session": "signed-in-person"},
    )
    return Moosewave(
        tenant_id="acme",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def _async_client(handler) -> AsyncPostwave:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="http://localhost:8080",
        cookies={"postwave_session": "signed-in-person"},
    )
    return AsyncPostwave(
        tenant_id="acme",
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def test_sync_agent_mandates_preserve_session_boundary_and_exact_routes():
    seen: list[tuple[str, str, object | None, bool, bool]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        seen.append(
            (
                req.method,
                req.url.raw_path.decode(),
                body,
                "authorization" in req.headers,
                "postwave_session=signed-in-person" in req.headers.get("cookie", ""),
            )
        )
        if req.method == "GET":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "mandate/one",
                            "purpose": "Reconcile campaign evidence",
                            "actions": ["campaign.read"],
                            "resources": ["campaign:cmp_123"],
                            "uses_remaining": 0,
                            "expires_at": "2026-08-31T04:00:00Z",
                            "revoked_at": "2026-08-31T03:00:00Z",
                        }
                    ]
                },
            )
        if req.method == "POST":
            return httpx.Response(
                201,
                json={
                    "id": "mandate/one",
                    "token": "reveal-once-token",
                    "expires_at": "2026-08-31T04:00:00Z",
                    "uses": 3,
                    "notice": "This token is shown once.",
                },
            )
        return httpx.Response(200, json={"revoked": True})

    client = _sync_client(handler)
    assert isinstance(client.agent_mandates, AgentMandatesResource)
    page = client.agent_mandates.list()
    minted = client.agent_mandates.create(GRANT)
    revoked = client.agent_mandates.revoke("mandate/one")

    assert page["data"][0]["revoked_at"] == "2026-08-31T03:00:00Z"
    assert "token" not in page["data"][0]
    assert minted["token"] == "reveal-once-token"
    assert revoked == {"revoked": True}
    assert seen == [
        ("GET", "/api/v1/agent-mandates", None, False, True),
        ("POST", "/api/v1/agent-mandates", GRANT, False, True),
        ("DELETE", "/api/v1/agent-mandates/mandate%2Fone", None, False, True),
    ]


@pytest.mark.asyncio
async def test_async_agent_mandates_match_sync_surface():
    seen: list[tuple[str, str, object | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(
            (
                req.method,
                req.url.raw_path.decode(),
                json.loads(req.content) if req.content else None,
            )
        )
        if req.method == "GET":
            return httpx.Response(200, json={"data": []})
        if req.method == "POST":
            return httpx.Response(
                201,
                json={
                    "id": "mandate-two",
                    "token": "reveal-once-token",
                    "expires_at": "2026-08-31T04:00:00Z",
                    "uses": 3,
                    "notice": "This token is shown once.",
                },
            )
        return httpx.Response(200, json={"revoked": True})

    client = _async_client(handler)
    assert isinstance(client.agent_mandates, AsyncAgentMandatesResource)
    assert await client.agent_mandates.list() == {"data": []}
    assert (await client.agent_mandates.create(GRANT))["id"] == "mandate-two"
    assert await client.agent_mandates.revoke("mandate/two") == {"revoked": True}
    assert seen == [
        ("GET", "/api/v1/agent-mandates", None),
        ("POST", "/api/v1/agent-mandates", GRANT),
        ("DELETE", "/api/v1/agent-mandates/mandate%2Ftwo", None),
    ]
    await client.aclose()


@pytest.mark.parametrize("mandate_id", ["", None])
def test_agent_mandate_revoke_rejects_missing_id(mandate_id):
    client = _sync_client(lambda _req: pytest.fail("request must not be sent"))
    with pytest.raises(ValueError, match="agent mandate id is required"):
        client.agent_mandates.revoke(mandate_id)
