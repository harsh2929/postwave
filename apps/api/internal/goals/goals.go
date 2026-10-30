// SPDX-License-Identifier: AGPL-3.0-only
//
// Package goals implements dashboard goals & pacing.
//
// Operators set per-tenant targets (subscriber count, open rate,
// revenue, list growth) on a monthly or quarterly cadence; the
// dashboard polls /goals/progress and renders an
// ahead | on_track | behind chip per goal.
//
// Surface (tenant-scoped):
//
//	GET    /api/v1/goals            — list
//	POST   /api/v1/goals            — create
//	PATCH  /api/v1/goals/{id}       — update target/period/name/starts_at
//	DELETE /api/v1/goals/{id}       — delete
//	GET    /api/v1/goals/progress   — per-goal live progress + pace
//
// Storage: tenant_goals (migration 0389). Progress is never
// denormalised — every /progress call computes the current value from
// the existing aggregates (see progress.go for the per-metric source
// queries).
package goals

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

const goalJSONMaxBodyBytes int64 = 16 << 10

// Metrics + periods accepted by the CHECK constraints in 0389.
var (
	validMetrics = map[string]bool{
		"subscribers": true, "open_rate": true,
		"revenue_cents": true, "list_growth": true,
	}
	validPeriods = map[string]bool{"monthly": true, "quarterly": true}
)

// Errors surfaced to the HTTP layer.
var (
	ErrNotFound      = errors.New("goals: not found")
	ErrInvalidMetric = errors.New("goals: metric must be subscribers|open_rate|revenue_cents|list_growth")
	ErrInvalidPeriod = errors.New("goals: period must be monthly|quarterly")
	ErrInvalidTarget = errors.New("goals: target must be > 0")
)

// Goal is the public projection of a tenant_goals row.
type Goal struct {
	ID        string    `json:"id"`
	Name      string    `json:"name,omitempty"`
	Metric    string    `json:"metric"`
	Target    float64   `json:"target"`
	Period    string    `json:"period"`
	StartsAt  time.Time `json:"starts_at"`
	CreatedBy string    `json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// CreateInput is the POST body.
type CreateInput struct {
	Name     string     `json:"name,omitempty"`
	Metric   string     `json:"metric"`
	Target   float64    `json:"target"`
	Period   string     `json:"period,omitempty"`
	StartsAt *time.Time `json:"starts_at,omitempty"`
}

// UpdateInput is the PATCH body. nil = leave untouched.
type UpdateInput struct {
	Name              *string    `json:"name,omitempty"`
	Target            *float64   `json:"target,omitempty"`
	Period            *string    `json:"period,omitempty"`
	StartsAt          *time.Time `json:"starts_at,omitempty"`
	ExpectedUpdatedAt *time.Time `json:"expected_updated_at,omitempty"`
}

func (in *CreateInput) validate() error {
	in.Metric = strings.ToLower(strings.TrimSpace(in.Metric))
	if !validMetrics[in.Metric] {
		return ErrInvalidMetric
	}
	if in.Target <= 0 {
		return ErrInvalidTarget
	}
	if in.Period == "" {
		in.Period = "monthly"
	}
	in.Period = strings.ToLower(strings.TrimSpace(in.Period))
	if !validPeriods[in.Period] {
		return ErrInvalidPeriod
	}
	return nil
}

// Deps wires the HTTP surface.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers the goal endpoints. Reads ride the reports
// scope (dashboard tiles); mutations require admin.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/goals", d.List)
	r.With(admin).Post("/api/v1/goals", d.Create)
	r.With(read).Get("/api/v1/goals/progress", d.Progress)
	r.With(admin).Patch("/api/v1/goals/{id}", d.Update)
	r.With(admin).Delete("/api/v1/goals/{id}", d.Delete)
}

// List GET /api/v1/goals.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 100
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 100, pagination.MaxLimit)
	if err != nil {
		httperror.WriteValidation(w, "invalid_cursor", "cursor is malformed")
		return
	}
	goals, next, err := d.listGoalsPage(r.Context(), t.ID, limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Additive over the prior {"goals":[...]} shape: nextCursor is added
	// only when more rows remain (omitted on the last page).
	body := map[string]any{"goals": goals}
	if next != "" {
		body["nextCursor"] = next
	}
	writeJSON(w, http.StatusOK, body)
}

// Create POST /api/v1/goals.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, goalJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if err := in.validate(); err != nil {
		httperror.WriteValidation(w, "invalid_goal", err.Error())
		return
	}
	var createdBy any
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil && u.ID != "" {
		createdBy = u.ID
	}
	startsAt := time.Now().UTC()
	if in.StartsAt != nil && !in.StartsAt.IsZero() {
		startsAt = in.StartsAt.UTC()
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var g Goal
	err = tx.QueryRow(r.Context(), `
INSERT INTO tenant_goals (tenant_id, name, metric, target, period, starts_at, created_by)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
RETURNING id::text, name, metric, target::float8, period, starts_at,
          COALESCE(created_by::text, ''), created_at, updated_at`,
		t.ID, strings.TrimSpace(in.Name), in.Metric, in.Target, in.Period,
		startsAt, createdBy,
	).Scan(&g.ID, &g.Name, &g.Metric, &g.Target, &g.Period, &g.StartsAt,
		&g.CreatedBy, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, g)
}

// Update PATCH /api/v1/goals/{id}.
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "goal id required")
		return
	}
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, goalJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.Target != nil && *in.Target <= 0 {
		httperror.WriteValidation(w, "invalid_goal", ErrInvalidTarget.Error())
		return
	}
	if in.Period != nil {
		p := strings.ToLower(strings.TrimSpace(*in.Period))
		if !validPeriods[p] {
			httperror.WriteValidation(w, "invalid_goal", ErrInvalidPeriod.Error())
			return
		}
		in.Period = &p
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		in.Name = &name
	}
	if in.ExpectedUpdatedAt != nil && in.ExpectedUpdatedAt.IsZero() {
		httperror.WriteValidation(w, "invalid_expected_updated_at", "expected_updated_at must be the exact non-zero updated_at value from the goal being changed")
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var g Goal
	err = tx.QueryRow(r.Context(), `
UPDATE tenant_goals
   SET name       = COALESCE($1, name),
       target     = COALESCE($2, target),
       period     = COALESCE($3, period),
       starts_at  = COALESCE($4, starts_at),
       updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
 WHERE tenant_id = $5::uuid AND id = $6::uuid
   AND ($7::timestamptz IS NULL OR updated_at = $7::timestamptz)
RETURNING id::text, name, metric, target::float8, period, starts_at,
          COALESCE(created_by::text, ''), created_at, updated_at`,
		in.Name, in.Target, in.Period, in.StartsAt, t.ID, id,
		in.ExpectedUpdatedAt,
	).Scan(&g.ID, &g.Name, &g.Metric, &g.Target, &g.Period, &g.StartsAt,
		&g.CreatedBy, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if in.ExpectedUpdatedAt != nil {
				exists, existsErr := goalExists(r.Context(), tx, t.ID, id)
				if existsErr != nil {
					httperror.WriteInternal(w, d.Logger, existsErr, r.Context())
					return
				}
				if exists {
					httperror.Write(w, http.StatusConflict, "goal_revision_conflict", "the goal changed after it was opened; reload before editing it")
					return
				}
			}
			httperror.Write(w, http.StatusNotFound, "not_found", "no such goal")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// Delete DELETE /api/v1/goals/{id}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "goal id required")
		return
	}
	expectedUpdatedAt, err := optionalExpectedUpdatedAt(r.URL.Query().Get("expected_updated_at"))
	if err != nil {
		httperror.WriteValidation(w, "invalid_expected_updated_at", err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(), `
	DELETE FROM tenant_goals
	 WHERE tenant_id = $1::uuid AND id = $2::uuid
	   AND ($3::timestamptz IS NULL OR updated_at = $3::timestamptz)`,
		t.ID, id, expectedUpdatedAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		if expectedUpdatedAt != nil {
			exists, existsErr := goalExists(r.Context(), tx, t.ID, id)
			if existsErr != nil {
				httperror.WriteInternal(w, d.Logger, existsErr, r.Context())
				return
			}
			if exists {
				httperror.Write(w, http.StatusConflict, "goal_revision_conflict", "the goal changed after it was opened; reload before deleting it")
				return
			}
		}
		httperror.Write(w, http.StatusNotFound, "not_found", "no such goal")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func optionalExpectedUpdatedAt(raw string) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil || parsed.IsZero() {
		return nil, errors.New("expected_updated_at must be the exact non-zero RFC3339 updated_at value from the goal being deleted")
	}
	parsed = parsed.UTC()
	return &parsed, nil
}

func goalExists(ctx context.Context, tx pgx.Tx, tenantID, id string) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM tenant_goals
   WHERE tenant_id = $1::uuid AND id = $2::uuid
)`, tenantID, id).Scan(&exists)
	return exists, err
}

// listGoalsPage returns goals newest-first with keyset pagination on
// (created_at, id). limit is the page size (caller clamps via
// pagination.ReadParamsWithDefault); a non-empty next cursor is returned
// when more rows remain.
func (d *Deps) listGoalsPage(ctx context.Context, tenantID string, limit int, cursor pagination.Cursor) ([]Goal, string, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 limit+1; the keyset bound (when paging) takes $3/$4.
	args := []any{tenantID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (created_at, id) < ($3::timestamptz, $4::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, name, metric, target::float8, period, starts_at,
       COALESCE(created_by::text, ''), created_at, updated_at
  FROM tenant_goals
 WHERE tenant_id = $1::uuid
 `+keyset+`
 ORDER BY created_at DESC, id DESC
 LIMIT $2`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Goal{}
	for rows.Next() {
		var g Goal
		if err := rows.Scan(&g.ID, &g.Name, &g.Metric, &g.Target, &g.Period,
			&g.StartsAt, &g.CreatedBy, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, "", err
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.CreatedAt, ID: last.ID})
	}
	return out, next, nil
}

// listGoals returns up to the prior LIMIT 100 goals newest-first. It
// preserves the pre-pagination behavior for /goals/progress, which needs
// the full goal set (not a single page) to compute per-goal pace.
func (d *Deps) listGoals(ctx context.Context, tenantID string) ([]Goal, error) {
	out, _, err := d.listGoalsPage(ctx, tenantID, 100, pagination.Cursor{})
	return out, err
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
