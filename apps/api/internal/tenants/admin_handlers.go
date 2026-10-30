// Package tenants exposes admin-only tenant management endpoints used
// by the e2e harness and operator tooling. None of these handlers are
// intended for end-user consumption — every route mounted by this
// package MUST be guarded by an internal-token check so accidental
// exposure (e.g. a misconfigured load balancer) doesn't leak a
// "delete any tenant by slug" knob.
//
// Today the package owns:
//
//	DELETE /api/internal/tenants/{slug}
//	  Cascade-deletes a tenant + every tenant-owned row (subscribers,
//	  campaigns, audit, suppressions, sample-data markers, billing).
//	  Idempotent: 200 OK whether the tenant existed or not.
//
// The cascade list is implemented by issuing per-table DELETEs inside a
// single transaction so a partial failure leaves the database in its
// original state. We rely on FOREIGN KEY ... ON DELETE CASCADE wherever
// the schema author bothered to wire it (most tables) and only need to
// touch the few tables that lack ON DELETE CASCADE explicitly.
//
// We deliberately do NOT delete the row from `tenants` itself with a
// raw DELETE under app.tenant_id — the RLS policies on `tenants`
// enforce that the row id matches the GUC at WITH CHECK time, and a
// plain DELETE outside the WithTenant flow would block. Instead we
// delete after dropping the GUC binding so the cascade fires correctly.
package tenants

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AdminDeps wires the admin handler to its dependencies.
type AdminDeps struct {
	Pool *pgxpool.Pool
	// InternalAPIToken is the shared secret presented as
	// `Authorization: Bearer <token>`. Empty disables the route entirely
	// — production MUST set this; dev may opt out via the dev tenant
	// header pattern (see AllowDevToken).
	InternalAPIToken string
	// AllowDevToken, when true, accepts any non-empty bearer or no
	// bearer at all. Wired only when the dev-mode flags
	// (POSTWAVE_DEV_TENANT_SLUG_HEADER) are on. Production must keep
	// this false.
	AllowDevToken bool
}

// MountAdmin registers DELETE /api/internal/tenants/{slug} on the
// supplied router. Caller is responsible for choosing the right router
// scope (typically the top-level router so it doesn't sit behind tenant
// middleware).
func MountAdmin(r chi.Router, d *AdminDeps) {
	r.Delete("/api/internal/tenants/{slug}", d.DeleteTenantHandler)
}

// DeleteTenantHandler removes a tenant and cascades the row deletions.
// 200 OK whether the tenant existed or not. The response body shape is:
//
//	{"deleted": true, "counts": {"subscribers": N, "campaigns": M, ...}}
func (d *AdminDeps) DeleteTenantHandler(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]any{"code": "unauthorized"},
		})
		return
	}
	slug := strings.TrimSpace(chi.URLParam(r, "slug"))
	if slug == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]any{"code": "missing_slug"},
		})
		return
	}
	if d.Pool == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "no_pool"},
		})
		return
	}

	tenantID, err := lookupTenantIDBySlug(r.Context(), d.Pool, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Idempotent: deleting a missing tenant is success.
			writeJSON(w, http.StatusOK, map[string]any{
				"deleted": true,
				"existed": false,
				"counts":  map[string]int64{},
				"slug":    slug,
			})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "lookup_failed", "message": "an internal error occurred"},
		})
		return
	}

	counts, err := cascadeDelete(r.Context(), d.Pool, tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "delete_failed", "message": "an internal error occurred"},
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted":  true,
		"existed":  true,
		"slug":     slug,
		"tenantId": tenantID,
		"counts":   counts,
	})
}

// authorize accepts requests under one of two regimes:
//
//  1. Production — `Authorization: Bearer <InternalAPIToken>`. The
//     comparison is constant-time-ish via subtle equivalent (we skip
//     timing safety because the token is rotated per-deploy and the
//     route is internal-only; an attacker who can probe this with
//     timing has already breached the perimeter).
//  2. Dev — when AllowDevToken is true, any request with the dev tenant
//     header on (or no token at all) is allowed. The dev gate is the
//     same env var that already powers POSTWAVE_DEV_TENANT_SLUG_HEADER,
//     so misconfiguring one already implies the other.
func (d *AdminDeps) authorize(r *http.Request) bool {
	if d.AllowDevToken {
		return true
	}
	want := strings.TrimSpace(d.InternalAPIToken)
	if want == "" {
		// No token configured AND not in dev mode → fail closed.
		return false
	}
	got := r.Header.Get("Authorization")
	if !strings.HasPrefix(got, "Bearer ") {
		return false
	}
	got = strings.TrimSpace(strings.TrimPrefix(got, "Bearer "))
	return got == want
}

func lookupTenantIDBySlug(ctx context.Context, pool *pgxpool.Pool, slug string) (string, error) {
	// Internal admin handler — runs entirely outside the tenant
	// middleware chain, so app.tenant_id is never bound. Opt into the
	// resolver-only SELECT policy on `tenants` (migration 0333) via a
	// short tx with app.tenant_resolver = 'true'. Without this the
	// narrow policy denies the lookup and slug-by-bearer cascade-delete
	// always returns "deleted but did not exist".
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read-only tx
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_resolver', 'true', true)`); err != nil {
		return "", err
	}

	const q = `SELECT id::text FROM tenants WHERE slug = $1`
	var id string
	if err := tx.QueryRow(ctx, q, slug).Scan(&id); err != nil {
		return "", err
	}
	return id, nil
}

// cascadeDelete deletes every tenant-owned row in a single transaction.
// We bind app.tenant_id at the start so RLS policies still authorize
// each DELETE; tenants.row deletion at the end happens under the same
// GUC because the tenants table's DELETE policy requires the row id to
// equal app.tenant_id.
//
// Rollback semantics: if any DELETE fails the entire tx rolls back and
// the tenant remains intact.
func cascadeDelete(ctx context.Context, pool *pgxpool.Pool, tenantID string) (map[string]int64, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	// Schema/sidecar guards correctly reject ordinary deletion of populated or
	// required audience fields. This transaction is the reviewed whole-tenant
	// erasure path, so mark it explicitly; database triggers may then allow both
	// stores and their owning subscriber rows to disappear atomically.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_cascade_delete', 'on', true)`); err != nil {
		return nil, err
	}

	tables, err := tenantOwnedTables(ctx, tx)
	if err != nil {
		return nil, err
	}

	counts := make(map[string]int64, len(tables)+1)
	lastErrs := map[string]string{}
	for pass, pending := 0, tables; len(pending) > 0; pass++ {
		if pass > len(tables)+1 {
			return nil, fmt.Errorf("delete tenant-owned rows stalled: %s", formatDeleteErrors(lastErrs))
		}
		next := make([]string, 0, len(pending))
		progressed := false
		for i, table := range pending {
			savepoint := fmt.Sprintf("del_%03d_%03d", pass, i)
			if _, err := tx.Exec(ctx, "SAVEPOINT "+savepoint); err != nil {
				return nil, err
			}
			tag, err := tx.Exec(ctx,
				`DELETE FROM `+quoteIdent(table)+` WHERE tenant_id = $1::uuid`, tenantID)
			if err != nil {
				_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+savepoint)
				_, _ = tx.Exec(ctx, "RELEASE SAVEPOINT "+savepoint)
				lastErrs[table] = err.Error()
				if isDeleteOrderError(err) || isUndefinedTable(err) {
					next = append(next, table)
					continue
				}
				return nil, fmt.Errorf("delete %s: %w", table, err)
			}
			if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT "+savepoint); err != nil {
				return nil, err
			}
			counts[table] += tag.RowsAffected()
			delete(lastErrs, table)
			progressed = true
		}
		if len(next) > 0 && !progressed {
			return nil, fmt.Errorf("delete tenant-owned rows blocked: %s", formatDeleteErrors(lastErrs))
		}
		pending = next
	}

	// Finally, the tenants row itself. We rely on the WITH CHECK on the
	// tenants RLS policy (see migration 0001) — app.tenant_id is already
	// bound to tenantID, so this DELETE matches.
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return nil, err
	}
	counts["tenants"] = tag.RowsAffected()

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return counts, nil
}

func tenantOwnedTables(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `
SELECT c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p')
   AND a.attname = 'tenant_id'
   AND NOT a.attisdropped
   AND c.relname <> 'tenants'
   AND has_table_privilege(current_user, c.oid, 'DELETE')
   AND (
        c.relrowsecurity
        OR EXISTS (
            SELECT 1
              FROM pg_constraint con
              JOIN pg_class rt ON rt.oid = con.confrelid
              JOIN pg_namespace rn ON rn.oid = rt.relnamespace
             WHERE con.conrelid = c.oid
               AND con.contype = 'f'
               AND rn.nspname = 'public'
               AND rt.relname = 'tenants'
        )
   )
 ORDER BY c.relname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			return nil, err
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tables, nil
}

func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func isDeleteOrderError(err error) bool {
	return sqlState(err) == "23503"
}

// isUndefinedTable returns true for SQLSTATE 42P01 ("relation does not
// exist"). The text fallback keeps older pgx-wrapped errors classified too.
func isUndefinedTable(err error) bool {
	if err == nil {
		return false
	}
	if sqlState(err) == "42P01" {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "SQLSTATE 42P01") ||
		strings.Contains(msg, "does not exist")
}

func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.SQLState()
	}
	return ""
}

func formatDeleteErrors(errs map[string]string) string {
	if len(errs) == 0 {
		return "no blocker details"
	}
	keys := make([]string, 0, len(errs))
	for k := range errs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+errs[k])
	}
	return strings.Join(parts, "; ")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
