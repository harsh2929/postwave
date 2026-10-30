// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	LiftResultVersion      = "postwave.holdout-lift-result.v1"
	LiftMethodologyVersion = "postwave.holdout-lift-methodology.v1"

	liftConversionSetVersion = "postwave.holdout-conversion-set.v1"
	liftEvidenceVersion      = "postwave.holdout-lift-evidence.v1"

	// This statement is persisted with every result. It names both the
	// intent-to-treat population and the identity boundary so a later reader
	// cannot mistake the result for campaign-attributed conversion reporting.
	LiftMethodologyStatement = "Intent-to-treat two-proportion z-test over the immutable campaign_holdout_assignments population. A recipient converts once when a conversion matching the frozen metric occurs in the half-open configured window [window_start, window_end) and resolves through its winning identity touch or the tenant subscriber identity indexes; campaign attribution is neither required nor consulted. Rates use the complete assigned populations. The result uses a two-sided 95% unpooled confidence interval and an 80%-power minimum detectable effect. Lift, interval, and incremental-conversion fields are suppressed unless the observed difference is significant or the sample can detect the frozen minimum relative effect."
)

var (
	ErrLiftResultInput       = errors.New("holdout: invalid lift result input")
	ErrLiftResultUnavailable = errors.New("holdout: frozen lift contract unavailable")
	ErrLiftWindowOpen        = errors.New("holdout: conversion window is not closed")
	ErrLiftResultIntegrity   = errors.New("holdout: lift result evidence failed integrity validation")
)

// LiftResult is the complete immutable F02 result. Underpowered rows retain
// populations, conversion counts, rates, p-value and MDE, but deliberately
// carry nil estimate/interval fields so no generic JSON or export caller can
// accidentally turn absence of power into a numeric lift claim.
type LiftResult struct {
	ID                      string
	TenantID                string
	CampaignID              string
	ResultVersion           string
	MethodologyVersion      string
	Metric                  string
	WindowStart             time.Time
	WindowEnd               time.Time
	NTreatment              int64
	NControl                int64
	ConversionsTreatment    int64
	ConversionsControl      int64
	RateTreatment           float64
	RateControl             float64
	Status                  string
	AbsoluteLift            *float64
	RelativeLift            *float64
	IncrementalConversions  *float64
	PValue                  float64
	CILow                   *float64
	CIHigh                  *float64
	MinimumDetectableEffect float64
	MinimumRelativeEffect   float64
	UnderpoweredReason      string
	AssignmentSetSHA256     string
	ConversionSetSHA256     string
	EvidenceSHA256          string
	MethodologyStatement    string
	GeneratedAt             time.Time
}

func (r *LiftResult) Powered() bool {
	return r != nil && r.Status == "powered"
}

// PoweredLiftQuery is the narrow reader contract used by evidence/report
// adapters. The finalized holdout window must be wholly contained by the
// caller's already-authenticated fixed report window.
type PoweredLiftQuery struct {
	TenantID   string
	CampaignID string
	Since      time.Time
	Until      time.Time
}

// LiftResultStore owns finalization and immutable reads. Now is injectable for
// deterministic generated_at evidence; PostgreSQL independently enforces that
// the configured window is closed against its own clock.
type LiftResultStore struct {
	pool *db.Pool
	now  func() time.Time
}

func NewLiftResultStore(pool *db.Pool) *LiftResultStore {
	return &LiftResultStore{pool: pool, now: time.Now}
}

func (s *LiftResultStore) nowUTC() time.Time {
	if s != nil && s.now != nil {
		return normalizeLiftTime(s.now())
	}
	return normalizeLiftTime(time.Now())
}

type frozenLiftContract struct {
	metric                string
	windowStart           time.Time
	windowEnd             time.Time
	minimumRelativeEffect float64
	assignmentSetSHA256   string
	assignmentVersion     string
	heldOutCount          int64
	sentCount             int64
}

// CloseConfiguredWindow finalizes exactly the metric and conversion window
// frozen with the assignment set. It has no caller-supplied date or outcome
// override. Replays return the original immutable row before re-reading mutable
// conversion inputs, so late ingestion cannot silently rewrite a published
// result identity.
func (s *LiftResultStore) CloseConfiguredWindow(
	ctx context.Context,
	tenantID, campaignID string,
) (*LiftResult, error) {
	tenantID = strings.TrimSpace(tenantID)
	campaignID = strings.TrimSpace(campaignID)
	if s == nil || s.pool == nil || tenantID == "" || campaignID == "" {
		return nil, ErrLiftResultInput
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return nil, fmt.Errorf("%w: tenant id must be a UUID", ErrLiftResultInput)
	}
	if _, err := uuid.Parse(campaignID); err != nil {
		return nil, fmt.Errorf("%w: campaign id must be a UUID", ErrLiftResultInput)
	}

	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	contract, err := loadFrozenLiftContract(ctx, tx, tenantID, campaignID)
	if err != nil {
		return nil, err
	}

	existing, err := selectLiftResult(ctx, tx, `
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND metric = $3
   AND window_start = $4
   AND window_end = $5
   AND methodology_version = $6`, tenantID, campaignID, contract.metric,
		contract.windowStart, contract.windowEnd, LiftMethodologyVersion)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if err := validateLiftResultEvidence(existing); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return existing, nil
	}

	generatedAt := s.nowUTC()
	if generatedAt.Before(contract.windowEnd) {
		return nil, fmt.Errorf("%w: closes at %s", ErrLiftWindowOpen,
			contract.windowEnd.Format(time.RFC3339Nano))
	}

	nTreatment, nControl, assignmentDigest, err := loadFrozenPopulation(
		ctx, tx, tenantID, campaignID,
	)
	if err != nil {
		return nil, err
	}
	if nTreatment != contract.sentCount || nControl != contract.heldOutCount ||
		assignmentDigest != contract.assignmentSetSHA256 {
		return nil, fmt.Errorf("%w: assignment population no longer matches its frozen contract",
			ErrLiftResultIntegrity)
	}

	conversions, err := loadResolvedLiftConversions(ctx, tx, tenantID, campaignID,
		contract.metric, contract.windowStart, contract.windowEnd)
	if err != nil {
		return nil, err
	}
	convertedTreatment := make(map[string]struct{})
	convertedControl := make(map[string]struct{})
	for _, conversion := range conversions {
		switch conversion.Arm {
		case "treatment":
			convertedTreatment[conversion.RecipientID] = struct{}{}
		case "control":
			convertedControl[conversion.RecipientID] = struct{}{}
		default:
			return nil, fmt.Errorf("%w: unknown assignment arm %q",
				ErrLiftResultIntegrity, conversion.Arm)
		}
	}
	conversionsTreatment := int64(len(convertedTreatment))
	conversionsControl := int64(len(convertedControl))
	if conversionsTreatment > nTreatment || conversionsControl > nControl {
		return nil, fmt.Errorf("%w: unique conversion counts exceed assigned populations",
			ErrLiftResultIntegrity)
	}

	significance := ComputeLiftSignificanceForEffect(
		conversionsControl, nControl,
		conversionsTreatment, nTreatment,
		contract.minimumRelativeEffect,
	)
	status := "underpowered"
	if significance.Powered {
		status = "powered"
	}

	result := &LiftResult{
		ID:                      uuid.NewString(),
		TenantID:                tenantID,
		CampaignID:              campaignID,
		ResultVersion:           LiftResultVersion,
		MethodologyVersion:      LiftMethodologyVersion,
		Metric:                  contract.metric,
		WindowStart:             normalizeLiftTime(contract.windowStart),
		WindowEnd:               normalizeLiftTime(contract.windowEnd),
		NTreatment:              nTreatment,
		NControl:                nControl,
		ConversionsTreatment:    conversionsTreatment,
		ConversionsControl:      conversionsControl,
		RateTreatment:           significance.TreatmentRate,
		RateControl:             significance.ControlRate,
		Status:                  status,
		AbsoluteLift:            significance.AbsoluteLift,
		RelativeLift:            significance.RelativeLift,
		IncrementalConversions:  significance.IncrementalConversions,
		PValue:                  significance.PValue,
		CILow:                   significance.CILow,
		CIHigh:                  significance.CIHigh,
		MinimumDetectableEffect: significance.MinimumDetectableEffect,
		MinimumRelativeEffect:   contract.minimumRelativeEffect,
		UnderpoweredReason:      significance.Reason,
		AssignmentSetSHA256:     assignmentDigest,
		ConversionSetSHA256:     hashResolvedConversionSet(conversions),
		MethodologyStatement:    LiftMethodologyStatement,
		GeneratedAt:             generatedAt,
	}
	result.EvidenceSHA256 = hashLiftResultEvidence(result)
	if err := validateLiftResultEvidence(result); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.holdout_result_writer', 'true', true)`); err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO campaign_holdout_lift_results (
    id, tenant_id, campaign_id, result_version, methodology_version, metric,
    window_start, window_end, n_treatment, n_control,
    conversions_treatment, conversions_control, rate_treatment, rate_control,
    status, absolute_lift, relative_lift, incremental_conversions, p_value,
    ci_low, ci_high, minimum_detectable_effect, minimum_relative_effect,
    underpowered_reason, assignment_set_sha256, conversion_set_sha256,
    evidence_sha256, methodology_statement, generated_at
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
    $7, $8, $9, $10, $11, $12, $13, $14,
    $15, $16, $17, $18, $19, $20, $21, $22, $23,
    $24, $25, $26, $27, $28, $29
)`,
		result.ID, result.TenantID, result.CampaignID,
		result.ResultVersion, result.MethodologyVersion, result.Metric,
		result.WindowStart, result.WindowEnd, result.NTreatment, result.NControl,
		result.ConversionsTreatment, result.ConversionsControl,
		result.RateTreatment, result.RateControl, result.Status,
		nullableLiftFloat(result.AbsoluteLift), nullableLiftFloat(result.RelativeLift),
		nullableLiftFloat(result.IncrementalConversions), result.PValue,
		nullableLiftFloat(result.CILow), nullableLiftFloat(result.CIHigh),
		result.MinimumDetectableEffect, result.MinimumRelativeEffect,
		nullableLiftString(result.UnderpoweredReason), result.AssignmentSetSHA256,
		result.ConversionSetSHA256, result.EvidenceSHA256,
		result.MethodologyStatement, result.GeneratedAt)
	if err != nil {
		return nil, fmt.Errorf("persist finalized holdout lift result: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

// PoweredResultFor returns only immutable powered evidence wholly contained by
// the requested report window. An absent or underpowered result is represented
// as nil, never as a zero-valued estimate.
func (s *LiftResultStore) PoweredResultFor(
	ctx context.Context,
	query PoweredLiftQuery,
) (*LiftResult, error) {
	query.TenantID = strings.TrimSpace(query.TenantID)
	query.CampaignID = strings.TrimSpace(query.CampaignID)
	if s == nil || s.pool == nil || query.TenantID == "" || query.CampaignID == "" ||
		query.Since.IsZero() || query.Until.IsZero() || !query.Since.Before(query.Until) {
		return nil, ErrLiftResultInput
	}
	if _, err := uuid.Parse(query.TenantID); err != nil {
		return nil, fmt.Errorf("%w: tenant id must be a UUID", ErrLiftResultInput)
	}
	if _, err := uuid.Parse(query.CampaignID); err != nil {
		return nil, fmt.Errorf("%w: campaign id must be a UUID", ErrLiftResultInput)
	}

	tx, err := db.WithTenant(ctx, s.pool, query.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := selectLiftResult(ctx, tx, `
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND status = 'powered'
   AND window_start >= $3
   AND window_end <= $4
 ORDER BY generated_at DESC, id DESC
 LIMIT 1`, query.TenantID, query.CampaignID,
		normalizeLiftTime(query.Since), normalizeLiftTime(query.Until))
	if err != nil {
		return nil, err
	}
	if result != nil {
		if !result.Powered() {
			return nil, fmt.Errorf("%w: powered reader returned an unpowered row",
				ErrLiftResultIntegrity)
		}
		if err := validateLiftResultEvidence(result); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func loadFrozenLiftContract(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID string,
) (frozenLiftContract, error) {
	var out frozenLiftContract
	var decidedAt *time.Time
	err := tx.QueryRow(ctx, `
SELECT outcome_metric, decided_at,
       decided_at + make_interval(days => conversion_window_days),
       minimum_relative_effect, COALESCE(assignment_ledger_sha256, ''),
       COALESCE(assignment_ledger_version, ''), held_out_count, sent_count
  FROM campaign_holdouts
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
 FOR UPDATE`, tenantID, campaignID).Scan(
		&out.metric, &decidedAt, &out.windowEnd, &out.minimumRelativeEffect,
		&out.assignmentSetSHA256, &out.assignmentVersion,
		&out.heldOutCount, &out.sentCount,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return frozenLiftContract{}, ErrLiftResultUnavailable
	}
	if err != nil {
		return frozenLiftContract{}, err
	}
	if decidedAt == nil || out.assignmentVersion != AssignmentVersion ||
		!validLiftSHA256(out.assignmentSetSHA256) {
		return frozenLiftContract{}, ErrLiftResultUnavailable
	}
	if out.minimumRelativeEffect <= 0 || out.minimumRelativeEffect > 1 ||
		math.IsNaN(out.minimumRelativeEffect) || math.IsInf(out.minimumRelativeEffect, 0) {
		return frozenLiftContract{}, fmt.Errorf("%w: invalid minimum relative effect",
			ErrLiftResultIntegrity)
	}
	out.windowStart = normalizeLiftTime(*decidedAt)
	out.windowEnd = normalizeLiftTime(out.windowEnd)
	return out, nil
}

func loadFrozenPopulation(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID string,
) (nTreatment, nControl int64, digest string, err error) {
	err = tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE arm = 'treatment'),
       count(*) FILTER (WHERE arm = 'control'),
       campaign_holdout_assignment_set_sha256($1::uuid, $2::uuid)
  FROM campaign_holdout_assignments
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid`, tenantID, campaignID).Scan(
		&nTreatment, &nControl, &digest,
	)
	return
}

type resolvedLiftConversion struct {
	ConversionID     int64     `json:"conversion_id"`
	RecipientID      string    `json:"recipient_id"`
	Arm              string    `json:"arm"`
	EventName        string    `json:"event_name"`
	OccurredAt       time.Time `json:"occurred_at"`
	ResolutionSource string    `json:"resolution_source"`
}

func loadResolvedLiftConversions(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID, metric string,
	windowStart, windowEnd time.Time,
) ([]resolvedLiftConversion, error) {
	rows, err := tx.Query(ctx, `
SELECT conversion.id, resolved.recipient_id::text, assignment.arm,
       conversion.event_name, conversion.occurred_at,
       resolved.resolution_source
  FROM conversions AS conversion
  LEFT JOIN LATERAL (
      SELECT touch.subscriber_id,
             'identity_touch:' || touch.identity_kind AS resolution_source
        FROM conversion_attribution_touches AS touch
	       WHERE touch.tenant_id = conversion.tenant_id
	         AND touch.conversion_id = conversion.id
	         AND touch.touch_kind = 'identity'
	         -- Historical unsalted email_sha256 rows are retained for audit but
	         -- are not identity proof. Only current tenant-HMAC, click, and
	         -- external-id evidence may put a conversion into an experiment arm.
	         AND touch.identity_kind IN ('email_hmac_sha256', 'click_id', 'external_id')
	         AND touch.is_winner
         AND touch.subscriber_id IS NOT NULL
       ORDER BY touch.resolution_rank, touch.id
       LIMIT 1
  ) AS winner ON true
  LEFT JOIN LATERAL (
      SELECT candidate.subscriber_id, candidate.resolution_source
        FROM (
            SELECT subscriber.id AS subscriber_id, 1 AS priority,
                   'subscriber_email'::text AS resolution_source
              FROM subscribers AS subscriber
             WHERE conversion.subscriber_email IS NOT NULL
               AND subscriber.tenant_id = conversion.tenant_id
               AND subscriber.email = conversion.subscriber_email
            UNION ALL
	            SELECT click_identity.subscriber_id, 2, 'click_id'::text
	              FROM conversion_click_identities AS click_identity
             WHERE conversion.click_id IS NOT NULL
               AND click_identity.tenant_id = conversion.tenant_id
               AND click_identity.click_id = conversion.click_id
               AND click_identity.subscriber_id IS NOT NULL
            UNION ALL
	            SELECT subscriber.id, 3, 'external_id'::text
              FROM subscribers AS subscriber
             WHERE conversion.external_id IS NOT NULL
               AND subscriber.tenant_id = conversion.tenant_id
               AND subscriber.external_id = conversion.external_id
        ) AS candidate
       ORDER BY candidate.priority
       LIMIT 1
  ) AS fallback ON winner.subscriber_id IS NULL
  CROSS JOIN LATERAL (
      SELECT COALESCE(winner.subscriber_id, fallback.subscriber_id) AS recipient_id,
             COALESCE(winner.resolution_source, fallback.resolution_source) AS resolution_source
  ) AS resolved
  JOIN campaign_holdout_assignments AS assignment
    ON assignment.tenant_id = conversion.tenant_id
   AND assignment.campaign_id = $2::uuid
   AND assignment.recipient_id = resolved.recipient_id
 WHERE conversion.tenant_id = $1::uuid
   AND conversion.occurred_at >= $3
   AND conversion.occurred_at < $5
   AND ($4 = 'any_conversion' OR conversion.event_name = $4)
 ORDER BY resolved.recipient_id, conversion.id`,
		tenantID, campaignID, windowStart, metric, windowEnd)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	conversions := make([]resolvedLiftConversion, 0)
	for rows.Next() {
		var conversion resolvedLiftConversion
		if err := rows.Scan(
			&conversion.ConversionID, &conversion.RecipientID, &conversion.Arm,
			&conversion.EventName, &conversion.OccurredAt,
			&conversion.ResolutionSource,
		); err != nil {
			return nil, err
		}
		conversion.OccurredAt = normalizeLiftTime(conversion.OccurredAt)
		conversions = append(conversions, conversion)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return conversions, nil
}

const liftResultColumns = `
id::text, tenant_id::text, campaign_id::text, result_version,
methodology_version, metric, window_start, window_end,
n_treatment, n_control, conversions_treatment, conversions_control,
rate_treatment, rate_control, status, absolute_lift, relative_lift,
incremental_conversions, p_value, ci_low, ci_high,
minimum_detectable_effect, minimum_relative_effect, underpowered_reason,
assignment_set_sha256, conversion_set_sha256, evidence_sha256,
methodology_statement, generated_at`

func selectLiftResult(
	ctx context.Context,
	tx pgx.Tx,
	clause string,
	args ...any,
) (*LiftResult, error) {
	row := tx.QueryRow(ctx,
		`SELECT `+liftResultColumns+` FROM campaign_holdout_lift_results`+clause,
		args...)
	result, err := scanLiftResult(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return result, err
}

func scanLiftResult(row pgx.Row) (*LiftResult, error) {
	var result LiftResult
	var absolute, relative, incremental, ciLow, ciHigh *float64
	var underpoweredReason *string
	err := row.Scan(
		&result.ID, &result.TenantID, &result.CampaignID,
		&result.ResultVersion, &result.MethodologyVersion, &result.Metric,
		&result.WindowStart, &result.WindowEnd,
		&result.NTreatment, &result.NControl,
		&result.ConversionsTreatment, &result.ConversionsControl,
		&result.RateTreatment, &result.RateControl, &result.Status,
		&absolute, &relative, &incremental, &result.PValue,
		&ciLow, &ciHigh, &result.MinimumDetectableEffect,
		&result.MinimumRelativeEffect, &underpoweredReason,
		&result.AssignmentSetSHA256, &result.ConversionSetSHA256,
		&result.EvidenceSHA256, &result.MethodologyStatement, &result.GeneratedAt,
	)
	if err != nil {
		return nil, err
	}
	result.AbsoluteLift = absolute
	result.RelativeLift = relative
	result.IncrementalConversions = incremental
	result.CILow = ciLow
	result.CIHigh = ciHigh
	if underpoweredReason != nil {
		result.UnderpoweredReason = *underpoweredReason
	}
	result.WindowStart = normalizeLiftTime(result.WindowStart)
	result.WindowEnd = normalizeLiftTime(result.WindowEnd)
	result.GeneratedAt = normalizeLiftTime(result.GeneratedAt)
	return &result, nil
}

func hashResolvedConversionSet(conversions []resolvedLiftConversion) string {
	ordered := append([]resolvedLiftConversion(nil), conversions...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].RecipientID != ordered[j].RecipientID {
			return ordered[i].RecipientID < ordered[j].RecipientID
		}
		if ordered[i].ConversionID != ordered[j].ConversionID {
			return ordered[i].ConversionID < ordered[j].ConversionID
		}
		return ordered[i].ResolutionSource < ordered[j].ResolutionSource
	})
	for i := range ordered {
		ordered[i].OccurredAt = normalizeLiftTime(ordered[i].OccurredAt)
	}
	payload := struct {
		Version     string                   `json:"version"`
		Conversions []resolvedLiftConversion `json:"conversions"`
	}{Version: liftConversionSetVersion, Conversions: ordered}
	raw, _ := json.Marshal(payload)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

type liftEvidencePayload struct {
	Version                 string    `json:"version"`
	ResultID                string    `json:"result_id"`
	TenantID                string    `json:"tenant_id"`
	CampaignID              string    `json:"campaign_id"`
	ResultVersion           string    `json:"result_version"`
	MethodologyVersion      string    `json:"methodology_version"`
	Metric                  string    `json:"metric"`
	WindowStart             time.Time `json:"window_start"`
	WindowEnd               time.Time `json:"window_end"`
	NTreatment              int64     `json:"n_treatment"`
	NControl                int64     `json:"n_control"`
	ConversionsTreatment    int64     `json:"conversions_treatment"`
	ConversionsControl      int64     `json:"conversions_control"`
	RateTreatment           float64   `json:"rate_treatment"`
	RateControl             float64   `json:"rate_control"`
	Status                  string    `json:"status"`
	AbsoluteLift            *float64  `json:"absolute_lift"`
	RelativeLift            *float64  `json:"relative_lift"`
	IncrementalConversions  *float64  `json:"incremental_conversions"`
	PValue                  float64   `json:"p_value"`
	CILow                   *float64  `json:"ci_low"`
	CIHigh                  *float64  `json:"ci_high"`
	MinimumDetectableEffect float64   `json:"minimum_detectable_effect"`
	MinimumRelativeEffect   float64   `json:"minimum_relative_effect"`
	UnderpoweredReason      string    `json:"underpowered_reason"`
	AssignmentSetSHA256     string    `json:"assignment_set_sha256"`
	ConversionSetSHA256     string    `json:"conversion_set_sha256"`
	MethodologyStatement    string    `json:"methodology_statement"`
	GeneratedAt             time.Time `json:"generated_at"`
}

func hashLiftResultEvidence(result *LiftResult) string {
	if result == nil {
		return ""
	}
	payload := liftEvidencePayload{
		Version:  liftEvidenceVersion,
		ResultID: result.ID, TenantID: result.TenantID, CampaignID: result.CampaignID,
		ResultVersion: result.ResultVersion, MethodologyVersion: result.MethodologyVersion,
		Metric:      result.Metric,
		WindowStart: normalizeLiftTime(result.WindowStart),
		WindowEnd:   normalizeLiftTime(result.WindowEnd),
		NTreatment:  result.NTreatment, NControl: result.NControl,
		ConversionsTreatment: result.ConversionsTreatment,
		ConversionsControl:   result.ConversionsControl,
		RateTreatment:        result.RateTreatment, RateControl: result.RateControl,
		Status: result.Status, AbsoluteLift: result.AbsoluteLift,
		RelativeLift:           result.RelativeLift,
		IncrementalConversions: result.IncrementalConversions,
		PValue:                 result.PValue, CILow: result.CILow, CIHigh: result.CIHigh,
		MinimumDetectableEffect: result.MinimumDetectableEffect,
		MinimumRelativeEffect:   result.MinimumRelativeEffect,
		UnderpoweredReason:      result.UnderpoweredReason,
		AssignmentSetSHA256:     result.AssignmentSetSHA256,
		ConversionSetSHA256:     result.ConversionSetSHA256,
		MethodologyStatement:    result.MethodologyStatement,
		GeneratedAt:             normalizeLiftTime(result.GeneratedAt),
	}
	raw, _ := json.Marshal(payload)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func validateLiftResultEvidence(result *LiftResult) error {
	if !liftResultHeaderValid(result) {
		return ErrLiftResultIntegrity
	}
	if !liftResultCountsValid(result) {
		return ErrLiftResultIntegrity
	}
	switch result.Status {
	case "powered":
		if !poweredLiftResultValid(result) {
			return ErrLiftResultIntegrity
		}
	case "underpowered":
		if !underpoweredLiftResultValid(result) {
			return ErrLiftResultIntegrity
		}
	default:
		return ErrLiftResultIntegrity
	}
	if hashLiftResultEvidence(result) != result.EvidenceSHA256 {
		return ErrLiftResultIntegrity
	}
	return nil
}

// liftResultHeaderValid checks the version pins, digests, methodology
// statement and the three identifying UUIDs. It is the only predicate that
// tolerates a nil result, so it must run first.
func liftResultHeaderValid(result *LiftResult) bool {
	if result == nil || result.ResultVersion != LiftResultVersion ||
		result.MethodologyVersion != LiftMethodologyVersion ||
		!validLiftSHA256(result.AssignmentSetSHA256) ||
		!validLiftSHA256(result.ConversionSetSHA256) ||
		!validLiftSHA256(result.EvidenceSHA256) ||
		result.MethodologyStatement != LiftMethodologyStatement {
		return false
	}
	if _, err := uuid.Parse(result.ID); err != nil {
		return false
	}
	if _, err := uuid.Parse(result.TenantID); err != nil {
		return false
	}
	if _, err := uuid.Parse(result.CampaignID); err != nil {
		return false
	}
	return true
}

// liftResultCountsValid checks the window, the arm counts, the rates and the
// power parameters, including that each stored rate equals the rate implied
// by its arm's counts.
func liftResultCountsValid(result *LiftResult) bool {
	if result.WindowStart.IsZero() || !result.WindowStart.Before(result.WindowEnd) ||
		result.GeneratedAt.Before(result.WindowEnd) ||
		result.NTreatment < 0 || result.NControl < 0 ||
		result.ConversionsTreatment < 0 ||
		result.ConversionsTreatment > result.NTreatment ||
		result.ConversionsControl < 0 || result.ConversionsControl > result.NControl ||
		!validLiftUnitFloat(result.RateTreatment) ||
		!validLiftUnitFloat(result.RateControl) ||
		!validLiftUnitFloat(result.PValue) ||
		result.MinimumDetectableEffect < 0 ||
		math.IsNaN(result.MinimumDetectableEffect) ||
		math.IsInf(result.MinimumDetectableEffect, 0) ||
		result.MinimumRelativeEffect <= 0 || result.MinimumRelativeEffect > 1 ||
		math.IsNaN(result.MinimumRelativeEffect) ||
		math.IsInf(result.MinimumRelativeEffect, 0) ||
		!nearlyEqualLift(result.RateTreatment,
			safeRate(result.ConversionsTreatment, result.NTreatment)) ||
		!nearlyEqualLift(result.RateControl,
			safeRate(result.ConversionsControl, result.NControl)) {
		return false
	}
	return true
}

// poweredLiftResultValid checks the effect-size fields a "powered" result must
// carry and their arithmetic consistency with the arm rates.
func poweredLiftResultValid(result *LiftResult) bool {
	if result.AbsoluteLift == nil || result.IncrementalConversions == nil ||
		result.CILow == nil || result.CIHigh == nil ||
		result.UnderpoweredReason != "" || result.NTreatment <= 0 ||
		result.NControl <= 0 || !validFiniteLiftFloat(*result.AbsoluteLift) ||
		!validFiniteLiftFloat(*result.IncrementalConversions) ||
		!validFiniteLiftFloat(*result.CILow) ||
		!validFiniteLiftFloat(*result.CIHigh) ||
		!nearlyEqualLift(*result.AbsoluteLift,
			result.RateTreatment-result.RateControl) ||
		!nearlyEqualLift(*result.IncrementalConversions,
			*result.AbsoluteLift*float64(result.NTreatment)) ||
		*result.CILow > *result.CIHigh ||
		*result.AbsoluteLift < *result.CILow-1e-12 ||
		*result.AbsoluteLift > *result.CIHigh+1e-12 {
		return false
	}
	if result.RateControl == 0 {
		return result.RelativeLift == nil
	}
	if result.RelativeLift == nil ||
		!validFiniteLiftFloat(*result.RelativeLift) ||
		!nearlyEqualLift(*result.RelativeLift,
			(*result.AbsoluteLift/result.RateControl)*100) {
		return false
	}
	return true
}

// underpoweredLiftResultValid checks that an "underpowered" result carries no
// effect-size fields and names its reason.
func underpoweredLiftResultValid(result *LiftResult) bool {
	if result.AbsoluteLift != nil || result.RelativeLift != nil ||
		result.IncrementalConversions != nil || result.CILow != nil ||
		result.CIHigh != nil || result.UnderpoweredReason == "" {
		return false
	}
	return true
}

func validLiftUnitFloat(value float64) bool {
	return validFiniteLiftFloat(value) && value >= 0 && value <= 1
}

func validFiniteLiftFloat(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func nearlyEqualLift(left, right float64) bool {
	scale := math.Max(1, math.Max(math.Abs(left), math.Abs(right)))
	return math.Abs(left-right) <= 1e-12*scale
}

func validLiftSHA256(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func normalizeLiftTime(value time.Time) time.Time {
	return value.UTC().Truncate(time.Microsecond)
}

func nullableLiftFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableLiftString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
