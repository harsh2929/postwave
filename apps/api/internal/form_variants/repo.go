package form_variants

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a variant lookup misses.
var ErrNotFound = errors.New("form_variants: not found")

// ErrLabelConflict is the unique-violation translation for (form_id, label).
var ErrLabelConflict = errors.New("form_variants: label already in use for this form")

// Repo is the persistence surface for form variants + their bandit
// impressions + the promotion audit log. Every admin method opens a
// tenant-scoped tx via db.WithTenant.
//
// The public render + submit increments run OUTSIDE tenant middleware
// (same as forms.Repo.InsertSubmission); we expose
// IncrementImpressionPublic / IncrementSubmissionPublic for that path.
type Repo struct {
	Pool *db.Pool
}

// List returns the variants for one form, ordered by label (stable for UI).
// Each row carries the running impressions/submissions joined in.
func (r *Repo) List(ctx context.Context, tenantID, formID string) ([]Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := r.listInTx(ctx, tx, formID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) listInTx(ctx context.Context, tx pgx.Tx, formID string) ([]Variant, error) {
	rows, err := tx.Query(ctx, `
SELECT v.id::text, v.tenant_id::text, v.form_id::text, v.variant_label,
       v.display_config, v.traffic_pct, v.status, v.promoted_at, v.last_z_score,
       v.created_at, v.updated_at,
       COALESCE(i.impressions, 0) AS impressions,
       COALESCE(i.submissions, 0) AS submissions
FROM form_variants v
LEFT JOIN form_variant_impressions i
       ON i.tenant_id = v.tenant_id
      AND i.form_id   = v.form_id
      AND i.variant_id = v.id
WHERE v.form_id::text = $1
ORDER BY v.variant_label ASC`, formID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Variant{}
	for rows.Next() {
		var (
			v          Variant
			configRaw  []byte
			promotedAt *string
		)
		_ = promotedAt
		if err := rows.Scan(
			&v.ID, &v.TenantID, &v.FormID, &v.Label,
			&configRaw, &v.TrafficPct, &v.Status, &v.PromotedAt, &v.LastZScore,
			&v.CreatedAt, &v.UpdatedAt,
			&v.Impressions, &v.Submissions,
		); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(configRaw, &v.DisplayConfig)
		if v.DisplayConfig == nil {
			v.DisplayConfig = map[string]any{}
		}
		if v.Impressions > 0 {
			v.ConversionRate = float64(v.Submissions) / float64(v.Impressions)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Create inserts a new variant. Surfaces ErrLabelConflict on the
// (form_id, label) unique violation. Other variants for the form are
// rebalanced to fit alongside the new one (even-split) unless the
// caller explicitly supplied a TrafficPct.
func (r *Repo) Create(ctx context.Context, tenantID, formID string, in CreateInput) (*Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cfgBytes, _ := json.Marshal(in.DisplayConfig)
	if len(cfgBytes) == 0 || string(cfgBytes) == "null" {
		cfgBytes = []byte("{}")
	}
	// Determine initial traffic_pct. If caller specified one, use it;
	// otherwise compute even split with existing exploring variants.
	var trafficPct int
	if in.TrafficPct > 0 {
		trafficPct = in.TrafficPct
	} else {
		var existing int
		if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM form_variants WHERE form_id::text = $1 AND status = 'exploring'
`, formID).Scan(&existing); err != nil {
			return nil, err
		}
		// New variant will be #(existing+1), even split.
		trafficPct = 100 / (existing + 1)
		if trafficPct == 0 {
			trafficPct = 1
		}
	}
	row := tx.QueryRow(ctx, `
INSERT INTO form_variants (tenant_id, form_id, variant_label, display_config, traffic_pct, status)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, 'exploring')
RETURNING id::text, created_at, updated_at`,
		tenantID, formID, in.Label, cfgBytes, trafficPct)
	v := &Variant{
		TenantID:      tenantID,
		FormID:        formID,
		Label:         in.Label,
		DisplayConfig: in.DisplayConfig,
		TrafficPct:    trafficPct,
		Status:        StatusExploring,
	}
	if v.DisplayConfig == nil {
		v.DisplayConfig = map[string]any{}
	}
	if err := row.Scan(&v.ID, &v.CreatedAt, &v.UpdatedAt); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrLabelConflict
		}
		return nil, err
	}
	// Rebalance peers to leave room for the new variant if caller didn't
	// pin TrafficPct. We use a simple proportional shrink: every other
	// "exploring" variant gets its traffic_pct scaled by (100-new)/sum.
	if in.TrafficPct == 0 {
		if _, err := tx.Exec(ctx, `
WITH peer_total AS (
    SELECT SUM(traffic_pct)::int AS s
    FROM form_variants
    WHERE form_id::text = $1 AND status = 'exploring' AND id::text <> $2
)
UPDATE form_variants
   SET traffic_pct = GREATEST(1, (traffic_pct * (100 - $3))::int / NULLIF((SELECT s FROM peer_total), 0))
 WHERE form_id::text = $1 AND status = 'exploring' AND id::text <> $2`,
			formID, v.ID, trafficPct); err != nil {
			return nil, err
		}
	}
	// Seed an impressions row so the bandit reads zero (not missing).
	if _, err := tx.Exec(ctx, `
INSERT INTO form_variant_impressions (tenant_id, form_id, variant_id, impressions, submissions)
VALUES ($1::uuid, $2::uuid, $3::uuid, 0, 0)
ON CONFLICT (tenant_id, form_id, variant_id) DO NOTHING`,
		tenantID, formID, v.ID); err != nil {
		return nil, err
	}
	return v, tx.Commit(ctx)
}

// Update applies a patch. AllowedStatusTransition is enforced.
func (r *Repo) Update(ctx context.Context, tenantID, formID, variantID string, in UpdateInput) (*Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cur, err := r.getInTx(ctx, tx, formID, variantID)
	if err != nil {
		return nil, err
	}
	if in.Status != nil && !AllowedStatusTransition(cur.Status, *in.Status) {
		return nil, fmt.Errorf("form_variants: illegal status transition %s -> %s", cur.Status, *in.Status)
	}
	if in.Label != nil {
		cur.Label = *in.Label
	}
	if in.DisplayConfig != nil {
		cur.DisplayConfig = *in.DisplayConfig
	}
	if in.TrafficPct != nil {
		if *in.TrafficPct < 0 || *in.TrafficPct > 100 {
			return nil, fmt.Errorf("form_variants: trafficPct must be 0..100")
		}
		cur.TrafficPct = *in.TrafficPct
	}
	if in.Status != nil {
		cur.Status = *in.Status
	}
	cfgBytes, _ := json.Marshal(cur.DisplayConfig)
	row := tx.QueryRow(ctx, `
UPDATE form_variants
   SET variant_label=$1, display_config=$2::jsonb, traffic_pct=$3, status=$4, updated_at=now()
 WHERE form_id::text = $5 AND id::text = $6
RETURNING updated_at`,
		cur.Label, cfgBytes, cur.TrafficPct, cur.Status, formID, variantID)
	if err := row.Scan(&cur.UpdatedAt); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrLabelConflict
		}
		return nil, err
	}
	return cur, tx.Commit(ctx)
}

// Delete removes a variant + cascades its impressions row.
func (r *Repo) Delete(ctx context.Context, tenantID, formID, variantID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM form_variants WHERE form_id::text = $1 AND id::text = $2`,
		formID, variantID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// Get returns a single variant.
func (r *Repo) Get(ctx context.Context, tenantID, formID, variantID string) (*Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	v, err := r.getInTx(ctx, tx, formID, variantID)
	if err != nil {
		return nil, err
	}
	return v, tx.Commit(ctx)
}

func (r *Repo) getInTx(ctx context.Context, tx pgx.Tx, formID, variantID string) (*Variant, error) {
	row := tx.QueryRow(ctx, `
SELECT v.id::text, v.tenant_id::text, v.form_id::text, v.variant_label,
       v.display_config, v.traffic_pct, v.status, v.promoted_at, v.last_z_score,
       v.created_at, v.updated_at,
       COALESCE(i.impressions, 0), COALESCE(i.submissions, 0)
  FROM form_variants v
  LEFT JOIN form_variant_impressions i
         ON i.tenant_id = v.tenant_id AND i.form_id = v.form_id AND i.variant_id = v.id
 WHERE v.form_id::text = $1 AND v.id::text = $2
 LIMIT 1`, formID, variantID)
	v := &Variant{}
	var cfgRaw []byte
	if err := row.Scan(
		&v.ID, &v.TenantID, &v.FormID, &v.Label,
		&cfgRaw, &v.TrafficPct, &v.Status, &v.PromotedAt, &v.LastZScore,
		&v.CreatedAt, &v.UpdatedAt,
		&v.Impressions, &v.Submissions,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal(cfgRaw, &v.DisplayConfig)
	if v.DisplayConfig == nil {
		v.DisplayConfig = map[string]any{}
	}
	if v.Impressions > 0 {
		v.ConversionRate = float64(v.Submissions) / float64(v.Impressions)
	}
	return v, nil
}

// IncrementImpressionPublic bumps the (form_id, variant_id) impressions
// counter from the unauthenticated render path. The caller (forms public
// handler) has already resolved (tenant_id, form_id) and bound them via
// app.public_form_tenant_id / app.public_form_id. We bind the same GUCs
// inside this tx so the permissive RLS policies match.
func (r *Repo) IncrementImpressionPublic(ctx context.Context, tenantID, formID, variantID string) error {
	return r.incrementPublic(ctx, tenantID, formID, variantID, "impressions")
}

// IncrementSubmissionPublic bumps the submissions counter for the
// variant the user actually saw at submit time.
func (r *Repo) IncrementSubmissionPublic(ctx context.Context, tenantID, formID, variantID string) error {
	return r.incrementPublic(ctx, tenantID, formID, variantID, "submissions")
}

func (r *Repo) incrementPublic(ctx context.Context, tenantID, formID, variantID, column string) error {
	if tenantID == "" || formID == "" || variantID == "" {
		return nil
	}
	if column != "impressions" && column != "submissions" {
		return fmt.Errorf("form_variants: unknown counter %q", column)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_form_tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_form_id', $1, true)`, formID); err != nil {
		return err
	}
	// %s is safe here: column is validated against an allow-list above.
	q := fmt.Sprintf(`
INSERT INTO form_variant_impressions (tenant_id, form_id, variant_id, %s, updated_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, 1, now())
ON CONFLICT (tenant_id, form_id, variant_id) DO UPDATE
   SET %s = form_variant_impressions.%s + 1, updated_at = now()`, column, column, column)
	if _, err := tx.Exec(ctx, q, tenantID, formID, variantID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ApplyDecision persists a Reweight() Decision: writes new traffic_pct
// for every variant, flips the winner's status to "promoted" + the
// peers to "paused" if PromoteVariantID is set, and appends a
// form_variant_promotions audit row.
func (r *Repo) ApplyDecision(ctx context.Context, tenantID, formID string, dec Decision, samples []Sample) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for variantID, pct := range dec.Weights {
		if _, err := tx.Exec(ctx, `
UPDATE form_variants
   SET traffic_pct = $1, last_z_score = $2, updated_at = now()
 WHERE form_id::text = $3 AND id::text = $4`,
			pct, dec.ZScore, formID, variantID); err != nil {
			return err
		}
	}
	if dec.PromoteVariantID != "" {
		// Flip winner to promoted, peers to paused.
		if _, err := tx.Exec(ctx, `
UPDATE form_variants
   SET status = 'promoted', promoted_at = now(), updated_at = now()
 WHERE form_id::text = $1 AND id::text = $2`,
			formID, dec.PromoteVariantID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
UPDATE form_variants
   SET status = 'paused', updated_at = now()
 WHERE form_id::text = $1 AND id::text <> $2 AND status = 'exploring'`,
			formID, dec.PromoteVariantID); err != nil {
			return err
		}
		// Audit row.
		var winnerImps, runnerImps int64
		for _, s := range samples {
			if s.VariantID == dec.PromoteVariantID {
				winnerImps = s.Impressions
			}
			if s.VariantID == dec.RunnerUpVariantID {
				runnerImps = s.Impressions
			}
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO form_variant_promotions
    (tenant_id, form_id, winner_variant_id, winner_rate, runner_up_rate,
     z_score, winner_impressions, runner_up_impressions)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)`,
			tenantID, formID, dec.PromoteVariantID,
			dec.LeaderRate, dec.RunnerUpRate, dec.ZScore,
			winnerImps, runnerImps); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ListPromotions returns the promotion audit feed for one form.
func (r *Repo) ListPromotions(ctx context.Context, tenantID, formID string) ([]Promotion, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, form_id::text, winner_variant_id::text, winner_rate, runner_up_rate,
       z_score, winner_impressions, runner_up_impressions, decided_at
  FROM form_variant_promotions
 WHERE form_id::text = $1
 ORDER BY decided_at DESC
 LIMIT 100`, formID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Promotion{}
	for rows.Next() {
		var p Promotion
		if err := rows.Scan(
			&p.ID, &p.FormID, &p.WinnerVariantID, &p.WinnerRate, &p.RunnerUpRate,
			&p.ZScore, &p.WinnerImpressions, &p.RunnerUpImpressions, &p.DecidedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// SamplesForForm reads the (impressions, submissions) counters for every
// active variant — input to Reweight().
func (r *Repo) SamplesForForm(ctx context.Context, tenantID, formID string) ([]Sample, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT v.id::text, COALESCE(i.impressions, 0), COALESCE(i.submissions, 0)
  FROM form_variants v
  LEFT JOIN form_variant_impressions i
         ON i.tenant_id = v.tenant_id AND i.form_id = v.form_id AND i.variant_id = v.id
 WHERE v.form_id::text = $1 AND v.status = 'exploring'`, formID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Sample{}
	for rows.Next() {
		var s Sample
		if err := rows.Scan(&s.VariantID, &s.Impressions, &s.Submissions); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// PickForRenderPublic resolves the variant a public visitor should see.
// The caller supplies the (tenant_id, form_id) identity already resolved by
// the public form lookup; this method binds both values transaction-locally
// before reading through the exact-form public RLS policy. Selection is
// weighted-random by traffic_pct; when a variant has been promoted, it gets
// all the traffic. When no variants are configured, returns (nil, ErrNotFound)
// so the caller falls back to the default form rendering path.
//
// Note: we DO NOT increment impressions here — that's the public
// render handler's responsibility (it should also write the variant
// id into the rendered page so submit can attribute back). This
// keeps PickForRenderPublic side-effect-free and easy to unit-test.
func (r *Repo) PickForRenderPublic(ctx context.Context, tenantID, formID string, randPct int) (*PickResult, error) {
	if tenantID == "" || formID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_form_tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_form_id', $1, true)`, formID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, variant_label, display_config, traffic_pct, status
  FROM form_variants
 WHERE form_id::text = $1 AND status IN ('exploring','promoted')
 ORDER BY status DESC, variant_label ASC`, formID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type candidate struct {
		ID, Label string
		Config    map[string]any
		Pct       int
		Status    string
	}
	var promoted *candidate
	exploring := []candidate{}
	for rows.Next() {
		var c candidate
		var raw []byte
		if err := rows.Scan(&c.ID, &c.Label, &raw, &c.Pct, &c.Status); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &c.Config)
		if c.Config == nil {
			c.Config = map[string]any{}
		}
		if c.Status == "promoted" {
			cc := c
			promoted = &cc
			continue
		}
		exploring = append(exploring, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if promoted != nil {
		return &PickResult{
			VariantID: promoted.ID, Label: promoted.Label, DisplayConfig: promoted.Config,
		}, nil
	}
	if len(exploring) == 0 {
		return nil, ErrNotFound
	}
	// Weighted choice by traffic_pct. randPct is the caller-supplied
	// random integer in [0, 100). When the weights don't sum to 100
	// (operator drift), we normalize.
	total := 0
	for _, c := range exploring {
		total += c.Pct
	}
	if total <= 0 {
		c := exploring[0]
		return &PickResult{VariantID: c.ID, Label: c.Label, DisplayConfig: c.Config}, nil
	}
	pct := randPct % total
	acc := 0
	for _, c := range exploring {
		acc += c.Pct
		if pct < acc {
			return &PickResult{VariantID: c.ID, Label: c.Label, DisplayConfig: c.Config}, nil
		}
	}
	c := exploring[len(exploring)-1]
	return &PickResult{VariantID: c.ID, Label: c.Label, DisplayConfig: c.Config}, nil
}

func isUniqueViolation(err error) bool {
	type sqlStater interface{ SQLState() string }
	var pgerr sqlStater
	if errors.As(err, &pgerr) {
		return pgerr.SQLState() == "23505"
	}
	return false
}
