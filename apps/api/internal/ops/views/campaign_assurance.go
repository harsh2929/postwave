package views

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const maxCampaignAssuranceCursorBytes = 256

var ErrInvalidCampaignAssuranceQuery = errors.New("invalid Campaign Assurance ops query")

// CampaignAssuranceRunFilter is the bounded, keyset-paginated fleet query.
// Empty TenantID and State values mean all tenants/states.
type CampaignAssuranceRunFilter struct {
	TenantID string
	State    string
	Cursor   string
	Limit    int
}

// CampaignAssuranceRunRow intentionally contains operational metadata only.
// The SQL function behind it has an equally narrow RETURNS TABLE contract.
type CampaignAssuranceRunRow struct {
	TenantID                         string     `json:"tenant_id"`
	CampaignID                       string     `json:"campaign_id"`
	RunID                            string     `json:"run_id"`
	RunNo                            int64      `json:"run_no"`
	TriggerKind                      string     `json:"trigger_kind"`
	Profile                          string     `json:"profile"`
	State                            string     `json:"state"`
	GateDecision                     string     `json:"gate_decision"`
	AttemptCount                     int        `json:"attempt_count"`
	MaxAttempts                      int        `json:"max_attempts"`
	RetryNotBefore                   *time.Time `json:"retry_not_before,omitempty"`
	ErrorCode                        *string    `json:"error_code,omitempty"`
	RequiredExtractionCount          int        `json:"required_extraction_count"`
	TerminalExtractionCount          int        `json:"terminal_extraction_count"`
	ExtractionErrorCount             int        `json:"extraction_error_count"`
	BlockingFindingCount             int        `json:"blocking_finding_count"`
	DeterministicTargetCount         int64      `json:"deterministic_target_count"`
	ModeledTargetCount               int64      `json:"modeled_target_count"`
	ControlledObservationTargetCount int64      `json:"controlled_observation_target_count"`
	InputTokens                      int64      `json:"input_tokens"`
	OutputTokens                     int64      `json:"output_tokens"`
	CostMicrounits                   int64      `json:"cost_microunits"`
	MaxModeledCostMicrounits         int64      `json:"max_modeled_cost_microunits"`
	InvokedExtractionCount           int64      `json:"invoked_extraction_count"`
	CacheReuseCount                  int64      `json:"cache_reuse_count"`
	LiveRawEvidenceCount             int64      `json:"live_raw_evidence_count"`
	ExpiredRawEvidenceCount          int64      `json:"expired_raw_evidence_count"`
	NextRawEvidenceExpiry            *time.Time `json:"next_raw_evidence_expiry,omitempty"`
	SeedObservationCount             int64      `json:"seed_observation_count"`
	LatestSeedObservationAt          *time.Time `json:"latest_seed_observation_at,omitempty"`
	NextSeedObservationExpiry        *time.Time `json:"next_seed_observation_expiry,omitempty"`
	CommandDeliveryAttemptCount      int        `json:"command_delivery_attempt_count"`
	CommandAvailableAt               *time.Time `json:"command_available_at,omitempty"`
	CommandLeaseExpiresAt            *time.Time `json:"command_lease_expires_at,omitempty"`
	LeaseExpiresAt                   *time.Time `json:"lease_expires_at,omitempty"`
	HeartbeatAt                      *time.Time `json:"heartbeat_at,omitempty"`
	SnapshotFrozenAt                 *time.Time `json:"snapshot_frozen_at,omitempty"`
	CreatedAt                        time.Time  `json:"created_at"`
	UpdatedAt                        time.Time  `json:"updated_at"`
	CompletedAt                      *time.Time `json:"completed_at,omitempty"`
}

type CampaignAssuranceRunPage struct {
	Runs       []CampaignAssuranceRunRow `json:"runs"`
	NextCursor string                    `json:"next_cursor,omitempty"`
}

// CampaignAssuranceRunDetail adds immutable version/hash lineage and aggregate
// diagnostics. It still has no content-bearing or provider-payload field.
type CampaignAssuranceRunDetail struct {
	CampaignAssuranceRunRow
	ContentRevisionID                string     `json:"content_revision_id"`
	SendPlanID                       string     `json:"send_plan_id"`
	SourceHash                       string     `json:"source_hash"`
	PlanHash                         string     `json:"plan_hash"`
	ArtifactSetHash                  *string    `json:"artifact_set_hash,omitempty"`
	CoverageManifestHash             string     `json:"coverage_manifest_hash"`
	ConfigurationManifestHash        *string    `json:"configuration_manifest_hash,omitempty"`
	TargetManifestHash               *string    `json:"target_manifest_hash,omitempty"`
	RendererVersion                  string     `json:"renderer_version"`
	CompilerVersion                  string     `json:"compiler_version"`
	FixtureSetVersion                string     `json:"fixture_set_version"`
	PlanPolicyVersion                string     `json:"plan_policy_version"`
	AnalyzerSuiteVersion             string     `json:"analyzer_suite_version"`
	ModelSuiteVersion                string     `json:"model_suite_version"`
	PromptSuiteVersion               string     `json:"prompt_suite_version"`
	PromptSuiteHash                  string     `json:"prompt_suite_hash"`
	NormalizationVersion             string     `json:"normalization_version"`
	ScoringVersion                   string     `json:"scoring_version"`
	GatePolicyVersion                string     `json:"gate_policy_version"`
	MethodologyVersion               string     `json:"methodology_version"`
	RequiredScenarioCount            int        `json:"required_scenario_count"`
	RequiredConfigurationCount       int        `json:"required_configuration_count"`
	SuccessfulExtractionCount        int        `json:"successful_extraction_count"`
	FindingCount                     int        `json:"finding_count"`
	ReusedOriginalCostMicrounits     int64      `json:"reused_original_cost_microunits"`
	ModelReservationCount            int64      `json:"model_reservation_count"`
	ReservedCostMicrounits           int64      `json:"reserved_cost_microunits"`
	SettledModelInvocationCount      int64      `json:"settled_model_invocation_count"`
	ChargeUnknownCount               int64      `json:"charge_unknown_count"`
	RawEvidenceCount                 int64      `json:"raw_evidence_count"`
	LatestRawEvidenceExpiry          *time.Time `json:"latest_raw_evidence_expiry,omitempty"`
	ControlledClientObservationCount int64      `json:"controlled_client_observation_count"`
	ObservedSurfaceCount             int64      `json:"observed_surface_count"`
	UnhealthyObservationCount        int64      `json:"unhealthy_observation_count"`
	ExpiredSeedObservationCount      int64      `json:"expired_seed_observation_count"`
	CommandLastDeliveredAt           *time.Time `json:"command_last_delivered_at,omitempty"`
	CommandCompletedAt               *time.Time `json:"command_completed_at,omitempty"`
	StartedAt                        *time.Time `json:"started_at,omitempty"`
	CancelledAt                      *time.Time `json:"cancelled_at,omitempty"`
	StaleAt                          *time.Time `json:"stale_at,omitempty"`
}

type CampaignAssuranceTimelineEvent struct {
	TenantID        string    `json:"tenant_id"`
	CampaignID      string    `json:"campaign_id"`
	RunID           string    `json:"run_id"`
	EventNo         int64     `json:"event_no"`
	EventID         string    `json:"event_id"`
	AttemptCount    int       `json:"attempt_count"`
	EventType       string    `json:"event_type"`
	Stage           string    `json:"stage"`
	Status          string    `json:"status"`
	EntityID        *string   `json:"entity_id,omitempty"`
	ArtifactID      *string   `json:"artifact_id,omitempty"`
	ConfigurationID *string   `json:"configuration_id,omitempty"`
	ReceiptHash     *string   `json:"receipt_hash,omitempty"`
	OccurredAt      time.Time `json:"occurred_at"`
}

type CampaignAssuranceTimelinePage struct {
	TenantID  string                           `json:"tenant_id"`
	RunID     string                           `json:"run_id"`
	Events    []CampaignAssuranceTimelineEvent `json:"events"`
	NextAfter int64                            `json:"next_after,omitempty"`
}

type campaignAssuranceRunCursor struct {
	CreatedAt time.Time
	RunID     string
}

func validCampaignAssuranceState(state string) bool {
	switch state {
	case "", "queued", "running", "complete", "incomplete", "failed", "cancelled", "stale":
		return true
	default:
		return false
	}
}

func encodeCampaignAssuranceCursor(createdAt time.Time, runID string) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + runID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCampaignAssuranceCursor(encoded string) (campaignAssuranceRunCursor, bool) {
	if encoded == "" || len(encoded) > maxCampaignAssuranceCursorBytes {
		return campaignAssuranceRunCursor{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) > maxCampaignAssuranceCursorBytes {
		return campaignAssuranceRunCursor{}, false
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) != 2 {
		return campaignAssuranceRunCursor{}, false
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return campaignAssuranceRunCursor{}, false
	}
	runID, ok := canonicalUUID(parts[1])
	if !ok {
		return campaignAssuranceRunCursor{}, false
	}
	canonical := encodeCampaignAssuranceCursor(createdAt, runID)
	if canonical != encoded {
		return campaignAssuranceRunCursor{}, false
	}
	return campaignAssuranceRunCursor{CreatedAt: createdAt.UTC(), RunID: runID}, true
}

func campaignAssuranceSummaryScanDest(row *CampaignAssuranceRunRow) []any {
	return []any{
		&row.TenantID, &row.CampaignID, &row.RunID, &row.RunNo,
		&row.TriggerKind, &row.Profile, &row.State, &row.GateDecision,
		&row.AttemptCount, &row.MaxAttempts, &row.RetryNotBefore, &row.ErrorCode,
		&row.RequiredExtractionCount, &row.TerminalExtractionCount,
		&row.ExtractionErrorCount, &row.BlockingFindingCount,
		&row.DeterministicTargetCount, &row.ModeledTargetCount,
		&row.ControlledObservationTargetCount,
		&row.InputTokens, &row.OutputTokens, &row.CostMicrounits,
		&row.MaxModeledCostMicrounits, &row.InvokedExtractionCount,
		&row.CacheReuseCount, &row.LiveRawEvidenceCount,
		&row.ExpiredRawEvidenceCount, &row.NextRawEvidenceExpiry,
		&row.SeedObservationCount, &row.LatestSeedObservationAt,
		&row.NextSeedObservationExpiry, &row.CommandDeliveryAttemptCount,
		&row.CommandAvailableAt, &row.CommandLeaseExpiresAt,
		&row.LeaseExpiresAt, &row.HeartbeatAt, &row.SnapshotFrozenAt,
		&row.CreatedAt, &row.UpdatedAt, &row.CompletedAt,
	}
}

// ListCampaignAssuranceRuns reads through the reviewed SECURITY DEFINER
// function. postwave_ops has no direct SELECT on any source table.
func (r *Reader) ListCampaignAssuranceRuns(
	ctx context.Context,
	filter CampaignAssuranceRunFilter,
) (CampaignAssuranceRunPage, error) {
	filter.TenantID = strings.TrimSpace(filter.TenantID)
	filter.State = strings.TrimSpace(filter.State)
	if filter.Limit < 1 || filter.Limit > maxViewRows ||
		!validCampaignAssuranceState(filter.State) {
		return CampaignAssuranceRunPage{}, ErrInvalidCampaignAssuranceQuery
	}
	var tenantID any
	if filter.TenantID != "" {
		canonical, ok := canonicalUUID(filter.TenantID)
		if !ok {
			return CampaignAssuranceRunPage{}, ErrInvalidCampaignAssuranceQuery
		}
		tenantID = canonical
	}
	var state any
	if filter.State != "" {
		state = filter.State
	}
	var beforeAt, beforeRunID any
	if filter.Cursor != "" {
		cursor, ok := decodeCampaignAssuranceCursor(filter.Cursor)
		if !ok {
			return CampaignAssuranceRunPage{}, ErrInvalidCampaignAssuranceQuery
		}
		beforeAt, beforeRunID = cursor.CreatedAt, cursor.RunID
	}

	rows, err := r.Pool.Query(ctx, `
SELECT *
  FROM ops_campaign_assurance_runs(
      $1::uuid, $2::text, $3::timestamptz, $4::uuid, $5::integer
  )`, tenantID, state, beforeAt, beforeRunID, filter.Limit)
	if err != nil {
		return CampaignAssuranceRunPage{}, err
	}
	defer rows.Close()
	page := CampaignAssuranceRunPage{Runs: []CampaignAssuranceRunRow{}}
	for rows.Next() {
		var row CampaignAssuranceRunRow
		if err := rows.Scan(campaignAssuranceSummaryScanDest(&row)...); err != nil {
			return CampaignAssuranceRunPage{}, err
		}
		page.Runs = append(page.Runs, row)
	}
	if err := rows.Err(); err != nil {
		return CampaignAssuranceRunPage{}, err
	}
	if len(page.Runs) > filter.Limit {
		page.Runs = page.Runs[:filter.Limit]
		last := page.Runs[len(page.Runs)-1]
		page.NextCursor = encodeCampaignAssuranceCursor(last.CreatedAt, last.RunID)
	}
	return page, nil
}

func campaignAssuranceDetailScanDest(detail *CampaignAssuranceRunDetail) []any {
	dest := campaignAssuranceSummaryScanDest(&detail.CampaignAssuranceRunRow)
	return append(dest,
		&detail.ContentRevisionID, &detail.SendPlanID,
		&detail.SourceHash, &detail.PlanHash, &detail.ArtifactSetHash,
		&detail.CoverageManifestHash, &detail.ConfigurationManifestHash,
		&detail.TargetManifestHash, &detail.RendererVersion,
		&detail.CompilerVersion, &detail.FixtureSetVersion,
		&detail.PlanPolicyVersion, &detail.AnalyzerSuiteVersion,
		&detail.ModelSuiteVersion, &detail.PromptSuiteVersion,
		&detail.PromptSuiteHash, &detail.NormalizationVersion,
		&detail.ScoringVersion, &detail.GatePolicyVersion,
		&detail.MethodologyVersion, &detail.RequiredScenarioCount,
		&detail.RequiredConfigurationCount, &detail.SuccessfulExtractionCount,
		&detail.FindingCount, &detail.ReusedOriginalCostMicrounits,
		&detail.ModelReservationCount, &detail.ReservedCostMicrounits,
		&detail.SettledModelInvocationCount, &detail.ChargeUnknownCount,
		&detail.RawEvidenceCount, &detail.LatestRawEvidenceExpiry,
		&detail.ControlledClientObservationCount, &detail.ObservedSurfaceCount,
		&detail.UnhealthyObservationCount, &detail.ExpiredSeedObservationCount,
		&detail.CommandLastDeliveredAt, &detail.CommandCompletedAt,
		&detail.StartedAt, &detail.CancelledAt, &detail.StaleAt,
	)
}

// CampaignAssuranceRunDetailByID returns nil when the run does not exist.
func (r *Reader) CampaignAssuranceRunDetailByID(
	ctx context.Context,
	runID string,
) (*CampaignAssuranceRunDetail, error) {
	runID, ok := canonicalUUID(runID)
	if !ok {
		return nil, ErrInvalidCampaignAssuranceQuery
	}
	var detail CampaignAssuranceRunDetail
	err := r.Pool.QueryRow(ctx, `
SELECT * FROM ops_campaign_assurance_run_detail($1::uuid)`, runID).
		Scan(campaignAssuranceDetailScanDest(&detail)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &detail, nil
}

// CampaignAssuranceRunTimeline returns nil when the run does not exist. It
// verifies the run and reads the event page in one repeatable-read snapshot.
func (r *Reader) CampaignAssuranceRunTimeline(
	ctx context.Context,
	runID string,
	afterEventNo int64,
	limit int,
) (*CampaignAssuranceTimelinePage, error) {
	runID, ok := canonicalUUID(runID)
	if !ok || afterEventNo < 0 || limit < 1 || limit > maxViewRows {
		return nil, ErrInvalidCampaignAssuranceQuery
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var tenantID string
	if err := tx.QueryRow(ctx, `
SELECT tenant_id
  FROM ops_campaign_assurance_run_detail($1::uuid)`, runID).Scan(&tenantID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT *
  FROM ops_campaign_assurance_run_timeline($1::uuid, $2::bigint, $3::integer)`,
		runID, afterEventNo, limit)
	if err != nil {
		return nil, err
	}
	page := &CampaignAssuranceTimelinePage{
		TenantID: tenantID,
		RunID:    runID,
		Events:   []CampaignAssuranceTimelineEvent{},
	}
	for rows.Next() {
		var event CampaignAssuranceTimelineEvent
		if err := rows.Scan(
			&event.TenantID, &event.CampaignID, &event.RunID,
			&event.EventNo, &event.EventID, &event.AttemptCount,
			&event.EventType, &event.Stage, &event.Status,
			&event.EntityID, &event.ArtifactID, &event.ConfigurationID,
			&event.ReceiptHash, &event.OccurredAt,
		); err != nil {
			rows.Close()
			return nil, err
		}
		page.Events = append(page.Events, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(page.Events) > limit {
		page.Events = page.Events[:limit]
		page.NextAfter = page.Events[len(page.Events)-1].EventNo
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return page, nil
}
