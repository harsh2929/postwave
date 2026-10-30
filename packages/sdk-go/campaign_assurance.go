package postwave

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type CampaignAssuranceProfile string

const (
	CampaignAssuranceProfileFast        CampaignAssuranceProfile = "fast"
	CampaignAssuranceProfileFull        CampaignAssuranceProfile = "full"
	CampaignAssuranceProfileCalibration CampaignAssuranceProfile = "calibration"
)

type CampaignAssuranceSourceClass string

const (
	CampaignAssuranceSourceDeterministic         CampaignAssuranceSourceClass = "deterministic"
	CampaignAssuranceSourceModeled               CampaignAssuranceSourceClass = "modeled"
	CampaignAssuranceSourceControlledObservation CampaignAssuranceSourceClass = "controlled_observation"
)

type CampaignAssuranceRunState string
type CampaignAssuranceGateDecision string
type CampaignAssuranceExtractionStatus string
type CampaignAssuranceAppealDecision string

const (
	CampaignAssuranceAppealAllowSend CampaignAssuranceAppealDecision = "allow_send"
	CampaignAssuranceAppealReject    CampaignAssuranceAppealDecision = "reject"
)

// CampaignAssuranceSourceDisclosure says which evidence classes are actually
// present. Modeled evidence is a prediction, not an observation of a private
// inbox provider's generated summary.
type CampaignAssuranceSourceDisclosure struct {
	Class   CampaignAssuranceSourceClass `json:"class"`
	Present bool                         `json:"present"`
	Meaning string                       `json:"meaning"`
}

type CampaignAssuranceMeasurement struct {
	Name           string                              `json:"name"`
	Interpretation string                              `json:"interpretation"`
	SourceClasses  []CampaignAssuranceSourceDisclosure `json:"source_classes"`
}

type CampaignAssuranceEnvelope[T any] struct {
	Measurement CampaignAssuranceMeasurement `json:"measurement"`
	Data        T                            `json:"data"`
}

type CreateCampaignAssuranceRunInput struct {
	Profile CampaignAssuranceProfile `json:"profile"`
	// ContentRevisionID selects an exact revision. Empty freezes the current draft.
	ContentRevisionID string `json:"content_revision_id,omitempty"`
	// SendPlanID selects an existing ready plan and requires ContentRevisionID.
	// Empty asks the server to compile and materialize the exact revision.
	SendPlanID string `json:"send_plan_id,omitempty"`
	RequestID  string `json:"request_id"`
	// IncludeSeedTest requests a named controlled observation. The API fails
	// closed until a reviewed controlled-client adapter is configured.
	IncludeSeedTest  bool     `json:"include_seed_test,omitempty"`
	ObservedSurfaces []string `json:"observed_surfaces,omitempty"`
}

type CampaignAssuranceMutationOptions struct {
	// IdempotencyKey should be stable for an exact retry across processes. If
	// empty, the SDK mints one key and reuses it for its transport retries.
	IdempotencyKey string
}

type CampaignAssuranceApplyOptions struct {
	// IfMatch is the exact strong campaign ETag returned for the draft version
	// the editor reviewed. It is required and cannot be weak or wildcard.
	IfMatch        string
	IdempotencyKey string
}

type FactContractIntentKind string
type FactContractPrimaryActionRole string
type FactContractSecondaryActionRole string
type FactContractFactType string
type FactContractCriticality string

const (
	FactContractIntentInform        FactContractIntentKind = "inform"
	FactContractIntentInvite        FactContractIntentKind = "invite"
	FactContractIntentPromote       FactContractIntentKind = "promote"
	FactContractIntentRequestAction FactContractIntentKind = "request_action"
	FactContractIntentRemind        FactContractIntentKind = "remind"
	FactContractIntentSurvey        FactContractIntentKind = "survey"
	FactContractIntentTransact      FactContractIntentKind = "transact"
	FactContractIntentOnboard       FactContractIntentKind = "onboard"
	FactContractIntentRetain        FactContractIntentKind = "retain"
	FactContractIntentOther         FactContractIntentKind = "other"
)

const (
	FactContractActionNavigate FactContractPrimaryActionRole = "navigate"
	FactContractActionRegister FactContractPrimaryActionRole = "register"
	FactContractActionPurchase FactContractPrimaryActionRole = "purchase"
	FactContractActionRSVP     FactContractPrimaryActionRole = "rsvp"
	FactContractActionConfirm  FactContractPrimaryActionRole = "confirm"
	FactContractActionDownload FactContractPrimaryActionRole = "download"
	FactContractActionSurvey   FactContractPrimaryActionRole = "survey"
	FactContractActionReply    FactContractPrimaryActionRole = "reply"
	FactContractActionTrack    FactContractPrimaryActionRole = "track"
)

const (
	FactContractFactText       FactContractFactType = "text"
	FactContractFactDateTime   FactContractFactType = "datetime"
	FactContractFactMoney      FactContractFactType = "money"
	FactContractFactLocation   FactContractFactType = "location"
	FactContractFactCode       FactContractFactType = "code"
	FactContractFactPercentage FactContractFactType = "percentage"
	FactContractFactQuantity   FactContractFactType = "quantity"
	FactContractFactURL        FactContractFactType = "url"
)

const (
	FactContractCritical   FactContractCriticality = "critical"
	FactContractImportant  FactContractCriticality = "important"
	FactContractSupporting FactContractCriticality = "supporting"
)

type FactContractIntentV1 struct {
	Kind      FactContractIntentKind `json:"kind"`
	Statement string                 `json:"statement"`
}

type FactContractAudienceV1 struct {
	Description        string `json:"description"`
	TargetingReference string `json:"targeting_reference,omitempty"`
}

type FactContractClaimV1 struct {
	Statement      string   `json:"statement"`
	SourceBlockIDs []string `json:"source_block_ids,omitempty"`
}

type FactContractPrimaryActionV1 struct {
	ActionID     string                        `json:"action_id"`
	BlockID      string                        `json:"block_id"`
	Role         FactContractPrimaryActionRole `json:"role"`
	Label        string                        `json:"label"`
	CanonicalURL string                        `json:"canonical_url,omitempty"`
}

type FactContractDateTimeValueV1 struct {
	RFC3339  string `json:"rfc3339"`
	Timezone string `json:"timezone"`
}

type FactContractMoneyValueV1 struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency"`
}

type FactContractNumberValueV1 struct {
	Value string `json:"value"`
	Unit  string `json:"unit,omitempty"`
}

type FactContractRequiredFactV1 struct {
	ID             string                       `json:"id"`
	Type           FactContractFactType         `json:"type"`
	DisplayValue   string                       `json:"display_value"`
	Criticality    FactContractCriticality      `json:"criticality"`
	SourceBlockIDs []string                     `json:"source_block_ids"`
	TextValue      *string                      `json:"text_value,omitempty"`
	DateTimeValue  *FactContractDateTimeValueV1 `json:"datetime_value,omitempty"`
	MoneyValue     *FactContractMoneyValueV1    `json:"money_value,omitempty"`
	NumberValue    *FactContractNumberValueV1   `json:"number_value,omitempty"`
	URLValue       *string                      `json:"url_value,omitempty"`
}

type FactContractForbiddenClaimV1 struct {
	ID        string `json:"id"`
	Statement string `json:"statement"`
}

// FactContractV1 is the sender-authored expected-output oracle. It does not
// describe or claim an inbox provider observation.
type FactContractV1 struct {
	SchemaVersion           int                               `json:"schema_version"`
	PrimaryIntent           FactContractIntentV1              `json:"primary_intent"`
	AudienceContext         FactContractAudienceV1            `json:"audience_context"`
	CoreClaim               FactContractClaimV1               `json:"core_claim"`
	PrimaryAction           FactContractPrimaryActionV1       `json:"primary_action"`
	RequiredFacts           []FactContractRequiredFactV1      `json:"required_facts"`
	ForbiddenClaims         []FactContractForbiddenClaimV1    `json:"forbidden_claims"`
	AllowedSecondaryActions []FactContractSecondaryActionRole `json:"allowed_secondary_actions"`
	Language                string                            `json:"language"`
}

type SetFactContractOptions struct {
	// IfMatch is the exact strong ETag returned for the mutable campaign version.
	IfMatch        string
	IdempotencyKey string
}

type SetFactContractResult struct {
	Campaign Campaign
	ETag     string
}

type CampaignAssuranceStartRun struct {
	RunID                   string                    `json:"run_id"`
	CampaignID              string                    `json:"campaign_id"`
	ContentRevisionID       string                    `json:"content_revision_id"`
	SendPlanID              string                    `json:"send_plan_id"`
	RequestID               string                    `json:"request_id"`
	Profile                 CampaignAssuranceProfile  `json:"profile"`
	State                   CampaignAssuranceRunState `json:"state"`
	RequiredScenarioCount   int                       `json:"required_scenario_count"`
	RequiredExtractionCount int                       `json:"required_extraction_count"`
	StatusURL               string                    `json:"status_url"`
	EvidenceURL             string                    `json:"evidence_url"`
	EventsURL               string                    `json:"events_url"`
}

type CampaignAssuranceRun struct {
	ID                         string                        `json:"id"`
	CampaignID                 string                        `json:"campaign_id"`
	ContentRevisionID          string                        `json:"content_revision_id"`
	SendPlanID                 string                        `json:"send_plan_id"`
	RunNo                      int64                         `json:"run_no"`
	RequestID                  string                        `json:"request_id"`
	RequestHash                string                        `json:"request_hash"`
	TriggerKind                string                        `json:"trigger_kind"`
	Profile                    CampaignAssuranceProfile      `json:"profile"`
	State                      CampaignAssuranceRunState     `json:"state"`
	SourceHash                 string                        `json:"source_hash"`
	PlanHash                   string                        `json:"plan_hash"`
	ArtifactSetHash            string                        `json:"artifact_set_hash"`
	CoverageManifestHash       string                        `json:"coverage_manifest_hash"`
	ConfigurationManifestHash  string                        `json:"configuration_manifest_hash"`
	TargetManifestHash         string                        `json:"target_manifest_hash"`
	RendererVersion            string                        `json:"renderer_version"`
	CompilerVersion            string                        `json:"compiler_version"`
	FixtureSetVersion          string                        `json:"fixture_set_version"`
	PlanPolicyVersion          string                        `json:"plan_policy_version"`
	AnalyzerSuiteVersion       string                        `json:"analyzer_suite_version"`
	ModelSuiteVersion          string                        `json:"model_suite_version"`
	PromptSuiteVersion         string                        `json:"prompt_suite_version"`
	PromptSuiteHash            string                        `json:"prompt_suite_hash"`
	NormalizationVersion       string                        `json:"normalization_version"`
	ScoringVersion             string                        `json:"scoring_version"`
	GatePolicyVersion          string                        `json:"gate_policy_version"`
	MethodologyVersion         string                        `json:"methodology_version"`
	RequiredScenarioCount      int                           `json:"required_scenario_count"`
	RequiredConfigurationCount int                           `json:"required_configuration_count"`
	RequiredExtractionCount    int                           `json:"required_extraction_count"`
	TerminalExtractionCount    int                           `json:"terminal_extraction_count"`
	SuccessfulExtractionCount  int                           `json:"successful_extraction_count"`
	ExtractionErrorCount       int                           `json:"extraction_error_count"`
	FindingCount               int                           `json:"finding_count"`
	BlockingFindingCount       int                           `json:"blocking_finding_count"`
	ComponentScores            json.RawMessage               `json:"component_scores,omitempty"`
	OverallScore               *float64                      `json:"overall_score"`
	ScoreMin                   *float64                      `json:"score_min"`
	ScoreMax                   *float64                      `json:"score_max"`
	ScoreSpread                *float64                      `json:"score_spread"`
	Agreement                  *float64                      `json:"agreement"`
	GateDecision               CampaignAssuranceGateDecision `json:"gate_decision"`
	InputTokens                int64                         `json:"input_tokens"`
	OutputTokens               int64                         `json:"output_tokens"`
	CostMicrounits             int64                         `json:"cost_microunits"`
	MaxModeledCostMicrounits   int64                         `json:"max_modeled_cost_microunits"`
	LatencyMS                  int64                         `json:"latency_ms"`
	SnapshotFrozenAt           *time.Time                    `json:"snapshot_frozen_at,omitempty"`
	LeaseExpiresAt             *time.Time                    `json:"lease_expires_at,omitempty"`
	HeartbeatAt                *time.Time                    `json:"heartbeat_at,omitempty"`
	AttemptCount               int                           `json:"attempt_count"`
	MaxAttempts                int                           `json:"max_attempts"`
	RetryNotBefore             *time.Time                    `json:"retry_not_before,omitempty"`
	ErrorCode                  *string                       `json:"error_code,omitempty"`
	ErrorMessage               *string                       `json:"error_message,omitempty"`
	CreatedBy                  *string                       `json:"created_by,omitempty"`
	CreatedAt                  time.Time                     `json:"created_at"`
	StartedAt                  *time.Time                    `json:"started_at,omitempty"`
	CompletedAt                *time.Time                    `json:"completed_at,omitempty"`
	CancelledAt                *time.Time                    `json:"cancelled_at,omitempty"`
	StaleAt                    *time.Time                    `json:"stale_at,omitempty"`
	UpdatedAt                  time.Time                     `json:"updated_at"`
}

type CampaignAssuranceRunArtifact struct {
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

type CampaignAssuranceRunConfiguration struct {
	CampaignID        string                       `json:"campaign_id"`
	RunID             string                       `json:"run_id"`
	Ordinal           int                          `json:"ordinal"`
	ConfigurationID   string                       `json:"configuration_id"`
	SourceClass       CampaignAssuranceSourceClass `json:"source_class"`
	ConfigurationHash string                       `json:"configuration_hash"`
	Configuration     map[string]any               `json:"configuration"`
	SnapshottedAt     time.Time                    `json:"snapshotted_at"`
}

type CampaignAssuranceRunTarget struct {
	CampaignID        string                       `json:"campaign_id"`
	RunID             string                       `json:"run_id"`
	SendPlanID        string                       `json:"send_plan_id"`
	ArtifactID        string                       `json:"artifact_id"`
	ConfigurationID   string                       `json:"configuration_id"`
	Ordinal           int                          `json:"ordinal"`
	SourceClass       CampaignAssuranceSourceClass `json:"source_class"`
	ConfigurationHash string                       `json:"configuration_hash"`
	OutboundMIMEHash  string                       `json:"outbound_mime_hash"`
	SnapshottedAt     time.Time                    `json:"snapshotted_at"`
}

type CampaignAssuranceManifest struct {
	Run            CampaignAssuranceRun                `json:"run"`
	Artifacts      []CampaignAssuranceRunArtifact      `json:"artifacts"`
	Configurations []CampaignAssuranceRunConfiguration `json:"configurations"`
	Targets        []CampaignAssuranceRunTarget        `json:"targets"`
}

type CampaignAssuranceRunDetail struct {
	Run           CampaignAssuranceRun           `json:"run"`
	Manifest      CampaignAssuranceManifest      `json:"manifest"`
	SourceClasses []CampaignAssuranceSourceClass `json:"source_classes"`
}

type CampaignAssuranceApplicability struct {
	ApplicableToFrozenSnapshot bool   `json:"applicable_to_frozen_snapshot"`
	Freshness                  string `json:"freshness"`
	Basis                      string `json:"basis"`
}

type CampaignAssuranceLatest struct {
	Detail        CampaignAssuranceRunDetail     `json:"detail"`
	Applicability CampaignAssuranceApplicability `json:"applicability"`
}

type CampaignAssuranceExtraction struct {
	ID                           string                            `json:"id"`
	CampaignID                   string                            `json:"campaign_id"`
	RunID                        string                            `json:"run_id"`
	SendPlanID                   string                            `json:"send_plan_id"`
	AttemptCount                 int                               `json:"attempt_count"`
	ReceiptHash                  string                            `json:"receipt_hash"`
	ArtifactID                   string                            `json:"artifact_id"`
	ConfigurationID              string                            `json:"configuration_id"`
	SourceClass                  CampaignAssuranceSourceClass      `json:"source_class"`
	ConfigurationHash            string                            `json:"configuration_hash"`
	OutboundMIMEHash             string                            `json:"outbound_mime_hash"`
	Status                       CampaignAssuranceExtractionStatus `json:"status"`
	NormalizedExtraction         json.RawMessage                   `json:"normalized_extraction,omitempty"`
	EvidenceManifest             json.RawMessage                   `json:"evidence_manifest"`
	UnsupportedClaims            json.RawMessage                   `json:"unsupported_claims"`
	Ambiguities                  json.RawMessage                   `json:"ambiguities"`
	RawOutputObjectRef           string                            `json:"raw_output_object_ref,omitempty"`
	RawOutputHash                string                            `json:"raw_output_hash,omitempty"`
	RawOutputExpiresAt           *time.Time                        `json:"raw_output_expires_at,omitempty"`
	ModelProvider                string                            `json:"model_provider"`
	ModelID                      string                            `json:"model_id"`
	ModelVersion                 string                            `json:"model_version"`
	PromptVersion                string                            `json:"prompt_version"`
	PromptHash                   string                            `json:"prompt_hash"`
	SeedValue                    string                            `json:"seed_value,omitempty"`
	Temperature                  *float64                          `json:"temperature,omitempty"`
	InputTokens                  int64                             `json:"input_tokens"`
	OutputTokens                 int64                             `json:"output_tokens"`
	CostMicrounits               int64                             `json:"cost_microunits"`
	LatencyMS                    int64                             `json:"latency_ms"`
	ModelCacheKey                string                            `json:"model_cache_key,omitempty"`
	ModelInputManifestHash       string                            `json:"model_input_manifest_hash,omitempty"`
	ModelInvocationID            string                            `json:"model_invocation_id,omitempty"`
	ExecutionKind                string                            `json:"execution_kind,omitempty"`
	ReusedFromExtractionID       string                            `json:"reused_from_extraction_id,omitempty"`
	ReusedFromReceiptHash        string                            `json:"reused_from_receipt_hash,omitempty"`
	ReusedOriginalCostMicrounits int64                             `json:"reused_original_cost_microunits,omitempty"`
	ErrorCode                    string                            `json:"error_code,omitempty"`
	ErrorMessage                 string                            `json:"error_message,omitempty"`
	CreatedAt                    time.Time                         `json:"created_at"`
}

type CampaignAssuranceFinding struct {
	ID                      string                       `json:"id"`
	CampaignID              string                       `json:"campaign_id"`
	RunID                   string                       `json:"run_id"`
	SendPlanID              string                       `json:"send_plan_id"`
	AttemptCount            int                          `json:"attempt_count"`
	ConfigurationHash       string                       `json:"configuration_hash"`
	OutboundMIMEHash        string                       `json:"outbound_mime_hash"`
	FindingKey              string                       `json:"finding_key"`
	ReceiptHash             string                       `json:"receipt_hash"`
	ArtifactID              string                       `json:"artifact_id"`
	ConfigurationID         string                       `json:"configuration_id"`
	ExtractionID            string                       `json:"extraction_id,omitempty"`
	Code                    string                       `json:"code"`
	SourceClass             CampaignAssuranceSourceClass `json:"source_class"`
	Severity                string                       `json:"severity"`
	Blocking                bool                         `json:"blocking"`
	Overridable             bool                         `json:"overridable"`
	Dimension               string                       `json:"dimension"`
	BlockReferences         json.RawMessage              `json:"block_references"`
	EvidenceReferences      json.RawMessage              `json:"evidence_references"`
	ExpectedValue           json.RawMessage              `json:"expected_value,omitempty"`
	ObservedValue           json.RawMessage              `json:"observed_value,omitempty"`
	Explanation             string                       `json:"explanation"`
	Remediation             json.RawMessage              `json:"remediation"`
	TypedPatch              json.RawMessage              `json:"typed_patch,omitempty"`
	TypedPatchSchemaVersion *int                         `json:"typed_patch_schema_version,omitempty"`
	DetectorVersion         string                       `json:"detector_version"`
	PolicyVersion           string                       `json:"policy_version"`
	CreatedAt               time.Time                    `json:"created_at"`
}

type CampaignAssuranceOverride struct {
	ID                 string                          `json:"id"`
	CampaignID         string                          `json:"campaign_id"`
	RunID              string                          `json:"run_id"`
	AttemptCount       int                             `json:"attempt_count"`
	FindingID          string                          `json:"finding_id"`
	FindingReceiptHash string                          `json:"finding_receipt_hash"`
	RequestID          string                          `json:"request_id"`
	RequestHash        string                          `json:"request_hash"`
	ArtifactSetHash    string                          `json:"artifact_set_hash"`
	ActorID            string                          `json:"actor_id"`
	ActorRole          string                          `json:"actor_role"`
	Decision           CampaignAssuranceAppealDecision `json:"decision"`
	Reason             string                          `json:"reason"`
	ExpiresAt          *time.Time                      `json:"expires_at,omitempty"`
	CreatedAt          time.Time                       `json:"created_at"`
}

type CampaignAssuranceApplyFindingInput struct {
	RequestID string `json:"request_id"`
}

// CampaignAssurancePatchApplication is the append-only receipt for the exact
// server-owned deterministic patch applied to the campaign draft.
type CampaignAssurancePatchApplication struct {
	ID                       string    `json:"id"`
	CampaignID               string    `json:"campaign_id"`
	RunID                    string    `json:"run_id"`
	AttemptCount             int       `json:"attempt_count"`
	FindingID                string    `json:"finding_id"`
	RequestID                string    `json:"request_id"`
	RequestHash              string    `json:"request_hash"`
	FindingReceiptHash       string    `json:"finding_receipt_hash"`
	TypedPatchHash           string    `json:"typed_patch_hash"`
	TypedPatchSchemaVersion  int       `json:"typed_patch_schema_version"`
	BaseContentRevisionID    string    `json:"base_content_revision_id"`
	CreatedContentRevisionID string    `json:"created_content_revision_id"`
	ActorID                  string    `json:"actor_id"`
	CampaignUpdatedAt        time.Time `json:"campaign_updated_at"`
	CreatedAt                time.Time `json:"created_at"`
}

type CampaignAssuranceAppliedRevision struct {
	ID                   string          `json:"id"`
	CampaignID           string          `json:"campaign_id"`
	RevisionNo           int64           `json:"revision_no"`
	SourceMode           string          `json:"source_mode"`
	ContentSchemaVersion int             `json:"content_schema_version"`
	Subject              string          `json:"subject"`
	PreviewText          *string         `json:"preview_text,omitempty"`
	SemanticTree         json.RawMessage `json:"semantic_tree"`
	LegacyHTML           *string         `json:"legacy_html,omitempty"`
	ReviewedPlainText    *string         `json:"reviewed_plain_text,omitempty"`
	FactContract         json.RawMessage `json:"fact_contract"`
	Variants             json.RawMessage `json:"variants"`
	Locales              json.RawMessage `json:"locales"`
	SourceHash           string          `json:"source_hash"`
	CreatedBy            *string         `json:"created_by,omitempty"`
	CreatedAt            time.Time       `json:"created_at"`
}

type CampaignAssuranceApplyFindingResult struct {
	Application         CampaignAssurancePatchApplication `json:"application"`
	Revision            CampaignAssuranceAppliedRevision  `json:"revision"`
	CampaignETag        string                            `json:"campaign_etag"`
	OriginatingRunState string                            `json:"originating_run_state"`
	RerunRequired       bool                              `json:"rerun_required"`
}

type CampaignAssurancePage[T any] struct {
	Items      []T  `json:"items"`
	Offset     int  `json:"offset"`
	Limit      int  `json:"limit"`
	Total      int  `json:"total"`
	NextOffset *int `json:"next_offset,omitempty"`
}

type CampaignAssuranceEvidence struct {
	Run           CampaignAssuranceRun                               `json:"run"`
	SourceClasses []CampaignAssuranceSourceClass                     `json:"source_classes"`
	Extractions   CampaignAssurancePage[CampaignAssuranceExtraction] `json:"extractions"`
	Findings      CampaignAssurancePage[CampaignAssuranceFinding]    `json:"findings"`
	Overrides     CampaignAssurancePage[CampaignAssuranceOverride]   `json:"overrides"`
}

// CampaignAssuranceProgressSnapshot is returned by the /events route. The
// current API does not provide durable event history or SSE on that route.
type CampaignAssuranceProgressSnapshot struct {
	RunID                   string                         `json:"run_id"`
	State                   CampaignAssuranceRunState      `json:"state"`
	GateDecision            CampaignAssuranceGateDecision  `json:"gate_decision"`
	AttemptCount            int                            `json:"attempt_count"`
	RequiredExtractions     int                            `json:"required_extractions"`
	TerminalExtractions     int                            `json:"terminal_extractions"`
	SuccessfulExtractions   int                            `json:"successful_extractions"`
	ExtractionErrors        int                            `json:"extraction_errors"`
	FindingCount            int                            `json:"finding_count"`
	BlockingFindingCount    int                            `json:"blocking_finding_count"`
	UpdatedAt               time.Time                      `json:"updated_at"`
	CompletedAt             *time.Time                     `json:"completed_at,omitempty"`
	EventHistoryAvailable   bool                           `json:"event_history_available"`
	EventHistoryExplanation string                         `json:"event_history_explanation"`
	SourceClasses           []CampaignAssuranceSourceClass `json:"source_classes"`
}

type CampaignAssuranceAppealInput struct {
	RequestID string                          `json:"request_id"`
	Decision  CampaignAssuranceAppealDecision `json:"decision"`
	Reason    string                          `json:"reason"`
	ExpiresAt *time.Time                      `json:"expires_at,omitempty"`
}

// CampaignAssuranceResource exposes tenant-scoped assurance. Reads require
// read:campaigns; creation, cancellation, and stored-patch application require
// write:campaigns. Application additionally requires an exact strong campaign
// ETag. Appeals also require send:transactional and a tenant-bound owner/admin
// actor.
type CampaignAssuranceResource struct{ client *Client }

// SetFactContract replaces the complete mutable contract and returns the next
// campaign ETag. Passing nil explicitly stores the no-contract state `{}`.
func (r *CampaignAssuranceResource) SetFactContract(ctx context.Context, campaignID string, contract *FactContractV1, options *SetFactContractOptions) (*SetFactContractResult, error) {
	if options == nil || !validStrongCampaignETag(options.IfMatch) {
		return nil, fmt.Errorf("postwave: Fact Contract If-Match must be the exact strong campaign ETag returned by the API")
	}
	body := any(contract)
	if contract == nil {
		body = map[string]any{}
	}
	campaign := Campaign{}
	nextETag := ""
	err := r.client.requestWithHeadersAndIdempotencyKeyAndResponseHeaders(
		ctx,
		http.MethodPut,
		"/api/v1/campaigns/"+url.PathEscape(campaignID)+"/fact-contract",
		body,
		&campaign,
		map[string]string{"If-Match": options.IfMatch},
		options.IdempotencyKey,
		func(headers http.Header) { nextETag = headers.Get("ETag") },
	)
	if err != nil {
		return nil, err
	}
	if !validStrongCampaignETag(nextETag) {
		return nil, fmt.Errorf("postwave: Fact Contract response did not include a valid strong campaign ETag")
	}
	return &SetFactContractResult{Campaign: campaign, ETag: nextETag}, nil
}

func (r *CampaignAssuranceResource) CreateRun(ctx context.Context, campaignID string, input *CreateCampaignAssuranceRunInput, options *CampaignAssuranceMutationOptions) (*CampaignAssuranceEnvelope[CampaignAssuranceStartRun], error) {
	if input == nil {
		return nil, fmt.Errorf("postwave: Campaign Assurance run input is required")
	}
	if err := validateObservedSurfaces(input.IncludeSeedTest, input.ObservedSurfaces); err != nil {
		return nil, err
	}
	out := &CampaignAssuranceEnvelope[CampaignAssuranceStartRun]{}
	err := r.client.requestWithIdempotencyKey(ctx, http.MethodPost,
		"/api/v1/campaigns/"+url.PathEscape(campaignID)+"/assurance-runs",
		input, out, assuranceIdempotencyKey(options))
	return out, err
}

func validateObservedSurfaces(includeSeed bool, surfaces []string) error {
	if surfaces != nil && !includeSeed {
		return fmt.Errorf("postwave: observed_surfaces require include_seed_test=true")
	}
	if len(surfaces) > 32 {
		return fmt.Errorf("postwave: observed_surfaces must contain at most 32 identifiers")
	}
	seen := make(map[string]struct{}, len(surfaces))
	for _, surface := range surfaces {
		if surface == "" || len(surface) > 128 {
			return fmt.Errorf("postwave: observed_surfaces must be unique stable 1-128 byte identifiers")
		}
		for _, current := range surface {
			valid := current >= 'a' && current <= 'z' || current >= 'A' && current <= 'Z' ||
				current >= '0' && current <= '9' || strings.ContainsRune("._:-", current)
			if !valid {
				return fmt.Errorf("postwave: observed_surfaces must be unique stable 1-128 byte identifiers")
			}
		}
		if _, duplicate := seen[surface]; duplicate {
			return fmt.Errorf("postwave: observed_surfaces must be unique stable 1-128 byte identifiers")
		}
		seen[surface] = struct{}{}
	}
	return nil
}

func (r *CampaignAssuranceResource) GetLatest(ctx context.Context, campaignID string) (*CampaignAssuranceEnvelope[CampaignAssuranceLatest], error) {
	out := &CampaignAssuranceEnvelope[CampaignAssuranceLatest]{}
	err := r.client.request(ctx, http.MethodGet,
		"/api/v1/campaigns/"+url.PathEscape(campaignID)+"/assurance", nil, out)
	return out, err
}

func (r *CampaignAssuranceResource) GetRun(ctx context.Context, campaignID, runID string) (*CampaignAssuranceEnvelope[CampaignAssuranceRunDetail], error) {
	out := &CampaignAssuranceEnvelope[CampaignAssuranceRunDetail]{}
	err := r.client.request(ctx, http.MethodGet, campaignAssuranceRunPath(campaignID, runID), nil, out)
	return out, err
}

func (r *CampaignAssuranceResource) GetManifest(ctx context.Context, campaignID, runID string) (*CampaignAssuranceEnvelope[CampaignAssuranceManifest], error) {
	out := &CampaignAssuranceEnvelope[CampaignAssuranceManifest]{}
	err := r.client.request(ctx, http.MethodGet, campaignAssuranceRunPath(campaignID, runID)+"/manifest", nil, out)
	return out, err
}

func (r *CampaignAssuranceResource) GetEvidence(ctx context.Context, campaignID, runID string, offset, limit int) (*CampaignAssuranceEnvelope[CampaignAssuranceEvidence], error) {
	out := &CampaignAssuranceEnvelope[CampaignAssuranceEvidence]{}
	query := url.Values{}
	if offset != 0 {
		query.Set("offset", strconv.Itoa(offset))
	}
	if limit != 0 {
		query.Set("limit", strconv.Itoa(limit))
	}
	path := campaignAssuranceRunPath(campaignID, runID) + "/evidence"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	err := r.client.request(ctx, http.MethodGet, path, nil, out)
	return out, err
}

// GetEvents returns the current aggregate snapshot. Inspect
// EventHistoryAvailable; the current endpoint does not expose event history.
func (r *CampaignAssuranceResource) GetEvents(ctx context.Context, campaignID, runID string) (*CampaignAssuranceEnvelope[CampaignAssuranceProgressSnapshot], error) {
	out := &CampaignAssuranceEnvelope[CampaignAssuranceProgressSnapshot]{}
	err := r.client.request(ctx, http.MethodGet, campaignAssuranceRunPath(campaignID, runID)+"/events", nil, out)
	return out, err
}

func (r *CampaignAssuranceResource) AppealFinding(ctx context.Context, campaignID, runID, findingID string, input *CampaignAssuranceAppealInput, options *CampaignAssuranceMutationOptions) (*CampaignAssuranceEnvelope[CampaignAssuranceOverride], error) {
	return r.findingDecision(ctx, campaignID, runID, findingID, "appeals", input, options)
}

// OverrideFinding is the compatibility spelling for the same governed
// finding-decision contract.
func (r *CampaignAssuranceResource) OverrideFinding(ctx context.Context, campaignID, runID, findingID string, input *CampaignAssuranceAppealInput, options *CampaignAssuranceMutationOptions) (*CampaignAssuranceEnvelope[CampaignAssuranceOverride], error) {
	return r.findingDecision(ctx, campaignID, runID, findingID, "overrides", input, options)
}

// ApplyFinding applies only the server-stored deterministic typed patch. It
// creates a new immutable revision and makes the originating run stale; callers
// must run Campaign Assurance again for the returned revision.
func (r *CampaignAssuranceResource) ApplyFinding(ctx context.Context, campaignID, runID, findingID string, input *CampaignAssuranceApplyFindingInput, options *CampaignAssuranceApplyOptions) (*CampaignAssuranceEnvelope[CampaignAssuranceApplyFindingResult], error) {
	if options == nil || !validStrongCampaignETag(options.IfMatch) {
		return nil, fmt.Errorf("postwave: Campaign Assurance If-Match must be the exact strong campaign ETag returned by the API")
	}
	out := &CampaignAssuranceEnvelope[CampaignAssuranceApplyFindingResult]{}
	path := campaignAssuranceRunPath(campaignID, runID) + "/findings/" + url.PathEscape(findingID) + "/apply"
	err := r.client.requestWithHeadersAndIdempotencyKey(ctx, http.MethodPost, path, input, out,
		map[string]string{"If-Match": options.IfMatch}, options.IdempotencyKey)
	return out, err
}

func (r *CampaignAssuranceResource) findingDecision(ctx context.Context, campaignID, runID, findingID, route string, input *CampaignAssuranceAppealInput, options *CampaignAssuranceMutationOptions) (*CampaignAssuranceEnvelope[CampaignAssuranceOverride], error) {
	out := &CampaignAssuranceEnvelope[CampaignAssuranceOverride]{}
	path := campaignAssuranceRunPath(campaignID, runID) + "/findings/" + url.PathEscape(findingID) + "/" + route
	err := r.client.requestWithIdempotencyKey(ctx, http.MethodPost, path, input, out, assuranceIdempotencyKey(options))
	return out, err
}

func (r *CampaignAssuranceResource) CancelRun(ctx context.Context, campaignID, runID string, options *CampaignAssuranceMutationOptions) (*CampaignAssuranceEnvelope[CampaignAssuranceRun], error) {
	out := &CampaignAssuranceEnvelope[CampaignAssuranceRun]{}
	err := r.client.requestWithIdempotencyKey(ctx, http.MethodPost,
		campaignAssuranceRunPath(campaignID, runID)+"/cancel", nil, out,
		assuranceIdempotencyKey(options))
	return out, err
}

func campaignAssuranceRunPath(campaignID, runID string) string {
	return "/api/v1/campaigns/" + url.PathEscape(campaignID) + "/assurance-runs/" + url.PathEscape(runID)
}

func assuranceIdempotencyKey(options *CampaignAssuranceMutationOptions) string {
	if options == nil {
		return ""
	}
	return options.IdempotencyKey
}
