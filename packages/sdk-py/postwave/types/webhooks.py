from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


WebhookEventType = Literal[
    "campaign.sent",
    "subscriber.added",
    "subscriber.removed",
    "subscriber.unsubscribed",
    "approval.requested",
    "approval.decided",
    "audit.created",
    "bounce.received",
    "list_health.degraded",
    "list.subscriber.added",
    "email.bounced",
    "email.complained",
    "email.delivered",
    "assurance.run.completed",
    "assurance.run.blocked",
]
OUTBOUND_WEBHOOK_EVENT_TYPES: tuple[str, ...] = get_args(WebhookEventType)
WebhookSigningAlgorithm = Literal["hmac_sha256", "ecdsa_p256", "ed25519"]


class WebhookEvent(_Base):
    id: str
    type: WebhookEventType
    occurred_at: datetime
    data: dict[str, Any] = Field(default_factory=dict)


class WebhookEnvelopeReference(_Base):
    id: str


class WebhookEnvelopeDelivery(_Base):
    id: str
    attempt: int = Field(ge=1)


class WebhookEnvelope(_Base):
    event: WebhookEvent
    webhook: WebhookEnvelopeReference
    delivery: WebhookEnvelopeDelivery


class WebhookReceiverAuthNone(_Base):
    type: Literal["none"] = "none"


class WebhookReceiverAuthBearer(_Base):
    type: Literal["bearer"] = "bearer"
    bearer_token: str


class WebhookReceiverAuthHeaders(_Base):
    type: Literal["headers", "custom_headers"]
    headers: dict[str, str]


class WebhookReceiverAuthMTLS(_Base):
    type: Literal["mtls"] = "mtls"
    mtls_cert_pem: str
    mtls_key_pem: str


class WebhookReceiverAuthCombined(_Base):
    type: Literal["combined"] = "combined"
    bearer_token: str | None = None
    headers: dict[str, str] | None = None
    mtls_cert_pem: str | None = None
    mtls_key_pem: str | None = None


WebhookReceiverAuthWrite = (
    WebhookReceiverAuthNone
    | WebhookReceiverAuthBearer
    | WebhookReceiverAuthHeaders
    | WebhookReceiverAuthMTLS
    | WebhookReceiverAuthCombined
)


class WebhookReceiverAuthMetadata(_Base):
    """Value-free read projection; credential values are intentionally absent."""

    type: Literal["bearer", "headers", "custom_headers", "mtls", "combined"]
    bearer_configured: bool = False
    header_names: list[str] = Field(default_factory=list)
    mtls_configured: bool = False
    secret_redacted: bool = False


class WebhookSubscription(_Base):
    id: str
    tenant_id: str
    url: str
    events: list[WebhookEventType] = Field(default_factory=list)
    active: bool = True
    description: str | None = None
    created_by_user_id: str | None = None
    created_at: datetime
    updated_at: datetime
    last_succeeded_at: datetime | None = None
    last_failed_at: datetime | None = None
    consecutive_failures: int = 0
    signing_algorithm: WebhookSigningAlgorithm = "hmac_sha256"
    signing_public_key: str | None = None
    secondary_public_key: str | None = None
    secondary_expires_at: datetime | None = None
    rotated_at: datetime | None = None
    list_id: str | None = None
    auth_config: WebhookReceiverAuthMetadata | None = None
    auth_config_status: Literal["ready", "legacy_pending", "invalid"] | None = None


class WebhookSubscriptionInput(_Base):
    url: str
    events: list[WebhookEventType]
    description: str | None = None
    algorithm: WebhookSigningAlgorithm | None = None
    list_id: str | None = None
    # Credential-bearing write object. The API never returns its values.
    auth_config: WebhookReceiverAuthWrite | None = None


class WebhookCreateResponse(_Base):
    webhook: WebhookSubscription
    signing_secret: str | None = None
    private_key_pem: str | None = None
    public_key_pem: str | None = None


class WebhookDelivery(_Base):
    id: str
    webhook_id: str
    event_type: str
    attempt_count: int
    next_attempt_at: datetime | None = None
    status: Literal["pending", "delivered", "failed", "exhausted"]
    last_status_code: int | None = None
    last_response_body_truncated: str = ""
    last_error: str = ""
    created_at: datetime
    delivered_at: datetime | None = None
