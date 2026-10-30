"""Strict Route43 customer push-suppression authority resource."""

from __future__ import annotations

import builtins
import re
from hashlib import sha256
import unicodedata
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from ..errors import PostwaveError
from ._base import AsyncResource, SyncResource

PushSuppressionRow = dict[str, Any]
PushSuppressionsPage = dict[str, Any]

PLATFORMS = frozenset({"apns", "fcm", "web"})
REASONS = frozenset({"manual", "unregistered", "expired", "complaint", "user_opt_out"})
SOURCES = frozenset({"dashboard", "provider", "user", "complaint", "legacy"})
LOCKED_REASONS = frozenset(
    {
        "provider_authority",
        "user_opt_out_authority",
        "complaint_authority",
        "legacy_authority_requires_review",
    }
)
_UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_TENANT_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_FINGERPRINT = re.compile(r"^[0-9a-f]{16}$")
_HASH_PREFIX = re.compile(r"^[0-9a-f]{8,16}$")
_CURSOR = re.compile(r"^[A-Za-z0-9_-]+$")
_UTC_TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$"
)
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_ROW_KEYS = {
    "id",
    "tenant_id",
    "device_token_hash",
    "platform",
    "reason",
    "source",
    "created_at",
    "updated_at",
    "version",
    "reversible",
    "locked_reason",
}


def _contract_error(message: str = "Invalid push suppression response.") -> PostwaveError:
    return PostwaveError(message, status=502, code="invalid_push_suppression_response")


def _timestamp(value: Any) -> tuple[str, int]:
    if not isinstance(value, str) or len(value) > 64:
        raise _contract_error()
    match = _UTC_TIMESTAMP.fullmatch(value)
    if match is None or int(match[1]) < 2000 or int(match[1]) >= 2100:
        raise _contract_error()
    try:
        instant = datetime(
            int(match[1]),
            int(match[2]),
            int(match[3]),
            int(match[4]),
            int(match[5]),
            int(match[6]),
            tzinfo=timezone.utc,
        )
        if not (
            datetime(2000, 1, 1, tzinfo=timezone.utc)
            <= instant
            < datetime(2100, 1, 1, tzinfo=timezone.utc)
        ):
            raise ValueError("outside projection")
    except ValueError as error:
        raise _contract_error() from error
    fraction = (match[7] or "").ljust(9, "0")
    nanoseconds = int(instant.timestamp()) * 1_000_000_000 + int(fraction or "0")
    return value, nanoseconds


def _decode_row(value: Any, tenant_id: str) -> PushSuppressionRow:
    if not isinstance(value, dict) or any(key not in _ROW_KEYS for key in value):
        raise _contract_error()
    row_id = value.get("id")
    fingerprint = value.get("device_token_hash")
    platform = value.get("platform")
    reason = value.get("reason")
    source = value.get("source")
    version = value.get("version")
    reversible = value.get("reversible")
    locked = value.get("locked_reason")
    created_at, created_ns = _timestamp(value.get("created_at"))
    updated_at, updated_ns = _timestamp(value.get("updated_at"))
    if (
        not isinstance(row_id, str)
        or _UUID_V4.fullmatch(row_id) is None
        or value.get("tenant_id") != tenant_id
        or not isinstance(fingerprint, str)
        or _FINGERPRINT.fullmatch(fingerprint) is None
        or platform not in PLATFORMS
        or reason not in REASONS
        or source not in SOURCES
        or isinstance(version, bool)
        or not isinstance(version, int)
        or not 1 <= version <= _MAX_SAFE_INTEGER
        or not isinstance(reversible, bool)
        or updated_ns < created_ns
    ):
        raise _contract_error()
    valid_authority = (
        reason == "manual"
        and source == "dashboard"
        and reversible is True
        and "locked_reason" not in value
    ) or (
        reason in {"unregistered", "expired"}
        and source == "provider"
        and reversible is False
        and locked == "provider_authority"
    ) or (
        reason == "user_opt_out"
        and source == "user"
        and reversible is False
        and locked == "user_opt_out_authority"
    ) or (
        reason == "complaint"
        and source == "complaint"
        and reversible is False
        and locked == "complaint_authority"
    ) or (
        source == "legacy"
        and reversible is False
        and locked == "legacy_authority_requires_review"
    )
    if not valid_authority:
        raise _contract_error()
    return {
        "id": row_id,
        "tenant_id": tenant_id,
        "device_token_hash": fingerprint,
        "platform": platform,
        "reason": reason,
        "source": source,
        "created_at": created_at,
        "updated_at": updated_at,
        "version": version,
        "reversible": reversible,
        **({"locked_reason": locked} if locked is not None else {}),
    }


def decode_push_suppressions_page(
    value: Any,
    *,
    tenant_id: str,
    platform: str | None = None,
    reason: str | None = None,
    hash_prefix: str | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> PushSuppressionsPage:
    if _TENANT_UUID.fullmatch(tenant_id) is None:
        raise _contract_error()
    if (
        not isinstance(value, dict)
        or set(value) - {"tenantId", "items", "total", "nextCursor", "snapshotAt"}
        or value.get("tenantId") != tenant_id
        or not isinstance(value.get("items"), list)
        or len(value["items"]) > limit
    ):
        raise _contract_error()
    total = value.get("total")
    if (
        isinstance(total, bool)
        or not isinstance(total, int)
        or not len(value["items"]) <= total <= _MAX_SAFE_INTEGER
    ):
        raise _contract_error()
    snapshot_at, _ = _timestamp(value.get("snapshotAt"))
    next_cursor = value.get("nextCursor")
    if (
        next_cursor is not None
        and (
            not isinstance(next_cursor, str)
            or not 1 <= len(next_cursor) <= 2048
            or _CURSOR.fullmatch(next_cursor) is None
        )
    ):
        raise _contract_error()
    items = [_decode_row(item, tenant_id) for item in value["items"]]
    seen: set[str] = set()
    previous: tuple[int, str] | None = None
    for item in items:
        _, created_ns = _timestamp(item["created_at"])
        if (
            item["id"] in seen
            or (platform is not None and item["platform"] != platform)
            or (reason is not None and item["reason"] != reason)
            or (hash_prefix is not None and not item["device_token_hash"].startswith(hash_prefix))
            or (
                previous is not None
                and (
                    created_ns > previous[0]
                    or (created_ns == previous[0] and item["id"] >= previous[1])
                )
            )
        ):
            raise _contract_error()
        seen.add(item["id"])
        previous = (created_ns, item["id"])
    if next_cursor is not None and (len(items) != limit or total <= len(items)):
        raise _contract_error()
    if cursor is None and next_cursor is None and total != len(items):
        raise _contract_error()
    return {
        "tenantId": tenant_id,
        "items": items,
        "total": total,
        "snapshotAt": snapshot_at,
        **({"nextCursor": next_cursor} if next_cursor is not None else {}),
    }


def _tenant(explicit: str | None, fallback: Any) -> str:
    value = explicit if explicit is not None else fallback
    if value is None or _TENANT_UUID.fullmatch(value) is None:
        raise ValueError("Push suppression operation requires an expected canonical tenant UUID")
    return value


def _list_query(
    *, platform: str | None, reason: str | None, hash_prefix: str | None,
    cursor: str | None, limit: int,
) -> dict[str, Any]:
    if platform is not None and platform not in PLATFORMS:
        raise ValueError("Push suppression platform is unsupported")
    if reason is not None and reason not in REASONS:
        raise ValueError("Push suppression reason is unsupported")
    if hash_prefix is not None and _HASH_PREFIX.fullmatch(hash_prefix) is None:
        raise ValueError("Push suppression hash_prefix must be 8–16 lowercase hexadecimal characters")
    if (
        cursor is not None
        and (not 1 <= len(cursor) <= 2048 or _CURSOR.fullmatch(cursor) is None)
    ):
        raise ValueError("Push suppression cursor is invalid")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("Push suppression limit must be an integer from 1 to 100")
    return {
        "limit": limit,
        **({"platform": platform} if platform is not None else {}),
        **({"reason": reason} if reason is not None else {}),
        **({"hash_prefix": hash_prefix} if hash_prefix is not None else {}),
        **({"cursor": cursor} if cursor is not None else {}),
    }


def _token(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("device_token must be a string")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise ValueError("device_token contains invalid Unicode") from error
    if (
        not 20 <= size <= 4096
        or value.strip() != value
        or any(char.isspace() or unicodedata.category(char) == "Cc" for char in value)
    ):
        raise ValueError(
            "device_token must be exact 20–4096 UTF-8 bytes without whitespace or controls"
        )
    return value


def _add(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) - {"device_token", "platform", "reason"}:
        raise ValueError("Push suppression add must be a strict object")
    platform = value.get("platform")
    if platform not in PLATFORMS or value.get("reason", "manual") != "manual":
        raise ValueError("Push suppression add requires a supported platform and reason=manual")
    return {
        "device_token": _token(value.get("device_token")),
        "platform": platform,
        "reason": "manual",
    }


def _remove(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"id", "expected_version"}:
        raise ValueError("Push suppression removal must contain id and expected_version")
    version = value.get("expected_version")
    if (
        not isinstance(value.get("id"), str)
        or _UUID_V4.fullmatch(value["id"]) is None
        or isinstance(version, bool)
        or not isinstance(version, int)
        or not 1 <= version < _MAX_SAFE_INTEGER
    ):
        raise ValueError("Push suppression removal requires UUIDv4 id and positive expected_version")
    return {"id": value["id"], "expected_version": version}


def _decode_delete(value: Any, tenant_id: str, expected: dict[str, Any]) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or set(value) != {"ok", "tenantId", "id", "version", "stillSuppressed"}
        or value.get("ok") is not True
        or value.get("tenantId") != tenant_id
        or value.get("id") != expected["id"]
        or value.get("version") != expected["expected_version"] + 1
        or not isinstance(value.get("stillSuppressed"), bool)
    ):
        raise _contract_error()
    return dict(value)


def _bulk_add(items: Any) -> list[dict[str, str]]:
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ValueError("Push suppression bulk import requires 1–100 entries")
    result = [_add(item) for item in items]
    keys = {(item["platform"], item["device_token"]) for item in result}
    if len(keys) != len(result):
        raise ValueError("Push suppression bulk import cannot repeat platform/token")
    return result


def _bulk_remove(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ValueError("Push suppression bulk removal requires 1–100 entries")
    result = [_remove(item) for item in items]
    if len({item["id"] for item in result}) != len(result):
        raise ValueError("Push suppression bulk removal cannot repeat ids")
    return result


def _fingerprint(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()[:16]


def _decode_bulk_import(
    value: Any, tenant_id: str, inputs: list[dict[str, str]]
) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or set(value) != {"ok", "tenantId", "created", "existing", "items"}
        or value.get("ok") is not True
        or value.get("tenantId") != tenant_id
        or isinstance(value.get("created"), bool)
        or not isinstance(value.get("created"), int)
        or value["created"] < 0
        or isinstance(value.get("existing"), bool)
        or not isinstance(value.get("existing"), int)
        or value["existing"] < 0
        or value["created"] + value["existing"] != len(inputs)
        or not isinstance(value.get("items"), list)
        or len(value["items"]) != len(inputs)
    ):
        raise _contract_error()
    rows = [_decode_row(item, tenant_id) for item in value["items"]]
    if len({row["id"] for row in rows}) != len(rows) or any(
        row["platform"] != inputs[index]["platform"]
        or row["device_token_hash"] != _fingerprint(inputs[index]["device_token"])
        or row["reason"] != "manual"
        or row["source"] != "dashboard"
        or row["reversible"] is not True
        for index, row in enumerate(rows)
    ):
        raise _contract_error()
    return {**value, "items": rows}


def _decode_bulk_remove(
    value: Any, tenant_id: str, inputs: list[dict[str, Any]]
) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or set(value) != {"ok", "tenantId", "removed", "stillSuppressed", "items"}
        or value.get("ok") is not True
        or value.get("tenantId") != tenant_id
        or value.get("removed") != len(inputs)
        or isinstance(value.get("stillSuppressed"), bool)
        or not isinstance(value.get("stillSuppressed"), int)
        or not 0 <= value["stillSuppressed"] <= len(inputs)
        or not isinstance(value.get("items"), list)
        or len(value["items"]) != len(inputs)
    ):
        raise _contract_error()
    receipts = [
        _decode_delete(item, tenant_id, inputs[index])
        for index, item in enumerate(value["items"])
    ]
    if sum(item["stillSuppressed"] is True for item in receipts) != value["stillSuppressed"]:
        raise _contract_error()
    return {**value, "items": receipts}


class PushSuppressionsResource(SyncResource):
    def list(
        self,
        *,
        tenant_id: str | None = None,
        platform: str | None = None,
        reason: str | None = None,
        hash_prefix: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> PushSuppressionsPage:
        expected = _tenant(tenant_id, self._client.tenant_id)
        query = _list_query(
            platform=platform,
            reason=reason,
            hash_prefix=hash_prefix,
            cursor=cursor,
            limit=limit,
        )
        raw = self._client.request("GET", "/api/v1/push/suppressions", query=query)
        return decode_push_suppressions_page(
            raw,
            tenant_id=expected,
            platform=platform,
            reason=reason,
            hash_prefix=hash_prefix,
            cursor=cursor,
            limit=limit,
        )

    def add(
        self,
        *,
        device_token: str,
        platform: str,
        reason: str = "manual",
        tenant_id: str | None = None,
    ) -> PushSuppressionRow:
        expected = _tenant(tenant_id, self._client.tenant_id)
        payload = _add(
            {"device_token": device_token, "platform": platform, "reason": reason}
        )
        row = _decode_row(
            self._client.request(
                "POST", "/api/v1/push/suppressions", body=payload
            ),
            expected,
        )
        if (
            row["platform"] != platform
            or row["device_token_hash"] != _fingerprint(payload["device_token"])
            or row["reason"] != "manual"
            or row["source"] != "dashboard"
            or not row["reversible"]
        ):
            raise _contract_error()
        return row

    def remove(
        self,
        suppression_id: str,
        *,
        expected_version: int,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        expected_tenant = _tenant(tenant_id, self._client.tenant_id)
        expected = _remove({"id": suppression_id, "expected_version": expected_version})
        raw = self._client.request(
            "DELETE",
            f"/api/v1/push/suppressions/{quote(suppression_id, safe='')}",
            body={"expected_version": expected_version},
        )
        return _decode_delete(raw, expected_tenant, expected)

    def bulk_import(
        self,
        items: builtins.list[dict[str, Any]],
        *,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        expected = _tenant(tenant_id, self._client.tenant_id)
        inputs = _bulk_add(items)
        raw = self._client.request(
            "POST", "/api/v1/push/suppressions/bulk-import", body={"items": inputs}
        )
        return _decode_bulk_import(raw, expected, inputs)

    def bulk_remove(
        self,
        items: builtins.list[dict[str, Any]],
        *,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        expected = _tenant(tenant_id, self._client.tenant_id)
        inputs = _bulk_remove(items)
        raw = self._client.request(
            "POST", "/api/v1/push/suppressions/bulk-remove", body={"items": inputs}
        )
        return _decode_bulk_remove(raw, expected, inputs)


class AsyncPushSuppressionsResource(AsyncResource):
    async def list(
        self,
        *,
        tenant_id: str | None = None,
        platform: str | None = None,
        reason: str | None = None,
        hash_prefix: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> PushSuppressionsPage:
        expected = _tenant(tenant_id, self._client.tenant_id)
        query = _list_query(
            platform=platform,
            reason=reason,
            hash_prefix=hash_prefix,
            cursor=cursor,
            limit=limit,
        )
        raw = await self._client.request("GET", "/api/v1/push/suppressions", query=query)
        return decode_push_suppressions_page(
            raw,
            tenant_id=expected,
            platform=platform,
            reason=reason,
            hash_prefix=hash_prefix,
            cursor=cursor,
            limit=limit,
        )

    async def add(
        self,
        *,
        device_token: str,
        platform: str,
        reason: str = "manual",
        tenant_id: str | None = None,
    ) -> PushSuppressionRow:
        expected = _tenant(tenant_id, self._client.tenant_id)
        payload = _add(
            {"device_token": device_token, "platform": platform, "reason": reason}
        )
        row = _decode_row(
            await self._client.request(
                "POST", "/api/v1/push/suppressions", body=payload
            ),
            expected,
        )
        if (
            row["platform"] != platform
            or row["device_token_hash"] != _fingerprint(payload["device_token"])
            or row["reason"] != "manual"
            or row["source"] != "dashboard"
            or not row["reversible"]
        ):
            raise _contract_error()
        return row

    async def remove(
        self,
        suppression_id: str,
        *,
        expected_version: int,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        expected_tenant = _tenant(tenant_id, self._client.tenant_id)
        expected = _remove({"id": suppression_id, "expected_version": expected_version})
        raw = await self._client.request(
            "DELETE",
            f"/api/v1/push/suppressions/{quote(suppression_id, safe='')}",
            body={"expected_version": expected_version},
        )
        return _decode_delete(raw, expected_tenant, expected)

    async def bulk_import(
        self,
        items: builtins.list[dict[str, Any]],
        *,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        expected = _tenant(tenant_id, self._client.tenant_id)
        inputs = _bulk_add(items)
        raw = await self._client.request(
            "POST", "/api/v1/push/suppressions/bulk-import", body={"items": inputs}
        )
        return _decode_bulk_import(raw, expected, inputs)

    async def bulk_remove(
        self,
        items: builtins.list[dict[str, Any]],
        *,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        expected = _tenant(tenant_id, self._client.tenant_id)
        inputs = _bulk_remove(items)
        raw = await self._client.request(
            "POST", "/api/v1/push/suppressions/bulk-remove", body={"items": inputs}
        )
        return _decode_bulk_remove(raw, expected, inputs)
