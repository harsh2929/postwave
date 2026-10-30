"""Strict Route43 customer push-suppression SDK contracts."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

from postwave import AsyncPostwave, Moosewave, PostwaveError

TENANT = "00000000-0000-0000-0000-000000000001"
OTHER_TENANT = "00000000-0000-0000-0000-000000000002"
ROW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SECOND_ID = "99999999-9999-4999-8999-999999999999"
TOKEN = "fcm-device-token-with-enough-entropy-123"
SECOND_TOKEN = "web-device-token-with-enough-entropy-456"


def _fingerprint(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()[:16]


def _row(
    *,
    row_id: str = ROW_ID,
    token: str = TOKEN,
    platform: str = "fcm",
    **overrides: Any,
) -> dict[str, Any]:
    return {
        "id": row_id,
        "tenant_id": TENANT,
        "device_token_hash": _fingerprint(token),
        "platform": platform,
        "reason": "manual",
        "source": "dashboard",
        "created_at": "2026-08-28T10:00:00.000000001Z",
        "updated_at": "2026-08-28T10:00:00.000000002Z",
        "version": 1,
        "reversible": True,
        **overrides,
    }


def _page(items: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
    return {
        "tenantId": TENANT,
        "items": items,
        "total": len(items),
        "snapshotAt": "2026-08-28T12:00:00Z",
        **overrides,
    }


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> Moosewave:
    http = httpx.Client(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    return Moosewave(
        api_key="pw_test_admin",
        tenant_id=TENANT,
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def _async_client(
    handler: Callable[[httpx.Request], httpx.Response],
) -> AsyncPostwave:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
    )
    return AsyncPostwave(
        api_key="pw_test_admin",
        tenant_id=TENANT,
        http_client=http,
        retries=0,
        base_url="http://localhost:8080",
    )


def test_list_binds_tenant_filters_snapshot_order_and_bounded_authority() -> None:
    locked = _row(
        platform="apns",
        reason="unregistered",
        source="provider",
        reversible=False,
        locked_reason="provider_authority",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/api/v1/push/suppressions"
        assert dict(request.url.params) == {
            "limit": "1",
            "platform": "apns",
            "reason": "unregistered",
            "hash_prefix": locked["device_token_hash"][:8],
            "cursor": "eyJ2IjoxfQ",
        }
        return httpx.Response(
            200,
            json=_page(
                [locked],
                total=2,
                nextCursor="eyJ2IjoxLCJhZnRlciI6MX0",
            ),
        )

    page = _client(handler).push_suppressions.list(
        platform="apns",
        reason="unregistered",
        hash_prefix=locked["device_token_hash"][:8],
        cursor="eyJ2IjoxfQ",
        limit=1,
    )
    assert page["tenantId"] == TENANT
    assert page["items"] == [locked]
    assert page["total"] == 2


def test_list_accepts_revision_snapshot_rows_after_wall_clock_rollback() -> None:
    future_dated = _row(
        created_at="2026-08-28T13:00:00.000000001Z",
        updated_at="2026-08-28T13:00:00.000000002Z",
    )
    page = _client(
        lambda _request: httpx.Response(
            200,
            json=_page(
                [future_dated],
                snapshotAt="2026-08-28T12:00:00Z",
            ),
        )
    ).push_suppressions.list()
    assert page["items"] == [future_dated]


def test_sync_mutations_bind_token_fingerprint_cas_and_atomic_receipts() -> None:
    second = _row(
        row_id=SECOND_ID,
        token=SECOND_TOKEN,
        platform="web",
        version=4,
    )
    seen: list[tuple[str, str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append((request.method, request.url.path, body))
        if request.url.path.endswith("bulk-import"):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "tenantId": TENANT,
                    "created": 1,
                    "existing": 1,
                    "items": [_row(), second],
                },
            )
        if request.url.path.endswith("bulk-remove"):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "tenantId": TENANT,
                    "removed": 2,
                    "stillSuppressed": 1,
                    "items": [
                        {
                            "ok": True,
                            "tenantId": TENANT,
                            "id": ROW_ID,
                            "version": 2,
                            "stillSuppressed": False,
                        },
                        {
                            "ok": True,
                            "tenantId": TENANT,
                            "id": SECOND_ID,
                            "version": 5,
                            "stillSuppressed": True,
                        },
                    ],
                },
            )
        if request.method == "DELETE":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "tenantId": TENANT,
                    "id": ROW_ID,
                    "version": 2,
                    "stillSuppressed": False,
                },
            )
        return httpx.Response(201, json=_row())

    client = _client(handler)
    assert client.push_suppressions.add(
        device_token=TOKEN, platform="fcm"
    ) == _row()
    assert client.push_suppressions.remove(
        ROW_ID, expected_version=1
    )["stillSuppressed"] is False
    imported = client.push_suppressions.bulk_import(
        [
            {"device_token": TOKEN, "platform": "fcm", "reason": "manual"},
            {
                "device_token": SECOND_TOKEN,
                "platform": "web",
                "reason": "manual",
            },
        ]
    )
    assert imported["created"] == 1
    removed = client.push_suppressions.bulk_remove(
        [
            {"id": ROW_ID, "expected_version": 1},
            {"id": SECOND_ID, "expected_version": 4},
        ]
    )
    assert removed["stillSuppressed"] == 1
    assert seen == [
        (
            "POST",
            "/api/v1/push/suppressions",
            {"device_token": TOKEN, "platform": "fcm", "reason": "manual"},
        ),
        (
            "DELETE",
            f"/api/v1/push/suppressions/{ROW_ID}",
            {"expected_version": 1},
        ),
        (
            "POST",
            "/api/v1/push/suppressions/bulk-import",
            {
                "items": [
                    {
                        "device_token": TOKEN,
                        "platform": "fcm",
                        "reason": "manual",
                    },
                    {
                        "device_token": SECOND_TOKEN,
                        "platform": "web",
                        "reason": "manual",
                    },
                ]
            },
        ),
        (
            "POST",
            "/api/v1/push/suppressions/bulk-remove",
            {
                "items": [
                    {"id": ROW_ID, "expected_version": 1},
                    {"id": SECOND_ID, "expected_version": 4},
                ]
            },
        ),
    ]


@pytest.mark.asyncio
async def test_async_surface_uses_the_same_strict_contract() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert json.loads(request.content) == {
            "device_token": TOKEN,
            "platform": "fcm",
            "reason": "manual",
        }
        return httpx.Response(200, json=_row())

    client = _async_client(handler)
    result = await client.push_suppressions.add(
        device_token=TOKEN, platform="fcm", reason="manual"
    )
    assert result["device_token_hash"] == _fingerprint(TOKEN)
    await client.aclose()


@pytest.mark.parametrize(
    "malformed",
    [
        _row(tenant_id=OTHER_TENANT),
        _row(source_event_id="provider-secret"),
        _row(
            reason="expired",
            source="provider",
            reversible=False,
            locked_reason="complaint_authority",
        ),
        _row(reason="manual", source="legacy", reversible=True),
        _row(updated_at="2026-08-28T10:00:00.000000000Z"),
        _row(version=9_007_199_254_740_992),
    ],
)
def test_response_decoder_rejects_tenant_secret_tuple_time_and_integer_drift(
    malformed: dict[str, Any],
) -> None:
    with pytest.raises(PostwaveError) as raised:
        _client(
            lambda _request: httpx.Response(200, json=_page([malformed]))
        ).push_suppressions.list()
    assert raised.value.code == "invalid_push_suppression_response"
    assert raised.value.status == 502


def test_add_rejects_a_mismatched_token_receipt() -> None:
    client = _client(
        lambda _request: httpx.Response(
            201,
            json=_row(device_token_hash="0123456789abcdef"),
        )
    )
    with pytest.raises(PostwaveError, match="Invalid push suppression response"):
        client.push_suppressions.add(device_token=TOKEN, platform="fcm")


def test_invalid_inputs_fail_before_any_request_and_never_require_token_logging() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    client = _client(handler)
    with pytest.raises(ValueError, match="canonical tenant UUID"):
        client.push_suppressions.list(tenant_id="")
    with pytest.raises(ValueError, match="20–4096 UTF-8 bytes"):
        client.push_suppressions.add(device_token="contains whitespace token", platform="fcm")
    with pytest.raises(ValueError, match="reason=manual"):
        client.push_suppressions.add(
            device_token=TOKEN, platform="fcm", reason="expired"
        )
    with pytest.raises(ValueError, match="cannot repeat"):
        client.push_suppressions.bulk_import(
            [
                {"device_token": TOKEN, "platform": "fcm"},
                {"device_token": TOKEN, "platform": "fcm"},
            ]
        )
    with pytest.raises(ValueError, match="cannot repeat"):
        client.push_suppressions.bulk_remove(
            [
                {"id": ROW_ID, "expected_version": 1},
                {"id": ROW_ID, "expected_version": 2},
            ]
        )
    assert calls == 0


def test_readme_documents_exact_admin_privacy_cas_and_delivery_hold() -> None:
    readme = " ".join(
        (Path(__file__).parents[1] / "README.md").read_text(encoding="utf-8").split()
    )
    for method in ("list", "add", "remove", "bulk_import", "bulk_remove"):
        assert method in readme
    assert "exact-admin credential" in readme
    assert "tenant-customer APNs/FCM/Web registry" in readme
    assert "not operator Expo-device management" in readme
    assert "minimized 16-hex" in readme
    assert "never the raw customer token or full digest" in readme
    assert "expected_version" in readme
    assert "stillSuppressed" in readme
    assert "HOLD / NO-GO" in readme
    assert "automatic provider feedback" in readme
    assert "Web is registry-only" in readme
