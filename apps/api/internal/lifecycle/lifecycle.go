// SPDX-License-Identifier: AGPL-3.0-only
//
// Package lifecycle owns the HubSpot-parity per-subscriber lifecycle
// stage column (GAP-LS-068) plus the per-subscriber stage score.
// Storage is the subscriber_lifecycle sidecar table from migration 0250
// (PK on subscriber_id keeps the join cheap, RLS-scoped to tenant).
//
// Surface:
//
//	GET   /api/v1/subscribers/{id}/lifecycle
//	PUT   /api/v1/subscribers/{id}/lifecycle  (idempotent upsert)
//	GET   /api/v1/lifecycle/distribution      (stage histogram)
package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/subscriberevents"
)

// Stage mirrors the CHECK constraint on subscriber_lifecycle.stage.
type Stage string

const (
	StageSubscriber  Stage = "subscriber"
	StageLead        Stage = "lead"
	StageMQL         Stage = "mql"
	StageSQL         Stage = "sql"
	StageOpportunity Stage = "opportunity"
	StageCustomer    Stage = "customer"
	StageEvangelist  Stage = "evangelist"
	StageOther       Stage = "other"
)

// AllStages is the canonical catalog.
var AllStages = []Stage{
	StageSubscriber, StageLead, StageMQL, StageSQL,
	StageOpportunity, StageCustomer, StageEvangelist, StageOther,
}

var lifecycleSourceRE = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,64}$`)

// IsValidStage reports whether s is one of AllStages.
func IsValidStage(s string) bool {
	for _, x := range AllStages {
		if string(x) == s {
			return true
		}
	}
	return false
}

// Lifecycle is one row from subscriber_lifecycle.
type Lifecycle struct {
	SubscriberID   string     `json:"subscriber_id"`
	TenantID       string     `json:"tenant_id"`
	Stage          Stage      `json:"stage"`
	PreviousStage  *Stage     `json:"previous_stage,omitempty"`
	Score          int        `json:"score"`
	Transitioned   bool       `json:"transitioned,omitempty"`
	TransitionedAt *time.Time `json:"transitioned_at,omitempty"`
	UpdatedAt      time.Time  `json:"updated_at"`
	// TransitionSequence advances only when Stage changes. It is allocated
	// under the subscriber aggregate lock and orders every downstream copy.
	TransitionSequence int64 `json:"transition_sequence"`
	// SubscriberVersion is the exact parent-profile revision observed by a
	// read or produced by a write. Lifecycle is part of the subscriber
	// aggregate, so clients chain this token through If-Match.
	SubscriberVersion string `json:"subscriber_version"`
}

// UpsertInput is the body of PUT /subscribers/{id}/lifecycle.
type UpsertInput struct {
	Stage  string `json:"stage"`
	Score  *int   `json:"score,omitempty"`
	Source string `json:"source"`
	Reason string `json:"reason"`
}

// Sentinel errors.
var (
	ErrNotFound                 = errors.New("lifecycle: not found")
	ErrInvalidInput             = errors.New("lifecycle: invalid input")
	ErrPreconditionFailed       = errors.New("lifecycle: stale subscriber revision")
	ErrAutomationOutboxRequired = errors.New("lifecycle: durable automation outbox is not configured")
)

const AutomationOutboxKind = "lifecycle.automation_stage_changed"

type AutomationOutboxAppender interface {
	Append(ctx context.Context, tx pgx.Tx, in outbox.Append) (string, error)
}

// Repo wraps the pgx pool for subscriber_lifecycle reads/writes.
type Repo struct {
	Pool             *db.Pool
	AutomationOutbox AutomationOutboxAppender
}

// Get returns the lifecycle row for a subscriber, or a default
// "subscriber" stage row when none exists yet (matches HubSpot
// behaviour where every contact has a stage from creation).
func (r *Repo) Get(ctx context.Context, tenantID, subscriberID string) (*Lifecycle, error) {
	if _, err := uuid.Parse(strings.TrimSpace(subscriberID)); err != nil {
		return nil, ErrInvalidInput
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var parentID string
	var parentUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT id::text, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID).Scan(&parentID, &parentUpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	parentVersion := httpcache.ConcurrencyToken("subscriber", parentID, parentUpdatedAt)
	var l Lifecycle
	err = tx.QueryRow(ctx, `
SELECT subscriber_id::text, tenant_id::text, stage, score, updated_at,
       transition_sequence
  FROM subscriber_lifecycle
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`,
		tenantID, subscriberID).
		Scan(&l.SubscriberID, &l.TenantID, (*string)(&l.Stage), &l.Score,
			&l.UpdatedAt, &l.TransitionSequence)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Default row: matches the schema defaults so callers
			// can render without a 404 spin.
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			return &Lifecycle{
				SubscriberID:      subscriberID,
				TenantID:          tenantID,
				Stage:             StageSubscriber,
				Score:             3,
				UpdatedAt:         parentUpdatedAt,
				SubscriberVersion: parentVersion,
			}, nil
		}
		return nil, err
	}
	l.SubscriberVersion = parentVersion
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &l, nil
}

// Upsert writes a row into subscriber_lifecycle (insert-or-update on
// the subscriber_id PK). Score defaults to 3 when omitted.
func (r *Repo) Upsert(
	ctx context.Context,
	tenantID, subscriberID string,
	in UpsertInput,
	ifMatchToken string,
	auditMeta db.AuditMeta,
) (*Lifecycle, error) {
	if _, err := uuid.Parse(strings.TrimSpace(subscriberID)); err != nil {
		return nil, ErrInvalidInput
	}
	in.Stage = strings.ToLower(strings.TrimSpace(in.Stage))
	if !IsValidStage(in.Stage) {
		return nil, ErrInvalidInput
	}
	in.Source = strings.ToLower(strings.TrimSpace(in.Source))
	if in.Source == "" {
		in.Source = "operator"
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if !lifecycleSourceRE.MatchString(in.Source) || !validLifecycleReason(in.Reason) {
		return nil, ErrInvalidInput
	}
	score := 3
	if in.Score != nil {
		score = *in.Score
	}
	if score < 1 || score > 5 {
		return nil, ErrInvalidInput
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var parentID string
	var parentEmail string
	var parentUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT id::text, email::text, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, subscriberID).Scan(&parentID, &parentEmail, &parentUpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	parentVersion := httpcache.ConcurrencyToken("subscriber", parentID, parentUpdatedAt)
	if strings.TrimSpace(ifMatchToken) == "" || ifMatchToken != parentVersion {
		return nil, ErrPreconditionFailed
	}
	prevStage := string(StageSubscriber)
	prevScore := 3
	var prevTransitionSequence int64
	var prevUpdatedAt time.Time
	prevErr := tx.QueryRow(ctx, `
SELECT stage, score, updated_at, transition_sequence
  FROM subscriber_lifecycle
	 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
	 FOR UPDATE`,
		tenantID, parentID).Scan(&prevStage, &prevScore, &prevUpdatedAt, &prevTransitionSequence)
	if prevErr != nil && !errors.Is(prevErr, pgx.ErrNoRows) {
		return nil, prevErr
	}
	hasLifecycleRow := prevErr == nil
	stageChanged := prevStage != in.Stage
	scoreChanged := prevScore != score
	nextTransitionSequence := prevTransitionSequence
	if stageChanged {
		nextTransitionSequence++
	}
	if !stageChanged && !scoreChanged {
		if !hasLifecycleRow {
			prevUpdatedAt = parentUpdatedAt
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &Lifecycle{
			SubscriberID:       parentID,
			TenantID:           tenantID,
			Stage:              Stage(prevStage),
			Score:              prevScore,
			UpdatedAt:          prevUpdatedAt,
			TransitionSequence: prevTransitionSequence,
			SubscriberVersion:  parentVersion,
		}, nil
	}
	_, err = tx.Exec(ctx, `
	INSERT INTO subscriber_lifecycle
	    (subscriber_id, tenant_id, stage, score, transition_sequence)
	VALUES ($1::uuid, $2::uuid, $3, $4::smallint, $5)
	ON CONFLICT (subscriber_id) DO UPDATE
	   SET stage = EXCLUDED.stage,
	       score = EXCLUDED.score,
	       transition_sequence = EXCLUDED.transition_sequence,
	       updated_at = now()`,
		parentID, tenantID, in.Stage, score, nextTransitionSequence)
	if err != nil {
		return nil, err
	}
	var l Lifecycle
	if err := tx.QueryRow(ctx, `
	SELECT subscriber_id::text, tenant_id::text, stage, score, updated_at,
	       transition_sequence
  FROM subscriber_lifecycle
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`,
		tenantID, parentID).
		Scan(&l.SubscriberID, &l.TenantID, (*string)(&l.Stage), &l.Score,
			&l.UpdatedAt, &l.TransitionSequence); err != nil {
		return nil, err
	}
	if stageChanged {
		l.Transitioned = true
		l.TransitionedAt = &l.UpdatedAt
		ps := Stage(prevStage)
		l.PreviousStage = &ps
		var lifecycleEventID int64
		if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_lifecycle_events
	(tenant_id, subscriber_id, previous_stage, next_stage, score, source,
	 reason, at, transition_sequence)
	VALUES ($1::uuid, $2::uuid, NULLIF($3, ''), $4, $5::smallint, $6, $7, $8, $9)
RETURNING id`,
			tenantID, parentID, prevStage, in.Stage, score, in.Source,
			strings.TrimSpace(in.Reason), l.UpdatedAt, l.TransitionSequence).
			Scan(&lifecycleEventID); err != nil {
			return nil, err
		}
		if err := appendCanonicalStageEvent(
			ctx, tx, tenantID, parentID, parentEmail, lifecycleEventID,
			prevStage, in.Stage, score, in.Source, l.TransitionSequence, l.UpdatedAt,
		); err != nil {
			return nil, err
		}
	}
	var freshParentUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
UPDATE subscribers
   SET updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING updated_at`, tenantID, parentID).Scan(&freshParentUpdatedAt); err != nil {
		return nil, err
	}
	l.SubscriberVersion = httpcache.ConcurrencyToken("subscriber", parentID, freshParentUpdatedAt)
	if stageChanged {
		if r.AutomationOutbox == nil {
			return nil, ErrAutomationOutboxRequired
		}
		if _, err := r.AutomationOutbox.Append(ctx, tx, outbox.Append{
			TenantID: tenantID,
			Kind:     AutomationOutboxKind,
			Payload: lifecycleAutomationPayload{
				SubscriberID:       parentID,
				FromStage:          prevStage,
				ToStage:            in.Stage,
				Score:              score,
				At:                 l.UpdatedAt,
				TransitionSequence: l.TransitionSequence,
			},
		}); err != nil {
			return nil, fmt.Errorf("%w: append intent: %v", ErrAutomationOutboxRequired, err)
		}
	}
	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "subscriber.lifecycle_changed", "subscriber", parentID, map[string]any{
		"previous_stage":      prevStage,
		"stage":               in.Stage,
		"previous_score":      prevScore,
		"score":               score,
		"stage_changed":       stageChanged,
		"transition_sequence": l.TransitionSequence,
		"source":              in.Source,
		"reason_present":      strings.TrimSpace(in.Reason) != "",
		"previous_version":    parentVersion,
		"new_version":         l.SubscriberVersion,
	}); err != nil {
		return nil, fmt.Errorf("audit lifecycle change: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &l, nil
}

func validLifecycleReason(reason string) bool {
	if !utf8.ValidString(reason) || utf8.RuneCountInString(reason) > 500 || len(reason) > 2048 {
		return false
	}
	for _, character := range reason {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

// ResolveEmail returns the subscriber's email for a subscriber id. Used by the
// SUB-136 lifecycle-stage forwarder, whose downstream automation runtime joins
// on subscriber_email rather than the row id. Returns ErrNotFound when the id
// has no subscribers row (e.g. it was erased between intent creation and a
// later delivery attempt).
func (r *Repo) ResolveEmail(ctx context.Context, tenantID, subscriberID string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var email string
	if err := tx.QueryRow(ctx, `
SELECT email::text
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND archived_at IS NULL`,
		tenantID, subscriberID).Scan(&email); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return email, nil
}

// Distribution returns the per-stage subscriber count. Used by the
// "Pipeline" widget on the subscribers dashboard.
type DistributionRow struct {
	Stage Stage `json:"stage"`
	Count int64 `json:"count"`
}

// Distribution returns the histogram over every active tenant subscriber. Contacts
// with no sidecar row are bucketed into 'subscriber', matching Get's implicit
// default instead of disappearing from the report. Archived profiles are
// intentionally excluded so the pipeline matches the active directory.
func (r *Repo) Distribution(ctx context.Context, tenantID string) ([]DistributionRow, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT COALESCE(l.stage, 'subscriber') AS stage, COUNT(*)::bigint
  FROM subscribers AS s
  LEFT JOIN subscriber_lifecycle AS l
    ON l.tenant_id = s.tenant_id
   AND l.subscriber_id = s.id
 WHERE s.tenant_id = $1::uuid
   AND s.archived_at IS NULL
 GROUP BY COALESCE(l.stage, 'subscriber')
 ORDER BY COALESCE(l.stage, 'subscriber')`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DistributionRow{}
	for rows.Next() {
		var r DistributionRow
		if err := rows.Scan((*string)(&r.Stage), &r.Count); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

const canonicalLifecycleEventSource = "lifecycle"

// appendCanonicalStageEvent joins the lifecycle sidecar to the subscriber's
// canonical activity stream in the same transaction. Timeline, tenant scoring
// rules, exports, and other event consumers therefore observe a stage change
// atomically with the aggregate revision and automation intent.
func appendCanonicalStageEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, subscriberID, subscriberEmail string,
	lifecycleEventID int64,
	previousStage, nextStage string,
	score int,
	source string,
	transitionSequence int64,
	at time.Time,
) error {
	sourceEventID := fmt.Sprintf("lifecycle-transition:%d", lifecycleEventID)
	claim, err := subscriberevents.ClaimDedupKey(
		ctx, tx, tenantID, canonicalLifecycleEventSource, sourceEventID,
	)
	if err != nil {
		return fmt.Errorf("claim canonical lifecycle event: %w", err)
	}
	if !claim.Claimed {
		return errors.New("canonical lifecycle event id was already claimed")
	}
	metadata, err := json.Marshal(map[string]any{
		"subscriber_id":       subscriberID,
		"previous_stage":      previousStage,
		"stage":               nextStage,
		"score":               score,
		"source":              source,
		"transition_sequence": transitionSequence,
	})
	if err != nil {
		return fmt.Errorf("encode canonical lifecycle event: %w", err)
	}
	var eventID int64
	var eventAt time.Time
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, at, source, source_event_id, metadata)
VALUES ($1::uuid, $2, 'lifecycle_stage_changed', $3, $4, $5, $6::jsonb)
RETURNING id, at`, tenantID, subscriberEmail, at, canonicalLifecycleEventSource, sourceEventID, string(metadata)).Scan(&eventID, &eventAt); err != nil {
		return fmt.Errorf("append canonical lifecycle event: %w", err)
	}
	if err := subscriberevents.BindDedupKey(
		ctx, tx, tenantID, canonicalLifecycleEventSource, sourceEventID, eventID, eventAt,
	); err != nil {
		return fmt.Errorf("bind canonical lifecycle event: %w", err)
	}
	return nil
}
