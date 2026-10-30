// SPDX-License-Identifier: AGPL-3.0-only
//
// Package recipient_tz_send implements recipient-timezone-aware
// scheduling: the operator declares "9am Tuesday in their local
// time" and the dispatcher releases the audience slice-by-slice
// as each timezone's wall clock crosses that hour.
//
// Subscribers carry their timezone in subscribers.custom_fields
// JSON under the key "timezone" (IANA, e.g. "America/Los_Angeles"
// or "Europe/Berlin"). Rows without a timezone fall back to the
// campaign's fallback_tz.
//
// Surfaces:
//
//   POST   /api/v1/campaigns/{id}/tz-schedule
//          body: {local_time: "09:00", date: "2026-06-04",
//                 fallback_tz: "UTC"}
//   GET    /api/v1/campaigns/{id}/tz-schedule
//   DELETE /api/v1/campaigns/{id}/tz-schedule
//   GET    /api/v1/campaigns/{id}/tz-schedule/audience-preview
//          → distribution of audience across timezones
//
// Schema only ships the metadata; the actual fan-out happens
// inside the dispatcher (a small `DueAudience(tx, campaignID)`
// helper consults this table and returns the slice for the
// current hour). The dispatcher integration is intentionally left
// for the sending package's next iteration — this package owns
// the operator-facing CRUD and the audience-distribution preview
// so the operator can sanity-check before flipping the campaign
// to scheduled.

package recipient_tz_send

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const requestJSONMaxBodyBytes int64 = 8 << 10

// Deps wires the HTTP surface.
type Deps struct {
	Pool         *db.Pool
	Logger       *slog.Logger
	LiveDispatch dispatchcontrol.Gate
}

// Schedule is the API projection.
type Schedule struct {
	CampaignID  string     `json:"campaign_id"`
	LocalTime   string     `json:"local_time"`
	Date        string     `json:"date"`
	FallbackTZ  string     `json:"fallback_tz"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type upsertReq struct {
	LocalTime  string `json:"local_time"`
	Date       string `json:"date"`
	FallbackTZ string `json:"fallback_tz"`
}

// MountRoutes registers admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	live := apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(live).Post("/api/v1/campaigns/{id}/tz-schedule", d.Upsert)
	r.With(read).Get("/api/v1/campaigns/{id}/tz-schedule", d.Get)
	r.With(admin).Delete("/api/v1/campaigns/{id}/tz-schedule", d.Delete)
	r.With(read).Get("/api/v1/campaigns/{id}/tz-schedule/audience-preview", d.Preview)
}

// Upsert POST /api/v1/campaigns/{id}/tz-schedule.
func (d *Deps) Upsert(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	var body upsertReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes that are
		// in httperror.IsValidationCode allowlist (operator-authored text).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if _, err := time.Parse("15:04", body.LocalTime); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_local_time", "expected HH:MM (24h)")
		return
	}
	if _, err := time.Parse("2006-01-02", body.Date); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_date", "expected YYYY-MM-DD")
		return
	}
	tz := strings.TrimSpace(body.FallbackTZ)
	if tz == "" {
		tz = "UTC"
	}
	if _, err := time.LoadLocation(tz); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_fallback_tz", "fallback_tz must be a valid IANA name")
		return
	}
	if err := dispatchcontrol.Check(d.LiveDispatch, r.Context(), t.ID); err != nil {
		dispatchcontrol.WriteHTTPError(w, err)
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	_, err = tx.Exec(r.Context(), `
INSERT INTO campaign_tz_schedules
   (campaign_id, tenant_id, tz_window_local, tz_window_date, fallback_tz)
VALUES ($1::uuid, $2::uuid, $3::time, $4::date, $5)
ON CONFLICT (campaign_id) DO UPDATE SET
    tz_window_local = EXCLUDED.tz_window_local,
    tz_window_date  = EXCLUDED.tz_window_date,
    fallback_tz     = EXCLUDED.fallback_tz,
    updated_at      = now()`,
		id, t.ID, body.LocalTime, body.Date, tz)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"campaign_id": id,
		"local_time":  body.LocalTime,
		"date":        body.Date,
		"fallback_tz": tz,
	})
}

// Get GET /api/v1/campaigns/{id}/tz-schedule.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var s Schedule
	err = tx.QueryRow(r.Context(), `
SELECT campaign_id::text, to_char(tz_window_local, 'HH24:MI'),
       tz_window_date::text, fallback_tz,
       started_at, completed_at, created_at, updated_at
  FROM campaign_tz_schedules
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		t.ID, id).Scan(&s.CampaignID, &s.LocalTime, &s.Date, &s.FallbackTZ,
		&s.StartedAt, &s.CompletedAt, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// Delete DELETE /api/v1/campaigns/{id}/tz-schedule.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM campaign_tz_schedules WHERE campaign_id = $1::uuid AND tenant_id = $2::uuid`,
		id, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Preview GET /api/v1/campaigns/{id}/tz-schedule/audience-preview.
//
// Returns the distribution of the campaign's audience across
// timezone buckets, plus the absolute UTC wall-clock the send
// window will hit each bucket. Helps the operator spot weird
// outliers ("why are 200 subscribers on Pacific/Kiritimati?").
func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var local, date, fallback string
	err = tx.QueryRow(r.Context(), `
SELECT to_char(tz_window_local, 'HH24:MI'),
       tz_window_date::text, fallback_tz
  FROM campaign_tz_schedules
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		t.ID, id).Scan(&local, &date, &fallback)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}

	rows, err := tx.Query(r.Context(), `
SELECT COALESCE(NULLIF(custom_fields->>'timezone', ''), $2) AS tz,
       count(*) AS subs
  FROM subscribers
 WHERE tenant_id = $1::uuid AND status = 'enabled'
 GROUP BY tz
 ORDER BY subs DESC
 LIMIT 200`, t.ID, fallback)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()

	type bucket struct {
		Timezone    string    `json:"timezone"`
		Subscribers int64     `json:"subscribers"`
		SendAtUTC   time.Time `json:"send_at_utc"`
		Valid       bool      `json:"valid"`
	}
	out := []bucket{}
	for rows.Next() {
		var b bucket
		if err := rows.Scan(&b.Timezone, &b.Subscribers); err != nil {
			continue
		}
		if t, err := resolveSendAt(b.Timezone, date, local); err == nil {
			b.SendAtUTC = t
			b.Valid = true
		}
		out = append(out, b)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"campaign_id": id,
		"local_time":  local,
		"date":        date,
		"fallback_tz": fallback,
		"buckets":     out,
	})
}

// ResolveSendAt is the exported helper the dispatcher uses to
// compute "when does this subscriber's window hit, in UTC?". The
// dispatcher walks each subscriber, calls this, and releases them
// when now >= sendAt.
func ResolveSendAt(timezone, dateYMD, localHHMM string) (time.Time, error) {
	return resolveSendAt(timezone, dateYMD, localHHMM)
}

func resolveSendAt(tz, dateYMD, localHHMM string) (time.Time, error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.Time{}, err
	}
	stamp, err := time.ParseInLocation("2006-01-02 15:04", dateYMD+" "+localHHMM, loc)
	if err != nil {
		return time.Time{}, err
	}
	return stamp.UTC(), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep errors imported for future typed sentinels.
var _ = errors.New
