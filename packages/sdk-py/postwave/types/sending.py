from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


class SendingState(_Base):
    tenant_id: str = ""
    provider: Literal["postmark", "ses"] = "postmark"
    server_id: str = ""
    signature_id: str = ""
    from_email: str = ""
    tier: Literal["shared", "dedicated"] = "shared"
    provisioned_at: datetime | None = None


class WarmupEntry(_Base):
    day: int
    cap_pct: float


class WarmupState(_Base):
    started: bool = False
    warmup_started_at: datetime | None = None
    warmup_day: int | None = None
    todays_cap: int | None = None
    todays_sent: int | None = None
    schedule: list[WarmupEntry] = Field(default_factory=list)
