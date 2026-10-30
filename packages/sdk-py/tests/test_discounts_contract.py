"""Sanitized discount-history contract for sync and async clients."""

from __future__ import annotations

import inspect

import httpx
import pytest

from postwave import AsyncPostwave, Moosewave
from postwave.resources.discounts import (
    AsyncDiscountsResource,
    DiscountsResource,
)

RECORD_ID = "A1B2C3D4-E5F6-4789-ABCD-EF0123456789"
SAFE_RECORD = {
    "id": RECORD_ID.lower(),
    "label": "Discount record A1B2C3D4",
    "percent_off": 20,
    "currency": "usd",
    "times_redeemed": 3,
    "applies_to": "both",
    "created_at": "2026-07-01T00:00:00Z",
}
SAFE_EVENT = {
    "redeemed_at": "2026-07-02T00:00:00Z",
    "subscriber_linked": True,
}


def _response(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/redemptions"):
        return httpx.Response(200, json={"items": [SAFE_EVENT], "has_more": True})
    return httpx.Response(200, json={"items": [SAFE_RECORD], "has_more": False})


def test_sync_discount_history_uses_exactly_the_two_mounted_gets() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response(request)

    with Moosewave(
        api_key="test",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    ) as client:
        assert client.discounts.list(
            record_id=RECORD_ID,
            limit=50,
            offset=0,
        ) == {
            "items": [SAFE_RECORD],
            "has_more": False,
        }
        assert client.discounts.redemptions(
            RECORD_ID,
            limit=100,
            offset=10_000,
        ) == {"items": [SAFE_EVENT], "has_more": True}

    assert [request.method for request in seen] == ["GET", "GET"]
    assert seen[0].url.path == "/api/v1/discounts"
    assert dict(seen[0].url.params) == {
        "record_id": RECORD_ID.lower(),
        "limit": "50",
        "offset": "0",
    }
    assert seen[1].url.path == (
        "/api/v1/discounts/"
        "a1b2c3d4-e5f6-4789-abcd-ef0123456789/redemptions"
    )
    assert dict(seen[1].url.params) == {"limit": "100", "offset": "10000"}


@pytest.mark.asyncio
async def test_async_discount_history_matches_sync_contract() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response(request)

    client = AsyncPostwave(
        api_key="test",
        base_url="http://localhost:8080",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        retries=0,
    )
    try:
        await client.discounts.list(limit=100, offset=10_000)
        await client.discounts.redemptions(RECORD_ID, limit=1, offset=0)
    finally:
        await client.aclose()

    assert [request.method for request in seen] == ["GET", "GET"]
    assert dict(seen[0].url.params) == {"limit": "100", "offset": "10000"}
    assert dict(seen[1].url.params) == {"limit": "1", "offset": "0"}


def test_discount_resources_expose_only_list_and_redemptions() -> None:
    for resource in (DiscountsResource, AsyncDiscountsResource):
        methods = {
            name
            for name, member in inspect.getmembers(resource, inspect.isfunction)
            if member.__qualname__.startswith(f"{resource.__name__}.")
        }
        assert methods == {"list", "redemptions"}
        assert "check" not in methods
        assert "export_redemptions_csv" not in methods


def test_record_id_and_pagination_fail_before_transport() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _response(request)

    with Moosewave(
        api_key="test",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    ) as client:
        invalid_ids = [
            "SAVE20",
            "",
            " a1b2c3d4-e5f6-4789-abcd-ef0123456789",
            "a1b2c3d4e5f64789abcdef0123456789",
            "a1b2c3d4-e5f6-4789-abcd-ef012345678",
        ]
        for record_id in invalid_ids:
            with pytest.raises((TypeError, ValueError), match="record_id"):
                client.discounts.list(record_id=record_id)
            with pytest.raises((TypeError, ValueError), match="record_id"):
                client.discounts.redemptions(record_id)

        for kwargs in (
            {"limit": 0},
            {"limit": 101},
            {"limit": True},
            {"offset": -1},
            {"offset": 10_001},
        ):
            with pytest.raises(ValueError):
                client.discounts.list(**kwargs)  # type: ignore[arg-type]
            with pytest.raises(ValueError):
                client.discounts.redemptions(RECORD_ID, **kwargs)  # type: ignore[arg-type]

    assert seen == []
