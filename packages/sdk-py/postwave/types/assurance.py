"""Typed wire models for the Campaign Assurance public API.

The measurement envelope intentionally distinguishes deterministic checks,
modeled predictions, and controlled observations. A modeled result is not an
observation of how a private inbox provider summarized a recipient's message.
"""

from __future__ import annotations

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field


CampaignAssuranceProfile = Literal["fast", "full", "calibration"]
CampaignAssuranceSourceClass = Literal[
    "deterministic", "modeled", "controlled_observation"
]
CampaignAssuranceRunState = Literal[
    "queued", "running", "complete", "incomplete", "failed", "cancelled", "stale"
]
CampaignAssuranceGateDecision = Literal[
    "pending", "pass", "warn", "block", "unavailable"
]
CampaignAssuranceExtractionStatus = Literal["complete", "error", "unavailable"]
CampaignAssuranceAppealDecision = Literal["allow_send", "reject"]
FactContractIntentKind = Literal[
    "inform",
    "invite",
    "promote",
    "request_action",
    "remind",
    "survey",
    "transact",
    "onboard",
    "retain",
    "other",
]
FactContractPrimaryActionRole = Literal[
    "navigate",
    "register",
    "purchase",
    "rsvp",
    "confirm",
    "download",
    "survey",
    "reply",
    "track",
]
FactContractSecondaryActionRole = Literal[
    "unsubscribe",
    "preferences",
    "view_in_browser",
    "social",
    "legal",
    "share",
    "contact",
    "reply",
]
FactContractFactType = Literal[
    "text", "datetime", "money", "location", "code", "percentage", "quantity", "url"
]
FactContractCriticality = Literal["critical", "important", "supporting"]


class _AssuranceModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class _FactContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class FactContractIntentV1(_FactContractModel):
    kind: FactContractIntentKind
    statement: str


class FactContractAudienceV1(_FactContractModel):
    description: str
    targeting_reference: str | None = None


class FactContractClaimV1(_FactContractModel):
    statement: str
    source_block_ids: list[str] = Field(default_factory=list)


class FactContractPrimaryActionV1(_FactContractModel):
    action_id: str
    block_id: str
    role: FactContractPrimaryActionRole
    label: str
    canonical_url: str | None = None


class FactContractDateTimeValueV1(_FactContractModel):
    rfc3339: str
    timezone: str


class FactContractMoneyValueV1(_FactContractModel):
    amount: str
    currency: str


class FactContractNumberValueV1(_FactContractModel):
    value: str
    unit: str | None = None


class FactContractRequiredFactV1(_FactContractModel):
    id: str
    type: FactContractFactType
    display_value: str
    criticality: FactContractCriticality
    source_block_ids: list[str]
    text_value: str | None = None
    datetime_value: FactContractDateTimeValueV1 | None = None
    money_value: FactContractMoneyValueV1 | None = None
    number_value: FactContractNumberValueV1 | None = None
    url_value: str | None = None


class FactContractForbiddenClaimV1(_FactContractModel):
    id: str
    statement: str


class FactContractV1(_FactContractModel):
    """Sender-authored expected-output oracle, never inbox observation."""

    schema_version: Literal[1]
    primary_intent: FactContractIntentV1
    audience_context: FactContractAudienceV1
    core_claim: FactContractClaimV1
    primary_action: FactContractPrimaryActionV1
    required_facts: list[FactContractRequiredFactV1]
    forbidden_claims: list[FactContractForbiddenClaimV1]
    allowed_secondary_actions: list[FactContractSecondaryActionRole]
    language: str


class SetFactContractResult(_AssuranceModel):
    campaign: dict[str, Any]
    etag: str


class CampaignAssuranceSourceDisclosure(_AssuranceModel):
    class_: CampaignAssuranceSourceClass = Field(alias="class")
    present: bool
    meaning: str


class CampaignAssuranceMeasurement(_AssuranceModel):
    name: Literal["Predicted Agent Comprehension"]
    interpretation: str
    source_classes: list[CampaignAssuranceSourceDisclosure]


T = TypeVar("T")


class CampaignAssuranceEnvelope(_AssuranceModel, Generic[T]):
    measurement: CampaignAssuranceMeasurement
    data: T


class CreateCampaignAssuranceRunInput(_AssuranceModel):
    profile: CampaignAssuranceProfile
    request_id: str
    content_revision_id: str | None = None
    send_plan_id: str | None = None
    include_seed_test: bool | None = None
    observed_surfaces: list[str] | None = None


class CampaignAssuranceStartRun(_AssuranceModel):
    run_id: str
    campaign_id: str
    content_revision_id: str
    send_plan_id: str
    request_id: str
    profile: CampaignAssuranceProfile
    state: CampaignAssuranceRunState
    required_scenario_count: int
    required_extraction_count: int
    status_url: str
    evidence_url: str
    events_url: str


class CampaignAssuranceRun(_AssuranceModel):
    id: str
    campaign_id: str
    content_revision_id: str
    send_plan_id: str
    run_no: int
    request_id: str
    request_hash: str
    trigger_kind: str
    profile: CampaignAssuranceProfile
    state: CampaignAssuranceRunState
    source_hash: str
    plan_hash: str
    artifact_set_hash: str
    coverage_manifest_hash: str
    configuration_manifest_hash: str
    target_manifest_hash: str
    renderer_version: str
    compiler_version: str
    fixture_set_version: str
    plan_policy_version: str
    analyzer_suite_version: str
    model_suite_version: str
    prompt_suite_version: str
    prompt_suite_hash: str
    normalization_version: str
    scoring_version: str
    gate_policy_version: str
    methodology_version: str
    required_scenario_count: int
    required_configuration_count: int
    required_extraction_count: int
    terminal_extraction_count: int
    successful_extraction_count: int
    extraction_error_count: int
    finding_count: int
    blocking_finding_count: int
    component_scores: Any | None = None
    overall_score: float | None
    score_min: float | None
    score_max: float | None
    score_spread: float | None
    agreement: float | None
    gate_decision: CampaignAssuranceGateDecision
    input_tokens: int
    output_tokens: int
    cost_microunits: int
    max_modeled_cost_microunits: int
    latency_ms: int
    snapshot_frozen_at: str | None = None
    lease_expires_at: str | None = None
    heartbeat_at: str | None = None
    attempt_count: int
    max_attempts: int
    retry_not_before: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_by: str | None = None
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None
    cancelled_at: str | None = None
    stale_at: str | None = None
    updated_at: str


class CampaignAssuranceRunArtifact(_AssuranceModel):
    campaign_id: str
    run_id: str
    send_plan_id: str
    artifact_id: str
    ordinal: int
    scenario_id: str
    outbound_mime_hash: str
    mime_structure_hash: str
    snapshotted_at: str


class CampaignAssuranceRunConfiguration(_AssuranceModel):
    campaign_id: str
    run_id: str
    ordinal: int
    configuration_id: str
    source_class: CampaignAssuranceSourceClass
    configuration_hash: str
    configuration: dict[str, Any]
    snapshotted_at: str


class CampaignAssuranceRunTarget(_AssuranceModel):
    campaign_id: str
    run_id: str
    send_plan_id: str
    artifact_id: str
    configuration_id: str
    ordinal: int
    source_class: CampaignAssuranceSourceClass
    configuration_hash: str
    outbound_mime_hash: str
    snapshotted_at: str


class CampaignAssuranceManifest(_AssuranceModel):
    run: CampaignAssuranceRun
    artifacts: list[CampaignAssuranceRunArtifact]
    configurations: list[CampaignAssuranceRunConfiguration]
    targets: list[CampaignAssuranceRunTarget]


class CampaignAssuranceRunDetail(_AssuranceModel):
    run: CampaignAssuranceRun
    manifest: CampaignAssuranceManifest
    source_classes: list[CampaignAssuranceSourceClass]


class CampaignAssuranceApplicability(_AssuranceModel):
    applicable_to_frozen_snapshot: bool
    freshness: Literal["frozen_snapshot_current", "stale", "cancelled"]
    basis: str


class CampaignAssuranceLatest(_AssuranceModel):
    detail: CampaignAssuranceRunDetail
    applicability: CampaignAssuranceApplicability


class CampaignAssuranceExtraction(_AssuranceModel):
    id: str
    campaign_id: str
    run_id: str
    send_plan_id: str
    attempt_count: int
    receipt_hash: str
    artifact_id: str
    configuration_id: str
    source_class: CampaignAssuranceSourceClass
    configuration_hash: str
    outbound_mime_hash: str
    status: CampaignAssuranceExtractionStatus
    normalized_extraction: Any | None = None
    evidence_manifest: Any
    unsupported_claims: Any
    ambiguities: Any
    raw_output_object_ref: str | None = None
    raw_output_hash: str | None = None
    raw_output_expires_at: str | None = None
    model_provider: str
    model_id: str
    model_version: str
    prompt_version: str
    prompt_hash: str
    seed_value: str | None = None
    temperature: float | None = None
    input_tokens: int
    output_tokens: int
    cost_microunits: int
    latency_ms: int
    model_cache_key: str | None = None
    model_input_manifest_hash: str | None = None
    model_invocation_id: str | None = None
    execution_kind: Literal["invoked", "cache_reuse"] | None = None
    reused_from_extraction_id: str | None = None
    reused_from_receipt_hash: str | None = None
    reused_original_cost_microunits: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: str


class CampaignAssuranceFinding(_AssuranceModel):
    id: str
    campaign_id: str
    run_id: str
    send_plan_id: str
    attempt_count: int
    configuration_hash: str
    outbound_mime_hash: str
    finding_key: str
    receipt_hash: str
    artifact_id: str
    configuration_id: str
    extraction_id: str | None = None
    code: str
    source_class: CampaignAssuranceSourceClass
    severity: str
    blocking: bool
    overridable: bool
    dimension: str
    block_references: Any
    evidence_references: Any
    expected_value: Any | None = None
    observed_value: Any | None = None
    explanation: str
    remediation: Any
    typed_patch: Any | None = None
    typed_patch_schema_version: int | None = None
    detector_version: str
    policy_version: str
    created_at: str


class CampaignAssuranceOverride(_AssuranceModel):
    id: str
    campaign_id: str
    run_id: str
    attempt_count: int
    finding_id: str
    finding_receipt_hash: str
    request_id: str
    request_hash: str
    artifact_set_hash: str
    actor_id: str
    actor_role: str
    decision: CampaignAssuranceAppealDecision
    reason: str
    expires_at: str | None = None
    created_at: str


class CampaignAssuranceApplyFindingInput(_AssuranceModel):
    request_id: str


class CampaignAssurancePatchApplication(_AssuranceModel):
    id: str
    campaign_id: str
    run_id: str
    attempt_count: int
    finding_id: str
    request_id: str
    request_hash: str
    finding_receipt_hash: str
    typed_patch_hash: str
    typed_patch_schema_version: Literal[1]
    base_content_revision_id: str
    created_content_revision_id: str
    actor_id: str
    campaign_updated_at: str
    created_at: str


class CampaignAssuranceAppliedRevision(_AssuranceModel):
    id: str
    campaign_id: str
    revision_no: int
    source_mode: Literal["semantic", "legacy_html"]
    content_schema_version: int
    subject: str
    preview_text: str | None = None
    semantic_tree: Any
    legacy_html: str | None = None
    reviewed_plain_text: str | None = None
    fact_contract: Any
    variants: Any
    locales: Any
    source_hash: str
    created_by: str | None = None
    created_at: str


class CampaignAssuranceApplyFindingResult(_AssuranceModel):
    application: CampaignAssurancePatchApplication
    revision: CampaignAssuranceAppliedRevision
    campaign_etag: str
    originating_run_state: Literal["stale"]
    rerun_required: Literal[True]


U = TypeVar("U")


class CampaignAssurancePage(_AssuranceModel, Generic[U]):
    items: list[U]
    offset: int
    limit: int
    total: int
    next_offset: int | None = None


class CampaignAssuranceEvidence(_AssuranceModel):
    run: CampaignAssuranceRun
    source_classes: list[CampaignAssuranceSourceClass]
    extractions: CampaignAssurancePage[CampaignAssuranceExtraction]
    findings: CampaignAssurancePage[CampaignAssuranceFinding]
    overrides: CampaignAssurancePage[CampaignAssuranceOverride]


class CampaignAssuranceProgressSnapshot(_AssuranceModel):
    """Aggregate snapshot from `/events`; it is not an event stream/history."""

    run_id: str
    state: CampaignAssuranceRunState
    gate_decision: CampaignAssuranceGateDecision
    attempt_count: int
    required_extractions: int
    terminal_extractions: int
    successful_extractions: int
    extraction_errors: int
    finding_count: int
    blocking_finding_count: int
    updated_at: str
    completed_at: str | None = None
    event_history_available: Literal[False]
    event_history_explanation: str
    source_classes: list[CampaignAssuranceSourceClass]


class CampaignAssuranceAppealInput(_AssuranceModel):
    request_id: str
    decision: CampaignAssuranceAppealDecision
    reason: str
    expires_at: str | None = None
