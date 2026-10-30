from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .common import SourcePlatform


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


MigrationStatus = Literal[
    "pending", "authenticating", "discovering", "dry_run", "awaiting_confirmation",
    "importing", "rolling_back", "completed", "failed", "rolled_back",
]


class MigrationProgress(_Base):
    subscribers_total: int = 0
    subscribers_done: int = 0
    segments_total: int = 0
    segments_done: int = 0
    automations_total: int = 0
    automations_done: int = 0
    paid_subs_total: int = 0
    paid_subs_done: int = 0
    archive_total: int = 0
    archive_done: int = 0
    templates_total: int = 0
    templates_done: int = 0
    source_archive_total: int = 0
    source_archive_done: int = 0


class CustomFieldMapping(_Base):
    source: str
    canonical: str
    type: str


class SegmentWarning(_Base):
    name: str
    warning: str


class AutomationUnsupported(_Base):
    name: str
    reason: str


AutomationRebuildStatus = Literal[
    "not_started",
    "rebuilding",
    "test_passed",
    "approved_not_needed",
    "blocked",
]


class AutomationRebuildItem(_Base):
    rank: int
    name: str
    source_id: str | None = None
    status: AutomationRebuildStatus = "not_started"
    owner: str | None = None
    notes: str | None = None
    test_evidence: str | None = None
    updated_at: datetime | None = None


class ResourceCompleteness(_Base):
    resource: str
    label: str
    source_total: int = 0
    imported: int = 0
    supported: bool = False
    status: Literal[
        "imported_runtime",
        "partial_runtime",
        "preserved_for_rebuild",
        "manual_rebuild_required",
        "not_supported",
        "not_detected",
    ] = "not_detected"
    notes: list[str] = Field(default_factory=list)


class ResourceWarning(_Base):
    resource: str
    source_id: str | None = None
    name: str | None = None
    warning: str


class SubscriberMergeConflict(_Base):
    email: str
    source_ids: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    conflict_fields: list[str] = Field(default_factory=list)


class VerificationReport(_Base):
    subscribers_imported: int = 0
    suppression_list_size: int = 0
    consent_known: int = 0
    consent_unknown: int = 0
    duplicate_subscribers_merged: int = 0
    subscriber_merge_conflicts: list[SubscriberMergeConflict] = Field(default_factory=list)
    custom_fields_mapped: list[CustomFieldMapping] = Field(default_factory=list)
    custom_fields_unmapped: list[str] = Field(default_factory=list)
    segments_translated: int = 0
    segments_with_warnings: list[SegmentWarning] = Field(default_factory=list)
    automations_translated: int = 0
    automations_unsupported: list[AutomationUnsupported] = Field(default_factory=list)
    automation_rebuilds: list[AutomationRebuildItem] = Field(default_factory=list)
    paid_subs_imported: int = 0
    premium_memberships_observed: int = 0
    archive_imported: int = 0
    discovery_warnings: list[str] = Field(default_factory=list)
    campaign_archive_warnings: list[ResourceWarning] = Field(default_factory=list)
    templates_imported: int = 0
    template_warnings: list[ResourceWarning] = Field(default_factory=list)
    source_archive_imported: int = 0
    source_archive_warnings: list[ResourceWarning] = Field(default_factory=list)
    source_archive_by_resource: dict[str, int] = Field(default_factory=dict)
    resource_completeness: list[ResourceCompleteness] = Field(default_factory=list)
    data_loss_estimate_pct: float = 0.0


class MigrationJob(_Base):
    id: str
    tenant_id: str = ""
    source: SourcePlatform
    status: MigrationStatus
    progress: MigrationProgress = Field(default_factory=MigrationProgress)
    cursor: dict[str, str | None] = Field(default_factory=dict)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    rollback_until: datetime | None = None
    source_session_expires_at: datetime | None = None
    selected_audience_ids: list[str] = Field(default_factory=list)
    verification_report: VerificationReport | None = None
    error: str | None = None


class _Capabilities(_Base):
    subscribers: bool = False
    segments: bool = False
    automations: bool = False
    automation_mode: Literal["runtime", "rebuild_review", "none"] | None = None
    campaign_archive: bool = False
    paid_subs: bool = False
    consent_timestamps: bool = False
    templates: bool = False
    campaigns: bool = False
    reports: bool = False
    groups: bool = False
    forms: bool = False
    landing_pages: bool = False
    ecommerce: bool = False
    crm: bool = False
    custom_objects: bool = False
    sms: bool = False


class AdapterCapabilities(_Base):
    source: SourcePlatform
    auth_method: Literal["oauth2", "api_key", "csv_upload"]
    supports: _Capabilities = Field(default_factory=_Capabilities)


class OAuthStartResponse(_Base):
    authorize_url: str
    state: str


class DiscoveryAudience(_Base):
    id: str
    name: str | None = None
    subscribers_total: int = 0


class DiscoveryReport(_Base):
    # Authoritative identity for subsequent dry-run, commit, reconnect, and
    # job-detail requests.
    job_id: str = Field(min_length=1)
    source: SourcePlatform | None = None
    subscribers_count: int = 0
    profiles_without_email_count: int = 0
    additional_email_identities_count: int = 0
    # HubSpot combines list snapshots and active email subscription targeting
    # boundaries here; use subscription_channels_count for the definition count.
    segments_count: int = 0
    automations_count: int = 0
    paid_subs_count: int = 0
    archive_count: int = 0
    source_archive_count: int = 0
    templates_count: int = 0
    campaigns_count: int = 0
    reports_count: int = 0
    groups_count: int = 0
    forms_count: int = 0
    landing_pages_count: int = 0
    ecommerce_count: int = 0
    custom_objects_count: int = 0
    subscription_channels_count: int = 0
    sms_campaigns_count: int = 0
    push_campaigns_count: int = 0
    resource_metadata: list[ResourceCompleteness] = Field(default_factory=list)
    custom_fields: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    audiences: list[DiscoveryAudience] = Field(default_factory=list)
    capabilities: AdapterCapabilities | None = None


class RollbackProgress(_Base):
    state: Literal["pending", "running", "completed", "failed"]
    archive_deleted: int = 0
    archive_total: int = 0
    templates_deleted: int = 0
    templates_total: int = 0
    automations_deleted: int = 0
    automations_total: int = 0
    segments_deleted: int = 0
    segments_total: int = 0
    subscribers_deleted: int = 0
    subscribers_total: int = 0
    lists_deleted: int = 0
    lists_total: int = 0
    paid_subs_deleted: int = 0
    paid_subs_total: int = 0
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None


class RollbackStartResponse(_Base):
    job_id: str
    state: Literal["running"]


PilotStatus = Literal["pass", "warning", "blocker"]


class PilotAcceptanceItem(_Base):
    key: str
    label: str
    status: PilotStatus
    expected: int | None = None
    actual: int | None = None
    detail: str | None = None
    evidence: list[str] = Field(default_factory=list)


class PilotAcceptanceReport(_Base):
    job_id: str = ""
    source: SourcePlatform | None = None
    generated_at: datetime | None = None
    status: PilotStatus
    blockers: int = 0
    warnings: int = 0
    items: list[PilotAcceptanceItem] = Field(default_factory=list)


class ShadowResourceDelta(_Base):
    resource: str
    label: str
    source_total: int = 0
    imported: int = 0
    delta: int = 0
    status: str = ""
    supported: bool = False
    cutover_risk: str = "none"
    notes: list[str] = Field(default_factory=list)


class ShadowCheckResponse(_Base):
    job_id: str
    source: SourcePlatform
    generated_at: datetime | None = None
    attempt_token: str | None = None
    import_epoch: str | None = None
    baseline_fingerprint: str | None = None
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)
    current_discovery: dict[str, int] = Field(default_factory=dict)
    needs_delta_import: bool = False
    recommended_action: str = ""
    blockers: list[str] = Field(default_factory=list)
    deltas: list[ShadowResourceDelta] = Field(default_factory=list)


class ShadowMonitor(_Base):
    job_id: str
    tenant_id: str = ""
    source: SourcePlatform
    enabled: bool = False
    interval_seconds: int = 0
    last_checked_at: datetime | None = None
    next_check_at: datetime | None = None
    last_recommended_action: str | None = None
    last_error: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ShadowMonitorResponse(_Base):
    monitor: ShadowMonitor
    history: list[ShadowCheckResponse] = Field(default_factory=list)


class RollbackRehearsalItem(_Base):
    key: str
    label: str
    status: PilotStatus
    count: int | None = None
    detail: str | None = None
    order: int | None = None


class RollbackRehearsalReport(_Base):
    job_id: str = ""
    source: SourcePlatform | None = None
    generated_at: datetime | None = None
    status: PilotStatus
    rollback_until: datetime | None = None
    total_resources: int = 0
    items: list[RollbackRehearsalItem] = Field(default_factory=list)


class SourceEventMonitor(_Base):
    job_id: str
    tenant_id: str = ""
    source: SourcePlatform
    enabled: bool = False
    interval_seconds: int = 0
    enabled_since: datetime | None = None
    first_successful_sync_at: datetime | None = None
    successful_sync_count: int = 0
    max_success_gap_seconds: int = 0
    cursor: str | None = None
    last_event_at: datetime | None = None
    last_synced_at: datetime | None = None
    next_sync_at: datetime | None = None
    last_error: str | None = None
    events_seen: int = 0
    events_applied: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SourceEventRecord(_Base):
    id: str = ""
    job_id: str
    tenant_id: str = ""
    source: SourcePlatform
    source_event_id: str
    resource_type: str
    action: str
    occurred_at: datetime | None = None
    applied: bool = False
    error: str | None = None
    review_status: Literal["pending", "reviewed"] = "pending"
    review_detail: str | None = None
    review_evidence: list[str] = Field(default_factory=list)
    reviewed_at: datetime | None = None
    payload: dict[str, object] = Field(default_factory=dict)
    created_at: datetime | None = None


class SourceEventMonitorResponse(_Base):
    monitor: SourceEventMonitor
    events: list[SourceEventRecord] = Field(default_factory=list)
