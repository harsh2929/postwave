"""Typed campaign poll authoring and aggregate-report contracts."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


StableReference = str
_STABLE_REFERENCE = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"


class CampaignPollMaterializationInput(BaseModel):
    """Runtime settings for a poll already present in a semantic-v2 AST.

    Unknown fields are rejected so caller-authored ``question`` or ``options``
    cannot become a second source of poll meaning.
    """

    model_config = ConfigDict(extra="forbid")

    content_revision_id: str = Field(min_length=1)
    poll_key: StableReference = Field(
        min_length=1, max_length=128, pattern=_STABLE_REFERENCE
    )
    two_step_required: bool | None = None
    closes_at: str | None = Field(default=None, min_length=1)


class _CampaignPollOutput(BaseModel):
    model_config = ConfigDict(extra="ignore")


class CampaignPollDefinitionOption(_CampaignPollOutput):
    option_key: StableReference
    label: str
    position: int


class CampaignPollDefinition(_CampaignPollOutput):
    """Immutable response contract without tenant or recipient identity."""

    id: str
    campaign_id: str
    poll_key: StableReference
    question: str
    two_step_required: bool
    closes_at: str | None = None
    options: list[CampaignPollDefinitionOption]
    created_at: str


class CampaignPollList(_CampaignPollOutput):
    items: list[CampaignPollDefinition]
    # The API omits this field on the terminal page.
    next_cursor: str | None = Field(default=None, min_length=1, max_length=512)


class CampaignPollOptionTally(_CampaignPollOutput):
    option_key: StableReference
    label: str
    counted: int


class CampaignPollTally(_CampaignPollOutput):
    """Aggregate tally where unknown classifier output remains excluded."""

    poll_id: str
    poll_key: StableReference
    question: str
    options: list[CampaignPollOptionTally]
    machine_excluded: int
    unclassified_excluded: int
    voided_multi_option: int
    previewed_only: int
