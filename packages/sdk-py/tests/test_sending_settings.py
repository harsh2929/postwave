from __future__ import annotations

import json

import httpx
import pytest

from postwave import (
    AsyncPostwave,
    ConflictError,
    ParseError,
    Moosewave,
    PostwaveError,
    SENDING_SETTINGS_RECONCILIATION_WAIT_SECONDS,
    ServerError,
)


INPUT = {
    "max_sends_per_hour": 2_500,
    "quiet_hours_start": "22:00",
    "quiet_hours_end": "07:00",
    "quiet_hours_tz": "America/New_York",
    "quiet_hours_per_recipient": True,
    "fallback_hour_utc": None,
    "expected_updated_at": "2026-08-30T08:00:00Z",
}
COMMITTED = {
    "tenant_id": "11111111-1111-4111-8111-111111111111",
    "max_sends_per_hour": 2_500,
    "quiet_hours_start": "22:00",
    "quiet_hours_end": "07:00",
    "quiet_hours_tz": "America/New_York",
    "quiet_hours_per_recipient": True,
    "fallback_hour_utc": None,
    "updated_at": "2026-08-30T08:01:00Z",
}


def test_publishes_causal_quiescence_wait_for_absence_reconciliation() -> None:
    assert SENDING_SETTINGS_RECONCILIATION_WAIT_SECONDS == 35


def test_set_is_one_attempt_strips_default_idempotency_and_requires_commit_proof() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            headers={
                "x-postwave-sending-cap-outcome": "committed",
                "x-request-id": "req-settings",
            },
            json=COMMITTED,
        )

    http = httpx.Client(
        headers={"Idempotency-Key": "client-default-must-not-leak"},
        transport=httpx.MockTransport(handler),
    )
    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=http,
        retries=9,
    )

    assert client.sending_settings.set(INPUT) == COMMITTED
    assert len(seen) == 1
    assert seen[0].method == "PUT"
    assert seen[0].url.path == "/api/v1/settings/sending"
    assert "idempotency-key" not in seen[0].headers
    assert json.loads(seen[0].content) == INPUT


def test_update_alias_never_retries_an_outcome_ambiguous_503() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            503,
            headers={
                "retry-after": "0",
                "x-postwave-sending-cap-outcome":
                    "committed-conservatively-fenced",
            },
            json={
                "error": {
                    "code": "sending_cap_convergence_pending",
                    "message": "settings committed; cap convergence remains fenced",
                }
            },
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    with pytest.raises(ParseError, match="reconcile canonical settings") as caught:
        client.sending_settings.update(INPUT)
    assert caught.value.status == 503
    assert len(seen) == 1


def test_set_turns_a_transport_failure_into_explicit_reconciliation() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        raise httpx.ConnectError("socket closed after upload", request=request)

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    with pytest.raises(ParseError, match="reconcile canonical settings") as caught:
        client.sending_settings.set(INPUT)
    assert caught.value.status == 0
    assert "35 seconds" in str(caught.value)
    assert isinstance(caught.value.__cause__, PostwaveError)
    assert len(seen) == 1


@pytest.mark.parametrize("outcome", [None, "probably-not-committed"])
def test_set_holds_an_unproven_409_for_reconciliation(outcome: str | None) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        headers = (
            {}
            if outcome is None
            else {"x-postwave-sending-cap-outcome": outcome}
        )
        return httpx.Response(
            409,
            headers=headers,
            json={"error": {"code": "settings_conflict", "message": "changed"}},
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    with pytest.raises(ParseError, match="reconcile canonical settings") as caught:
        client.sending_settings.set(INPUT)
    assert caught.value.status == 409
    assert len(seen) == 1


def test_set_preserves_an_exact_not_committed_409() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            headers={"x-postwave-sending-cap-outcome": "not-committed"},
            json={"error": {"code": "settings_conflict", "message": "changed"}},
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    with pytest.raises(ConflictError) as caught:
        client.sending_settings.set(INPUT)
    assert caught.value.code == "settings_conflict"


def test_set_holds_a_headerless_redirect_for_reconciliation() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            302,
            headers={"location": "/api/v1/settings/sending-replayed"},
            json={"error": {"code": "redirected", "message": "proxy redirect"}},
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(
            transport=httpx.MockTransport(handler), follow_redirects=True
        ),
        retries=9,
    )

    with pytest.raises(ParseError, match="reconcile canonical settings") as caught:
        client.sending_settings.set(INPUT)
    assert caught.value.status == 302
    assert len(seen) == 1


def test_set_holds_even_an_outcome_bearing_redirect_for_reconciliation() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"x-postwave-sending-cap-outcome": "not-committed"},
            json={"error": {"code": "redirected", "message": "proxy redirect"}},
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    with pytest.raises(ParseError, match="reconcile canonical settings") as caught:
        client.sending_settings.set(INPUT)
    assert caught.value.status == 302


def test_set_does_not_compare_a_local_tenant_slug_with_the_response_uuid() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            headers={"x-postwave-sending-cap-outcome": "committed"},
            json=COMMITTED,
        )

    client = Moosewave(
        api_key="pw_settings",
        tenant_id="acme",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    assert client.sending_settings.set(INPUT) == COMMITTED
    assert len(seen) == 1
    assert seen[0].headers["x-tenant-slug"] == "acme"


def test_set_proves_omitted_owned_fields_against_defaults_and_preserves_fallback() -> None:
    payload = {"expected_updated_at": INPUT["expected_updated_at"]}
    default_settings = {
        "tenant_id": COMMITTED["tenant_id"],
        "quiet_hours_per_recipient": True,
        "fallback_hour_utc": 17,
        "updated_at": COMMITTED["updated_at"],
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"x-postwave-sending-cap-outcome": "committed"},
            json=default_settings,
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    assert client.sending_settings.set(payload) == default_settings


def test_set_rejects_nondefault_committed_row_when_owned_fields_were_omitted() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"x-postwave-sending-cap-outcome": "committed"},
            json=COMMITTED,
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    with pytest.raises(ParseError, match="reconcile canonical settings"):
        client.sending_settings.set(
            {"expected_updated_at": INPUT["expected_updated_at"]}
        )


@pytest.mark.parametrize(
    "quiet_policy",
    [
        {
            "quiet_hours_start": "22:00",
            "quiet_hours_end": "",
            "quiet_hours_tz": "",
        },
        {
            "quiet_hours_start": "25:00",
            "quiet_hours_end": "07:00",
            "quiet_hours_tz": "UTC",
        },
        {
            "quiet_hours_start": "07:00",
            "quiet_hours_end": "07:00",
            "quiet_hours_tz": "UTC",
        },
        {
            "quiet_hours_start": "22:00",
            "quiet_hours_end": "07:00",
            "quiet_hours_tz": "Mars/Olympus_Mons",
        },
    ],
)
def test_set_rejects_a_committed_row_echoing_noncanonical_quiet_policy(
    quiet_policy: dict[str, str],
) -> None:
    payload = {**INPUT, **quiet_policy}
    candidate = {**COMMITTED, **quiet_policy}

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"x-postwave-sending-cap-outcome": "committed"},
            json=candidate,
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=4,
    )

    with pytest.raises(ParseError, match="reconcile canonical settings"):
        client.sending_settings.set(payload)


@pytest.mark.parametrize(
    "body,headers",
    [
        (COMMITTED, {}),
        (
            {**COMMITTED, "max_sends_per_hour": 9_999},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "tenant_id": "tenant-1"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "surprise": True},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "ip_pool": {"name": "", "dedicated": True}},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {
                **COMMITTED,
                "ip_pool": {
                    "name": "shared",
                    "dedicated": False,
                    "surprise": True,
                },
            },
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_by_user_id": "user-1"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "fallback_hour_utc": 17},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": "0001-01-01T00:00:00Z"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": "0001-01-01T00:00:00.0Z"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": "2026-02-30T08:01:00Z"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": "2026-08-30T08:01:00+14:01"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": "2026-08-30T08:01:00-23:59"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": "2026-08-30T08:01:00+12:99"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": "2026-08-30T08:01:00-13:60"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": INPUT["expected_updated_at"]},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": "2026-08-30T07:59:59.999999999Z"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
        (
            {**COMMITTED, "updated_at": "2026-08-30T09:00:00+01:00"},
            {"x-postwave-sending-cap-outcome": "committed"},
        ),
    ],
)
def test_set_rejects_unproven_or_mismatched_success(
    body: dict[str, object], headers: dict[str, str]
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers=headers, json=body)

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=4,
    )

    with pytest.raises(ParseError, match="reconcile canonical settings"):
        client.sending_settings.set(INPUT)


def test_set_preserves_nanoseconds_when_proving_revision_order() -> None:
    payload = {
        **INPUT,
        "expected_updated_at": "2026-08-30T08:00:00.000000001Z",
    }
    committed = {
        **COMMITTED,
        "updated_at": "2026-08-30T08:00:00.000000002Z",
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"x-postwave-sending-cap-outcome": "committed"},
            json=committed,
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=4,
    )

    assert client.sending_settings.set(payload) == committed


@pytest.mark.parametrize("mode", ["empty", "omitted"])
def test_set_accepts_a_fresh_revision_without_an_existing_revision(mode: str) -> None:
    payload = {**INPUT, "expected_updated_at": ""}
    if mode == "omitted":
        payload.pop("expected_updated_at")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"x-postwave-sending-cap-outcome": "committed"},
            json=COMMITTED,
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=4,
    )

    assert client.sending_settings.set(payload) == COMMITTED


def test_status_reads_the_canonical_coordination_endpoint() -> None:
    seen: list[httpx.Request] = []
    status = {
        "tenant_id": COMMITTED["tenant_id"],
        "quiet_hours_per_recipient": True,
        "counter_authoritative": False,
        "counter_source": "unavailable",
        "counter_scope": "unavailable",
        "cap_coordination_state": "ready",
        "cap_coordination_ready": True,
        "cap_coordination_matches_settings": True,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=status)

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=0,
    )

    assert client.sending_settings.status() == status
    assert len(seen) == 1
    assert seen[0].url.path == "/api/v1/settings/sending/status"


async def test_async_set_has_the_same_one_attempt_proof_boundary() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            headers={"x-postwave-sending-cap-outcome": "committed"},
            json=COMMITTED,
        )

    client = AsyncPostwave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.AsyncClient(
            headers={"Idempotency-Key": "client-default-must-not-leak"},
            transport=httpx.MockTransport(handler),
        ),
        retries=9,
    )

    assert await client.sending_settings.set(INPUT) == COMMITTED
    assert len(seen) == 1
    assert "idempotency-key" not in seen[0].headers


async def test_async_set_wraps_a_transport_failure_for_reconciliation() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        raise httpx.ConnectError("socket closed after upload", request=request)

    client = AsyncPostwave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    with pytest.raises(ParseError, match="35 seconds") as caught:
        await client.sending_settings.set(INPUT)
    assert caught.value.status == 0
    assert isinstance(caught.value.__cause__, PostwaveError)
    assert len(seen) == 1


@pytest.mark.parametrize("status", [302, 409])
async def test_async_set_holds_a_headerless_response_for_reconciliation(
    status: int,
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            status,
            headers={"location": "/api/v1/settings/sending-replayed"},
            json={"error": {"code": "settings_conflict", "message": "changed"}},
        )

    client = AsyncPostwave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler), follow_redirects=True
        ),
        retries=9,
    )

    with pytest.raises(ParseError, match="reconcile canonical settings") as caught:
        await client.sending_settings.set(INPUT)
    assert caught.value.status == status
    assert len(seen) == 1


def test_invalid_explicit_attempt_bound_fails_closed_to_one_attempt() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            503,
            headers={"retry-after": "0"},
            json={"error": {"code": "temporary", "message": "try again"}},
        )

    client = Moosewave(
        api_key="pw_settings",
        base_url="http://localhost:8080",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        retries=9,
    )

    with pytest.raises(ServerError):
        client.request("PUT", "/api/v1/ordinary-resource", body={}, max_attempts=0)
    assert len(seen) == 1
