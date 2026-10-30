"""Error mapping tests."""

from __future__ import annotations

import httpx
import pytest

from postwave import (
    AuthError,
    ConflictError,
    NetworkError,
    NotFoundError,
    ParseError,
    Moosewave,
    PostwaveError,
    RateLimitError,
    RequestAbortedError,
    ServerError,
    TimeoutError,
    ValidationError,
    WrongRegionError,
)


def _client(status: int, body, headers: dict[str, str] | None = None) -> Moosewave:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body, headers=headers or {})

    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, base_url="http://localhost:8080")
    return Moosewave(api_key="k", tenant_id="t", http_client=http, retries=0, base_url="http://localhost:8080")


def test_401_maps_to_auth_error():
    pw = _client(401, {"error": {"code": "no_tenant", "message": "tenant required"}})
    with pytest.raises(AuthError) as exc:
        pw.subscribers.list()
    assert exc.value.code == "no_tenant"


def test_404_maps_to_not_found_with_request_id():
    pw = _client(
        404,
        {"error": {"code": "not_found", "message": "no such form"}},
        headers={"x-request-id": "req_xyz"},
    )
    with pytest.raises(NotFoundError) as exc:
        pw.forms.get("missing")
    assert str(exc.value) == "no such form"
    assert exc.value.code == "not_found"
    assert exc.value.request_id == "req_xyz"


def test_409_maps_to_conflict():
    pw = _client(409, {"error": {"code": "slug_taken", "message": "taken"}})
    with pytest.raises(ConflictError):
        pw.forms.create({"name": "x", "slug": "x", "optInMode": "single"})


def test_422_collects_field_errors():
    pw = _client(
        422,
        {"error": {"code": "invalid", "message": "bad", "fields": [{"path": "/email", "message": "must be email"}]}},
    )
    with pytest.raises(ValidationError) as exc:
        pw.subscribers.create({"email": "bad"})
    assert exc.value.fields == [{"path": "/email", "message": "must be email"}]


def test_500_maps_to_server_error():
    pw = _client(500, {"error": {"code": "boom", "message": "kaboom"}})
    with pytest.raises(ServerError):
        pw.subscribers.list()


def test_429_maps_to_rate_limit_with_retry_after():
    pw = _client(
        429,
        {"error": {"code": "rl", "message": "slow", "retry_after_seconds": 3}},
        headers={"retry-after": "3"},
    )
    with pytest.raises(RateLimitError) as exc:
        pw.subscribers.list()
    assert exc.value.retry_after_seconds == 3


def test_flat_string_error_envelope_supported():
    pw = _client(404, {"error": "no rollback for this job"})
    with pytest.raises(NotFoundError) as exc:
        pw.migrations.rollback_status("jx")
    assert "no rollback" in str(exc.value)


def test_oversized_error_body_maps_to_generic_http_error():
    pw = _client(
        500,
        {"error": {"code": "huge", "message": "x" * (70 * 1024)}},
        headers={"x-request-id": "req_huge"},
    )
    with pytest.raises(ServerError) as exc:
        pw.subscribers.list()
    assert exc.value.code == "http_500"
    assert exc.value.request_id == "req_huge"


def test_oversized_error_content_length_is_not_parsed():
    pw = _client(
        500,
        {"error": {"code": "boom", "message": "this small body should be ignored"}},
        headers={
            "content-length": str(64 * 1024 + 1),
            "x-request-id": "req_huge_declared",
        },
    )
    with pytest.raises(ServerError) as exc:
        pw.subscribers.list()
    assert exc.value.code == "http_500"
    assert exc.value.request_id == "req_huge_declared"


def test_subclass_chain():
    """Every subclass must inherit from PostwaveError so callers can catch broadly."""
    for cls in (AuthError, NotFoundError, ConflictError, ValidationError, RateLimitError, ServerError):
        assert issubclass(cls, PostwaveError)


def test_421_maps_to_wrong_region_from_headers():
    """421 Misdirected Request → WrongRegionError, carrying the canonical
    SDK host (Location header) and the tenant's pinned region."""
    pw = _client(
        421,
        {"error": {"code": "wrong_region", "message": "tenant lives in eu-central-1"}},
        headers={
            "location": "https://eu-central-1.api.moosewave.com",
            "x-postwave-region": "eu-central-1",
            "x-request-id": "req_region",
        },
    )
    with pytest.raises(WrongRegionError) as exc:
        pw.subscribers.list()
    assert exc.value.status == 421
    assert exc.value.code == "wrong_region"
    assert exc.value.correct_endpoint == "https://eu-central-1.api.moosewave.com"
    assert exc.value.region == "eu-central-1"
    assert exc.value.request_id == "req_region"


def test_421_falls_back_to_body_envelope():
    """When the headers are absent, WrongRegionError reads correct_endpoint /
    region from the JSON error envelope."""
    pw = _client(
        421,
        {
            "error": {
                "code": "wrong_region",
                "message": "wrong region",
                "correct_endpoint": "https://us-east-1.api.moosewave.com",
                "region": "us-east-1",
            }
        },
    )
    with pytest.raises(WrongRegionError) as exc:
        pw.subscribers.list()
    assert exc.value.correct_endpoint == "https://us-east-1.api.moosewave.com"
    assert exc.value.region == "us-east-1"


def test_new_error_classes_exist_and_subclass_postwave_error():
    for cls in (NetworkError, TimeoutError, RequestAbortedError, ParseError, WrongRegionError):
        assert issubclass(cls, PostwaveError)
    # TimeoutError and RequestAbortedError are NetworkErrors (status 0).
    assert issubclass(TimeoutError, NetworkError)
    assert issubclass(RequestAbortedError, NetworkError)


def test_network_error_fields():
    err = NetworkError("connection refused")
    assert err.status == 0
    assert err.code == "network_error"
    assert str(err) == "connection refused"
    err_with_code = NetworkError("dns failure", code="dns_error")
    assert err_with_code.code == "dns_error"


def test_timeout_error_fields():
    err = TimeoutError()
    assert err.status == 0
    assert err.code == "request_timeout"
    assert str(err) == "Request timed out"
    custom = TimeoutError("slow op")
    assert str(custom) == "slow op"
    assert custom.code == "request_timeout"


def test_request_aborted_error_fields():
    err = RequestAbortedError()
    assert err.status == 0
    assert err.code == "request_aborted"
    assert str(err) == "Request was cancelled"


def test_parse_error_fields():
    err = ParseError()
    assert err.status == 0
    assert err.code == "invalid_json"
    assert "invalid JSON" in str(err)
    custom = ParseError("bad body", status=502)
    assert custom.status == 502
    assert str(custom) == "bad body"


def test_wrong_region_error_fields():
    err = WrongRegionError(
        "wrong region",
        code="wrong_region",
        correct_endpoint="https://eu-central-1.api.moosewave.com",
        region="eu-central-1",
        request_id="req_1",
    )
    assert err.status == 421
    assert err.correct_endpoint == "https://eu-central-1.api.moosewave.com"
    assert err.region == "eu-central-1"
    assert err.request_id == "req_1"
