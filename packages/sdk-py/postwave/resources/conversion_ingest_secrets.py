"""Admin lifecycle for reveal-once conversion-ingest signing credentials."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from pydantic import ValidationError as PydanticValidationError

from ..errors import (
    AmbiguousConversionIngestSecretIssueError,
    ParseError,
    PostwaveError,
)
from ..types.conversions import (
    ConversionIngestSecretIssueResponse,
    ConversionIngestSecretPage,
    ConversionIngestSecretRevoked,
)
from ._base import AsyncResource, SyncResource

COLLECTION_PATH = "/api/v1/conversions/ingest-secrets"
AMBIGUOUS_ISSUE_RECOVERY = (
    "list signing-key metadata, identify any newly issued key ID, revoke it, "
    "then issue a replacement; never retry issuance blindly"
)


def _label(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("label must be a string")
    if (
        value != value.strip()
        or len(value) > 128
        or any(unicodedata.category(char) in {"Cc", "Cs"} for char in value)
    ):
        raise ValueError(
            "label must be at most 128 Unicode characters without controls or surrounding whitespace"
        )
    return value


def _limit(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 100:
        raise ValueError("limit must be an integer from 1 to 100")
    return value


def _cursor(value: str | None) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or any(unicodedata.category(char) == "Cs" for char in value)
        or len(value.encode("utf-8")) > 512
        or any(unicodedata.category(char) == "Cc" for char in value)
    ):
        raise ValueError("cursor must be a bounded opaque value")
    return value


def _page(payload: Any, request_cursor: str | None) -> ConversionIngestSecretPage:
    page = ConversionIngestSecretPage.model_validate(payload)
    if page.next_cursor is not None and page.next_cursor == request_cursor:
        raise ValueError("signing-key page repeated its request cursor")
    return page


def _definitive_rejection(error: PostwaveError) -> bool:
    return not isinstance(error, ParseError) and 400 <= error.status < 500


def _ambiguous() -> AmbiguousConversionIngestSecretIssueError:
    return AmbiguousConversionIngestSecretIssueError(
        f"Conversion signing-key issuance is ambiguous; {AMBIGUOUS_ISSUE_RECOVERY}.",
    )


class ConversionIngestSecretsResource(SyncResource):
    """One-page admin register plus reveal-once issue and exact revoke."""

    def list(
        self,
        *,
        limit: int = 100,
        cursor: str | None = None,
    ) -> ConversionIngestSecretPage:
        bounded_limit = _limit(limit)
        bounded_cursor = _cursor(cursor)
        payload = self._client.request(
            "GET",
            COLLECTION_PATH,
            query={"limit": bounded_limit, "cursor": bounded_cursor},
        )
        return _page(payload, bounded_cursor)

    def issue(self, label: str = "") -> ConversionIngestSecretIssueResponse:
        safe_label = _label(label)
        try:
            payload = self._client.request(
                "POST",
                COLLECTION_PATH,
                body={} if safe_label == "" else {"label": safe_label},
                # This reveal-once response is excluded from the replay ledger.
                # None removes any caller header and disables transport retries.
                idempotency_key=None,
                expected_status=201,
            )
        except PostwaveError as error:
            if _definitive_rejection(error):
                raise
            # Never retain or chain a malformed 201 decoder error: Pydantic's
            # diagnostic may echo the reveal-once secret and exceptions get logged.
            raise _ambiguous() from None
        try:
            issued = ConversionIngestSecretIssueResponse.model_validate(payload)
            if issued.secret.label != safe_label:
                raise ValueError("issued key label did not match the request")
            return issued
        except (PydanticValidationError, TypeError, ValueError):
            raise _ambiguous() from None

    def revoke(self, key_id: str) -> ConversionIngestSecretRevoked:
        if not isinstance(key_id, str) or re.fullmatch(r"[0-9a-f]{32}", key_id) is None:
            raise ValueError(
                "key_id must be exactly 32 lowercase hexadecimal characters"
            )
        payload = self._client.request(
            "POST",
            f"{COLLECTION_PATH}/{key_id}/revoke",
            # Force an exact bodyless request while preserving normal write
            # idempotency/retry handling in the shared transport.
            raw_body=b"",
        )
        return ConversionIngestSecretRevoked.model_validate(payload)


class AsyncConversionIngestSecretsResource(AsyncResource):
    async def list(
        self,
        *,
        limit: int = 100,
        cursor: str | None = None,
    ) -> ConversionIngestSecretPage:
        bounded_limit = _limit(limit)
        bounded_cursor = _cursor(cursor)
        payload = await self._client.request(
            "GET",
            COLLECTION_PATH,
            query={"limit": bounded_limit, "cursor": bounded_cursor},
        )
        return _page(payload, bounded_cursor)

    async def issue(self, label: str = "") -> ConversionIngestSecretIssueResponse:
        safe_label = _label(label)
        try:
            payload = await self._client.request(
                "POST",
                COLLECTION_PATH,
                body={} if safe_label == "" else {"label": safe_label},
                idempotency_key=None,
                expected_status=201,
            )
        except PostwaveError as error:
            if _definitive_rejection(error):
                raise
            raise _ambiguous() from None
        try:
            issued = ConversionIngestSecretIssueResponse.model_validate(payload)
            if issued.secret.label != safe_label:
                raise ValueError("issued key label did not match the request")
            return issued
        except (PydanticValidationError, TypeError, ValueError):
            raise _ambiguous() from None

    async def revoke(self, key_id: str) -> ConversionIngestSecretRevoked:
        if not isinstance(key_id, str) or re.fullmatch(r"[0-9a-f]{32}", key_id) is None:
            raise ValueError(
                "key_id must be exactly 32 lowercase hexadecimal characters"
            )
        payload = await self._client.request(
            "POST",
            f"{COLLECTION_PATH}/{key_id}/revoke",
            raw_body=b"",
        )
        return ConversionIngestSecretRevoked.model_validate(payload)
