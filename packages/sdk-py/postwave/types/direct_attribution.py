"""Identity-minimized campaign direct-attribution evidence contracts."""

from __future__ import annotations

from datetime import datetime
import re
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def _uuid_string(value: str) -> str:
    if _UUID.fullmatch(value) is None:
        raise ValueError("must be a canonical UUID string")
    try:
        UUID(value)
    except ValueError as error:
        raise ValueError("must be a canonical UUID string") from error
    return value


def _rfc3339_string(value: str) -> str:
    if _RFC3339.fullmatch(value) is None:
        raise ValueError("must be an RFC3339 date-time string")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("must be an RFC3339 date-time string") from error
    return value


class _EvidenceOutput(BaseModel):
    # The authoritative OpenAPI objects are closed. Refusing unknown response
    # fields prevents recipient, email, or code material from escaping if a
    # server projection regresses.
    model_config = ConfigDict(extra="forbid", strict=True)


class CampaignDirectAttributionEvidenceSummary(_EvidenceOutput):
    """Non-monetary counts; currency-scoped amounts remain on individual items."""

    code_allocations: int = Field(ge=0, le=_INT64_MAX)
    code_redemptions: int = Field(ge=0, le=_INT64_MAX)
    code_linked_outcomes: int = Field(ge=0, le=_INT64_MAX)
    no_click_redemptions: int = Field(ge=0, le=_INT64_MAX)
    with_click_redemptions: int = Field(ge=0, le=_INT64_MAX)
    click_evidence_unavailable: int = Field(ge=0, le=_INT64_MAX)
    vanity_visits: int = Field(ge=0, le=_INT64_MAX)
    vanity_linked_outcomes: int = Field(ge=0, le=_INT64_MAX)

    @model_validator(mode="after")
    def validate_reconciliation(self) -> "CampaignDirectAttributionEvidenceSummary":
        observed_click_redemptions = (
            self.no_click_redemptions
            + self.with_click_redemptions
            + self.click_evidence_unavailable
        )
        if (
            self.code_redemptions > self.code_allocations
            or self.code_linked_outcomes > self.code_allocations
            or observed_click_redemptions != self.code_redemptions
            or self.vanity_linked_outcomes > self.vanity_visits
        ):
            raise ValueError(
                "campaign direct-attribution evidence summary is inconsistent"
            )
        return self


class CampaignDirectAttributionEvidenceItem(_EvidenceOutput):
    kind: Literal["code_allocation", "vanity_visit"]
    evidence_id: str = Field(min_length=1)
    occurred_at: str = Field(min_length=1)
    status: str = Field(min_length=1)
    expires_at: str | None
    redeemed_at: str | None
    redemption_id: int | None = Field(ge=1, le=_INT64_MAX)
    conversion_id: int | None = Field(ge=1, le=_INT64_MAX)
    amount_cents: int | None = Field(ge=_INT64_MIN, le=_INT64_MAX)
    currency: str
    attributed_via: Literal["code_redemption", "campaign_vanity_path"]
    attribution_scope: Literal["campaign_assignment", "campaign"]
    # Null is a first-class historical state, never false-by-default.
    linked_without_recorded_assignment_click: bool | None
    readership_proven: Literal[False]

    @field_validator("evidence_id")
    @classmethod
    def validate_evidence_id(cls, value: str) -> str:
        return _uuid_string(value)

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("campaign direct-attribution evidence status is required")
        return value

    @field_validator("occurred_at")
    @classmethod
    def validate_occurred_at(cls, value: str) -> str:
        return _rfc3339_string(value)

    @field_validator("expires_at", "redeemed_at")
    @classmethod
    def validate_nullable_time(cls, value: str | None) -> str | None:
        return None if value is None else _rfc3339_string(value)

    @field_validator("currency")
    @classmethod
    def validate_currency(cls, value: str) -> str:
        if value and re.fullmatch(r"[A-Z]{3}", value) is None:
            raise ValueError(
                "campaign direct-attribution evidence currency provenance is invalid"
            )
        return value

    @field_validator("readership_proven", mode="before")
    @classmethod
    def validate_literal_false(cls, value: object) -> bool:
        if value is not False:
            raise ValueError(
                "campaign direct-attribution evidence cannot prove readership"
            )
        return False

    @model_validator(mode="after")
    def validate_provenance(self) -> "CampaignDirectAttributionEvidenceItem":
        expected = {
            "code_allocation": ("code_redemption", "campaign_assignment"),
            "vanity_visit": ("campaign_vanity_path", "campaign"),
        }[self.kind]
        if (self.attributed_via, self.attribution_scope) != expected:
            raise ValueError("campaign direct-attribution evidence provenance is inconsistent")
        return self


class CampaignDirectAttributionEvidencePageInfo(_EvidenceOutput):
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0, le=10_000)
    total: int = Field(ge=0, le=_INT64_MAX)
    has_more: bool


class CampaignDirectAttributionEvidencePage(_EvidenceOutput):
    campaign_id: str = Field(min_length=1)
    summary: CampaignDirectAttributionEvidenceSummary
    items: list[CampaignDirectAttributionEvidenceItem] = Field(max_length=100)
    page_info: CampaignDirectAttributionEvidencePageInfo

    @field_validator("campaign_id")
    @classmethod
    def validate_campaign_id(cls, value: str) -> str:
        return _uuid_string(value)

    @model_validator(mode="after")
    def validate_page(self) -> "CampaignDirectAttributionEvidencePage":
        if len(self.items) > self.page_info.limit:
            raise ValueError("campaign direct-attribution evidence page exceeds its limit")
        if self.page_info.total != (
            self.summary.code_allocations + self.summary.vanity_visits
        ):
            raise ValueError("campaign direct-attribution evidence total is inconsistent")
        expected_has_more = self.page_info.offset + len(self.items) < self.page_info.total
        if self.page_info.has_more is not expected_has_more:
            raise ValueError("campaign direct-attribution evidence pagination is inconsistent")
        return self
