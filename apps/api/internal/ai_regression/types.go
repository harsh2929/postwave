// SPDX-License-Identifier: AGPL-3.0-only
//
// Package ai_regression is the apps/api surface of the AI-output regression
// harness (#1, "golden-set firewall"). It owns the four harness tables
// (ai_golden_examples / ai_regression_runs / ai_regression_results /
// ai_regression_settings, migrations 0402-0405) and exposes the per-tenant
// CRUD + run-trigger + settings API. The actual LLM replay + fidelity
// scoring runs in the voice service (POST /v1/voice/regression/replay-batch,
// internalauth-gated); this package triggers it and persists the results.
//
// types.go holds the wire shapes, the surface-kind enum + validation, and
// the PURE gate-computation function (gate.go-style logic kept here so it
// is trivially table-testable without a DB or HTTP).
package ai_regression

import (
	"math"
	"time"
)

// Surface kinds — the generative surfaces a golden example can come from.
// Mirrors the CHECK constraint in 0402_ai_golden_examples.sql and the
// voice service's ChatKind values.
const (
	SurfaceCampaignDraft   = "campaign_draft"
	SurfaceSubjectLine     = "subject_line"
	SurfaceSequenceDraft   = "sequence_draft"
	SurfaceCampaignSummary = "campaign_summary"
	SurfaceReplyIntent     = "reply_intent"
)

// validSurfaceKinds is the closed set accepted on capture. Kept in lockstep
// with the migration CHECK so a bad value is a clean 422 rather than a 500
// from the DB constraint.
var validSurfaceKinds = map[string]bool{
	SurfaceCampaignDraft:   true,
	SurfaceSubjectLine:     true,
	SurfaceSequenceDraft:   true,
	SurfaceCampaignSummary: true,
	SurfaceReplyIntent:     true,
}

// IsValidSurfaceKind reports whether kind is one of the accepted surfaces.
func IsValidSurfaceKind(kind string) bool { return validSurfaceKinds[kind] }

// Run statuses (mirror 0403 CHECK).
const (
	RunStatusPending   = "pending"
	RunStatusRunning   = "running"
	RunStatusCompleted = "completed"
	RunStatusFailed    = "failed"
)

// Durable worker bounds.  Failure text is deliberately a short, public-safe
// explanation; provider payloads and stack traces must stay in private logs.
const (
	MaxRunFailureCodeLen    = 64
	MaxRunFailureMessageLen = 1000
	DefaultRunMaxAttempts   = 3
)

// Gate results (mirror 0403 CHECK).
const (
	GatePass     = "pass"
	GateFail     = "fail"
	GateAdvisory = "advisory"
)

// Default thresholds, matching the voice service's DriftWarnThreshold (60)
// and the migration defaults.
const (
	DefaultWarnThreshold      = 60.0
	DefaultHardGateThreshold  = 70.0
	DefaultMinExamplesForGate = 5
	// Default server-attested replay identity. Voice rejects the request if
	// its configured runtime differs, so drift cannot be silently mislabeled.
	DefaultRuntimeProvider            = "google"
	DefaultRuntimeModelID             = "gemini-3-flash-preview"
	DefaultRuntimePromptPolicyVersion = "voice-regression-replay-v2"
)

// Field bounds (mirror the migration CHECK constraints) so validation
// errors surface as 422 with a precise message rather than a DB 500.
const (
	maxBriefLen  = 8000
	maxOutputLen = 32000
)

// CaptureGoldenInput — POST /api/v1/ai-regression/golden-examples. Also the
// shape the GoldenCapturer adapter assembles internally on approval.
type CaptureGoldenInput struct {
	SurfaceKind    string `json:"surface_kind"`
	Brief          string `json:"brief"`
	ApprovedOutput string `json:"approved_output"`
	RequestID      string `json:"request_id,omitempty"`
	// Provenance is internal-only. Automatic capture derives it from trusted
	// resource/approval context; the public JSON decoder rejects these keys.
	ModelID             string `json:"-"`
	ApprovalID          string `json:"-"`
	AgentRunID          string `json:"-"`
	VoiceProfileVersion string `json:"-"`
}

// GoldenExample — wire shape for a captured example (brief shown, full
// approved_output omitted from list views to keep payloads small).
type GoldenExample struct {
	ID          string    `json:"id"`
	SurfaceKind string    `json:"surface_kind"`
	Brief       string    `json:"brief"`
	ModelID     string    `json:"model_id"`
	RequestID   *string   `json:"request_id,omitempty"`
	ApprovalID  *string   `json:"approval_id,omitempty"`
	AgentRunID  *string   `json:"agent_run_id,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

// TriggerRunInput — POST /api/v1/ai-regression/runs.
type TriggerRunInput struct {
	ModelVersionTag  string `json:"model_version_tag"`
	PromptVersionTag string `json:"-"`
	ModelID          string `json:"-"`
	RuntimeProvider  string `json:"-"`
}

// SurfaceResult — per-surface aggregation within a run.
type SurfaceResult struct {
	Total      int      `json:"total"`
	Scored     int      `json:"scored"`
	Errors     int      `json:"errors"`
	Passed     int      `json:"passed"`
	MeanScore  *float64 `json:"mean_score"`
	GateResult string   `json:"gate_result"`
}

// RegressionRun — wire shape for a run row.
type RegressionRun struct {
	ID                 string                   `json:"id"`
	TenantID           string                   `json:"-"`
	RuntimeProvider    string                   `json:"runtime_provider"`
	ModelID            string                   `json:"model_id"`
	ModelVersionTag    string                   `json:"model_version_tag"`
	PromptVersionTag   string                   `json:"prompt_version_tag"`
	Status             string                   `json:"status"`
	TotalExamples      int                      `json:"total_examples"`
	PassedExamples     int                      `json:"passed_examples"`
	ScoredExamples     int                      `json:"scored_examples"`
	ErrorExamples      int                      `json:"error_examples"`
	FidelityScoreMean  *float64                 `json:"fidelity_score_mean,omitempty"`
	FidelityScoreP25   *float64                 `json:"fidelity_score_p25,omitempty"`
	GateResult         *string                  `json:"gate_result,omitempty"`
	WarnThreshold      float64                  `json:"warn_threshold"`
	HardGateEnabled    bool                     `json:"hard_gate_enabled"`
	HardGateThreshold  *float64                 `json:"hard_gate_threshold,omitempty"`
	MinExamplesForGate int                      `json:"min_examples_for_gate"`
	MaxAttempts        int                      `json:"max_attempts"`
	ErrorMessage       *string                  `json:"error_message,omitempty"`
	ErrorCode          *string                  `json:"error_code,omitempty"`
	BySurface          map[string]SurfaceResult `json:"by_surface,omitempty"`
	CreatedAt          time.Time                `json:"created_at"`
	StartedAt          *time.Time               `json:"started_at,omitempty"`
	CompletedAt        *time.Time               `json:"completed_at,omitempty"`
	SnapshotFrozenAt   *time.Time               `json:"snapshot_frozen_at,omitempty"`
	ClaimToken         *string                  `json:"-"`
	LeaseOwner         *string                  `json:"-"`
	LeaseExpiresAt     *time.Time               `json:"lease_expires_at,omitempty"`
	HeartbeatAt        *time.Time               `json:"heartbeat_at,omitempty"`
	AttemptCount       int                      `json:"attempt_count"`
	RetryNotBefore     *time.Time               `json:"retry_not_before,omitempty"`
	StaleAt            *time.Time               `json:"stale_at,omitempty"`
	UpdatedAt          time.Time                `json:"updated_at"`
}

// RunExampleSnapshot is the immutable replay input captured at run creation.
// It intentionally carries the approved output: workers need the full frozen
// comparison target even if the source golden example is later archived or
// deleted.
type RunExampleSnapshot struct {
	RunID               string    `json:"run_id"`
	ExampleID           string    `json:"example_id"`
	Ordinal             int       `json:"ordinal"`
	SurfaceKind         string    `json:"surface_kind"`
	Brief               string    `json:"brief"`
	ApprovedOutput      string    `json:"approved_output"`
	SourceModelID       string    `json:"source_model_id"`
	VoiceProfileVersion *string   `json:"voice_profile_version,omitempty"`
	ApprovalID          *string   `json:"approval_id,omitempty"`
	AgentRunID          *string   `json:"agent_run_id,omitempty"`
	SourceCreatedAt     time.Time `json:"source_created_at"`
	SnapshottedAt       time.Time `json:"snapshotted_at"`
}

// ClaimedRegressionRun is a fenced unit of work.  Attempt and ClaimToken must
// be echoed by every heartbeat/result/terminal write so a stale worker cannot
// mutate a newer attempt.
type ClaimedRegressionRun struct {
	Run      RegressionRun        `json:"run"`
	Examples []RunExampleSnapshot `json:"examples"`
	Settings RegressionSettings   `json:"settings"`
}

// RunFailure is safe to persist and return to operators.  Callers must log
// private provider detail separately and map it to a bounded public code/text.
type RunFailure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// UpsertRegressionResultInput is one immutable-snapshot scoring outcome.
// ExampleID is mandatory for new durable runs; nullable legacy result rows are
// readable but are never produced by this writer.
type UpsertRegressionResultInput struct {
	ExampleID      string         `json:"example_id"`
	ReplayedOutput *string        `json:"replayed_output,omitempty"`
	FidelityScore  *float64       `json:"fidelity_score,omitempty"`
	Breakdown      map[string]any `json:"breakdown,omitempty"`
	Severity       string         `json:"severity"`
	ErrorCode      *string        `json:"error_code,omitempty"`
	ErrorMessage   *string        `json:"error_message,omitempty"`
}

// RegressionResult — wire shape for a per-example result row.
type RegressionResult struct {
	ID                  string         `json:"id"`
	ExampleID           *string        `json:"example_id,omitempty"`
	AttemptCount        int            `json:"attempt_count"`
	SurfaceKind         string         `json:"surface_kind"`
	Brief               *string        `json:"brief,omitempty"`
	ApprovedOutput      *string        `json:"approved_output,omitempty"`
	SourceModelID       *string        `json:"source_model_id,omitempty"`
	VoiceProfileVersion *string        `json:"voice_profile_version,omitempty"`
	ApprovalID          *string        `json:"approval_id,omitempty"`
	AgentRunID          *string        `json:"agent_run_id,omitempty"`
	SourceCreatedAt     *time.Time     `json:"source_created_at,omitempty"`
	SnapshottedAt       *time.Time     `json:"snapshotted_at,omitempty"`
	SnapshotOrdinal     *int           `json:"snapshot_ordinal,omitempty"`
	ReplayedOutput      *string        `json:"replayed_output,omitempty"`
	FidelityScore       *float64       `json:"fidelity_score,omitempty"`
	Breakdown           map[string]any `json:"breakdown,omitempty"`
	Severity            string         `json:"severity"`
	ErrorCode           *string        `json:"error_code,omitempty"`
	ErrorMessage        *string        `json:"error_message,omitempty"`
	ScoredAt            time.Time      `json:"scored_at"`
}

// RegressionSettings — GET/PUT /api/v1/ai-regression/settings.
type RegressionSettings struct {
	WarnThreshold      float64 `json:"warn_threshold"`
	HardGateEnabled    bool    `json:"hard_gate_enabled"`
	HardGateThreshold  float64 `json:"hard_gate_threshold"`
	MinExamplesForGate int     `json:"min_examples_for_gate"`
}

// DefaultSettings is the honest fallback when a tenant has no settings row.
// Advisory-first: hard gate OFF, matching the VoiceDriftBanner posture.
func DefaultSettings() RegressionSettings {
	return RegressionSettings{
		WarnThreshold:      DefaultWarnThreshold,
		HardGateEnabled:    false,
		HardGateThreshold:  DefaultHardGateThreshold,
		MinExamplesForGate: DefaultMinExamplesForGate,
	}
}

// GateInput is the pure input to ComputeGate — the batch outcome plus the
// tenant's settings and the eligible example count.
type GateInput struct {
	// MeanScore is the tenant-wide mean fidelity over scored (non-error)
	// examples, 0..100.
	MeanScore float64
	// ScoredExamples is the number of examples that produced a score
	// (errors excluded). Gate eligibility is measured against this — a
	// tenant whose examples all failed to generate can't be gated.
	ScoredExamples int
	// TotalExamples is the immutable evidence denominator. When it is known
	// and exceeds ScoredExamples, at least one replay has no valid score; that
	// incomplete receipt can never be reported as pass or fail.
	TotalExamples int
	Settings      RegressionSettings
}

// ComputeGate is the PURE gate-decision function. It returns one of
// GatePass / GateAdvisory / GateFail per the senior-staff-approved D3
// resolution:
//
//   - With no scored examples, or with any unscored example in a known
//     immutable denominator, there is not complete evidence → advisory
//     (never a fabricated pass or score-based fail).
//   - A hard gate is ELIGIBLE only when hard_gate_enabled AND
//     ScoredExamples >= min_examples_for_gate (default 5). Below that the
//     result is advisory regardless of the observed mean (the UI shows a
//     low-sample ConfidenceNote).
//   - When the hard gate is in force:
//     mean < hard_gate_threshold  → fail
//     otherwise                   → pass
//   - When the hard gate is NOT in force (advisory mode):
//     mean < warn_threshold → advisory  (a soft, non-blocking warning)
//     otherwise             → pass
//
// Boundaries are inclusive at the top: mean exactly == a threshold passes.
func ComputeGate(in GateInput) string {
	if in.ScoredExamples <= 0 || in.TotalExamples < 0 ||
		(in.TotalExamples > 0 && in.ScoredExamples != in.TotalExamples) ||
		math.IsNaN(in.MeanScore) || math.IsInf(in.MeanScore, 0) ||
		in.MeanScore < 0 || in.MeanScore > 100 {
		return GateAdvisory
	}
	s := in.Settings
	if math.IsNaN(s.WarnThreshold) || math.IsInf(s.WarnThreshold, 0) ||
		s.WarnThreshold < 0 || s.WarnThreshold > 100 ||
		math.IsNaN(s.HardGateThreshold) || math.IsInf(s.HardGateThreshold, 0) ||
		s.HardGateThreshold < 0 || s.HardGateThreshold > 100 {
		return GateAdvisory
	}
	minN := s.MinExamplesForGate
	if minN < 1 {
		minN = DefaultMinExamplesForGate
	}
	if s.HardGateEnabled {
		if in.ScoredExamples < minN {
			return GateAdvisory
		}
		if in.MeanScore < s.HardGateThreshold {
			return GateFail
		}
		return GatePass
	}
	// Advisory policy mode (hard gate disabled).
	if in.MeanScore < s.WarnThreshold {
		return GateAdvisory
	}
	return GatePass
}
