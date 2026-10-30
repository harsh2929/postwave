"""Sanitized Gift history SDK contract for sync and async clients."""

from __future__ import annotations

import inspect

import httpx
import pytest

from postwave import AsyncPostwave, Moosewave
from postwave.resources.gift_subscriptions import (
    AsyncGiftSubscriptionsResource,
    GiftSubscription,
    GiftSubscriptionsResource,
)

SAFE_RECORD = {
    "id": "00000000-0000-4000-8000-000000000001",
    "label": "Gift record 00000000",
    "plan_label": "Pro Annual",
    "duration_months": 12,
    "status": "redeemed",
    "created_at": "2026-07-01T00:00:00Z",
    "redeemed_at": "2026-07-02T00:00:00Z",
    "expires_at": None,
    "canceled_at": None,
    "message_recorded": True,
    "provider_invoice_linked": True,
    "gifter_member_linked": False,
    "recipient_member_linked": True,
}

SAFE_STATS = {
    "total": 8,
    "pending": 1,
    "paid": 1,
    "granted": 3,
    "canceled": 1,
    "expired": 1,
    "refunded": 1,
    "conversionRate": 0.5,
    "generated_at": "2026-07-27T12:00:00Z",
}


def _response_for(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/stats"):
        return httpx.Response(200, json=SAFE_STATS)
    if request.url.path == "/api/v1/gift-subscriptions":
        return httpx.Response(
            200,
            json={
                "items": [SAFE_RECORD],
                "total": 1,
                "limit": 100,
                "offset": 10000,
                "snapshot_at": "2026-07-27T12:00:00Z",
            },
        )
    return httpx.Response(200, json=SAFE_RECORD)


def test_sync_gift_history_uses_the_exact_three_get_routes() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response_for(request)

    with Moosewave(
        api_key="test",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    ) as client:
        page = client.gift_subscriptions.list(
            limit=100,
            offset=10000,
            q="Gift record A1B2-C3D4",
            filter="closed",
            sort="status",
        )
        stats = client.gift_subscriptions.stats()
        record = client.gift_subscriptions.get(
            "A1B2C3D4-E5F6-7890-ABCD-EF0123456789",
        )

    assert [request.method for request in seen] == ["GET", "GET", "GET"]
    assert seen[0].url.path == "/api/v1/gift-subscriptions"
    assert dict(seen[0].url.params) == {
        "limit": "100",
        "offset": "10000",
        "q": "a1b2c3d4",
        "filter": "closed",
        "sort": "status",
    }
    assert seen[1].url.path == "/api/v1/gift-subscriptions/stats"
    assert seen[2].url.path.endswith(
        "/a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    )
    assert page["items"][0] == SAFE_RECORD
    assert stats == SAFE_STATS
    assert record == SAFE_RECORD


@pytest.mark.asyncio
async def test_async_gift_history_matches_sync_query_and_route_behavior() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response_for(request)

    client = AsyncPostwave(
        api_key="test",
        base_url="http://localhost:8080",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        retries=0,
    )
    try:
        await client.gift_subscriptions.list(
            limit=1,
            offset=0,
            q="A1B2-C3D4",
            filter="pending",
            sort="oldest",
        )
        await client.gift_subscriptions.stats()
        await client.gift_subscriptions.get(
            "A1B2C3D4-E5F6-7890-ABCD-EF0123456789",
        )
    finally:
        await client.aclose()

    assert [request.method for request in seen] == ["GET", "GET", "GET"]
    assert dict(seen[0].url.params) == {
        "limit": "1",
        "offset": "0",
        "q": "a1b2c3d4",
        "filter": "pending",
        "sort": "oldest",
    }
    assert [request.url.path for request in seen[:2]] == [
        "/api/v1/gift-subscriptions",
        "/api/v1/gift-subscriptions/stats",
    ]
    assert seen[2].url.path.endswith(
        "/a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    )


def test_default_list_omits_noop_query_parameters() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return _response_for(request)

    with Moosewave(
        api_key="test",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    ) as client:
        client.gift_subscriptions.list(q="   ", filter="all", sort="newest")

    assert seen == ["http://localhost:8080/api/v1/gift-subscriptions"]


def test_sync_rejects_invalid_search_and_pagination_before_transport() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response_for(request)

    with Moosewave(
        api_key="test",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    ) as client:
        invalid_calls = [
            lambda: client.gift_subscriptions.list(q="person@example.com"),
            lambda: client.gift_subscriptions.list(q="1234567"),
            lambda: client.gift_subscriptions.list(q="f" * 33),
            lambda: client.gift_subscriptions.list(q=12345678),  # type: ignore[arg-type]
            lambda: client.gift_subscriptions.list(limit=0),
            lambda: client.gift_subscriptions.list(limit=101),
            lambda: client.gift_subscriptions.list(limit=True),
            lambda: client.gift_subscriptions.list(offset=-1),
            lambda: client.gift_subscriptions.list(offset=10001),
        ]
        for call in invalid_calls:
            with pytest.raises((TypeError, ValueError)):
                call()

    assert seen == []


def test_sync_rejects_malformed_detail_ids_before_transport() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response_for(request)

    with Moosewave(
        api_key="test",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    ) as client:
        invalid_ids = [
            "",
            "gift/part one",
            "a1b2c3d4e5f67890abcdef0123456789",
            "a1b2c3d4-e5f6-7890-abcd-ef012345678",
            " a1b2c3d4-e5f6-7890-abcd-ef0123456789",
            "person@example.com",
        ]
        for gift_id in invalid_ids:
            with pytest.raises(ValueError, match="canonical UUID"):
                client.gift_subscriptions.get(gift_id)
        with pytest.raises(TypeError, match="must be a string"):
            client.gift_subscriptions.get(None)  # type: ignore[arg-type]

    assert seen == []


@pytest.mark.asyncio
async def test_async_rejects_invalid_search_and_offset_before_transport() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response_for(request)

    client = AsyncPostwave(
        api_key="test",
        base_url="http://localhost:8080",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        retries=0,
    )
    try:
        with pytest.raises(ValueError, match="hexadecimal record prefix"):
            await client.gift_subscriptions.list(q="customer name")
        with pytest.raises(ValueError, match="offset"):
            await client.gift_subscriptions.list(offset=10001)
        with pytest.raises(ValueError, match="canonical UUID"):
            await client.gift_subscriptions.get("gift/part one")
    finally:
        await client.aclose()

    assert seen == []


def test_public_surface_and_record_type_are_strictly_read_only_and_minimized() -> None:
    expected_methods = {"get", "list", "stats"}
    for resource in (GiftSubscriptionsResource, AsyncGiftSubscriptionsResource):
        methods = {
            name
            for name, value in vars(resource).items()
            if not name.startswith("_") and inspect.isfunction(value)
        }
        assert methods == expected_methods

    assert set(GiftSubscription.__required_keys__) == set(SAFE_RECORD)
    assert not set(GiftSubscription.__annotations__) & {
        "tenant_id",
        "purchaser_email",
        "recipient_email",
        "message",
        "cancellation_reason",
        "stripe_invoice_id",
        "payment_url",
        "redemption_token",
        "subscriber_id",
        "attribution",
    }
