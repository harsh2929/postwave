// SPDX-License-Identifier: AGPL-3.0-only
//
// dedicated_ip_repo.go — Postgres CRUD for the
// dedicated_ip_assignments table (migration 0114).
//
// The legacy single-IP-per-tenant model lives on sending_state.
// dedicated_ip; the new many-IPs-per-tenant model lives here.
// Callers should ListByTenant first; if empty, fall back to the
// legacy column. Once a tenant has rows here, the legacy field is
// ignored.

package sending

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// DedicatedIPRepo is the pgx-backed assignments store.
type DedicatedIPRepo struct {
	Pool *db.Pool
}

// Assignment mirrors one dedicated_ip_assignments row.
type Assignment struct {
	ID                 string
	TenantID           string
	IP                 string
	Pool               string
	Status             string
	HaltedReason       string
	HaltedAt           *time.Time
	WarmupStartedAt    *time.Time
	Provider           string
	ProviderResourceID string
	CreatedAt          time.Time
}

// AssignmentStatus values for IsActive checks.
const (
	AssignmentActive   = "active"
	AssignmentDraining = "draining"
	AssignmentRetired  = "retired"
)

// HaltReason values for status flips.
const (
	HaltReasonBlocklistTier1 = "blocklist_tier1"
	HaltReasonEngagementCrit = "engagement_critical"
	HaltReasonManual         = "manual"
)

// ErrAssignmentNotFound is returned by Get when the row doesn't exist.
var ErrAssignmentNotFound = errors.New("dedicated_ip: assignment not found")

// Assign inserts a new IP assignment under status=active. Idempotent
// via the (tenant_id, ip) UNIQUE constraint — re-assigning an
// existing IP returns the existing row.
func (r *DedicatedIPRepo) Assign(ctx context.Context, tenantID, ip, pool, provider, providerResourceID string) (*Assignment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO dedicated_ip_assignments
    (tenant_id, ip, pool, status, provider, provider_resource_id,
     warmup_started_at)
VALUES ($1::uuid, $2, $3, 'active', $4, NULLIF($5, ''), now())
ON CONFLICT (tenant_id, ip) DO UPDATE
   SET status = 'active',
       halted_reason = NULL,
       halted_at = NULL
RETURNING `+assignmentCols, tenantID, ip, pool, provider, providerResourceID)
	a, err := scanAssignment(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// ListByTenant returns every assignment for the tenant, newest first.
func (r *DedicatedIPRepo) ListByTenant(ctx context.Context, tenantID string) ([]Assignment, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+assignmentCols+`
  FROM dedicated_ip_assignments
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Assignment{}
	for rows.Next() {
		a, err := scanAssignment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// ListActiveForTenant returns the subset of ListByTenant where
// status='active'. The dispatcher consults this on every send to
// pick which IP gets the next message.
func (r *DedicatedIPRepo) ListActiveForTenant(ctx context.Context, tenantID string) ([]Assignment, error) {
	all, err := r.ListByTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	out := make([]Assignment, 0, len(all))
	for _, a := range all {
		if a.Status == AssignmentActive {
			out = append(out, a)
		}
	}
	return out, nil
}

// MarkDraining flips an assignment to status='draining' with the
// supplied reason. Used by the auto-rotation hook when an IP halts
// (blocklist tier-1 hit or engagement-critical).
//
// Runs in the worker-permissive context so the snapshot job can call
// it without a tenant context. Tenant-initiated calls MUST use
// MarkDrainingForTenant instead — see Drain handler.
func (r *DedicatedIPRepo) MarkDraining(ctx context.Context, assignmentID, reason string) error {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE dedicated_ip_assignments
   SET status = 'draining', halted_reason = $2, halted_at = now()
 WHERE id::text = $1 AND status = 'active'`, assignmentID, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Already draining/retired — not an error from the caller's view.
		return tx.Commit(ctx)
	}
	return tx.Commit(ctx)
}

// MarkDrainingForTenant is the tenant-initiated variant of MarkDraining.
// Opens a tenant-scoped transaction so RLS prevents cross-tenant halts.
// The handler at dedicated_ip_handlers.go (Drain) MUST use this; the
// snapshot worker can keep using MarkDraining since it sweeps across
// every tenant.
func (r *DedicatedIPRepo) MarkDrainingForTenant(ctx context.Context, tenantID, assignmentID, reason string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE dedicated_ip_assignments
   SET status = 'draining', halted_reason = $3, halted_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND status = 'active'`,
		tenantID, assignmentID, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAssignmentNotFound
	}
	return tx.Commit(ctx)
}

// ListAllActive returns every active assignment across every tenant.
// Used by the snapshot worker to know which IPs to compute reputation
// for. Worker-permissive context.
func (r *DedicatedIPRepo) ListAllActive(ctx context.Context) ([]Assignment, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+assignmentCols+`
  FROM dedicated_ip_assignments
 WHERE status = 'active'
 ORDER BY tenant_id, ip`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Assignment{}
	for rows.Next() {
		a, err := scanAssignment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// WriteSnapshot persists one IP's reputation snapshot. The snapshot
// table keeps a rolling history; an older-than-7-day janitor (run
// alongside the snapshot worker) prunes the tail.
func (r *DedicatedIPRepo) WriteSnapshot(ctx context.Context, tenantID, ip, pool string, rep IPReputation) error {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tenantArg any
	if tenantID != "" {
		tenantArg = tenantID
	}
	_, err = tx.Exec(ctx, `
INSERT INTO ip_reputation_snapshots
    (ip, tenant_id, pool, blocklist_hits, bounce_rate_7d, complaint_rate_7d,
     sender_score, halted, health, sampled_at)
VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, now())`,
		ip, tenantArg, pool,
		rep.BlocklistHits, rep.BounceRate7d, rep.ComplaintRate7d,
		rep.SenderScore, rep.Halted, computeHealth(rep))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PruneOldSnapshots removes ip_reputation_snapshots older than maxAge.
func (r *DedicatedIPRepo) PruneOldSnapshots(ctx context.Context, maxAge time.Duration) (int64, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cutoff := time.Now().UTC().Add(-maxAge)
	tag, err := tx.Exec(ctx,
		`DELETE FROM ip_reputation_snapshots WHERE sampled_at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// LatestSnapshotsByTenant returns the most-recent snapshot per IP for
// one tenant. Used by the dashboard's IP-health table.
func (r *DedicatedIPRepo) LatestSnapshotsByTenant(ctx context.Context, tenantID string) ([]IPReputation, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT DISTINCT ON (ip)
       ip, pool, blocklist_hits, bounce_rate_7d, complaint_rate_7d,
       sender_score, halted
  FROM ip_reputation_snapshots
 WHERE tenant_id = $1::uuid
 ORDER BY ip, sampled_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IPReputation{}
	for rows.Next() {
		var rep IPReputation
		if err := rows.Scan(
			&rep.IP, &rep.Pool, &rep.BlocklistHits,
			&rep.BounceRate7d, &rep.ComplaintRate7d,
			&rep.SenderScore, &rep.Halted,
		); err != nil {
			return nil, err
		}
		out = append(out, rep)
	}
	return out, rows.Err()
}

// --- internals ---

const assignmentCols = `id::text, tenant_id::text, ip, pool, status,
        COALESCE(halted_reason,''), halted_at, warmup_started_at,
        provider, COALESCE(provider_resource_id,''), created_at`

func scanAssignment(s scanner) (*Assignment, error) {
	var a Assignment
	var haltedAt, warmupAt *time.Time
	if err := s.Scan(
		&a.ID, &a.TenantID, &a.IP, &a.Pool, &a.Status,
		&a.HaltedReason, &haltedAt, &warmupAt,
		&a.Provider, &a.ProviderResourceID, &a.CreatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAssignmentNotFound
		}
		return nil, fmt.Errorf("scan assignment: %w", err)
	}
	a.HaltedAt = haltedAt
	a.WarmupStartedAt = warmupAt
	return &a, nil
}

type scanner interface {
	Scan(dst ...any) error
}
