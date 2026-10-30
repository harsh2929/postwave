from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..errors import ParseError, PostwaveError
from ._base import AsyncResource, SyncResource


_COMMITTED_REVISION = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"
    r"(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$"
)
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_HHMM = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
_SENDING_SETTINGS_KEYS = frozenset(
    {
        "tenant_id",
        "max_sends_per_hour",
        "quiet_hours_start",
        "quiet_hours_end",
        "quiet_hours_tz",
        "quiet_hours_per_recipient",
        "fallback_hour_utc",
        "updated_by_user_id",
        "updated_at",
        "ip_pool",
    }
)
_SENDING_SETTINGS_IP_POOL_KEYS = frozenset({"name", "dedicated"})
SENDING_SETTINGS_RECONCILIATION_WAIT_SECONDS = 35
_INVALID_COMMITTED_RESPONSE = (
    "Sending-settings write returned an invalid committed response; "
    "wait at least 35 seconds from submission, then reconcile canonical "
    "settings and cap status before retrying."
)


def _is_int(value: Any, minimum: int, maximum: int) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def _is_committed_revision(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value != "0001-01-01T00:00:00Z"
        and _revision_epoch_nanoseconds(value) is not None
    )


def _revision_epoch_nanoseconds(value: str) -> int | None:
    match = _COMMITTED_REVISION.fullmatch(value)
    if match is None:
        return None
    year, month, day, hour, minute, second = (
        int(match.group(index)) for index in range(1, 7)
    )
    fraction = match.group(7) or ""
    offset_sign = match.group(8) or "+"
    offset_hours = int(match.group(9) or 0)
    offset_minutes = int(match.group(10) or 0)
    if (
        year < 2000
        or hour > 23
        or minute > 59
        or second > 59
        or offset_hours > 14
        or offset_minutes > 59
        or (offset_hours == 14 and offset_minutes != 0)
    ):
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    days_since_epoch = (
        date(year, month, day).toordinal() - date(1970, 1, 1).toordinal()
    )
    local_seconds = (
        days_since_epoch * 86_400 + hour * 3_600 + minute * 60 + second
    )
    signed_offset_seconds = (
        (-1 if offset_sign == "-" else 1)
        * (offset_hours * 60 + offset_minutes)
        * 60
    )
    nanoseconds = int(fraction.ljust(9, "0") or "0")
    return (local_seconds - signed_offset_seconds) * 1_000_000_000 + nanoseconds


def _is_canonical_quiet_policy(row: dict[str, Any]) -> bool:
    start = row.get("quiet_hours_start", "")
    end = row.get("quiet_hours_end", "")
    timezone = row.get("quiet_hours_tz", "")
    if not all(isinstance(value, str) for value in (start, end, timezone)):
        return False
    if start == "" and end == "" and timezone == "":
        return True
    if (
        _HHMM.fullmatch(start) is None
        or _HHMM.fullmatch(end) is None
        or start == end
        or not 1 <= len(timezone) <= 128
    ):
        return False
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True


def _is_canonical_ip_pool(value: Any) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict):
        return False
    name = value.get("name")
    return (
        value.keys() <= _SENDING_SETTINGS_IP_POOL_KEYS
        and isinstance(name, str)
        and bool(name.strip())
        and len(name) <= 160
        and isinstance(value.get("dedicated"), bool)
    )


def _is_sending_settings(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    tenant_id = value.get("tenant_id")
    cap = value.get("max_sends_per_hour")
    fallback = value.get("fallback_hour_utc")
    return (
        value.keys() <= _SENDING_SETTINGS_KEYS
        and isinstance(tenant_id, str)
        and _UUID.fullmatch(tenant_id) is not None
        and isinstance(value.get("quiet_hours_per_recipient"), bool)
        and _is_committed_revision(value.get("updated_at"))
        and (cap is None or _is_int(cap, 1, 1_000_000))
        and _is_canonical_quiet_policy(value)
        and (fallback is None or _is_int(fallback, 0, 23))
        and (
            value.get("updated_by_user_id") is None
            or (
                isinstance(value["updated_by_user_id"], str)
                and _UUID.fullmatch(value["updated_by_user_id"]) is not None
            )
        )
        and _is_canonical_ip_pool(value.get("ip_pool"))
    )


def _matches_submitted_settings(row: dict[str, Any], payload: dict[str, Any]) -> bool:
    if row.get("max_sends_per_hour") != payload.get("max_sends_per_hour"):
        return False
    string_fields = ("quiet_hours_start", "quiet_hours_end", "quiet_hours_tz")
    for field in string_fields:
        if (row.get(field) or "") != payload.get(field, ""):
            return False
    if row.get("quiet_hours_per_recipient") != payload.get(
        "quiet_hours_per_recipient", True
    ):
        return False
    # Omission preserves this legacy compatibility field server-side, so only
    # a caller-explicit fallback value can be compared in the direct receipt.
    if (
        "fallback_hour_utc" in payload
        and row.get("fallback_hour_utc") != payload["fallback_hour_utc"]
    ):
        return False
    return True


def _advances_submitted_revision(
    row: dict[str, Any], payload: dict[str, Any]
) -> bool:
    if "expected_updated_at" not in payload:
        return True
    expected = payload["expected_updated_at"]
    if expected == "":
        return True
    if not isinstance(expected, str):
        return False
    candidate = row.get("updated_at")
    if not isinstance(candidate, str):
        return False
    candidate_nanos = _revision_epoch_nanoseconds(candidate)
    expected_nanos = _revision_epoch_nanoseconds(expected)
    return (
        candidate_nanos is not None
        and expected_nanos is not None
        and candidate_nanos > expected_nanos
    )


def _validate_committed_response(
    value: Any,
    payload: dict[str, Any],
    outcome: str,
    request_id: str | None,
) -> dict[str, Any]:
    if (
        outcome != "committed"
        or not _is_sending_settings(value)
        or not _matches_submitted_settings(value, payload)
        or not _advances_submitted_revision(value, payload)
    ):
        raise ParseError(
            _INVALID_COMMITTED_RESPONSE,
            status=200,
            request_id=request_id,
            payload=value,
        )
    return value


class SendingSettingsResource(SyncResource):
    def get(self) -> Any:
        return self._client.request("GET", "/api/v1/settings/sending")

    def status(self) -> Any:
        return self._client.request("GET", "/api/v1/settings/sending/status")

    def set(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Replace settings with one wire attempt and verify commit proof.

        A transport error or non-200 response may follow a durable commit.
        Wait at least 35 seconds from submission, then reconcile with
        :meth:`get` and :meth:`status` before retrying.
        """
        outcome = ""
        request_id: str | None = None

        def capture(headers: Any) -> None:
            nonlocal outcome, request_id
            outcome = headers.get("x-postwave-sending-cap-outcome", "")
            request_id = headers.get("x-request-id")

        try:
            value = self._client.request(
                "PUT",
                "/api/v1/settings/sending",
                body=payload,
                idempotency_key=None,
                max_attempts=1,
                follow_redirects=False,
                expected_status=200,
                on_response_headers=capture,
            )
        except PostwaveError as error:
            safe_not_committed_http_failure = (
                error.status >= 400
                and outcome == "not-committed"
            )
            if not safe_not_committed_http_failure:
                raise ParseError(
                    "Sending-settings write returned no safe not-committed "
                    "receipt; wait at least 35 seconds from submission, then "
                    "reconcile canonical settings and cap status before retrying.",
                    status=error.status,
                    request_id=error.request_id,
                    payload=error.payload,
                ) from error
            raise
        return _validate_committed_response(value, payload, outcome, request_id)

    def update(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Backward-compatible alias for :meth:`set`."""
        return self.set(payload)


class AsyncSendingSettingsResource(AsyncResource):
    async def get(self) -> Any:
        return await self._client.request("GET", "/api/v1/settings/sending")

    async def status(self) -> Any:
        return await self._client.request("GET", "/api/v1/settings/sending/status")

    async def set(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Async one-attempt replacement with committed-response proof.

        After an ambiguous outcome, wait at least 35 seconds from submission
        before using canonical settings and status reads to justify a retry.
        """
        outcome = ""
        request_id: str | None = None

        def capture(headers: Any) -> None:
            nonlocal outcome, request_id
            outcome = headers.get("x-postwave-sending-cap-outcome", "")
            request_id = headers.get("x-request-id")

        try:
            value = await self._client.request(
                "PUT",
                "/api/v1/settings/sending",
                body=payload,
                idempotency_key=None,
                max_attempts=1,
                follow_redirects=False,
                expected_status=200,
                on_response_headers=capture,
            )
        except PostwaveError as error:
            safe_not_committed_http_failure = (
                error.status >= 400
                and outcome == "not-committed"
            )
            if not safe_not_committed_http_failure:
                raise ParseError(
                    "Sending-settings write returned no safe not-committed "
                    "receipt; wait at least 35 seconds from submission, then "
                    "reconcile canonical settings and cap status before retrying.",
                    status=error.status,
                    request_id=error.request_id,
                    payload=error.payload,
                ) from error
            raise
        return _validate_committed_response(value, payload, outcome, request_id)

    async def update(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Backward-compatible alias for :meth:`set`."""
        return await self.set(payload)
