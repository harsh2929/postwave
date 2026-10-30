// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignartifact owns immutable campaign source revisions, frozen
// send plans, and content-addressed synthetic render artifacts. The mutable
// campaigns row is an editor draft; assurance and dispatch must bind to these
// records instead of re-reading mutable content.
package campaignartifact

import (
	"encoding/json"
	"errors"
	"time"
)

const (
	SourceModeSemantic   = "semantic"
	SourceModeLegacyHTML = "legacy_html"

	PlanPreparing  = "preparing"
	PlanReady      = "ready"
	PlanCertified  = "certified"
	PlanStale      = "stale"
	PlanSuperseded = "superseded"
	PlanFailed     = "failed"
)

var (
	ErrNotFound            = errors.New("campaign artifact: not found")
	ErrInvalidInput        = errors.New("campaign artifact: invalid input")
	ErrSourceIncomplete    = errors.New("campaign artifact: source is incomplete")
	ErrIdempotencyConflict = errors.New("campaign artifact: idempotency key was reused with different input")
	ErrInvalidTransition   = errors.New("campaign artifact: invalid send-plan transition")
	ErrPlanNotPreparing    = errors.New("campaign artifact: send plan is not preparing")
	ErrPatchUnavailable    = errors.New("campaign artifact: finding has no applicable typed patch")
	ErrPatchUnsupported    = errors.New("campaign artifact: typed patch operation is unsupported")
	ErrPatchAlreadyApplied = errors.New("campaign artifact: finding patch was already applied")
	ErrPatchNoop           = errors.New("campaign artifact: typed patch does not change the source revision")
	ErrRevisionStale       = errors.New("campaign artifact: mutable draft no longer matches the finding revision")
	ErrPreconditionFailed  = errors.New("campaign artifact: campaign If-Match precondition failed")
	ErrCampaignLocked      = errors.New("campaign artifact: campaign has an active edit lease")
	ErrCampaignDispatched  = errors.New("campaign artifact: campaign content is frozen after dispatch")
	ErrRunNotActionable    = errors.New("campaign artifact: assurance run is not actionable")
	ErrUnauthorized        = errors.New("campaign artifact: actor cannot edit this campaign")
	ErrConcurrentMutation  = errors.New("campaign artifact: concurrent mutation")
)

// Revision is the immutable source oracle shared by preview, assurance, seed,
// and live compilation. JSON members are already canonicalized when returned.
type Revision struct {
	ID                   string          `json:"id"`
	TenantID             string          `json:"-"`
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
	// TrackingSettings is part of the immutable message source because the
	// canonical compiler rewrites links from it. A change here must therefore
	// produce a new source hash and can never reuse an older assurance receipt.
	TrackingSettings json.RawMessage `json:"tracking_settings"`
	SourceHash       string          `json:"source_hash"`
	CreatedBy        *string         `json:"created_by,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
}

// RevisionSummary is the bounded list projection. Revision bodies can be
// several megabytes, so collection endpoints never repeat semantic trees,
// legacy HTML, variants, or contracts for every historical save.
type RevisionSummary struct {
	ID                   string    `json:"id"`
	CampaignID           string    `json:"campaign_id"`
	RevisionNo           int64     `json:"revision_no"`
	SourceMode           string    `json:"source_mode"`
	ContentSchemaVersion int       `json:"content_schema_version"`
	Subject              string    `json:"subject"`
	SourceHash           string    `json:"source_hash"`
	CreatedBy            *string   `json:"created_by,omitempty"`
	CreatedAt            time.Time `json:"created_at"`
}

// PlanInput freezes every implementation identity and scenario manifest that
// can alter an artifact. RequestID is mandatory and tenant/campaign-scoped.
type PlanInput struct {
	CampaignID        string          `json:"campaign_id"`
	ContentRevisionID string          `json:"content_revision_id"`
	RequestID         string          `json:"request_id"`
	RendererVersion   string          `json:"renderer_version"`
	CompilerVersion   string          `json:"compiler_version"`
	TransformManifest json.RawMessage `json:"transform_manifest"`
	CoverageManifest  json.RawMessage `json:"coverage_manifest"`
	FixtureSetVersion string          `json:"fixture_set_version"`
	PolicyVersion     string          `json:"policy_version"`
	CreatedBy         string          `json:"-"`
}

// Plan is a frozen compilation unit. Input identity becomes immutable as soon
// as State leaves preparing.
type Plan struct {
	ID                string          `json:"id"`
	TenantID          string          `json:"-"`
	CampaignID        string          `json:"campaign_id"`
	ContentRevisionID string          `json:"content_revision_id"`
	PlanNo            int64           `json:"plan_no"`
	RequestID         *string         `json:"request_id,omitempty"`
	RequestHash       string          `json:"request_hash"`
	RendererVersion   string          `json:"renderer_version"`
	CompilerVersion   string          `json:"compiler_version"`
	TransformManifest json.RawMessage `json:"transform_manifest"`
	CoverageManifest  json.RawMessage `json:"coverage_manifest"`
	FixtureSetVersion string          `json:"fixture_set_version"`
	PolicyVersion     string          `json:"policy_version"`
	PlanHash          *string         `json:"plan_hash,omitempty"`
	State             string          `json:"state"`
	FailureCode       *string         `json:"failure_code,omitempty"`
	CreatedBy         *string         `json:"created_by,omitempty"`
	CreatedAt         time.Time       `json:"created_at"`
	ReadyAt           *time.Time      `json:"ready_at,omitempty"`
	CertifiedAt       *time.Time      `json:"certified_at,omitempty"`
	StaleAt           *time.Time      `json:"stale_at,omitempty"`
	SupersededAt      *time.Time      `json:"superseded_at,omitempty"`
	FailedAt          *time.Time      `json:"failed_at,omitempty"`
}

// ArtifactInput contains identities and encrypted object references only. It
// deliberately has no recipient address or real-recipient body field.
type ArtifactInput struct {
	ScenarioID             string          `json:"scenario_id"`
	VariantID              string          `json:"variant_id,omitempty"`
	Locale                 string          `json:"locale"`
	BranchKey              string          `json:"branch_key"`
	FixtureID              string          `json:"fixture_id"`
	SourceHash             string          `json:"source_hash"`
	HTMLHash               string          `json:"html_hash"`
	TextHash               string          `json:"text_hash"`
	StructuredDataHash     string          `json:"structured_data_hash,omitempty"`
	MIMEStructureHash      string          `json:"mime_structure_hash"`
	OutboundMIMEHash       string          `json:"outbound_mime_hash"`
	HTMLObjectRef          string          `json:"html_object_ref,omitempty"`
	TextObjectRef          string          `json:"text_object_ref,omitempty"`
	MIMEObjectRef          string          `json:"mime_object_ref,omitempty"`
	CompilerReceipt        json.RawMessage `json:"compiler_receipt"`
	RepresentationManifest json.RawMessage `json:"representation_manifest"`
	ExpiresAt              *time.Time      `json:"expires_at,omitempty"`
}

type Artifact struct {
	ID         string `json:"id"`
	TenantID   string `json:"-"`
	SendPlanID string `json:"send_plan_id"`
	ArtifactInput
	CreatedAt time.Time `json:"created_at"`
}

// ApplyAssuranceFindingInput identifies one immutable finding and the exact
// mutable draft version the caller reviewed. RequestID is a durable replay key;
// IfMatchToken must be the strong campaign ETag returned by the latest read.
type ApplyAssuranceFindingInput struct {
	CampaignID   string `json:"campaign_id"`
	RunID        string `json:"run_id"`
	FindingID    string `json:"finding_id"`
	RequestID    string `json:"request_id"`
	ActorID      string `json:"-"`
	IfMatchToken string `json:"-"`
}

// PatchApplication is an append-only audit receipt. The original run,
// finding, and base revision remain immutable and the run is made stale.
type PatchApplication struct {
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

// ApplyAssuranceFindingResult returns both immutable records plus the new
// mutable campaign ETag. The caller must run assurance again for Revision.
type ApplyAssuranceFindingResult struct {
	Application         PatchApplication `json:"application"`
	Revision            Revision         `json:"revision"`
	CampaignETag        string           `json:"campaign_etag"`
	OriginatingRunState string           `json:"originating_run_state"`
	RerunRequired       bool             `json:"rerun_required"`
}
