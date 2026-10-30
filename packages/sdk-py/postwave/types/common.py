from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

SubscriberStatus = Literal["enabled", "disabled", "blocklisted", "unconfirmed"]
ConsentSource = Literal["double_optin", "single_optin", "import", "api", "unknown"]
SourcePlatform = Literal[
    "mailchimp",
    "mailchimp_api",
    "klaviyo",
    "customerio",
    "constant-contact",
    "aweber",
    "drip",
    "campaign-monitor",
    "omnisend",
    "loops",
    "flodesk",
    "bento",
    "activecampaign",
    "convertkit",
    "substack",
    "beehiiv",
    "brevo",
    "hubspot",
    "sendy",
    "mailerlite",
    "csv",
]


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class Subscriber(_Base):
    id: str | None = None
    email: str
    status: SubscriberStatus
    consent_timestamp: datetime | None = None
    consent_source: ConsentSource = "unknown"
    custom_fields: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)
    source_id: str = ""
    source_platform: SourcePlatform = "csv"


class SubscriberPage(_Base):
    items: list[Subscriber] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    per_page: int = 50


class MeResponse(_Base):
    tenant: str
    user: str | None = None
