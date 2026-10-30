"""Typed server-side conversion ingest contracts."""

from __future__ import annotations

import math
import re
import unicodedata
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class SignedConversionCredentials(BaseModel):
    """One live conversion HMAC key. ``secret`` never leaves the SDK."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    key_id: str
    secret: str = Field(repr=False)

    @field_validator("key_id")
    @classmethod
    def _valid_key_id(cls, value: str) -> str:
        if (
            not value
            or value != value.strip()
            or len(value.encode("utf-8")) > 200
            or "," in value
            or any(unicodedata.category(char) == "Cc" for char in value)
        ):
            raise ValueError(
                "key_id must be 1-200 UTF-8 bytes without commas, controls, or surrounding whitespace"
            )
        return value

    @field_validator("secret")
    @classmethod
    def _valid_secret(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("secret must not be empty")
        return value


class SignedConversionIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email_hmac_sha256: str | None = None
    click_id: str | None = None
    external_id: str | None = None

    @field_validator("email_hmac_sha256")
    @classmethod
    def _valid_email_hash(cls, value: str | None) -> str | None:
        if value is not None and not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError(
                "email_hmac_sha256 must be 64 lowercase hexadecimal characters"
            )
        return value

    @model_validator(mode="after")
    def _has_identity(self) -> "SignedConversionIdentity":
        if not any(
            isinstance(value, str) and bool(value.strip())
            for value in (self.click_id, self.email_hmac_sha256, self.external_id)
        ):
            raise ValueError(
                "click_id, email_hmac_sha256, or external_id is required"
            )
        return self


class SignedConversionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_name: str = Field(min_length=1, max_length=128)
    occurred_at: datetime | None = None
    identity: SignedConversionIdentity
    value: int | float | None = None
    currency: str | None = None
    metadata: dict[str, Any] | None = None

    @field_validator("event_name")
    @classmethod
    def _valid_event_name(cls, value: str) -> str:
        if not value.strip() or any(
            unicodedata.category(char) == "Cc" for char in value
        ):
            raise ValueError("event_name is required and must not contain controls")
        return value

    @model_validator(mode="after")
    def _valid_money(self) -> "SignedConversionInput":
        if self.value is None:
            if self.currency not in (None, ""):
                raise ValueError("currency requires value")
            return self
        if isinstance(self.value, float) and not math.isfinite(self.value):
            raise ValueError("value must be finite")
        if not re.fullmatch(r"-?\d+(?:\.\d{1,2})?", str(self.value)):
            raise ValueError("value must have at most two fractional digits")
        if self.currency is None or re.fullmatch(r"[A-Za-z]{3}", self.currency) is None:
            raise ValueError("value requires a three-letter currency")
        return self


class SignedConversionReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: int = Field(ge=1, le=500)
    conversion_ids: list[int]
    key_id: str


ConversionEmailHMACProjectionStatus = Literal["pending", "ready", "failed"]
ConversionEmailHMACProjectionErrorCode = Literal[
    "secret_unavailable", "projection_failed"
]


def _valid_label(value: str) -> str:
    if (
        value != value.strip()
        or len(value) > 128
        or any(unicodedata.category(char) in {"Cc", "Cs"} for char in value)
    ):
        raise ValueError(
            "label must be at most 128 Unicode characters without controls or surrounding whitespace"
        )
    return value


class _ConversionIngestSecretMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    key_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    label: str
    created_at: datetime
    identity_projection_status: ConversionEmailHMACProjectionStatus
    identity_projection_error_code: ConversionEmailHMACProjectionErrorCode | None = None
    identity_projection_updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _closed_projection_state(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        status = value.get("identity_projection_status")
        has_error = "identity_projection_error_code" in value
        if status == "failed":
            if not has_error or value.get("identity_projection_error_code") is None:
                raise ValueError("failed projection requires its bounded error code")
        elif has_error:
            raise ValueError("non-failed projection must omit its error code")
        return value

    @field_validator("label")
    @classmethod
    def _label(cls, value: str) -> str:
        return _valid_label(value)

    @field_validator("created_at", "identity_projection_updated_at", mode="before")
    @classmethod
    def _timestamp_is_rfc3339_string(cls, value: Any) -> Any:
        if not isinstance(value, str) or len(value.encode("utf-8")) > 128:
            raise ValueError("timestamp must be a bounded RFC3339 string")
        return value

    @field_validator("created_at", "identity_projection_updated_at")
    @classmethod
    def _timestamp_has_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamp must include an RFC3339 timezone")
        return value


class ConversionIngestSecretSummary(_ConversionIngestSecretMetadata):
    """Metadata-only catalog row. It cannot contain the plaintext secret."""

    revoked_at: datetime | None = None

    @model_validator(mode="before")
    @classmethod
    def _revocation_must_be_omitted_or_timestamp(cls, value: Any) -> Any:
        if isinstance(value, dict) and "revoked_at" in value and value["revoked_at"] is None:
            raise ValueError("revoked_at must be omitted until revocation")
        return value

    @field_validator("revoked_at", mode="before")
    @classmethod
    def _revoked_timestamp_is_string(cls, value: Any) -> Any:
        if value is None:
            return value
        if not isinstance(value, str) or len(value.encode("utf-8")) > 128:
            raise ValueError("revoked_at must be a bounded RFC3339 string")
        return value

    @field_validator("revoked_at")
    @classmethod
    def _revoked_timestamp_has_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("revoked_at must include an RFC3339 timezone")
        return value


class ConversionIngestSecretIssued(_ConversionIngestSecretMetadata):
    """Only model that can contain the reveal-once plaintext credential."""

    secret: str = Field(
        min_length=43,
        max_length=43,
        pattern=r"^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
    )


class ConversionIngestSecretIssueResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    secret: ConversionIngestSecretIssued
    notice: Literal[
        "This is the only time the secret is shown. Store it now; it cannot be recovered, only replaced."
    ]

    @model_validator(mode="after")
    def _issued_state_starts_pending(self) -> "ConversionIngestSecretIssueResponse":
        if self.secret.identity_projection_status != "pending":
            raise ValueError("a newly issued key must start with pending projection")
        if self.secret.identity_projection_error_code is not None:
            raise ValueError("a pending projection cannot expose an error code")
        return self


class ConversionIngestSecretPage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    items: list[ConversionIngestSecretSummary] = Field(max_length=100)
    next_cursor: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _cursor_must_be_omitted_on_terminal_page(cls, value: Any) -> Any:
        if isinstance(value, dict) and "next_cursor" in value and value["next_cursor"] is None:
            raise ValueError("next_cursor must be omitted on the terminal page")
        return value

    @field_validator("next_cursor")
    @classmethod
    def _bounded_cursor(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if (
            not value
            or value != value.strip()
            or any(unicodedata.category(char) == "Cs" for char in value)
            or len(value.encode("utf-8")) > 512
            or any(unicodedata.category(char) == "Cc" for char in value)
        ):
            raise ValueError("next_cursor must be a bounded opaque value")
        return value

    @model_validator(mode="after")
    def _unique_key_ids(self) -> "ConversionIngestSecretPage":
        ids = [item.key_id for item in self.items]
        if len(set(ids)) != len(ids):
            raise ValueError("signing-key page contains duplicate key ids")
        return self


class ConversionIngestSecretRevoked(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    revoked: Literal[True]
