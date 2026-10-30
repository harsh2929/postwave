import hashlib
import hmac
import json

import httpx
import pytest

from postwave import (
    AsyncPostwave,
    ConflictError,
    Moosewave,
    SignedConversionCredentials,
    SignedConversionInput,
    compute_conversion_email_hmac_sha256,
    compute_conversion_ingest_signature_hex,
)


CREDENTIALS = SignedConversionCredentials(
    key_id="orders-primary", secret="sk_conversion_test_super_secret"
)
TIMESTAMP = 1_786_242_151


def independent_signature(body: bytes, key_id: str = CREDENTIALS.key_id) -> str:
    timestamp = str(TIMESTAMP).encode("utf-8")
    key = key_id.encode("utf-8")
    prefix = (
        b"postwave-conversion-v2\n"
        + str(len(key)).encode("ascii")
        + b"\n"
        + key
        + str(len(timestamp)).encode("ascii")
        + b"\n"
        + timestamp
    )
    return hmac.new(
        CREDENTIALS.secret.encode("utf-8"), prefix + body, hashlib.sha256
    ).hexdigest()


def conversion() -> SignedConversionInput:
    return SignedConversionInput(
        event_name="purchase",
        occurred_at="2026-08-09T10:22:31Z",
        identity={"external_id": "customer-1"},
        value=129,
        currency="USD",
        metadata={"order_id": "ord-1"},
    )


def assert_signed_request(request: httpx.Request, idempotency_key: str) -> None:
    assert request.headers.get("authorization") is None
    assert request.headers.get("x-tenant-slug") is None
    assert request.headers["x-postwave-timestamp"] == str(TIMESTAMP)
    assert request.headers["idempotency-key"] == idempotency_key
    assert request.headers["content-type"] == "application/json"
    assert request.headers["x-postwave-signature"] == (
        f"keyid={CREDENTIALS.key_id},v2={independent_signature(request.content)}"
    )


def test_sync_single_and_batch_sign_exact_raw_body_without_dashboard_auth():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        count = 2 if request.url.path.endswith("/batch") else 1
        return httpx.Response(
            202,
            json={
                "accepted": count,
                "conversion_ids": [41, 42] if count == 2 else [40],
                "key_id": CREDENTIALS.key_id,
            },
        )

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)
    client = Moosewave(
        api_key="pw_dashboard_must_not_leak",
        tenant_id="tenant-must-not-leak",
        http_client=http_client,
        retries=0,
    )
    single = client.conversion_ingest.ingest(
        conversion(), CREDENTIALS, timestamp=TIMESTAMP, idempotency_key="order-1"
    )
    batch = client.conversion_ingest.ingest_batch(
        [
            conversion(),
            {**conversion().model_dump(mode="json"), "identity": {"click_id": "click-2"}},
        ],
        CREDENTIALS,
        timestamp=TIMESTAMP,
        idempotency_key="orders-batch-1",
    )

    assert single.accepted == 1 and batch.accepted == 2
    assert [request.url.path for request in requests] == [
        "/api/public/conversions/ingest",
        "/api/public/conversions/ingest/batch",
    ]
    assert_signed_request(requests[0], "order-1")
    assert_signed_request(requests[1], "orders-batch-1")
    assert json.loads(requests[0].content) == conversion().model_dump(
        mode="json", exclude_none=True
    )
    assert len(json.loads(requests[1].content)["conversions"]) == 2


@pytest.mark.asyncio
async def test_async_ingest_uses_the_same_key_bound_contract():
    captured: httpx.Request | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured
        captured = request
        return httpx.Response(
            202,
            json={"accepted": 1, "conversion_ids": [40], "key_id": CREDENTIALS.key_id},
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncPostwave(
        http_client=http_client,
        retries=0,
    )
    receipt = await client.conversion_ingest.ingest(
        conversion(), CREDENTIALS, timestamp=TIMESTAMP, idempotency_key="order-async-1"
    )
    assert receipt.accepted == 1
    assert captured is not None
    assert_signed_request(captured, "order-async-1")
    await http_client.aclose()


def test_signature_binds_key_and_flat_error_keeps_machine_code():
    body = b'{"event_name":"purchase","identity":{"external_id":"c-1"}}'
    good = compute_conversion_ingest_signature_hex(body, CREDENTIALS, TIMESTAMP)
    other = compute_conversion_ingest_signature_hex(
        body,
        {"key_id": "orders-secondary", "secret": CREDENTIALS.secret},
        TIMESTAMP,
    )
    assert good == independent_signature(body)
    assert other != good

    identity_hmac = compute_conversion_email_hmac_sha256(
        "  Buyer@Example.COM  ", CREDENTIALS
    )
    assert identity_hmac == hmac.new(
        CREDENTIALS.secret.encode("utf-8"),
        b"buyer@example.com",
        hashlib.sha256,
    ).hexdigest()
    assert compute_conversion_email_hmac_sha256(
        "buyer@example.com",
        {"key_id": CREDENTIALS.key_id, "secret": "a-rotated-secret"},
    ) != identity_hmac

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={"error": "idempotency_conflict", "message": "different bytes"},
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Moosewave(api_key="pw_test", http_client=http_client, retries=0)
    with pytest.raises(ConflictError) as exc:
        client.conversion_ingest.ingest(conversion(), CREDENTIALS)
    assert exc.value.code == "idempotency_conflict"
    assert str(exc.value).endswith("different bytes")
