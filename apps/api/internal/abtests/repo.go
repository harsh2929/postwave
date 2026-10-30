package abtests

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

// ErrNotFound is returned when a settings/variant lookup misses.
var ErrNotFound = errors.New("abtests: not found")

// Repo wraps the three A/B tables. Every method opens its own
// db.WithTenant tx so RLS fires.
type Repo struct {
	Pool *db.Pool
}

// CreateVariants replaces the campaign's editable variant set. Rows omitted by
// the client are deleted in the same transaction, so removing a variant in the
// editor cannot leave a hidden arm participating in later assignments.
func (r *Repo) CreateVariants(ctx context.Context, tenantID, campaignID string, variants []Variant) ([]Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// campaign_variants IS delivered content: sendloop.loadCampaignBodies joins
	// it per batch and prefers v.subject / v.body_html / v.from_name /
	// v.from_email over the campaign's own. Freezing only the campaigns row left
	// this door wide open — and this method also DELETEs variants the client
	// omitted, which for a mid-send campaign strands every pending recipient
	// already assigned to that arm on "campaign body missing".
	//
	// Checked inside the write's own transaction, so a campaign that starts
	// dispatching concurrently cannot slip between the check and the write.
	if err := campaigndispatch.RequireEditable(ctx, tx, tenantID, campaignID); err != nil {
		return nil, err
	}
	labels := make([]string, 0, len(variants))
	for _, variant := range variants {
		labels = append(labels, variant.VariantLabel)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_ab_settings
   SET winning_variant_id = NULL, winner_decided_at = NULL
 WHERE campaign_id = $1::uuid
   AND winning_variant_id IN (
       SELECT id FROM campaign_variants
        WHERE campaign_id = $1::uuid AND NOT (variant_label = ANY($2::text[]))
   )`, campaignID, labels); err != nil {
		return nil, fmt.Errorf("clear removed winning variant: %w", err)
	}
	if _, err := tx.Exec(ctx, `
DELETE FROM campaign_variants
 WHERE campaign_id = $1::uuid
   AND NOT (variant_label = ANY($2::text[]))`, campaignID, labels); err != nil {
		return nil, fmt.Errorf("delete removed variants: %w", err)
	}

	const q = `
INSERT INTO campaign_variants
    (campaign_id, tenant_id, variant_label, subject, from_name, from_email,
     body_mjml, body_html, weight, send_time_offset_minutes)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (campaign_id, variant_label) DO UPDATE SET
    subject                  = EXCLUDED.subject,
    from_name                = EXCLUDED.from_name,
    from_email               = EXCLUDED.from_email,
    body_mjml                = EXCLUDED.body_mjml,
    body_html                = EXCLUDED.body_html,
    weight                   = EXCLUDED.weight,
    send_time_offset_minutes = EXCLUDED.send_time_offset_minutes
RETURNING id::text, campaign_id::text, tenant_id::text, variant_label,
          COALESCE(subject,''), COALESCE(from_name,''), COALESCE(from_email,''),
          COALESCE(body_mjml,''), COALESCE(body_html,''),
          weight, send_time_offset_minutes, created_at`

	out := make([]Variant, 0, len(variants))
	for _, v := range variants {
		row := tx.QueryRow(ctx, q,
			campaignID, tenantID, v.VariantLabel,
			nilIfEmpty(v.Subject), nilIfEmpty(v.FromName), nilIfEmpty(v.FromEmail),
			nilIfEmpty(v.BodyMJML), nilIfEmpty(v.BodyHTML),
			v.Weight, v.SendTimeOffsetMinutes,
		)
		var got Variant
		if err := row.Scan(&got.ID, &got.CampaignID, &got.TenantID, &got.VariantLabel,
			&got.Subject, &got.FromName, &got.FromEmail,
			&got.BodyMJML, &got.BodyHTML,
			&got.Weight, &got.SendTimeOffsetMinutes, &got.CreatedAt); err != nil {
			return nil, fmt.Errorf("upsert variant %q: %w", v.VariantLabel, err)
		}
		out = append(out, got)
	}
	return out, tx.Commit(ctx)
}

// ListVariants returns all variants for a campaign, ordered by label.
func (r *Repo) ListVariants(ctx context.Context, tenantID, campaignID string) ([]Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
SELECT id::text, campaign_id::text, tenant_id::text, variant_label,
       COALESCE(subject,''), COALESCE(from_name,''), COALESCE(from_email,''),
       COALESCE(body_mjml,''), COALESCE(body_html,''),
       weight, send_time_offset_minutes, created_at
FROM campaign_variants
WHERE campaign_id = $1::uuid
ORDER BY variant_label`

	rows, err := tx.Query(ctx, q, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Variant{}
	for rows.Next() {
		var v Variant
		if err := rows.Scan(&v.ID, &v.CampaignID, &v.TenantID, &v.VariantLabel,
			&v.Subject, &v.FromName, &v.FromEmail,
			&v.BodyMJML, &v.BodyHTML,
			&v.Weight, &v.SendTimeOffsetMinutes, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// ListResults returns the result row for every variant of a campaign. Missing
// rows are returned as zero-value VariantResult so callers can render a
// complete table.
func (r *Repo) ListResults(ctx context.Context, tenantID, campaignID string) ([]VariantResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := refreshResults(ctx, tx, tenantID, campaignID); err != nil {
		return nil, err
	}

	const q = `
SELECT v.id::text, v.tenant_id::text,
       COALESCE(r.recipients_count, 0), COALESCE(r.delivered, 0),
       COALESCE(r.opens, 0), COALESCE(r.clicks, 0),
       COALESCE(r.unsubscribes, 0), COALESCE(r.complaints, 0),
       COALESCE(r.winner, false), r.last_evaluated_at
FROM campaign_variants v
LEFT JOIN campaign_variant_results r ON r.variant_id = v.id
WHERE v.campaign_id = $1::uuid
ORDER BY v.variant_label`

	rows, err := tx.Query(ctx, q, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []VariantResult{}
	for rows.Next() {
		var vr VariantResult
		if err := rows.Scan(&vr.VariantID, &vr.TenantID, &vr.RecipientsCount, &vr.Delivered,
			&vr.Opens, &vr.Clicks, &vr.Unsubscribes, &vr.Complaints, &vr.Winner, &vr.LastEvaluatedAt); err != nil {
			return nil, err
		}
		out = append(out, vr)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// refreshResults materialises exact variant metrics from the authoritative
// recipient assignments and engagement log.  It intentionally recomputes
// distinct-recipient counts so webhook retries and multiple opens/clicks do
// not inflate experiment rates.  ListResults calls it in the same transaction,
// which keeps the UI, scheduler, and winner evaluation on one fresh snapshot.
//
// For every arm (a campaign_variants row of campaignID) it counts the
// campaign_recipients rows assigned to that arm, and, per engagement type, the
// distinct lower-cased addresses of those rows that have an event of that type
// on the campaign the recipient row belongs to.
//
// Recipients are selected by variant, never by campaign. The arms of a test
// created through POST /api/v1/campaigns/ab-test are canonical variants on a
// parent campaign, but the audience is queued on one child campaign per arm,
// and every child recipient carries the parent's variant id
// (campaigns/handlers_queue.go, childCanonicalVariantID). Engagement on those
// rows is recorded against the child. Filtering recipients by campaignID
// reports zeros for every such test.
//
// refreshResultsSQL is shaped so that its cost is linear whatever the
// planner's statistics say. See the comment on it before changing it.
func refreshResults(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) error {
	if _, err := tx.Exec(ctx, refreshResultsSQL, tenantID, campaignID); err != nil {
		return fmt.Errorf("refresh A/B results: %w", err)
	}
	return nil
}

// refreshResultsSQL computes every arm in one pass over the arms' recipients
// and one pass over the engagement of the campaigns those recipients live on.
//
// Why the FULL JOIN. The email match cannot be an index condition: both
// tables are under RLS, and neither lower() nor citext equality is LEAKPROOF,
// so Postgres will not evaluate it below the policy. A nested loop therefore
// re-reads every event of the campaign for every recipient — O(recipients x
// events). The planner picks exactly that whenever the inputs look small,
// which on never-analysed tables (every equality estimated at 0.5%) they
// always do. The previous form, one correlated subquery per metric per arm,
// spent 95-160 s per refresh on two arms of 5,000 recipients and 12,500
// events, and timed the package out on a fresh CI database. PostgreSQL has no
// nested-loop full join: a FULL JOIN runs as a hash or merge join,
// O(recipients + events), with or without statistics, and no planner setting
// has to leak into the rest of the caller's transaction.
//
// The rows a FULL JOIN adds over a LEFT JOIN are events with no assigned
// recipient. They all fall into the variant_id IS NULL group, which matches no
// arm below. Do not filter them out above the join (WHERE or HAVING on a.*):
// a strict condition on the recipient side lets the planner reduce the FULL
// JOIN to a LEFT JOIN, which it is free to run as the nested loop again.
// engaged is MATERIALIZED so no condition from the outer query is pushed into
// it either. TestTheRefreshCannotJoinEventsToRecipientsInALoop checks the plan.
//
// = ANY (ARRAY(subquery)) evaluates the arm ids and the recipients' campaigns
// once, up front, so each is applied by the scan that reads its table rather
// than by two more joins. They can be index conditions on (tenant_id,
// variant_id) and (tenant_id, campaign_id); whether they are depends on the
// server version and the statistics. On the plan tests' small fixture,
// PostgreSQL 17 reads subscriber_events by the (tenant_id, campaign_id) index
// condition, while PostgreSQL 16, which CI runs, fetches by tenant and applies
// campaign_id = ANY as a filter of the same scan. Either way no other
// campaign's event reaches the join
// (TestTheRefreshJoinsOnlyTheEventsOfTheArmsCampaigns).
//
// Tenant scoping is explicit on every scan and matches RLS: the transaction's
// app.tenant_id is tenantID (db.WithTenant).
const refreshResultsSQL = `
WITH arms AS MATERIALIZED (
    SELECT v.id, v.tenant_id
      FROM campaign_variants v
     WHERE v.tenant_id = $1::uuid AND v.campaign_id = $2::uuid
), assigned AS MATERIALIZED (
    SELECT cr.variant_id,
           cr.campaign_id,
           lower(cr.subscriber_email::text) AS email
      FROM campaign_recipients cr
     WHERE cr.tenant_id = $1::uuid
       AND cr.variant_id = ANY (ARRAY(SELECT id FROM arms))
), sized AS MATERIALIZED (
    SELECT variant_id, count(*)::int AS recipients_count
      FROM assigned
     GROUP BY variant_id
), engaged AS MATERIALIZED (
    SELECT a.variant_id,
           count(DISTINCT a.email) FILTER (WHERE e.event_type = 'delivered')::int    AS delivered,
           count(DISTINCT a.email) FILTER (WHERE e.event_type = 'opened')::int       AS opens,
           count(DISTINCT a.email) FILTER (WHERE e.event_type = 'clicked')::int      AS clicks,
           count(DISTINCT a.email) FILTER (WHERE e.event_type = 'unsubscribed')::int AS unsubscribes,
           count(DISTINCT a.email) FILTER (WHERE e.event_type = 'complained')::int   AS complaints
      FROM assigned a
      FULL JOIN (
          SELECT se.campaign_id,
                 lower(se.subscriber_email::text) AS email,
                 se.event_type
            FROM subscriber_events se
           WHERE se.tenant_id = $1::uuid
             AND se.campaign_id = ANY (ARRAY(SELECT DISTINCT campaign_id FROM assigned))
             AND se.event_type IN ('delivered', 'opened', 'clicked', 'unsubscribed', 'complained')
      ) e ON e.campaign_id = a.campaign_id AND e.email = a.email
     GROUP BY a.variant_id
)
INSERT INTO campaign_variant_results
    (variant_id, tenant_id, recipients_count, delivered, opens, clicks,
     unsubscribes, complaints, last_evaluated_at)
SELECT arms.id,
       arms.tenant_id,
       COALESCE(sized.recipients_count, 0),
       COALESCE(engaged.delivered, 0),
       COALESCE(engaged.opens, 0),
       COALESCE(engaged.clicks, 0),
       COALESCE(engaged.unsubscribes, 0),
       COALESCE(engaged.complaints, 0),
       now()
  FROM arms
  LEFT JOIN sized   ON sized.variant_id   = arms.id
  LEFT JOIN engaged ON engaged.variant_id = arms.id
ON CONFLICT (variant_id) DO UPDATE SET
    recipients_count  = EXCLUDED.recipients_count,
    delivered         = EXCLUDED.delivered,
    opens             = EXCLUDED.opens,
    clicks            = EXCLUDED.clicks,
    unsubscribes      = EXCLUDED.unsubscribes,
    complaints        = EXCLUDED.complaints,
    last_evaluated_at = EXCLUDED.last_evaluated_at`

// GetSettings returns the A/B settings for a campaign, or ErrNotFound.
func (r *Repo) GetSettings(ctx context.Context, tenantID, campaignID string) (ABSettings, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return ABSettings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
SELECT campaign_id::text, tenant_id::text, COALESCE(winner_metric,''),
       evaluation_window_hours, winner_recipients_pct, winner_decided_at,
       winning_variant_id::text, COALESCE(sample_pct, 100.0), sample_evaluated_at,
       COALESCE(bandit_strategy,'fixed'), COALESCE(explore_floor,0.1)::float8,
       COALESCE(recompute_interval_minutes,30), last_recomputed_at,
       winner_rollout_campaign_id::text, COALESCE(winner_looks_taken,0)
FROM campaign_ab_settings WHERE campaign_id = $1::uuid`

	var s ABSettings
	var metric string
	var winnerID *string
	var rolloutID *string
	row := tx.QueryRow(ctx, q, campaignID)
	if err := row.Scan(&s.CampaignID, &s.TenantID, &metric, &s.EvaluationWindowHours,
		&s.WinnerRecipientsPct, &s.WinnerDecidedAt, &winnerID,
		&s.SamplePct, &s.SampleEvaluatedAt,
		&s.BanditStrategy, &s.ExploreFloor, &s.RecomputeIntervalMinutes, &s.LastRecomputedAt,
		&rolloutID, &s.WinnerLooksTaken); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ABSettings{}, ErrNotFound
		}
		return ABSettings{}, err
	}
	s.WinnerMetric = WinnerMetric(metric)
	s.WinningVariantID = winnerID
	s.WinnerRolloutCampaignID = rolloutID
	return s, nil
}

// UpsertSettings creates or updates the A/B settings row for a campaign.
func (r *Repo) UpsertSettings(ctx context.Context, tenantID, campaignID string, in ABSettings) (ABSettings, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return ABSettings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	samplePct := in.SamplePct
	if samplePct <= 0 || samplePct > 100 {
		samplePct = 100
	}
	strategy := in.BanditStrategy
	switch strategy {
	case "thompson", "epsilon_greedy", "fixed":
	default:
		strategy = "fixed"
	}
	exploreFloor := in.ExploreFloor
	if exploreFloor <= 0 || exploreFloor > 1 {
		exploreFloor = 0.1
	}
	interval := in.RecomputeIntervalMinutes
	if interval <= 0 {
		interval = 30
	}
	const q = `
INSERT INTO campaign_ab_settings
    (campaign_id, tenant_id, winner_metric, evaluation_window_hours,
     winner_recipients_pct, sample_pct, bandit_strategy, explore_floor,
     recompute_interval_minutes)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (campaign_id) DO UPDATE SET
    winner_metric              = EXCLUDED.winner_metric,
    evaluation_window_hours    = EXCLUDED.evaluation_window_hours,
    winner_recipients_pct      = EXCLUDED.winner_recipients_pct,
    sample_pct                 = EXCLUDED.sample_pct,
    bandit_strategy            = EXCLUDED.bandit_strategy,
    explore_floor              = EXCLUDED.explore_floor,
    recompute_interval_minutes = EXCLUDED.recompute_interval_minutes
RETURNING campaign_id::text, tenant_id::text, COALESCE(winner_metric,''),
          evaluation_window_hours, winner_recipients_pct, winner_decided_at,
          winning_variant_id::text, COALESCE(sample_pct, 100.0), sample_evaluated_at,
          COALESCE(bandit_strategy,'fixed'), COALESCE(explore_floor,0.1)::float8,
          COALESCE(recompute_interval_minutes,30), last_recomputed_at`

	var s ABSettings
	var metric string
	var winnerID *string
	row := tx.QueryRow(ctx, q, campaignID, tenantID, string(in.WinnerMetric),
		in.EvaluationWindowHours, in.WinnerRecipientsPct, samplePct,
		strategy, exploreFloor, interval)
	if err := row.Scan(&s.CampaignID, &s.TenantID, &metric, &s.EvaluationWindowHours,
		&s.WinnerRecipientsPct, &s.WinnerDecidedAt, &winnerID,
		&s.SamplePct, &s.SampleEvaluatedAt,
		&s.BanditStrategy, &s.ExploreFloor, &s.RecomputeIntervalMinutes, &s.LastRecomputedAt); err != nil {
		return ABSettings{}, err
	}
	s.WinnerMetric = WinnerMetric(metric)
	s.WinningVariantID = winnerID
	return s, tx.Commit(ctx)
}

// MarkWinner persists the winning_variant_id + winner_decided_at on the
// settings row and flips the matching variant_results row's winner flag.
func (r *Repo) MarkWinner(ctx context.Context, tenantID, campaignID, variantID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`UPDATE campaign_ab_settings SET winning_variant_id = $1::uuid, winner_decided_at = now()
         WHERE campaign_id = $2::uuid`,
		variantID, campaignID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE campaign_variant_results SET winner = (variant_id = $1::uuid), last_evaluated_at = now()
         WHERE variant_id IN (SELECT id FROM campaign_variants WHERE campaign_id = $2::uuid)`,
		variantID, campaignID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MarkSampleEvaluated stamps the sample_evaluated_at timestamp on
// the campaign_ab_settings row, signalling that the auto-promotion
// scheduler has decided the winner + the remaining (100 - sample_pct)%
// of the audience is ready for the winning variant. The dispatcher
// reads this column to enqueue the second-phase send.
//
// Idempotent: re-running on a row that's already stamped is a no-op
// (the WHERE clause filters them out).
func (r *Repo) MarkSampleEvaluated(ctx context.Context, tenantID, campaignID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE campaign_ab_settings
		    SET sample_evaluated_at = now()
		  WHERE campaign_id = $1::uuid
		    AND sample_evaluated_at IS NULL`,
		campaignID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MarkWinnerDispatched stamps campaign_ab_settings.winner_dispatched_at
// + winner_rollout_campaign_id, signalling that the auto-rollout
// dispatcher has created the second-phase child campaign. Idempotent:
// re-running on a row that's already stamped is a no-op (the WHERE
// clause filters them out).
//
// rolloutCampaignID is the id of the child campaign the
// RolloutCreator just produced; we persist it for dashboard /
// forensics surfacing — operators ask "which send was the
// auto-rollout?" and want one query to answer.
// MarkWinnerInconclusive records that a promoted variant did NOT clear the
// significance bar.
//
// Called only after MarkWinner, and deliberately separate from it: the winner
// row is what drives the rollout, and the rollout should proceed either way.
// What must not happen is a report reading `winner_decided_at` and calling this
// a result — hence a distinct fact, written with the reason a human can act on.
func (r *Repo) MarkWinnerInconclusive(ctx context.Context, tenantID, campaignID, note string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_ab_settings
   SET winner_conclusive = false, winner_decision_note = $1
 WHERE campaign_id = $2::uuid`, note, campaignID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordWinnerLook spends one unit of the campaign's alpha budget and returns
// the count AFTER the increment.
//
// Returned from the UPDATE rather than read back separately: two schedulers, or
// a scheduler racing an operator's POST /ab/evaluate, would otherwise both read
// the same count, both believe they were look 7, and take eight looks against a
// budget of seven. A read-modify-write here is the same lost-update bug that
// makes peeking dangerous in the first place, one level down.
func (r *Repo) RecordWinnerLook(ctx context.Context, tenantID, campaignID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var taken int
	if err := tx.QueryRow(ctx, `
UPDATE campaign_ab_settings
   SET winner_looks_taken = winner_looks_taken + 1
 WHERE campaign_id = $1::uuid
RETURNING winner_looks_taken`, campaignID).Scan(&taken); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return taken, nil
}

func (r *Repo) MarkWinnerDispatched(ctx context.Context, tenantID, campaignID, rolloutCampaignID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE campaign_ab_settings
		    SET winner_dispatched_at = now(),
		        winner_rollout_campaign_id = NULLIF($2,'')::uuid
		  WHERE campaign_id = $1::uuid
		    AND winner_dispatched_at IS NULL`,
		campaignID, rolloutCampaignID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func nilIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
