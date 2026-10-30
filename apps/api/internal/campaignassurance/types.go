// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignassurance owns the gateway-side durable lifecycle for
// Predicted Agent Comprehension. It binds every run and immutable receipt to a
// frozen campaign revision, send plan, render-artifact set, and analyzer suite.
package campaignassurance

import (
	"encoding/json"
	"errors"
	"time"
)

const (
	// MaximumModeledInvocationCostMicrounits bounds one frozen provider-call
	// reservation before run-level multiplication and overflow checks.
	MaximumModeledInvocationCostMicrounits int64 = 1_000_000_000_000_000

	TriggerDraft            = "draft"
	TriggerExplicit         = "explicit"
	TriggerQueue            = "queue"
	TriggerSeed             = "seed"
	TriggerScheduledRecheck = "scheduled_recheck"

	ProfileFast        = "fast"
	ProfileFull        = "full"
	ProfileCalibration = "calibration"

	StateQueued     = "queued"
	StateRunning    = "running"
	StateComplete   = "complete"
	StateIncomplete = "incomplete"
	StateFailed     = "failed"
	StateCancelled  = "cancelled"
	StateStale      = "stale"

	GatePending     = "pending"
	GatePass        = "pass"
	GateWarn        = "warn"
	GateBlock       = "block"
	GateUnavailable = "unavailable"

	SourceDeterministic         = "deterministic"
	SourceModeled               = "modeled"
	SourceControlledObservation = "controlled_observation"

	ExtractionComplete    = "complete"
	ExtractionError       = "error"
	ExtractionUnavailable = "unavailable"
)

var (
	ErrNotFound            = errors.New("campaign assurance: not found")
	ErrInvalidInput        = errors.New("campaign assurance: invalid input")
	ErrIdempotencyConflict = errors.New("campaign assurance: idempotency key reused with different input")
	ErrRunInFlight         = errors.New("campaign assurance: matching run is already queued or running")
	ErrPlanNotReady        = errors.New("campaign assurance: send plan is not ready")
	ErrSnapshotIncomplete  = errors.New("campaign assurance: frozen input snapshot is incomplete")
	ErrInvalidLease        = errors.New("campaign assurance: invalid worker lease")
	ErrLeaseLost           = errors.New("campaign assurance: worker lease lost")
	ErrInvalidReceipt      = errors.New("campaign assurance: invalid worker receipt")
	ErrInvalidTransition   = errors.New("campaign assurance: invalid lifecycle transition")
	ErrUnauthorized        = errors.New("campaign assurance: authenticated actor is not authorized")
	ErrConcurrentMutation  = errors.New("campaign assurance: concurrent creation could not be serialized")
	ErrOverrideNotAllowed  = errors.New("campaign assurance: override is not allowed for this evidence")
	ErrCostBudgetExceeded  = errors.New("campaign assurance: modeled run cost budget exhausted")
)

// ConfigurationInput is one fixed analyzer configuration in the closed run
// suite. Configuration must be an object and is canonicalized before hashing.
type ConfigurationInput struct {
	ID            string          `json:"id"`
	SourceClass   string          `json:"source_class"`
	Configuration json.RawMessage `json:"configuration"`
}

// TargetInput selects one required artifact/configuration cell. When Targets
// is empty CreateRun intentionally expands the full Cartesian matrix. Supplying
// Targets enables sparse calibration or controlled-observation suites.
type TargetInput struct {
	ArtifactID      string `json:"artifact_id"`
	ConfigurationID string `json:"configuration_id"`
}

// CreateRunInput contains caller-selected methodology identity. Source, plan,
// artifact, compiler, fixture, and plan-policy identity are loaded from the
// immutable send plan and cannot be supplied optimistically by a caller.
type CreateRunInput struct {
	CampaignID           string               `json:"campaign_id"`
	ContentRevisionID    string               `json:"content_revision_id"`
	SendPlanID           string               `json:"send_plan_id"`
	RequestID            string               `json:"request_id"`
	TriggerKind          string               `json:"trigger_kind"`
	Profile              string               `json:"profile"`
	AnalyzerSuiteVersion string               `json:"analyzer_suite_version"`
	ModelSuiteVersion    string               `json:"model_suite_version"`
	PromptSuiteVersion   string               `json:"prompt_suite_version"`
	PromptSuiteHash      string               `json:"prompt_suite_hash"`
	NormalizationVersion string               `json:"normalization_version"`
	ScoringVersion       string               `json:"scoring_version"`
	GatePolicyVersion    string               `json:"gate_policy_version"`
	MethodologyVersion   string               `json:"methodology_version"`
	Configurations       []ConfigurationInput `json:"configurations"`
	Targets              []TargetInput        `json:"targets,omitempty"`
	MaxAttempts          int                  `json:"max_attempts,omitempty"`
	CreatedBy            string               `json:"-"`
}

// Run is the durable lifecycle and aggregate receipt. Scores are nullable
// because an assurance run without a valid Fact Contract must not fabricate an
// overall score.
type Run struct {
	ID                         string          `json:"id"`
	TenantID                   string          `json:"-"`
	CampaignID                 string          `json:"campaign_id"`
	ContentRevisionID          string          `json:"content_revision_id"`
	SendPlanID                 string          `json:"send_plan_id"`
	RunNo                      int64           `json:"run_no"`
	RequestID                  string          `json:"request_id"`
	RequestHash                string          `json:"request_hash"`
	TriggerKind                string          `json:"trigger_kind"`
	Profile                    string          `json:"profile"`
	State                      string          `json:"state"`
	SourceHash                 string          `json:"source_hash"`
	PlanHash                   string          `json:"plan_hash"`
	ArtifactSetHash            string          `json:"artifact_set_hash"`
	CoverageManifestHash       string          `json:"coverage_manifest_hash"`
	ConfigurationManifestHash  string          `json:"configuration_manifest_hash"`
	TargetManifestHash         string          `json:"target_manifest_hash"`
	RendererVersion            string          `json:"renderer_version"`
	CompilerVersion            string          `json:"compiler_version"`
	FixtureSetVersion          string          `json:"fixture_set_version"`
	PlanPolicyVersion          string          `json:"plan_policy_version"`
	AnalyzerSuiteVersion       string          `json:"analyzer_suite_version"`
	ModelSuiteVersion          string          `json:"model_suite_version"`
	PromptSuiteVersion         string          `json:"prompt_suite_version"`
	PromptSuiteHash            string          `json:"prompt_suite_hash"`
	NormalizationVersion       string          `json:"normalization_version"`
	ScoringVersion             string          `json:"scoring_version"`
	GatePolicyVersion          string          `json:"gate_policy_version"`
	MethodologyVersion         string          `json:"methodology_version"`
	RequiredScenarioCount      int             `json:"required_scenario_count"`
	RequiredConfigurationCount int             `json:"required_configuration_count"`
	RequiredExtractionCount    int             `json:"required_extraction_count"`
	TerminalExtractionCount    int             `json:"terminal_extraction_count"`
	SuccessfulExtractionCount  int             `json:"successful_extraction_count"`
	ExtractionErrorCount       int             `json:"extraction_error_count"`
	FindingCount               int             `json:"finding_count"`
	BlockingFindingCount       int             `json:"blocking_finding_count"`
	ComponentScores            json.RawMessage `json:"component_scores,omitempty"`
	OverallScore               *float64        `json:"overall_score"`
	ScoreMin                   *float64        `json:"score_min"`
	ScoreMax                   *float64        `json:"score_max"`
	ScoreSpread                *float64        `json:"score_spread"`
	Agreement                  *float64        `json:"agreement"`
	GateDecision               string          `json:"gate_decision"`
	InputTokens                int64           `json:"input_tokens"`
	OutputTokens               int64           `json:"output_tokens"`
	CostMicrounits             int64           `json:"cost_microunits"`
	MaxModeledCostMicrounits   int64           `json:"max_modeled_cost_microunits"`
	LatencyMS                  int64           `json:"latency_ms"`
	SnapshotFrozenAt           *time.Time      `json:"snapshot_frozen_at,omitempty"`
	ClaimToken                 *string         `json:"-"`
	LeaseOwner                 *string         `json:"-"`
	LeaseExpiresAt             *time.Time      `json:"lease_expires_at,omitempty"`
	HeartbeatAt                *time.Time      `json:"heartbeat_at,omitempty"`
	AttemptCount               int             `json:"attempt_count"`
	MaxAttempts                int             `json:"max_attempts"`
	RetryNotBefore             *time.Time      `json:"retry_not_before,omitempty"`
	ErrorCode                  *string         `json:"error_code,omitempty"`
	ErrorMessage               *string         `json:"error_message,omitempty"`
	CreatedBy                  *string         `json:"created_by,omitempty"`
	CreatedAt                  time.Time       `json:"created_at"`
	StartedAt                  *time.Time      `json:"started_at,omitempty"`
	CompletedAt                *time.Time      `json:"completed_at,omitempty"`
	CancelledAt                *time.Time      `json:"cancelled_at,omitempty"`
	StaleAt                    *time.Time      `json:"stale_at,omitempty"`
	UpdatedAt                  time.Time       `json:"updated_at"`
}

type RunArtifact struct {
	TenantID          string    `json:"-"`
	CampaignID        string    `json:"campaign_id"`
	RunID             string    `json:"run_id"`
	SendPlanID        string    `json:"send_plan_id"`
	ArtifactID        string    `json:"artifact_id"`
	Ordinal           int       `json:"ordinal"`
	ScenarioID        string    `json:"scenario_id"`
	OutboundMIMEHash  string    `json:"outbound_mime_hash"`
	MIMEStructureHash string    `json:"mime_structure_hash"`
	SnapshottedAt     time.Time `json:"snapshotted_at"`
}

type RunConfiguration struct {
	TenantID          string          `json:"-"`
	CampaignID        string          `json:"campaign_id"`
	RunID             string          `json:"run_id"`
	Ordinal           int             `json:"ordinal"`
	ID                string          `json:"configuration_id"`
	SourceClass       string          `json:"source_class"`
	ConfigurationHash string          `json:"configuration_hash"`
	Configuration     json.RawMessage `json:"configuration"`
	SnapshottedAt     time.Time       `json:"snapshotted_at"`
}

type RunTarget struct {
	TenantID          string    `json:"-"`
	CampaignID        string    `json:"campaign_id"`
	RunID             string    `json:"run_id"`
	SendPlanID        string    `json:"send_plan_id"`
	ArtifactID        string    `json:"artifact_id"`
	ConfigurationID   string    `json:"configuration_id"`
	Ordinal           int       `json:"ordinal"`
	SourceClass       string    `json:"source_class"`
	ConfigurationHash string    `json:"configuration_hash"`
	OutboundMIMEHash  string    `json:"outbound_mime_hash"`
	SnapshottedAt     time.Time `json:"snapshotted_at"`
}

type ClaimedRun struct {
	Run            Run                `json:"run"`
	Artifacts      []RunArtifact      `json:"artifacts"`
	Configurations []RunConfiguration `json:"configurations"`
	Targets        []RunTarget        `json:"targets"`
}

type ExtractionInput struct {
	ArtifactID                   string          `json:"artifact_id"`
	ConfigurationID              string          `json:"configuration_id"`
	SourceClass                  string          `json:"source_class"`
	ConfigurationHash            string          `json:"configuration_hash"`
	OutboundMIMEHash             string          `json:"outbound_mime_hash"`
	Status                       string          `json:"status"`
	NormalizedExtraction         json.RawMessage `json:"normalized_extraction,omitempty"`
	EvidenceManifest             json.RawMessage `json:"evidence_manifest"`
	UnsupportedClaims            json.RawMessage `json:"unsupported_claims"`
	Ambiguities                  json.RawMessage `json:"ambiguities"`
	RawOutputObjectRef           string          `json:"raw_output_object_ref,omitempty"`
	RawOutputHash                string          `json:"raw_output_hash,omitempty"`
	RawOutputExpiresAt           *time.Time      `json:"raw_output_expires_at,omitempty"`
	ModelProvider                string          `json:"model_provider"`
	ModelID                      string          `json:"model_id"`
	ModelVersion                 string          `json:"model_version"`
	PromptVersion                string          `json:"prompt_version"`
	PromptHash                   string          `json:"prompt_hash"`
	SeedValue                    string          `json:"seed_value,omitempty"`
	Temperature                  *float64        `json:"temperature,omitempty"`
	InputTokens                  int64           `json:"input_tokens"`
	OutputTokens                 int64           `json:"output_tokens"`
	CostMicrounits               int64           `json:"cost_microunits"`
	LatencyMS                    int64           `json:"latency_ms"`
	ErrorCode                    string          `json:"error_code,omitempty"`
	ErrorMessage                 string          `json:"error_message,omitempty"`
	ModelCacheKey                string          `json:"model_cache_key,omitempty"`
	ModelInputManifestHash       string          `json:"model_input_manifest_hash,omitempty"`
	ModelInvocationID            string          `json:"model_invocation_id,omitempty"`
	ExecutionKind                string          `json:"execution_kind,omitempty"`
	ReusedFromExtractionID       string          `json:"reused_from_extraction_id,omitempty"`
	ReusedFromReceiptHash        string          `json:"reused_from_receipt_hash,omitempty"`
	ReusedOriginalCostMicrounits int64           `json:"reused_original_cost_microunits,omitempty"`
}

type Extraction struct {
	ID           string `json:"id"`
	TenantID     string `json:"-"`
	CampaignID   string `json:"campaign_id"`
	RunID        string `json:"run_id"`
	SendPlanID   string `json:"send_plan_id"`
	AttemptCount int    `json:"attempt_count"`
	ClaimToken   string `json:"-"`
	ReceiptHash  string `json:"receipt_hash"`
	ExtractionInput
	CreatedAt time.Time `json:"created_at"`
}

const (
	ModeledExecutionInvoked    = "invoked"
	ModeledExecutionCacheReuse = "cache_reuse"

	InvocationResultComplete      = "complete"
	InvocationResultError         = "error"
	InvocationResultUnavailable   = "unavailable"
	InvocationResultChargeUnknown = "charge_unknown"
)

// ModeledCacheLookupInput binds a cache lookup to the active target and the
// stable semantic request hashes. Operational run/attempt identity is used as
// a lease fence, never as a cache match shortcut.
type ModeledCacheLookupInput struct {
	ArtifactID        string `json:"artifact_id"`
	ConfigurationID   string `json:"configuration_id"`
	ConfigurationHash string `json:"configuration_hash"`
	OutboundMIMEHash  string `json:"outbound_mime_hash"`
	CacheKey          string `json:"model_cache_key"`
	InputManifestHash string `json:"model_input_manifest_hash"`
}

type ReusableModeledExtraction struct {
	SourceRunID string     `json:"source_run_id"`
	Extraction  Extraction `json:"extraction"`
}

type ModeledCacheReuseInput struct {
	SourceExtractionID string          `json:"source_extraction_id"`
	SourceReceiptHash  string          `json:"source_receipt_hash"`
	Extraction         ExtractionInput `json:"extraction"`
}

type ModeledInvocationReservationInput struct {
	InvocationID       string `json:"invocation_id"`
	CacheKey           string `json:"model_cache_key"`
	InputManifestHash  string `json:"model_input_manifest_hash"`
	ArtifactID         string `json:"artifact_id"`
	ConfigurationID    string `json:"configuration_id"`
	ConfigurationHash  string `json:"configuration_hash"`
	OutboundMIMEHash   string `json:"outbound_mime_hash"`
	ReservedMicrounits int64  `json:"reserved_microunits"`
}

type ModeledInvocationReservation struct {
	TenantID     string `json:"-"`
	CampaignID   string `json:"campaign_id"`
	RunID        string `json:"run_id"`
	AttemptCount int    `json:"attempt_count"`
	ClaimToken   string `json:"-"`
	ModeledInvocationReservationInput
	CreatedAt time.Time `json:"created_at"`
}

type ModeledInvocationResultInput struct {
	InvocationID   string `json:"invocation_id"`
	Status         string `json:"status"`
	InputTokens    int64  `json:"input_tokens"`
	OutputTokens   int64  `json:"output_tokens"`
	CostMicrounits int64  `json:"cost_microunits"`
	LatencyMS      int64  `json:"latency_ms"`
	ReasonCode     string `json:"reason_code,omitempty"`
}

type ModeledInvocationResult struct {
	TenantID     string `json:"-"`
	CampaignID   string `json:"campaign_id"`
	RunID        string `json:"run_id"`
	AttemptCount int    `json:"attempt_count"`
	ClaimToken   string `json:"-"`
	ReceiptHash  string `json:"receipt_hash"`
	ModeledInvocationResultInput
	CreatedAt time.Time `json:"created_at"`
}

type FindingInput struct {
	ArtifactID              string          `json:"artifact_id"`
	ConfigurationID         string          `json:"configuration_id"`
	ExtractionID            string          `json:"extraction_id,omitempty"`
	Code                    string          `json:"code"`
	SourceClass             string          `json:"source_class"`
	Severity                string          `json:"severity"`
	Blocking                bool            `json:"blocking"`
	Overridable             bool            `json:"overridable"`
	Dimension               string          `json:"dimension"`
	BlockReferences         json.RawMessage `json:"block_references"`
	EvidenceReferences      json.RawMessage `json:"evidence_references"`
	ExpectedValue           json.RawMessage `json:"expected_value,omitempty"`
	ObservedValue           json.RawMessage `json:"observed_value,omitempty"`
	Explanation             string          `json:"explanation"`
	Remediation             json.RawMessage `json:"remediation"`
	TypedPatch              json.RawMessage `json:"typed_patch,omitempty"`
	TypedPatchSchemaVersion *int            `json:"typed_patch_schema_version,omitempty"`
	DetectorVersion         string          `json:"detector_version"`
	PolicyVersion           string          `json:"policy_version"`
}

type Finding struct {
	ID                string `json:"id"`
	TenantID          string `json:"-"`
	CampaignID        string `json:"campaign_id"`
	RunID             string `json:"run_id"`
	SendPlanID        string `json:"send_plan_id"`
	AttemptCount      int    `json:"attempt_count"`
	ClaimToken        string `json:"-"`
	ConfigurationHash string `json:"configuration_hash"`
	OutboundMIMEHash  string `json:"outbound_mime_hash"`
	FindingKey        string `json:"finding_key"`
	ReceiptHash       string `json:"receipt_hash"`
	FindingInput
	CreatedAt time.Time `json:"created_at"`
}

type FinalizeInput struct {
	ComponentScores json.RawMessage `json:"component_scores,omitempty"`
	OverallScore    *float64        `json:"overall_score,omitempty"`
	ScoreMin        *float64        `json:"score_min,omitempty"`
	ScoreMax        *float64        `json:"score_max,omitempty"`
	Agreement       *float64        `json:"agreement,omitempty"`
	GateDecision    string          `json:"gate_decision"`
}

type RunFailure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type OverrideInput struct {
	FindingID string     `json:"finding_id"`
	RequestID string     `json:"request_id"`
	Decision  string     `json:"decision"`
	Reason    string     `json:"reason"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

type Override struct {
	ID                 string     `json:"id"`
	TenantID           string     `json:"-"`
	CampaignID         string     `json:"campaign_id"`
	RunID              string     `json:"run_id"`
	AttemptCount       int        `json:"attempt_count"`
	FindingID          string     `json:"finding_id"`
	FindingReceiptHash string     `json:"finding_receipt_hash"`
	RequestID          string     `json:"request_id"`
	RequestHash        string     `json:"request_hash"`
	ArtifactSetHash    string     `json:"artifact_set_hash"`
	ActorID            string     `json:"actor_id"`
	ActorRole          string     `json:"actor_role"`
	Decision           string     `json:"decision"`
	Reason             string     `json:"reason"`
	ExpiresAt          *time.Time `json:"expires_at,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
}
