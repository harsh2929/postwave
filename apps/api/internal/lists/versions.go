// SPDX-License-Identifier: AGPL-3.0-only
//
// versions.go — daily per-list snapshot rows into list_versions
// (migration 0255, GAP-LS-062) backing the "over time by version" list
// analytics. The migration anticipated "a daily-tick worker (lands
// later)"; this is that worker plus the GET /versions reader.
//
// RLS shape mirrors segments.SnapshotWorker: tenant enumeration runs
// cross-tenant under db.WithWorkerScope; everything per-tenant (member
// counting + the version insert) re-enters db.WithTenant so list_versions
// writes stay behind tenant RLS (the table has no worker gate).
//
// The tick is hourly but idempotent per UTC day: a NOT EXISTS guard skips
// lists that already have today's snapshot, so a list is versioned once per
// day (catching up automatically after downtime). version is computed as
// COALESCE(MAX(version),0)+1 per (tenant,list); the worker is single-leader
// and the daily guard prevents same-day duplicates, with the table's
// UNIQUE(tenant_id,list_id,version) as a backstop.

package lists

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// versionSnapshotMaxListsPerTenantPerTick bounds one tenant's work per tick
// so a tenant with very many lists drains gradually.
const versionSnapshotMaxListsPerTenantPerTick = 500

// VersionWorker writes the daily list_versions rows.
type VersionWorker struct {
	Pool     *db.Pool
	Logger   *slog.Logger
	Interval time.Duration
}

// Run drives the worker until ctx is canceled.
func (w *VersionWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("lists version worker: nil deps")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = time.Hour
	}
	if w.Logger != nil {
		w.Logger.Info("list version snapshot worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && !errors.Is(err, context.Canceled) && w.Logger != nil {
			w.Logger.Warn("list version snapshot tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *VersionWorker) tick(ctx context.Context) error {
	tenants, err := w.listTenants(ctx)
	if err != nil {
		return err
	}
	for _, tenantID := range tenants {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.snapshotTenant(ctx, tenantID); err != nil && w.Logger != nil {
			w.Logger.Warn("list version snapshot: tenant failed",
				"tenant_id", tenantID, "err", err.Error())
		}
	}
	return nil
}

func (w *VersionWorker) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// snapshotTenant snapshots each of the tenant's lists that has live members
// and no row for today yet. Each list failure is isolated.
func (w *VersionWorker) snapshotTenant(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
SELECT DISTINCT ls.list_id::text
  FROM list_subscribers ls
 WHERE ls.tenant_id = $1::uuid
   AND ls.removed_at IS NULL
   AND NOT EXISTS (
       SELECT 1 FROM list_versions v
        WHERE v.tenant_id = ls.tenant_id
          AND v.list_id = ls.list_id
          AND v.snapshot_at::date = CURRENT_DATE)
 ORDER BY ls.list_id::text
 LIMIT $2`, tenantID, versionSnapshotMaxListsPerTenantPerTick)
	if err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	todo := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			_ = tx.Rollback(ctx)
			return err
		}
		todo = append(todo, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	_ = tx.Rollback(ctx) // read-only scan; each snapshot uses its own tx

	for _, listID := range todo {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.snapshotList(ctx, tenantID, listID); err != nil && w.Logger != nil {
			w.Logger.Warn("list version snapshot: list failed",
				"tenant_id", tenantID, "list_id", listID, "err", err.Error())
		}
	}
	return nil
}

// snapshotList counts the live members of one list and appends a new version
// row carrying member_count + a change_summary delta vs the previous version.
func (w *VersionWorker) snapshotList(ctx context.Context, tenantID, listID string) error {
	tx, txErr := db.WithTenant(ctx, w.Pool, tenantID)
	if txErr != nil {
		return txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var memberCount int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM list_subscribers
 WHERE tenant_id = $1::uuid AND list_id::text = $2 AND removed_at IS NULL`,
		tenantID, listID).Scan(&memberCount); err != nil {
		return err
	}

	var prevVersion, prevCount int
	first := false
	txErr = tx.QueryRow(ctx, `
SELECT version, member_count FROM list_versions
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid
 ORDER BY version DESC LIMIT 1`, tenantID, listID).Scan(&prevVersion, &prevCount)
	if errors.Is(txErr, pgx.ErrNoRows) {
		first = true
	} else if txErr != nil {
		return txErr
	}

	summary, _ := json.Marshal(map[string]any{
		"previous_member_count": prevCount,
		"member_count_delta":    memberCount - prevCount,
		"first_snapshot":        first,
	})

	if _, err := tx.Exec(ctx, `
INSERT INTO list_versions (tenant_id, list_id, version, member_count, change_summary)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
		tenantID, listID, prevVersion+1, memberCount, string(summary)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------

// ListVersion is one list_versions row in the API response.
type ListVersion struct {
	Version       int             `json:"version"`
	SnapshotAt    time.Time       `json:"snapshot_at"`
	MemberCount   int             `json:"member_count"`
	ChangeSummary json.RawMessage `json:"change_summary"`
}

// ListVersions returns a list's snapshot history, newest version first.
func (r *Repo) ListVersions(ctx context.Context, tenantID, listID string) ([]ListVersion, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT version, snapshot_at, member_count, change_summary
  FROM list_versions
 WHERE tenant_id = $1::uuid AND list_id::text = $2
 ORDER BY version DESC`, tenantID, listID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ListVersion{}
	for rows.Next() {
		var v ListVersion
		var raw []byte
		if err := rows.Scan(&v.Version, &v.SnapshotAt, &v.MemberCount, &raw); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			v.ChangeSummary = json.RawMessage(raw)
		} else {
			v.ChangeSummary = json.RawMessage("{}")
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// MountVersionRoutes registers the list-version reader. Caller wires the
// tenant middleware upstream (same group as the other list analytics).
func (d *Deps) MountVersionRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/lists/{id}/versions", d.ListVersions)
}

// ListVersions handles GET /api/v1/lists/{id}/versions.
func (d *Deps) ListVersions(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	if d.Repo == nil {
		httperror.WriteInternal(w, d.Logger, errors.New("lists: repo not wired"), r.Context())
		return
	}
	out, err := d.Repo.ListVersions(r.Context(), tenantID, listUUID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id": listUUID,
		"items":   out,
		"total":   len(out),
	})
}
