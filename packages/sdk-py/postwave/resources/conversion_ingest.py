"""HMAC-authenticated server-side conversion ingestion."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import unicodedata
from typing import Any

from ..types.conversions import (
    SignedConversionCredentials,
    SignedConversionInput,
    SignedConversionReceipt,
)
from ._base import AsyncResource, SyncResource


def compute_conversion_ingest_signature_hex(
    raw_body: bytes | str,
    credentials: SignedConversionCredentials | dict[str, str],
    timestamp: int | str,
) -> str:
    """Return the key-bound v2 MAC for exact raw request bytes."""

    creds = SignedConversionCredentials.model_validate(credentials)
    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    timestamp_text = str(timestamp)
    if not timestamp_text.isdigit() or int(timestamp_text) <= 0:
        raise ValueError("timestamp must be Unix seconds")
    key_bytes = creds.key_id.encode("utf-8")
    timestamp_bytes = timestamp_text.encode("utf-8")
    prefix = (
        b"postwave-conversion-v2\n"
        + str(len(key_bytes)).encode("ascii")
        + b"\n"
        + key_bytes
        + str(len(timestamp_bytes)).encode("ascii")
        + b"\n"
        + timestamp_bytes
    )
    return hmac.new(
        creds.secret.encode("utf-8"), prefix + body, hashlib.sha256
    ).hexdigest()


def compute_conversion_ingest_signature_header(
    raw_body: bytes | str,
    credentials: SignedConversionCredentials | dict[str, str],
    timestamp: int | str,
) -> str:
    creds = SignedConversionCredentials.model_validate(credentials)
    return (
        f"keyid={creds.key_id},v2="
        f"{compute_conversion_ingest_signature_hex(raw_body, creds, timestamp)}"
    )


def compute_conversion_email_hmac_sha256(
    email: str,
    credentials: SignedConversionCredentials | dict[str, str],
) -> str:
    """Derive the tenant/key-scoped email pseudonym; send no plaintext address."""

    creds = SignedConversionCredentials.model_validate(credentials)
    if not isinstance(email, str) or not email.strip():
        raise ValueError("email must not be empty")
    normalized = email.strip().lower().encode("utf-8")
    return hmac.new(
        creds.secret.encode("utf-8"), normalized, hashlib.sha256
    ).hexdigest()


def _validated_idempotency(value: str | None) -> str | None:
    if value is None:
        return None
    if (
        not value
        or value != value.strip()
        or len(value.encode("utf-8")) > 200
        or any(unicodedata.category(char) == "Cc" for char in value)
    ):
        raise ValueError(
            "idempotency_key must be 1-200 UTF-8 bytes without controls or surrounding whitespace"
        )
    return value


def _timestamp(value: int | str | None) -> str:
    text = str(int(time.time()) if value is None else value)
    if not text.isdigit() or int(text) <= 0:
        raise ValueError("timestamp must be Unix seconds")
    return text


def _model(value: SignedConversionInput | dict[str, Any]) -> SignedConversionInput:
    return SignedConversionInput.model_validate(value)


def _single_body(value: SignedConversionInput | dict[str, Any]) -> bytes:
    return _model(value).model_dump_json(exclude_none=True).encode("utf-8")


def _batch_body(values: list[SignedConversionInput | dict[str, Any]]) -> bytes:
    if len(values) < 1 or len(values) > 500:
        raise ValueError("conversion batch must contain 1 to 500 items")
    body = {"conversions": [_model(value).model_dump(mode="json", exclude_none=True) for value in values]}
    return json.dumps(
        body, ensure_ascii=False, allow_nan=False, separators=(",", ":")
    ).encode("utf-8")


def _request_arguments(
    raw_body: bytes,
    credentials: SignedConversionCredentials | dict[str, str],
    idempotency_key: str | None,
    timestamp: int | str | None,
) -> dict[str, Any]:
    timestamp_text = _timestamp(timestamp)
    creds = SignedConversionCredentials.model_validate(credentials)
    signature = compute_conversion_ingest_signature_header(
        raw_body, creds, timestamp_text
    )
    arguments: dict[str, Any] = {
        "raw_body": raw_body,
        "omit_authentication": True,
        "headers": {
            "Content-Type": "application/json",
            "X-Postwave-Timestamp": timestamp_text,
            "X-Postwave-Signature": signature,
        },
    }
    validated = _validated_idempotency(idempotency_key)
    if validated is not None:
        arguments["idempotency_key"] = validated
    return arguments


class ConversionIngestResource(SyncResource):
    """Public HMAC surface; dashboard bearer and tenant headers are omitted."""

    def ingest(
        self,
        payload: SignedConversionInput | dict[str, Any],
        credentials: SignedConversionCredentials | dict[str, str],
        *,
        idempotency_key: str | None = None,
        timestamp: int | str | None = None,
    ) -> SignedConversionReceipt:
        raw_body = _single_body(payload)
        value = self._client.request(
            "POST",
            "/api/public/conversions/ingest",
            **_request_arguments(raw_body, credentials, idempotency_key, timestamp),
        )
        return SignedConversionReceipt.model_validate(value)

    def ingest_batch(
        self,
        payloads: list[SignedConversionInput | dict[str, Any]],
        credentials: SignedConversionCredentials | dict[str, str],
        *,
        idempotency_key: str | None = None,
        timestamp: int | str | None = None,
    ) -> SignedConversionReceipt:
        raw_body = _batch_body(payloads)
        value = self._client.request(
            "POST",
            "/api/public/conversions/ingest/batch",
            **_request_arguments(raw_body, credentials, idempotency_key, timestamp),
        )
        return SignedConversionReceipt.model_validate(value)


class AsyncConversionIngestResource(AsyncResource):
    async def ingest(
        self,
        payload: SignedConversionInput | dict[str, Any],
        credentials: SignedConversionCredentials | dict[str, str],
        *,
        idempotency_key: str | None = None,
        timestamp: int | str | None = None,
    ) -> SignedConversionReceipt:
        raw_body = _single_body(payload)
        value = await self._client.request(
            "POST",
            "/api/public/conversions/ingest",
            **_request_arguments(raw_body, credentials, idempotency_key, timestamp),
        )
        return SignedConversionReceipt.model_validate(value)

    async def ingest_batch(
        self,
        payloads: list[SignedConversionInput | dict[str, Any]],
        credentials: SignedConversionCredentials | dict[str, str],
        *,
        idempotency_key: str | None = None,
        timestamp: int | str | None = None,
    ) -> SignedConversionReceipt:
        raw_body = _batch_body(payloads)
        value = await self._client.request(
            "POST",
            "/api/public/conversions/ingest/batch",
            **_request_arguments(raw_body, credentials, idempotency_key, timestamp),
        )
        return SignedConversionReceipt.model_validate(value)
