// SPDX-License-Identifier: AGPL-3.0-only
//
// Package send_window owns the per-tenant scheduling guard that
// blocks (or warns about) campaigns scheduled outside the
// operator's declared business hours.
//
// Distinct from sending/quiet_hours which throttles the
// DISPATCHER at runtime — this gate runs at SCHEDULE time, so the
// operator gets feedback immediately rather than at 2am when the
// dispatcher silently skips and they wonder why their campaign
// didn't go.
//
// Surfaces:
//
//   GET    /api/v1/send-window                        current policy
//   PUT    /api/v1/send-window                        upsert policy
//   POST   /api/v1/send-window/check                  body: {scheduled_at}
//   DELETE /api/v1/send-window                        remove policy (off)
//
// Exported helper:
//   CheckScheduledAt(ctx, pool, tenantID, at) (verdict, error)
//
// The campaign scheduling code in campaigns/ can call this helper
// inline before letting an UPDATE land — returning a 422 with
// the verdict body when policy='block'.

package send_window

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
)

const requestJSONMaxBodyBytes int64 = 4 << 10

// Deps wires the HTTP surface.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// Policy is the API projection.
type Policy struct {
	StartLocal    string    `json:"start_local"`
	EndLocal      string    `json:"end_local"`
	Timezone      string    `json:"timezone"`
	WeekdayBitmap int       `json:"weekday_bitmap"`
	Weekdays      []string  `json:"weekdays"`
	Enforcement   string    `json:"enforcement"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type upsertReq struct {
	StartLocal    string `json:"start_local"`
	EndLocal      string `json:"end_local"`
	Timezone      string `json:"timezone"`
	WeekdayBitmap *int   `json:"weekday_bitmap"`
	Enforcement   string `json:"enforcement"`
}

type checkReq struct {
	ScheduledAt time.Time `json:"scheduled_at"`
}

// Verdict is what CheckScheduledAt returns.
type Verdict struct {
	InsideWindow bool   `json:"inside_window"`
	Enforcement  string `json:"enforcement"`
	Should       string `json:"should"` // 'allow' | 'warn' | 'block'
	Reason       string `json:"reason,omitempty"`
}

// MountRoutes registers the admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/send-window", d.Get)
	r.With(admin).Put("/api/v1/send-window", d.Upsert)
	r.With(read).Post("/api/v1/send-window/check", d.Check)
	r.With(admin).Delete("/api/v1/send-window", d.Delete)
}

// Get GET /api/v1/send-window.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	p, err := loadPolicy(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if p == nil {
		writeJSON(w, http.StatusOK, map[string]any{"policy": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"policy": p})
}

// Upsert PUT /api/v1/send-window.
func (d *Deps) Upsert(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var body upsertReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	start, err := time.Parse("15:04", body.StartLocal)
	if err != nil {
		httperror.WriteValidation(w, "bad_start_local", "expected HH:MM")
		return
	}
	end, err := time.Parse("15:04", body.EndLocal)
	if err != nil {
		httperror.WriteValidation(w, "bad_end_local", "expected HH:MM")
		return
	}
	if !end.After(start) {
		httperror.WriteValidation(w, "bad_window", "end_local must be after start_local")
		return
	}
	tz := strings.TrimSpace(body.Timezone)
	if tz == "" {
		tz = "UTC"
	}
	if _, err := time.LoadLocation(tz); err != nil {
		httperror.WriteValidation(w, "bad_timezone", "IANA name required")
		return
	}
	weekdays := 126
	if body.WeekdayBitmap != nil {
		weekdays = *body.WeekdayBitmap
		if weekdays < 0 || weekdays > 127 {
			httperror.WriteValidation(w, "bad_weekday_bitmap", "0..127")
			return
		}
	}
	enforcement := strings.ToLower(strings.TrimSpace(body.Enforcement))
	if enforcement == "" {
		enforcement = "warn"
	}
	switch enforcement {
	case "block", "warn", "off":
	default:
		httperror.WriteValidation(w, "bad_enforcement", "block|warn|off")
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	_, err = tx.Exec(r.Context(), `
INSERT INTO tenant_send_window_policies
   (tenant_id, start_local, end_local, timezone, weekday_bitmap, enforcement)
VALUES ($1::uuid, $2::time, $3::time, $4, $5, $6)
ON CONFLICT (tenant_id) DO UPDATE SET
    start_local    = EXCLUDED.start_local,
    end_local      = EXCLUDED.end_local,
    timezone       = EXCLUDED.timezone,
    weekday_bitmap = EXCLUDED.weekday_bitmap,
    enforcement    = EXCLUDED.enforcement,
    updated_at     = now()`,
		t.ID, body.StartLocal, body.EndLocal, tz, weekdays, enforcement)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	p, _ := loadPolicy(r.Context(), d.Pool, t.ID)
	writeJSON(w, http.StatusOK, p)
}

// Check POST /api/v1/send-window/check.
func (d *Deps) Check(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var body checkReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if body.ScheduledAt.IsZero() {
		httperror.WriteValidation(w, "missing_scheduled_at", "")
		return
	}
	v, err := CheckScheduledAt(r.Context(), d.Pool, t.ID, body.ScheduledAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// Delete DELETE /api/v1/send-window — remove the row (off).
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	_, err = tx.Exec(r.Context(),
		`DELETE FROM tenant_send_window_policies WHERE tenant_id = $1::uuid`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- exported helpers ---

// CheckScheduledAt is the call campaign-scheduling code reaches
// for. Returns 'allow' when no policy exists or enforcement is
// 'off'; 'warn' or 'block' otherwise.
func CheckScheduledAt(ctx context.Context, pool *db.Pool, tenantID string, at time.Time) (Verdict, error) {
	p, err := loadPolicy(ctx, pool, tenantID)
	if err != nil {
		return Verdict{}, err
	}
	if p == nil || p.Enforcement == "off" {
		return Verdict{InsideWindow: true, Enforcement: "off", Should: "allow"}, nil
	}
	loc, err := time.LoadLocation(p.Timezone)
	if err != nil {
		loc = time.UTC
	}
	local := at.In(loc)
	dayBit := 1 << int(local.Weekday())
	if p.WeekdayBitmap&dayBit == 0 {
		return Verdict{
			InsideWindow: false,
			Enforcement:  p.Enforcement,
			Should:       p.Enforcement,
			Reason:       "weekday " + local.Weekday().String() + " not in policy bitmap",
		}, nil
	}
	startT, _ := time.Parse("15:04", p.StartLocal)
	endT, _ := time.Parse("15:04", p.EndLocal)
	startMin := startT.Hour()*60 + startT.Minute()
	endMin := endT.Hour()*60 + endT.Minute()
	atMin := local.Hour()*60 + local.Minute()
	if atMin < startMin || atMin >= endMin {
		should := p.Enforcement
		if should == "warn" {
			should = "warn"
		}
		return Verdict{
			InsideWindow: false,
			Enforcement:  p.Enforcement,
			Should:       should,
			Reason:       "local time " + local.Format("15:04") + " outside " + p.StartLocal + "-" + p.EndLocal,
		}, nil
	}
	return Verdict{InsideWindow: true, Enforcement: p.Enforcement, Should: "allow"}, nil
}

func loadPolicy(ctx context.Context, pool *db.Pool, tenantID string) (*Policy, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p Policy
	err = tx.QueryRow(ctx, `
SELECT to_char(start_local, 'HH24:MI'),
       to_char(end_local,   'HH24:MI'),
       timezone, weekday_bitmap, enforcement,
       created_at, updated_at
  FROM tenant_send_window_policies
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&p.StartLocal, &p.EndLocal, &p.Timezone, &p.WeekdayBitmap,
		&p.Enforcement, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.Weekdays = expandWeekdays(p.WeekdayBitmap)
	return &p, nil
}

func expandWeekdays(bitmap int) []string {
	days := []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	out := []string{}
	for i, d := range days {
		if bitmap&(1<<i) != 0 {
			out = append(out, d)
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
