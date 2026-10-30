from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


Placement = Literal["primary", "promotions", "updates", "social", "spam", "blocked", "missing"]
Provider = Literal["gmail", "outlook_com", "o365", "icloud", "yahoo", "proton", "gmx", "mailru"]
ReputationScore = Literal["low", "medium", "high"]
AuthStatus = Literal["ok", "warn", "fail"]
FixAction = Literal["dns_record", "copy_change", "image_swap", "resend"]
RenderEnvironment = Literal[
    "gmail_web", "gmail_ios", "gmail_android",
    "outlook_web", "outlook_ios", "outlook_desktop",
    "apple_mail_macos", "apple_mail_ios",
]


class InboxReport(_Base):
    campaign_id: str
    provider: Provider
    mailbox_id: str
    placement: Placement
    checked_at: datetime | None = None


class ProviderBreakdown(_Base):
    provider: Provider
    total: int = 0
    placements: dict[str, int] = Field(default_factory=dict)


class CampaignReport(_Base):
    campaign_id: str
    providers: list[ProviderBreakdown] = Field(default_factory=list)
    overall_pct: dict[str, float] = Field(default_factory=dict)
    total_inboxes: int = 0
    generated_at: datetime | None = None
    diagnostic_id: str | None = None
    reports: list[InboxReport] = Field(default_factory=list)


class Reputation(_Base):
    domain: str
    ip: str
    google_score: ReputationScore = "medium"
    microsoft_score: ReputationScore = "medium"
    sender_score: int = 0
    blacklist_hits: list[str] = Field(default_factory=list)
    checked_at: datetime | None = None


class AuthRecord(_Base):
    status: AuthStatus
    detail: str = ""


class AuthCheck(_Base):
    domain: str
    spf: AuthRecord
    dkim: AuthRecord
    dmarc: AuthRecord
    bimi: AuthRecord
    ptr: AuthRecord


class ContentScan(_Base):
    spam_score: float = 0.0
    spam_reasons: list[str] = Field(default_factory=list)
    image_text_ratio: float = 0.0
    link_reputation: AuthStatus = "ok"
    html_issues: list[str] = Field(default_factory=list)


class PredictedPlacement(_Base):
    primary: float = 0.0
    promotions: float = 0.0
    spam: float = 0.0


class HistoricalEngagement(_Base):
    open_rate: float = 0.0
    click_rate: float = 0.0
    complaint_rate: float = 0.0
    bounce_rate: float = 0.0
    sample_size: int = 0


class PredictInput(_Base):
    html: str
    subject: str
    reputation: Reputation | None = None
    history: HistoricalEngagement | None = None
    links: list[str] = Field(default_factory=list)


class PredictResponse(_Base):
    predicted: PredictedPlacement
    content: ContentScan
    at: datetime | None = None


class DNSRecord(_Base):
    type: str
    name: str
    value: str
    ttl: int | None = None


class Fix(_Base):
    title: str
    detail: str = ""
    action: FixAction
    dns_record: DNSRecord | None = None
    estimated_impact: float = 0.0


class Diagnosis(_Base):
    campaign_id: str
    diagnosis: str = ""
    fixes: list[Fix] = Field(default_factory=list)
    predicted_impact: dict[str, float] = Field(default_factory=dict)
    generated_at: datetime | None = None


class RenderInput(_Base):
    html: str
    environments: list[RenderEnvironment] = Field(default_factory=list)


class Render(_Base):
    environment: RenderEnvironment
    screenshot_url: str
    width_px: int = 0
    height_px: int = 0


class RenderResponse(_Base):
    renders: list[Render] = Field(default_factory=list)
    cache_hit: bool = False
