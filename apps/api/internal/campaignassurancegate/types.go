// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignassurancegate turns immutable Campaign Assurance evidence
// into one fail-closed queue authorization. It does not execute analyzers and
// never treats a predicted result as an observed inbox-client result.
package campaignassurancegate

import (
	"context"
	"errors"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

const PolicyVersion = "postwave.campaign-assurance.queue-gate.v1"

// Status is the single exact-artifact Campaign Assurance vocabulary exposed
// to pre-send clients and consumed by the queue gate. It deliberately keeps
// lifecycle uncertainty separate from a known deterministic blocker.
type Status string

const (
	StatusOK          Status = "ok"
	StatusWarn        Status = "warn"
	StatusCritical    Status = "critical"
	StatusPending     Status = "pending"
	StatusStale       Status = "stale"
	StatusUnavailable Status = "unavailable"
	StatusError       Status = "error"
)

const (
	ReasonAuthorized          = "authorized"
	ReasonAuthorizedWarn      = "authorized_warn"
	ReasonAuthorizedOverride  = "authorized_override"
	ReasonNotAssured          = "not_assured"
	ReasonRunPending          = "run_pending"
	ReasonRunStale            = "run_stale"
	ReasonEvidenceUnavailable = "evidence_unavailable"
	ReasonDeterministicBlock  = "deterministic_block"
	ReasonIntegrityMismatch   = "integrity_mismatch"
	ReasonDependencyError     = "dependency_error"
)

var (
	ErrInvalidInput      = errors.New("campaign assurance gate: invalid input")
	ErrNotAssured        = errors.New("campaign assurance gate: no applicable run")
	ErrPending           = errors.New("campaign assurance gate: applicable run is pending")
	ErrStale             = errors.New("campaign assurance gate: applicable run is stale")
	ErrUnavailable       = errors.New("campaign assurance gate: required evidence is unavailable")
	ErrBlocked           = errors.New("campaign assurance gate: deterministic findings block sending")
	ErrIntegrityMismatch = errors.New("campaign assurance gate: evidence integrity mismatch")
)

type Store interface {
	ListRuns(context.Context, string, string, int) ([]campaignassurance.Run, error)
	GetRunManifest(context.Context, string, string) (*campaignassurance.ClaimedRun, error)
	ListFindings(context.Context, string, string) ([]campaignassurance.Finding, error)
	ListOverrides(context.Context, string, string) ([]campaignassurance.Override, error)
}

type Request struct {
	TenantID          string
	CampaignID        string
	ContentRevisionID string
	SourceHash        string
}

// SourceCoverage reports bounded aggregate coverage without pretending that
// modeled or controlled evidence is deterministic truth. Required and
// Successful refer to frozen artifact/configuration cells, not recipients.
type SourceCoverage struct {
	Required                     int     `json:"required"`
	Successful                   int     `json:"successful"`
	Ratio                        float64 `json:"ratio"`
	DeterministicConfigs         int     `json:"deterministic_configurations"`
	ModeledConfigs               int     `json:"modeled_configurations"`
	ControlledObservationConfigs int     `json:"controlled_observation_configurations"`
}

// Evaluation is the authoritative cached pre-send projection for one exact
// immutable revision/hash. It contains no message body, model output, tenant
// label, or unbounded reason text. Authorized means the exact same evaluation
// can produce a queue receipt; Critical may still be Authorized when every
// blocking finding has a current finding-scoped admin/owner override.
type Evaluation struct {
	PolicyVersion         string         `json:"policy_version"`
	TenantID              string         `json:"-"`
	CampaignID            string         `json:"campaign_id"`
	RunID                 string         `json:"run_id,omitempty"`
	ContentRevisionID     string         `json:"content_revision_id"`
	SendPlanID            string         `json:"send_plan_id,omitempty"`
	SourceHash            string         `json:"source_hash"`
	PlanHash              string         `json:"plan_hash,omitempty"`
	ArtifactSetHash       string         `json:"artifact_set_hash,omitempty"`
	CoverageManifestHash  string         `json:"coverage_manifest_hash,omitempty"`
	Status                Status         `json:"status"`
	ReasonCode            string         `json:"reason_code"`
	GateDecision          string         `json:"gate_decision,omitempty"`
	Authorized            bool           `json:"authorized"`
	RunAttempt            int            `json:"run_attempt,omitempty"`
	DeterministicBlockers int            `json:"deterministic_blocker_count"`
	PredictedScore        *float64       `json:"predicted_score,omitempty"`
	PredictedScoreMin     *float64       `json:"predicted_score_min,omitempty"`
	PredictedScoreMax     *float64       `json:"predicted_score_max,omitempty"`
	SourceCoverage        SourceCoverage `json:"source_coverage"`
	OverrideIDs           []string       `json:"override_ids,omitempty"`
	RefreshedAt           time.Time      `json:"refreshed_at"`
	receipt               *Receipt
}

// Receipt is safe to attach to a queue/audit record. It contains immutable
// identities and aggregate authorization facts, never MIME bodies or model
// output.
type Receipt struct {
	PolicyVersion     string    `json:"policy_version"`
	TenantID          string    `json:"-"`
	CampaignID        string    `json:"campaign_id"`
	RunID             string    `json:"run_id"`
	ContentRevisionID string    `json:"content_revision_id"`
	SendPlanID        string    `json:"send_plan_id"`
	SourceHash        string    `json:"source_hash"`
	PlanHash          string    `json:"plan_hash"`
	ArtifactSetHash   string    `json:"artifact_set_hash"`
	RunAttempt        int       `json:"run_attempt"`
	Decision          string    `json:"decision"`
	OverrideIDs       []string  `json:"override_ids,omitempty"`
	AuthorizedAt      time.Time `json:"authorized_at"`
	// Rollout/evaluation fields let the queue response distinguish shadow from
	// warning without treating an advisory observation as a durable send
	// authorization. Advisory receipts deliberately have no RunID and are never
	// copied onto recipient rows.
	RolloutMode          RolloutMode `json:"rollout_mode,omitempty"`
	EvaluationStatus     Status      `json:"evaluation_status,omitempty"`
	EvaluationReasonCode string      `json:"evaluation_reason_code,omitempty"`
}

type Gate struct {
	Store Store
	Now   func() time.Time
}

// Evaluator is the client-safe, exact-hash read contract used by the unified
// five-second pre-send path. Implementations must consume cached evidence and
// must not execute analyzers inline.
type Evaluator interface {
	Evaluate(context.Context, Request) (Evaluation, error)
}

// Authorizer is the strict queue-time authorization contract.
type Authorizer interface {
	Authorize(context.Context, Request) (Receipt, error)
}

// BoundAuthorizer is the strict provider-boundary revalidation contract. A
// bound row is never affected by a later rollout-mode downgrade: once a row
// carries a receipt, revocation/staleness must still fail closed.
type BoundAuthorizer interface {
	ReauthorizeBound(context.Context, Request) (Receipt, error)
}
