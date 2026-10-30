// SPDX-License-Identifier: AGPL-3.0-only
package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// DashboardLayout stores the per-user, per-tenant, per-surface ordering of
// widgets. `surface` distinguishes the analytics KPI row from the home
// dashboard (OVR-032). Refined Dashboard PR 4.
type DashboardLayout struct {
	UserID    string    `json:"userId"`
	TenantID  string    `json:"tenantId"`
	Surface   string    `json:"surface"`
	Order     []string  `json:"order"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// defaultLayoutOrders is the per-surface order we return when a user has no row
// yet. Matches the visual order in the React grid so first-touch drags feel
// like rearranging an already-rendered layout.
var defaultLayoutOrders = map[string][]string{
	"analytics": {"subs", "opens", "clicks", "bounces"},
	"home": {
		"performance", "stats", "recommendations", "checklist",
		"upcoming", "campaigns", "activity", "status",
	},
}

// NormalizeLayoutSurface whitelists the surface discriminator; anything
// unrecognized falls back to the analytics KPI row (the historical default).
func NormalizeLayoutSurface(s string) string {
	if s == "home" {
		return "home"
	}
	return "analytics"
}

// GetLayout returns the user's dashboard layout for a surface, or the default
// when nothing's been saved yet. Never returns 404 — the layout is always
// defined (defaults are baked in).
func (r *Repo) GetLayout(ctx context.Context, tenantID, userID, surface string) (*DashboardLayout, error) {
	surface = NormalizeLayoutSurface(surface)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &DashboardLayout{
		UserID:    userID,
		TenantID:  tenantID,
		Surface:   surface,
		Order:     append([]string{}, defaultLayoutOrders[surface]...),
		UpdatedAt: time.Now().UTC(),
	}
	var orderJSON []byte
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `
SELECT layout, updated_at FROM dashboard_layouts
WHERE user_id = $1::uuid AND tenant_id = $2::uuid AND surface = $3`, userID, tenantID, surface).
		Scan(&orderJSON, &updatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil && len(orderJSON) > 0 {
		var ord []string
		if jerr := json.Unmarshal(orderJSON, &ord); jerr == nil && len(ord) > 0 {
			out.Order = ord
			out.UpdatedAt = updatedAt
		}
	}
	return out, tx.Commit(ctx)
}

// ErrInvalidInput marks a caller mistake rather than a server failure.
//
// Without it a handler cannot tell "you sent an empty body" from "the database
// is down", so every rejection here surfaced as a 500: the client could not
// show the operator what to fix, and the error budget counted user typos as
// outages. Follows the convention already in internal/audiences.
var ErrInvalidInput = errors.New("analytics: invalid input")

// SaveLayout upserts the user's chosen widget order for a surface.
func (r *Repo) SaveLayout(ctx context.Context, tenantID, userID, surface string, order []string) error {
	surface = NormalizeLayoutSurface(surface)
	if len(order) == 0 || len(order) > 16 {
		return fmt.Errorf("%w: layout order must be 1..16 entries", ErrInvalidInput)
	}
	for _, k := range order {
		if k == "" || len(k) > 64 {
			return fmt.Errorf("%w: layout key invalid", ErrInvalidInput)
		}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	b, _ := json.Marshal(order)
	if _, err := tx.Exec(ctx, `
INSERT INTO dashboard_layouts (user_id, tenant_id, surface, layout)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)
ON CONFLICT (user_id, tenant_id, surface)
DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()`,
		userID, tenantID, surface, string(b)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetLayout GET /api/v1/dashboard/layout
func (d *Deps) GetLayout(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u == nil || u.ID == "" {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_user", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	surface := NormalizeLayoutSurface(r.URL.Query().Get("surface"))
	out, err := d.Repo.GetLayout(r.Context(), t.ID, u.ID, surface)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// PutLayout PUT /api/v1/dashboard/layout  {"order": ["subs","opens",...]}
func (d *Deps) PutLayout(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u == nil || u.ID == "" {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_user", ""))
		return
	}
	var in struct {
		Order []string `json:"order"`
	}
	if err := httpbody.DecodeJSON(w, r, 4*1024, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	surface := NormalizeLayoutSurface(r.URL.Query().Get("surface"))
	if err := d.Repo.SaveLayout(r.Context(), t.ID, u.ID, surface, in.Order); err != nil {
		if errors.Is(err, ErrInvalidInput) {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

/* ---------- benchmarks (PR 4) ---------------------------------- */

// BenchmarkRow is one industry-average metric the dashboard compares
// the workspace's own number against. PR 4 ships with illustrative
// hardcoded averages; a follow-up will source these from real data.
type BenchmarkRow struct {
	Metric  string  `json:"metric"`  // "opens" | "clicks" | "bounces" | "unsubs"
	Average float64 `json:"average"` // 0..1
	Source  string  `json:"source"`  // human-readable provenance label
}

// BenchmarksResponse is what GET /api/v1/dashboard/benchmarks returns.
type BenchmarksResponse struct {
	Rows []BenchmarkRow `json:"rows"`
	Note string         `json:"note"`
}

// Hardcoded fallback used when the dashboard_benchmark_cache table is
// empty (e.g. fresh deploy, before the first BenchmarkAggregator
// tick). Numbers from public 2024 newsletter consensus
// (Mailchimp / Litmus / Campaign Monitor).
var illustrativeBenchmarks = []BenchmarkRow{
	{Metric: "opens", Average: 0.214, Source: "Industry average 2024"},
	{Metric: "clicks", Average: 0.026, Source: "Industry average 2024"},
	{Metric: "bounces", Average: 0.009, Source: "Industry average 2024"},
	{Metric: "unsubs", Average: 0.002, Source: "Industry average 2024"},
}

// GetBenchmarks GET /api/v1/dashboard/benchmarks
//
// Reads from dashboard_benchmark_cache (populated daily by
// BenchmarkAggregator). When the cache is empty — fresh deploys
// before the first tick — falls back to hardcoded illustrative
// averages so the UI can render meaningfully on day one.
//
// Window defaults to 30d; the cache table supports multiple windows
// for future expansion but only 30d is currently aggregated.
func (d *Deps) GetBenchmarks(w http.ResponseWriter, r *http.Request) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusOK, BenchmarksResponse{
			Rows: illustrativeBenchmarks,
			Note: "Illustrative averages — backend unavailable.",
		})
		return
	}
	cached, err := d.Repo.benchmarkRows(r.Context(), 30)
	if err == nil && len(cached) > 0 {
		writeJSON(w, http.StatusOK, BenchmarksResponse{
			Rows: cached,
			Note: "Anonymous platform-wide averages across the last 30 days.",
		})
		return
	}
	writeJSON(w, http.StatusOK, BenchmarksResponse{
		Rows: illustrativeBenchmarks,
		Note: "Illustrative averages — platform-wide aggregate not available yet.",
	})
}

// benchmarkRows reads the cache table for the given window. Returns
// an empty slice (no error) when no rows are present.
func (r *Repo) benchmarkRows(ctx context.Context, windowDays int) ([]BenchmarkRow, error) {
	rows, err := r.Pool.Query(ctx, `
SELECT metric, average, computed_at
FROM dashboard_benchmark_cache
WHERE window_days = $1
ORDER BY metric ASC`, windowDays)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BenchmarkRow{}
	for rows.Next() {
		var br BenchmarkRow
		var computedAt time.Time
		if err := rows.Scan(&br.Metric, &br.Average, &computedAt); err != nil {
			return nil, err
		}
		br.Source = "Platform average (last 30 days)"
		out = append(out, br)
	}
	return out, rows.Err()
}
