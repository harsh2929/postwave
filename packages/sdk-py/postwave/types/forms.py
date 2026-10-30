from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


OptInMode = Literal["single", "double"]
FormStatus = Literal["draft", "published", "archived"]
SubmissionStatus = Literal["pending", "confirmed", "unsubscribed"]


class Form(_Base):
    id: str
    tenant_id: str = Field(alias="tenantId", default="")
    slug: str
    name: str
    opt_in_mode: OptInMode = Field(alias="optInMode")
    structure: dict[str, Any] = Field(default_factory=dict)
    settings: dict[str, Any] = Field(default_factory=dict)
    status: FormStatus = "draft"
    created_at: datetime | None = Field(alias="createdAt", default=None)
    updated_at: datetime | None = Field(alias="updatedAt", default=None)


class FormListItem(Form):
    submissions_30d: int = Field(alias="submissions30d", default=0)
    conversion_rate: int = Field(alias="conversionRate", default=0)


class FormCreateInput(_Base):
    name: str
    slug: str
    opt_in_mode: OptInMode = Field(alias="optInMode")
    success_message: str = Field(alias="successMessage", default="")
    success_redirect_url: str | None = Field(alias="successRedirectUrl", default=None)


class FormUpdateInput(_Base):
    name: str | None = None
    slug: str | None = None
    opt_in_mode: OptInMode | None = Field(alias="optInMode", default=None)
    structure: dict[str, Any] | None = None
    settings: dict[str, Any] | None = None
    status: FormStatus | None = None


class Submission(_Base):
    id: str
    form_id: str = Field(alias="formId")
    email: str
    custom_fields: dict[str, str] = Field(alias="customFields", default_factory=dict)
    status: SubmissionStatus
    ip: str | None = None
    user_agent: str | None = Field(alias="userAgent", default=None)
    submitted_at: datetime | None = Field(alias="submittedAt", default=None)
    confirmed_at: datetime | None = Field(alias="confirmedAt", default=None)


class SubmitInput(_Base):
    email: str
    name: str | None = None
    consent: str | None = None
    website: str | None = None  # honeypot
    custom_fields: dict[str, str] = Field(alias="customFields", default_factory=dict)
    captcha_token: str | None = Field(alias="captchaToken", default=None)


class SubmitResponse(_Base):
    ok: bool
    state: Literal["subscribed", "pending-confirmation"]
    redirect: str | None = None
    message: str | None = None
