// SPDX-License-Identifier: AGPL-3.0-only
//
// Package search owns the Cmd-K palette / global search endpoint:
//
//	GET /api/v1/search?q=...&limit=20
//
// Returns up to 20 results across lists + segments + suppressions +
// subscribers with type tags. V1 is ILIKE-based across name/email/
// description columns; an FTS-backed v2 (using subscribers_fts from
// migration 0242) is a later upgrade.
//
// The package additionally hosts a few small misc Wave-3 endpoints
// that don't justify their own package:
//
//   - GET/PATCH /api/v1/blocklist/auto-suppress
//     Per-tenant blocklist auto-suppress toggle (replaces the
//     env-only POSTWAVE_BLOCKLIST_AUTO_SUPPRESS flag). Stored in
//     the blocklist_settings table from migration 0259.
//
//   - GET /api/v1/lists/{id}/inbox-reality
//     Returns placement scores for the most recent N inbox-reality
//     tests associated with a list (best-effort: we don't have an
//     explicit list_id ↔ test_id linker today, so we surface the
//     latest tests for the tenant and let the UI filter).
package search

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Result is one row in the palette response.
type Result struct {
	Type   string `json:"type"` // list | segment | suppression | subscriber | campaign | flow | template | form
	ID     string `json:"id"`
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
}

// Response is the wire shape.
type Response struct {
	Query   string   `json:"query"`
	Results []Result `json:"results"`
}

// BlocklistAutoSuppress is the wire shape of GET/PATCH on the
// auto-suppress toggle.
type BlocklistAutoSuppress struct {
	AutoSuppress       bool      `json:"auto_suppress"`
	EligibleNow        int64     `json:"eligible_now"`
	ActiveSuppressions int64     `json:"active_suppressions"`
	ObservedAt         time.Time `json:"observed_at"`
}

// Sentinel errors.
var (
	ErrNotFound = errors.New("search: not found")
)

// Repo wraps the pgx pool.
type Repo struct {
	Pool *db.Pool
}

// Query runs the ILIKE-based palette query across the four catalogs
// and returns up to limit results.
func (r *Repo) Query(ctx context.Context, tenantID, q string, limit int) (*Response, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	resp := &Response{Query: q, Results: []Result{}}
	if q == "" {
		return resp, nil
	}
	pat := "%" + q + "%"
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Lists (Listmonk-owned table). Use exports/walkers.go shape.
	if err := r.collect(ctx, tx, &resp.Results, limit, "list", `
SELECT id::text, COALESCE(name,''), COALESCE(description,'')
  FROM lists
 WHERE tenant_id = $1::uuid
   AND (name ILIKE $2 OR description ILIKE $2)
 ORDER BY name
 LIMIT $3`, tenantID, pat); err != nil {
		return nil, err
	}

	// 2. Segments.
	if err := r.collect(ctx, tx, &resp.Results, limit, "segment", `
SELECT id::text, name, COALESCE(description,'')
  FROM segments
 WHERE tenant_id = $1::uuid
   AND (name ILIKE $2 OR description ILIKE $2)
 ORDER BY updated_at DESC
 LIMIT $3`, tenantID, pat); err != nil {
		return nil, err
	}

	// 3. Suppressions (email_suppressions).
	if err := r.collect(ctx, tx, &resp.Results, limit, "suppression", `
SELECT id::text, email::text, reason
  FROM email_suppressions
 WHERE tenant_id = $1::uuid
   AND email::text ILIKE $2
 ORDER BY suppressed_at DESC
 LIMIT $3`, tenantID, pat); err != nil {
		return nil, err
	}

	// 4. Subscribers — match on email or name.
	if err := r.collect(ctx, tx, &resp.Results, limit, "subscriber", `
SELECT id::text, email::text, COALESCE(name,'')
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (email::text ILIKE $2 OR name ILIKE $2)
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, pat); err != nil {
		return nil, err
	}

	// 5. Campaigns — match on name or subject (SHELL-020).
	if err := r.collect(ctx, tx, &resp.Results, limit, "campaign", `
SELECT id::text, name, COALESCE(subject,'')
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND (name ILIKE $2 OR subject ILIKE $2)
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, pat); err != nil {
		return nil, err
	}

	// 6. Flows (automation journeys) — match on name.
	if err := r.collect(ctx, tx, &resp.Results, limit, "flow", `
SELECT id::text, name, COALESCE(status,'')
  FROM automation_journeys
 WHERE tenant_id = $1::uuid
   AND name ILIKE $2
 ORDER BY updated_at DESC
 LIMIT $3`, tenantID, pat); err != nil {
		return nil, err
	}

	// 7. Campaign templates — tenant-owned only (skip global catalog rows).
	if err := r.collect(ctx, tx, &resp.Results, limit, "template", `
SELECT id::text, name, ''
  FROM campaign_templates
 WHERE tenant_id = $1::uuid
   AND name ILIKE $2
 ORDER BY updated_at DESC
 LIMIT $3`, tenantID, pat); err != nil {
		return nil, err
	}

	// 8. Forms — match on name or slug.
	if err := r.collect(ctx, tx, &resp.Results, limit, "form", `
SELECT id::text, name, COALESCE(slug,'')
  FROM forms
 WHERE tenant_id = $1::uuid
   AND (name ILIKE $2 OR slug ILIKE $2)
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, pat); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Truncate to the global limit (each collector cap is the same;
	// guards against the four sources combining over budget).
	if len(resp.Results) > limit {
		resp.Results = resp.Results[:limit]
	}
	return resp, nil
}

// collect runs one of the four catalog queries and appends results.
// The SELECT MUST return (id, title, detail) as the first three columns.
func (r *Repo) collect(ctx context.Context, tx pgx.Tx, out *[]Result, limit int, typ, sql string, args ...any) error {
	args = append(args, limit)
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var r Result
		r.Type = typ
		if err := rows.Scan(&r.ID, &r.Title, &r.Detail); err != nil {
			return err
		}
		*out = append(*out, r)
	}
	return rows.Err()
}

// GetBlocklistAutoSuppress returns the per-tenant toggle. Missing row
// is reported as false (off).
func (r *Repo) GetBlocklistAutoSuppress(ctx context.Context, tenantID string) (bool, error) {
	state, err := r.GetBlocklistAutoSuppressState(ctx, tenantID)
	if err != nil {
		return false, err
	}
	return state.AutoSuppress, nil
}

// GetBlocklistAutoSuppressState returns the stored setting plus the exact
// current action preview used by the desktop confirmation. EligibleNow counts
// subjects whose latest observations meet the two-zone/tier-1 policy and do
// not already have an active blocklist suppression.
func (r *Repo) GetBlocklistAutoSuppressState(ctx context.Context, tenantID string) (BlocklistAutoSuppress, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return BlocklistAutoSuppress{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out BlocklistAutoSuppress
	err = tx.QueryRow(ctx, `
WITH latest AS (
  SELECT DISTINCT ON (subject_type, subject, zone)
         subject_type, subject, zone, listed, confidence
    FROM blocklist_observations
   WHERE tenant_id = $1::uuid
   ORDER BY subject_type, subject, zone, checked_at DESC
), eligible AS (
  SELECT subject_type, subject
    FROM latest
   GROUP BY subject_type, subject
  HAVING SUM(CASE WHEN listed AND confidence >= 0.95 THEN 1 ELSE 0 END) > 0
     AND SUM(CASE WHEN listed THEN 1 ELSE 0 END) >= 2
)
SELECT COALESCE((
         SELECT auto_suppress
           FROM blocklist_settings
          WHERE tenant_id = $1::uuid
       ), false),
       (SELECT count(*)
          FROM eligible e
         WHERE NOT EXISTS (
           SELECT 1
             FROM blocklist_suppressions s
            WHERE s.tenant_id = $1::uuid
              AND s.subject_type = e.subject_type
              AND s.subject = e.subject
              AND s.cleared_at IS NULL
         )),
       (SELECT count(*)
          FROM blocklist_suppressions
         WHERE tenant_id = $1::uuid
           AND cleared_at IS NULL)`, tenantID).Scan(
		&out.AutoSuppress,
		&out.EligibleNow,
		&out.ActiveSuppressions,
	)
	if err != nil {
		return BlocklistAutoSuppress{}, err
	}
	out.ObservedAt = time.Now().UTC()
	if err := tx.Commit(ctx); err != nil {
		return BlocklistAutoSuppress{}, err
	}
	return out, nil
}

// SetBlocklistAutoSuppress upserts the per-tenant toggle.
func (r *Repo) SetBlocklistAutoSuppress(ctx context.Context, tenantID string, v bool) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO blocklist_settings (tenant_id, auto_suppress)
VALUES ($1::uuid, $2)
ON CONFLICT (tenant_id) DO UPDATE
   SET auto_suppress = EXCLUDED.auto_suppress,
       updated_at = now()`,
		tenantID, v)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// InboxRealityForList returns the most recent N inbox_reality_tests
// rows for the tenant + their per-provider summary. The join to the
// list_id is best-effort: today inbox_reality_tests has no FK to
// lists, so we return the tenant-wide most recent tests and let the
// UI surface them as the "inbox reality" tile on the list detail page.
type InboxRealityRow struct {
	TestID     string  `json:"test_id"`
	Subject    string  `json:"subject,omitempty"`
	CreatedAt  string  `json:"created_at"`
	Status     string  `json:"status"`
	TotalSeeds int     `json:"total_seeds"`
	Inbox      int     `json:"inbox"`
	Spam       int     `json:"spam"`
	Missing    int     `json:"missing"`
	InboxPct   float64 `json:"inbox_pct"`
}

// InboxRealityForList returns up to limit recent test summaries.
func (r *Repo) InboxRealityForList(ctx context.Context, tenantID, listID string, limit int) ([]InboxRealityRow, error) {
	if limit <= 0 || limit > 25 {
		limit = 10
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT t.id::text, COALESCE(t.subject,''),
       t.created_at::text, t.status,
       COUNT(r.id)::int AS total,
       COALESCE(SUM(CASE WHEN r.placement = 'inbox' THEN 1 ELSE 0 END),0)::int AS inbox,
       COALESCE(SUM(CASE WHEN r.placement = 'spam'  THEN 1 ELSE 0 END),0)::int AS spam,
       COALESCE(SUM(CASE WHEN r.placement = 'missing' THEN 1 ELSE 0 END),0)::int AS missing
  FROM inbox_reality_tests t
  LEFT JOIN inbox_reality_test_results r ON r.test_id = t.id
 WHERE t.tenant_id = $1::uuid
 GROUP BY t.id, t.subject, t.created_at, t.status
 ORDER BY t.created_at DESC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []InboxRealityRow{}
	for rows.Next() {
		var row InboxRealityRow
		if err := rows.Scan(&row.TestID, &row.Subject, &row.CreatedAt,
			&row.Status, &row.TotalSeeds, &row.Inbox, &row.Spam, &row.Missing); err != nil {
			return nil, err
		}
		if row.TotalSeeds > 0 {
			row.InboxPct = float64(row.Inbox) / float64(row.TotalSeeds) * 100.0
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// listID is accepted but not used in the join today (see doc).
	_ = listID
	return out, tx.Commit(ctx)
}
