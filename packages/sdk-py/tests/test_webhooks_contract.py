from __future__ import annotations

from typing import get_args

import httpx

from postwave import Moosewave
from postwave.types import OUTBOUND_WEBHOOK_EVENT_TYPES, WebhookEventType


CANONICAL_OUTBOUND_EVENTS = (
    "campaign.sent",
    "subscriber.added",
    "subscriber.removed",
    "subscriber.unsubscribed",
    "approval.requested",
    "approval.decided",
    "audit.created",
    "bounce.received",
    "list_health.degraded",
    "list.subscriber.added",
    "email.bounced",
    "email.complained",
    "email.delivered",
    "assurance.run.completed",
    "assurance.run.blocked",
)


def _response(request: httpx.Request, body: object, status: int = 200) -> httpx.Response:
    return httpx.Response(status, request=request, json=body)


def test_complete_canonical_outbound_event_vocabulary():
    assert OUTBOUND_WEBHOOK_EVENT_TYPES == CANONICAL_OUTBOUND_EVENTS
    assert get_args(WebhookEventType) == CANONICAL_OUTBOUND_EVENTS
    assert "subscriber.created" not in OUTBOUND_WEBHOOK_EVENT_TYPES


def test_canonical_outbound_routes_receiver_auth_and_replay_idempotency():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/replay"):
            return _response(
                request,
                {
                    "delivery_id": "child",
                    "replayed_from": "parent",
                    "status": "pending",
                    "replayed_at": "2026-07-23T00:00:00Z",
                },
                202,
            )
        if request.method == "POST":
            return _response(
                request,
                {
                    "webhook": {
                        "id": "wh_1",
                        "tenant_id": "tenant",
                        "url": "https://receiver.example/hook",
                        "events": ["subscriber.added"],
                        "active": True,
                        "created_at": "2026-07-23T00:00:00Z",
                        "updated_at": "2026-07-23T00:00:00Z",
                        "consecutive_failures": 0,
                        "signing_algorithm": "hmac_sha256",
                        "auth_config": {
                            "type": "bearer",
                            "bearer_configured": True,
                            "secret_redacted": True,
                        },
                        "auth_config_status": "ready",
                    },
                    "signing_secret": "owhsec_once",
                },
                201,
            )
        return _response(request, {"webhooks": [], "next_cursor": None})

    with Moosewave(
        api_key="test",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    ) as client:
        client.webhooks.list(limit=25)
        created = client.webhooks.create(
            {
                "url": "https://receiver.example/hook",
                "events": ["subscriber.added"],
                "auth_config": {"type": "bearer", "bearer_token": "write-only"},
            }
        )
        client.webhooks.replay("delivery/1", idempotency_key="stable-replay")

    assert seen[0].url.path == "/api/v1/outbound-webhooks"
    assert '"bearer_token": "write-only"' in seen[1].content.decode()
    assert created.webhook.auth_config is not None
    assert created.webhook.auth_config.bearer_configured
    assert "write-only" not in created.webhook.model_dump_json()
    assert seen[2].url.raw_path.endswith(
        b"/outbound-webhooks/deliveries/delivery%2F1/replay"
    )
    assert seen[2].headers["Idempotency-Key"] == "stable-replay"


def test_canonical_inbound_event_replay_and_trigger_routes():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response(
            request,
            {"items": [], "ok": True, "queued": True, "replay_id": "r", "matches": []},
            200,
        )

    with Moosewave(
        api_key="test",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    ) as client:
        client.inbound_webhooks.get("in/1")
        client.inbound_webhooks.events("in/1", limit=50)
        client.inbound_webhooks.replay("in/1", 42, idempotency_key="stable-inbound")
        client.inbound_webhooks.triggers("in/1")
        client.inbound_webhooks.preview_transform(".payload", {"payload": {}})

    assert seen[0].url.raw_path.endswith(b"/inbound-webhooks/in%2F1")
    assert seen[1].url.raw_path.split(b"?", 1)[0].endswith(
        b"/inbound-webhooks/in%2F1/events"
    )
    assert seen[2].url.path.endswith("/events/42/replay")
    assert seen[2].headers["Idempotency-Key"] == "stable-inbound"
    assert seen[3].url.path.endswith("/triggers")
    assert seen[4].url.path.endswith("/inbound-webhooks/transform/preview")
