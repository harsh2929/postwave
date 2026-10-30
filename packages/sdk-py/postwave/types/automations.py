from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


class AutomationTriggerInput(_Base):
    automation_id: str
    trigger_type: str
    subscriber_email: str
    payload: dict[str, Any] = Field(default_factory=dict)


class AutomationExecution(_Base):
    id: str
    automation_id: str
    subscriber_email: str
    current_node_id: str = ""
    paused: bool = False
    started_at: datetime | None = None
    next_step_at: datetime | None = None
