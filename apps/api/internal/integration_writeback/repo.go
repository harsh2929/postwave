// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

var ErrNotFound = errors.New("integration_writeback: not found")

// AudienceMaxRows bounds a write-back run's resolved audience.
const AudienceMaxRows = 50000

type Repo struct {
	Pool *db.Pool
	// Logger is optional and nil-safe.
	//
	// Present so audience gating is not SILENT. Consent-gating is a real
	// semantic tightening: a tenant whose base was imported without recording
	// consent_events sees that audience go to zero, and the run does not error,
	// does not retry and produces no artefact — an operator watching a target
	// that used to sync 40 000 contacts just sees nothing happen.
	Logger *slog.Logger
}

func (r *Repo) ListTargets(ctx context.Context, tenantID string) ([]Target, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, credentials_ref,
       settings, sync_interval_minutes, last_run_at, error_message, created_at, updated_at
  FROM writeback_targets
 WHERE tenant_id = $1::uuid
 ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	out, err := scanTargets(rows)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetTarget(ctx context.Context, tenantID, id string) (*Target, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, credentials_ref,
       settings, sync_interval_minutes, last_run_at, error_message, created_at, updated_at
  FROM writeback_targets
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	out, err := scanTarget(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) UpsertTarget(ctx context.Context, tenantID string, in TargetInput) (*Target, error) {
	in.Provider = strings.ToLower(strings.TrimSpace(in.Provider))
	if in.Provider == "" {
		return nil, errors.New("provider is required")
	}
	if strings.TrimSpace(in.CredentialsRef) == "" {
		return nil, errors.New("credentials_ref is required")
	}
	if in.Name = strings.TrimSpace(in.Name); in.Name == "" {
		in.Name = in.Provider + " write-back"
	}
	if in.Status = strings.ToLower(strings.TrimSpace(in.Status)); in.Status == "" {
		in.Status = "active"
	}
	if in.SyncIntervalMinutes < 0 {
		in.SyncIntervalMinutes = 0
	}
	settings := in.Settings
	if settings == nil {
		settings = map[string]any{}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	settingsJSON, _ := json.Marshal(settings)
	row := tx.QueryRow(ctx, `
INSERT INTO writeback_targets (tenant_id, provider, name, status, credentials_ref, settings, sync_interval_minutes)
VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = EXCLUDED.status,
    credentials_ref = EXCLUDED.credentials_ref,
    settings = writeback_targets.settings || EXCLUDED.settings,
    sync_interval_minutes = EXCLUDED.sync_interval_minutes,
    error_message = '',
    updated_at = now()
RETURNING id::text, tenant_id::text, provider, name, status, credentials_ref,
       settings, sync_interval_minutes, last_run_at, error_message, created_at, updated_at`,
		tenantID, in.Provider, in.Name, in.Status, strings.TrimSpace(in.CredentialsRef), string(settingsJSON), in.SyncIntervalMinutes)
	out, err := scanTarget(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) SetTargetStatus(ctx context.Context, tenantID, id, status string) (*Target, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE writeback_targets SET status = $3, error_message = '', updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, tenant_id::text, provider, name, status, credentials_ref,
       settings, sync_interval_minutes, last_run_at, error_message, created_at, updated_at`, tenantID, id, status)
	out, err := scanTarget(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// RecordRun writes a run audit row and stamps the target's last_run_at/status.
func (r *Repo) RecordRun(ctx context.Context, tenantID, targetID, runMode string, s RunSummary, started, completed time.Time) (*Run, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	status := s.Status
	if status == "" {
		status = "completed"
	}
	row := tx.QueryRow(ctx, `
INSERT INTO writeback_runs (
    tenant_id, target_id, run_mode, status, members_seen, matched,
    tags_written, fields_written, rows_failed, error_message, started_at, completed_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id::text, tenant_id::text, target_id::text, run_mode, status,
       members_seen, matched, tags_written, fields_written, rows_failed,
       error_message, metadata, started_at, completed_at, created_at`,
		tenantID, targetID, runMode, status, s.MembersSeen, s.Matched,
		s.TagsWritten, s.FieldsWritten, s.RowsFailed, s.ErrorMessage, started, completed)
	run, err := scanRun(row)
	if err != nil {
		return nil, err
	}
	targetStatus := "active"
	if status == "failed" {
		targetStatus = "error"
	}
	if _, err := tx.Exec(ctx, `
UPDATE writeback_targets SET last_run_at = $3, status = CASE WHEN status = 'paused' THEN 'paused' ELSE $4 END,
       error_message = $5, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, targetID, completed, targetStatus, s.ErrorMessage); err != nil {
		return nil, err
	}
	return run, tx.Commit(ctx)
}

func (r *Repo) ListRuns(ctx context.Context, tenantID, targetID string, limit int) ([]Run, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, target_id::text, run_mode, status,
       members_seen, matched, tags_written, fields_written, rows_failed,
       error_message, metadata, started_at, completed_at, created_at
  FROM writeback_runs
 WHERE tenant_id = $1::uuid AND target_id::text = $2
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, targetID, limit)
	if err != nil {
		return nil, err
	}
	out := []Run{}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ResolveAudience resolves the target's source list/segment to subscriber emails
// that may actually be exported.
//
// Writeback is a CONTINUOUS third-party PII egress: the scheduler runs targets
// on a one-minute tick. This function previously selected on nothing but
// `s.email <> ”` — no status, no consent, no archived exclusion — and for a
// segment it read `segment_subscribers`, the materialized cache. That cache is
// correct for what it is: it holds DEFINITION membership, and "who matches this
// definition" legitimately includes people who have unsubscribed. Reading it as
// an audience is what turned it into a standing export of contacts who asked
// not to be contacted.
//
// WHAT THIS IS NOT. An earlier version of this comment said the fix was "not
// novel — it is the implementation that already existed a few files away",
// citing `audience_destinations/sync_runner.go` as compiling under the
// ACTIVATION population and concluding that "only one of them asked whether the
// contact consented". A review checked and it is inverted:
// `sync_runner.go:551` passes `DefinitionPopulation(false)` — archived-exclusion
// only, no status gate, no consent gate — and its list branch is a bare
// `JOIN subscribers` with no gate at all.
//
// So NEITHER implementation asked about consent, and this change makes writeback
// STRICTER than the surface it was supposed to be converging on. The divergence
// between the two is not closed; it is reversed. That is recorded here rather
// than papered over, because a comment naming a file and misstating what that
// file does is worse than no comment. Whether `audience_destinations` should
// follow is a product decision about an existing export, not something to change
// silently on the way past.
//
// What remains true, and is the reason for the change: a definition cache is not
// an eligibility answer, and a continuous third-party egress is the last place
// that distinction should be guessed at.
func (r *Repo) ResolveAudience(ctx context.Context, tenantID string, target *Target) ([]AudienceMember, error) {
	listID := settingString(target.Settings, "source_list_id")
	segmentID := settingString(target.Settings, "source_segment_id")
	if listID == "" && segmentID == "" {
		return nil, fmt.Errorf("target has no source — set source_list_id or source_segment_id")
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var query string
	var args []any
	switch {
	case listID != "":
		// A list membership is an explicit relationship, so the membership join
		// stays — but eligibility is the same question it is everywhere else, and
		// gets the same answer.
		gate, err := segments.CompilePopulation(ctx, nil, tenantID,
			segments.TransactionSegmentResolver{Queryer: tx},
			segments.ActivationPopulation(segments.ActivationChannelEmail))
		if err != nil {
			return nil, fmt.Errorf("compile activation gate: %w", err)
		}
		// `gate.Args` is provably empty: the gate is compiled from a nil AST, so
		// it is the constant channel-consent SQL with no placeholders. Appending
		// it would be dead code that ADVERTISES support this branch does not
		// have — segments numbers placeholders from $1, which here are already
		// bound to tenantID/listID, so a non-empty gate would silently mis-bind
		// rather than fail. If this branch ever compiles a real AST it must
		// renumber, as omnichannel/runtime.go:203 does.
		if len(gate.Args) != 0 {
			return nil, fmt.Errorf("writeback: list gate produced %d placeholder args; "+
				"they would mis-bind against tenant/list. Renumber before using them",
				len(gate.Args))
		}
		args = []any{tenantID, listID, AudienceMaxRows}
		query = `
SELECT subscribers.email::text, subscribers.custom_fields, subscribers.tags,
       subscribers.status, subscribers.consent_timestamp` + predictionSelect + `
  FROM list_subscribers ls
  JOIN subscribers ON subscribers.id = ls.subscriber_id` + predictionJoin + `
 WHERE ls.tenant_id = $1::uuid AND ls.list_id = $2::uuid AND ls.removed_at IS NULL
   AND subscribers.email <> '' AND (` + gate.SQL + `)
 ORDER BY subscribers.email ASC LIMIT $` + strconv.Itoa(len(args))
	default:
		// The segment's live definition, NOT segment_subscribers. The cache can be
		// stale and is scoped to definition membership either way.
		var ast json.RawMessage
		if err := tx.QueryRow(ctx, `
SELECT query_ast FROM segments WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, segmentID).Scan(&ast); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, fmt.Errorf("segment %s not found", segmentID)
			}
			return nil, fmt.Errorf("load segment: %w", err)
		}
		predicate, err := segments.CompilePopulation(ctx, ast, tenantID,
			segments.TransactionSegmentResolver{Queryer: tx},
			segments.ActivationPopulation(segments.ActivationChannelEmail))
		if err != nil {
			return nil, fmt.Errorf("compile segment: %w", err)
		}
		args = append(append([]any{}, predicate.Args...), AudienceMaxRows)
		query = `
SELECT subscribers.email::text, subscribers.custom_fields, subscribers.tags,
       subscribers.status, subscribers.consent_timestamp` + predictionSelect + `
  FROM subscribers` + predictionJoin + `
 WHERE subscribers.email <> '' AND (` + predicate.SQL + `)
 ORDER BY subscribers.email ASC LIMIT $` + strconv.Itoa(len(args))
	}

	// The ungated population, for the gating signal below. Counted in the same
	// transaction so both numbers describe one snapshot. A failure here is
	// deliberately ignored: it must never turn a working export into an error.
	var ungated int
	if listID != "" {
		_ = tx.QueryRow(ctx, `
SELECT count(*) FROM list_subscribers ls JOIN subscribers ON subscribers.id = ls.subscriber_id
 WHERE ls.tenant_id = $1::uuid AND ls.list_id = $2::uuid AND ls.removed_at IS NULL
   AND subscribers.email <> ''`, tenantID, listID).Scan(&ungated)
	} else {
		_ = tx.QueryRow(ctx, `
SELECT count(*) FROM segment_subscribers ss JOIN subscribers ON subscribers.id = ss.subscriber_id
 WHERE ss.tenant_id = $1::uuid AND ss.segment_id = $2::uuid
   AND subscribers.email <> ''`, tenantID, segmentID).Scan(&ungated)
	}

	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("resolve audience: %w", err)
	}
	out := []AudienceMember{}
	for rows.Next() {
		var (
			email     string
			customRaw []byte
			tags      []string
			status    string
			consentTS *time.Time
			pred      predictionScan
		)
		if err := rows.Scan(&email, &customRaw, &tags, &status, &consentTS,
			&pred.predictedCLV, &pred.historicCLV, &pred.totalCLV,
			&pred.churnRisk, &pred.predictedOrders, &pred.expectedNextOrderAt, &pred.predictedGender,
			&pred.rfmScore, &pred.rfmSegment, &pred.recencyScore, &pred.frequencyScore, &pred.monetaryScore); err != nil {
			return nil, err
		}
		traits := buildTraits(customRaw, tags, status, consentTS)
		addPredictionTraits(traits, pred)
		out = append(out, AudienceMember{Email: email, Traits: traits})
	}
	if withheld := ungated - len(out); withheld > 0 && r.Logger != nil {
		// WARN when the gate removes EVERYONE, because that is indistinguishable
		// from a broken target and is the case an operator needs to see; a
		// partial reduction is expected and normal.
		level := slog.LevelInfo
		if len(out) == 0 && ungated > 0 {
			level = slog.LevelWarn
		}
		r.Logger.Log(ctx, level, "writeback audience gated",
			"tenant_id", tenantID, "target_id", target.ID, "provider", target.Provider,
			"eligible", len(out), "in_source", ungated, "withheld", withheld)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// predictionSelect/predictionJoin add Klaviyo-style predicted analytics
// (profile_predictions + profile_rfm_scores, keyed by tenant+email) to the
// resolved audience so they can be SYNCED BACK to source platforms via
// trait_field_map — a two-way predictive sync Klaviyo's Shopify-scoped write-back
// doesn't do. LEFT JOIN: members without a score are unaffected.
// Casts make the scan types unambiguous for pgx (numeric -> float8, smallint ->
// int4, citext -> text) — this SELECT runs on every write-back run, so a scan
// mismatch would break the whole feature.
const predictionSelect = `,
       pp.predicted_clv_cents, pp.historic_clv_cents, pp.total_clv_cents,
       pp.churn_risk::float8, pp.predicted_order_count::float8, pp.expected_next_order_at, pp.predicted_gender::text,
       rfm.rfm_score::text, rfm.segment_key::text, rfm.recency_score::int, rfm.frequency_score::int, rfm.monetary_score::int`

// Written against the canonical table name rather than an alias: the compiled
// population predicate targets a `FROM subscribers` relation "whose canonical
// table name remains visible (no alias replacement)", so aliasing subscribers
// here would make every compiled gate fail at runtime.
const predictionJoin = `
  LEFT JOIN profile_predictions pp
         ON pp.tenant_id = subscribers.tenant_id AND pp.email = subscribers.email
  LEFT JOIN profile_rfm_scores rfm
         ON rfm.tenant_id = subscribers.tenant_id AND rfm.email = subscribers.email`

// predictionScan holds the nullable predicted-analytics columns from the LEFT
// JOINs (a member may have no score row yet).
type predictionScan struct {
	predictedCLV, historicCLV, totalCLV         *int
	churnRisk, predictedOrders                  *float64
	expectedNextOrderAt                         *time.Time
	predictedGender, rfmScore, rfmSegment       *string
	recencyScore, frequencyScore, monetaryScore *int
}

// addPredictionTraits overlays present predicted-analytics values onto the trait
// map under reserved underscore keys (so a trait_field_map can map e.g. a
// platform "Predicted_CLV" field to "_predicted_clv_cents"). Absent values are
// skipped, never written as zero.
func addPredictionTraits(traits map[string]any, p predictionScan) {
	setInt := func(k string, v *int) {
		if v != nil {
			traits[k] = *v
		}
	}
	setFloat := func(k string, v *float64) {
		if v != nil {
			traits[k] = *v
		}
	}
	setStr := func(k string, v *string) {
		if v != nil && *v != "" {
			traits[k] = *v
		}
	}
	setInt("_predicted_clv_cents", p.predictedCLV)
	setInt("_historic_clv_cents", p.historicCLV)
	setInt("_total_clv_cents", p.totalCLV)
	setFloat("_churn_risk", p.churnRisk)
	setFloat("_predicted_order_count", p.predictedOrders)
	if p.expectedNextOrderAt != nil {
		traits["_expected_next_order_at"] = p.expectedNextOrderAt.UTC().Format(time.RFC3339)
	}
	setStr("_predicted_gender", p.predictedGender)
	setStr("_rfm_score", p.rfmScore)
	setStr("_rfm_segment", p.rfmSegment)
	setInt("_recency_score", p.recencyScore)
	setInt("_frequency_score", p.frequencyScore)
	setInt("_monetary_score", p.monetaryScore)
}

// buildTraits assembles one subscriber's trait map for per-member field mapping:
// every custom_fields key verbatim (so a trait_field_map can reference whatever
// the tenant stores), plus reserved underscore-prefixed keys for the first-class
// columns (_tags / _status / _consent_timestamp) that can't collide with custom
// field names. Bare aliases (tags/status) are added only when the custom_fields
// don't already define them, so a tenant's own field always wins.
func buildTraits(customRaw []byte, tags []string, status string, consentTS *time.Time) map[string]any {
	traits := map[string]any{}
	if len(customRaw) > 0 {
		_ = json.Unmarshal(customRaw, &traits)
	}
	joinedTags := strings.Join(tags, ",")
	traits["_tags"] = joinedTags
	traits["_status"] = status
	if consentTS != nil {
		traits["_consent_timestamp"] = consentTS.UTC().Format(time.RFC3339)
	} else {
		traits["_consent_timestamp"] = ""
	}
	if _, ok := traits["tags"]; !ok {
		traits["tags"] = joinedTags
	}
	if _, ok := traits["status"]; !ok {
		traits["status"] = status
	}
	return traits
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanTarget(row rowScanner) (*Target, error) {
	var t Target
	var settings []byte
	if err := row.Scan(&t.ID, &t.TenantID, &t.Provider, &t.Name, &t.Status,
		&t.CredentialsRef, &settings, &t.SyncIntervalMinutes, &t.LastRunAt, &t.ErrorMessage, &t.CreatedAt, &t.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	t.Settings = map[string]any{}
	_ = json.Unmarshal(settings, &t.Settings)
	return &t, nil
}

func scanTargets(rows pgx.Rows) ([]Target, error) {
	defer rows.Close()
	out := []Target{}
	for rows.Next() {
		t, err := scanTarget(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

func scanRun(row rowScanner) (*Run, error) {
	var run Run
	var metadata []byte
	if err := row.Scan(&run.ID, &run.TenantID, &run.TargetID, &run.RunMode, &run.Status,
		&run.MembersSeen, &run.Matched, &run.TagsWritten, &run.FieldsWritten, &run.RowsFailed,
		&run.ErrorMessage, &metadata, &run.StartedAt, &run.CompletedAt, &run.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	run.Metadata = map[string]any{}
	_ = json.Unmarshal(metadata, &run.Metadata)
	return &run, nil
}
