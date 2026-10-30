from __future__ import annotations

import json

import httpx
import pytest
from pydantic import ValidationError as PydanticValidationError

from postwave import (
    AMBIGUOUS_ISSUE_RECOVERY,
    AmbiguousConversionIngestSecretIssueError,
    AsyncPostwave,
    Moosewave,
)


KEY_A = "0123456789abcdef0123456789abcdef"
KEY_B = "abcdef0123456789abcdef0123456789"
SECRET = "A" * 43
NOTICE = (
    "This is the only time the secret is shown. Store it now; "
    "it cannot be recovered, only replaced."
)
CREATED = "2026-08-30T12:00:00.123Z"
UPDATED = "2026-08-30T12:00:01Z"


def metadata(**overrides: object) -> dict[str, object]:
    return {
        "key_id": KEY_A,
        "label": "Orders 🔐",
        "created_at": CREATED,
        "identity_projection_status": "ready",
        "identity_projection_updated_at": UPDATED,
        **overrides,
    }


def issued(**overrides: object) -> dict[str, object]:
    return {
        "secret": {
            **metadata(identity_projection_status="pending"),
            "secret": SECRET,
            **overrides,
        },
        "notice": NOTICE,
    }


def test_sync_list_is_one_bounded_closed_page_with_conditional_projection_state():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "items": [
                    metadata(),
                    metadata(
                        key_id=KEY_B,
                        label="retired",
                        revoked_at="2026-08-30T13:00:00+00:00",
                        identity_projection_status="failed",
                        identity_projection_error_code="projection_failed",
                    ),
                ],
                "next_cursor": "next-page",
            },
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Moosewave(api_key="pw_admin", http_client=http_client, retries=4)
    page = client.conversion_ingest_secrets.list(limit=17, cursor="page-token")

    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert requests[0].url.path == "/api/v1/conversions/ingest-secrets"
    assert dict(requests[0].url.params) == {"limit": "17", "cursor": "page-token"}
    assert requests[0].content == b""
    assert page.next_cursor == "next-page"
    assert page.items[0].identity_projection_status == "ready"
    assert page.items[1].identity_projection_error_code == "projection_failed"
    assert page.items[1].revoked_at is not None


def test_sync_issue_is_one_exact_201_attempt_without_any_idempotency_header():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json=issued())

    http_client = httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"Idempotency-Key": "client-default-must-not-leak"},
    )
    client = Moosewave(api_key="pw_admin", http_client=http_client, retries=9)
    result = client.conversion_ingest_secrets.issue("Orders 🔐")

    assert len(requests) == 1
    assert requests[0].headers.get("idempotency-key") is None
    assert requests[0].method == "POST"
    assert requests[0].url.path == "/api/v1/conversions/ingest-secrets"
    assert json.loads(requests[0].content) == {"label": "Orders 🔐"}
    assert result.secret.key_id == KEY_A
    assert result.secret.secret == SECRET
    assert result.secret.identity_projection_status == "pending"
    assert result.notice == NOTICE


def test_issue_never_retries_ambiguous_5xx_and_carries_safe_recovery():
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(503, json={"error": {"code": "internal"}})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Moosewave(api_key="pw_admin", http_client=http_client, retries=9)

    with pytest.raises(AmbiguousConversionIngestSecretIssueError) as exc:
        client.conversion_ingest_secrets.issue("orders")
    assert attempts == 1
    assert exc.value.recovery == AMBIGUOUS_ISSUE_RECOVERY
    assert "never retry issuance blindly" in str(exc.value)


@pytest.mark.parametrize(
    ("status", "payload"),
    [
        (200, issued()),
        (201, issued(secret="wrong")),
        (201, issued(revoked_at=UPDATED)),
        (201, issued(identity_projection_status="ready")),
        (201, issued(label="mismatched")),
        (201, {**issued(), "extra": True}),
    ],
)
def test_wrong_success_status_or_malformed_reveal_is_ambiguous(status: int, payload: object):
    http_client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(status, json=payload)
        )
    )
    client = Moosewave(api_key="pw_admin", http_client=http_client, retries=5)
    with pytest.raises(AmbiguousConversionIngestSecretIssueError) as exc:
        client.conversion_ingest_secrets.issue("Orders 🔐")
    assert SECRET not in str(exc.value)
    assert SECRET not in repr(exc.value)
    assert exc.value.payload is None
    assert exc.value.__cause__ is None


def test_closed_pages_and_local_bounds_fail_closed():
    untouched = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal untouched
        untouched += 1
        return httpx.Response(200, json={"items": []})

    client = Moosewave(
        api_key="pw_admin",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    )
    for call in [
        lambda: client.conversion_ingest_secrets.list(limit=0),
        lambda: client.conversion_ingest_secrets.list(cursor="x" * 513),
        lambda: client.conversion_ingest_secrets.issue(" padded "),
        lambda: client.conversion_ingest_secrets.issue("😀" * 129),
        lambda: client.conversion_ingest_secrets.issue("bad\ud800label"),
    ]:
        with pytest.raises((TypeError, ValueError)):
            call()
    assert untouched == 0

    hostile_pages = [
        ({"items": [metadata(secret=SECRET)]}, None),
        ({"items": [metadata(identity_projection_error_code=None)]}, None),
        ({"items": [metadata(), metadata()]}, None),
        ({"items": [metadata()], "next_cursor": "same"}, "same"),
        ({"items": [], "unknown": True}, None),
    ]
    for payload, cursor in hostile_pages:
        closed = Moosewave(
            api_key="pw_admin",
            retries=0,
            http_client=httpx.Client(
                transport=httpx.MockTransport(
                    lambda _request, value=payload: httpx.Response(200, json=value)
                )
            ),
        )
        with pytest.raises((PydanticValidationError, ValueError)):
            closed.conversion_ingest_secrets.list(cursor=cursor)


def test_revoke_is_exact_bodyless_normal_write_with_strict_receipt():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"revoked": True})

    client = Moosewave(
        api_key="pw_admin",
        retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    receipt = client.conversion_ingest_secrets.revoke(KEY_A)

    assert receipt.revoked is True
    assert requests[0].url.path == f"/api/v1/conversions/ingest-secrets/{KEY_A}/revoke"
    assert requests[0].content == b""
    assert requests[0].headers.get("idempotency-key") is not None
    with pytest.raises(ValueError):
        client.conversion_ingest_secrets.revoke(KEY_A.upper())


@pytest.mark.asyncio
async def test_async_issue_uses_the_same_single_attempt_keyless_contract():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json=issued())

    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        headers={"Idempotency-Key": "must-not-leak"},
    )
    client = AsyncPostwave(api_key="pw_admin", http_client=http_client, retries=7)
    result = await client.conversion_ingest_secrets.issue("Orders 🔐")

    assert result.secret.secret == SECRET
    assert len(requests) == 1
    assert requests[0].headers.get("idempotency-key") is None
    await http_client.aclose()
