// SPDX-License-Identifier: AGPL-3.0-only
//
// Package domain_warmup implements the per-sending-domain volume
// ramp planner. IP warmup is handled separately in `sending/` —
// see dedicated_ip*.go.
//
// Lifecycle:
//
//   1. Operator verifies a new domain (sending_identities row).
//   2. POST /api/v1/domain-warmup creates a plan; we generate a
//      schedule of [day1_quota, day2_quota, …] using the canonical
//      doubling-with-cap curve.
//   3. The dispatcher (or future warmup-aware worker) reads
//      TodayQuota(tenant, domain) before queueing a fresh send;
//      if today's cap has been exhausted, the campaign deferred.
//   4. Each daily reconciliation tick updates last_sent_count so
//      the dashboard can show "84 / 100 today".
//   5. After `days` days the schedule is exhausted and TodayQuota stops
//      constraining sends — but the plan's `status` does NOT change on its own.
//
// STEP 5 USED TO SAY "the plan flips to status='completed'". It does not, and
// nothing in this repository ever has: the ONLY writer of
// `domain_warmup_plans.status` is the PATCH endpoint below, so a finished warmup
// sits at `active` until a person notices and changes it by hand.
//
// The distinction matters because the two halves of this feature age
// differently. The ramp itself is real and automatic — TodayQuota is computed
// from `started_on` and the schedule, so quotas widen and then stop binding
// exactly as designed. The STATUS is a label an operator maintains. A reader
// who believed step 5 would reasonably use `status = 'active'` to mean "still
// ramping", and would be wrong for every plan whose days have run out.
//
// This is also why the table is not in the operations registry
// (`internal/operation`): a shared "what is running" view built on this column
// would show every completed warmup as still in progress, forever. Wiring an
// automatic completion is a real change with a real decision behind it — who
// owns the tick, and whether an operator's manual `paused` should survive it —
// and is deliberately not smuggled in as a doc fix.
//
// Surfaces:
//
//   GET    /api/v1/domain-warmup
//   POST   /api/v1/domain-warmup                  body: {domain, target_daily, days?}
//   GET    /api/v1/domain-warmup/{domain}
//   PATCH  /api/v1/domain-warmup/{domain}/status  body: {status}
//   DELETE /api/v1/domain-warmup/{domain}
//   GET    /api/v1/domain-warmup/{domain}/today   live quota status

package domain_warmup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
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

const requestJSONMaxBodyBytes int64 = 8 << 10

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

// Plan is the API projection.
type Plan struct {
	ID             string     `json:"id"`
	Domain         string     `json:"domain"`
	TargetDaily    int        `json:"target_daily"`
	Days           int        `json:"days"`
	StartedOn      string     `json:"started_on"` // ISO date
	Status         string     `json:"status"`
	Schedule       []int      `json:"schedule"`
	LastSentCount  int        `json:"last_sent_count"`
	LastObservedAt *time.Time `json:"last_observed_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

type createReq struct {
	Domain      string `json:"domain"`
	TargetDaily int    `json:"target_daily"`
	Days        int    `json:"days"`
}

type statusReq struct {
	Status string `json:"status"`
}

// MountRoutes registers the admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/domain-warmup", d.List)
	r.With(admin).Post("/api/v1/domain-warmup", d.Create)
	r.With(admin).Get("/api/v1/domain-warmup/{domain}", d.Get)
	r.With(admin).Patch("/api/v1/domain-warmup/{domain}/status", d.SetStatus)
	r.With(admin).Delete("/api/v1/domain-warmup/{domain}", d.Delete)
	r.With(admin).Get("/api/v1/domain-warmup/{domain}/today", d.Today)
}

// List GET /api/v1/domain-warmup.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, domain, target_daily, days, started_on::text, status, schedule,
       last_sent_count, last_observed_at, created_at, updated_at
  FROM domain_warmup_plans
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Plan{}
	for rows.Next() {
		p, err := scanPlan(rows)
		if err == nil {
			out = append(out, p)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"plans": out, "count": len(out)})
}

// Create POST /api/v1/domain-warmup.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body createReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		code := httpbody.ErrorCode(err)
		if httperror.IsValidationCode(code) {
			httperror.Write(w, httpbody.StatusCode(err), code, httpbody.PublicMessage(err))
		} else {
			httperror.Write(w, httpbody.StatusCode(err), code, "request body invalid")
		}
		return
	}
	domain := strings.ToLower(strings.TrimSpace(body.Domain))
	if domain == "" || !strings.Contains(domain, ".") {
		writeErr(w, http.StatusBadRequest, "bad_domain", "domain must be a valid hostname")
		return
	}
	if body.TargetDaily <= 0 || body.TargetDaily > 10_000_000 {
		writeErr(w, http.StatusBadRequest, "bad_target", "target_daily must be 1..10_000_000")
		return
	}
	days := body.Days
	if days <= 0 {
		days = 30
	}
	if days < 7 || days > 90 {
		writeErr(w, http.StatusBadRequest, "bad_days", "days must be 7..90")
		return
	}

	schedule := generateSchedule(body.TargetDaily, days)
	schedJSON, _ := json.Marshal(schedule)

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO domain_warmup_plans (tenant_id, domain, target_daily, days, schedule)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
RETURNING id::text`, t.ID, domain, body.TargetDaily, days, schedJSON).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":           id,
		"domain":       domain,
		"target_daily": body.TargetDaily,
		"days":         days,
		"schedule":     schedule,
	})
}

// Get GET /api/v1/domain-warmup/{domain}.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "domain")))
	if domain == "" {
		writeErr(w, http.StatusBadRequest, "missing_domain", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	row := tx.QueryRow(r.Context(), `
SELECT id::text, domain, target_daily, days, started_on::text, status, schedule,
       last_sent_count, last_observed_at, created_at, updated_at
  FROM domain_warmup_plans
 WHERE tenant_id = $1::uuid AND domain = $2`, t.ID, domain)
	plan, err := scanPlan(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

// SetStatus PATCH /api/v1/domain-warmup/{domain}/status.
func (d *Deps) SetStatus(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "domain")))
	if domain == "" {
		writeErr(w, http.StatusBadRequest, "missing_domain", "")
		return
	}
	var body statusReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		code := httpbody.ErrorCode(err)
		if httperror.IsValidationCode(code) {
			httperror.Write(w, httpbody.StatusCode(err), code, httpbody.PublicMessage(err))
		} else {
			httperror.Write(w, httpbody.StatusCode(err), code, "request body invalid")
		}
		return
	}
	status := strings.ToLower(strings.TrimSpace(body.Status))
	switch status {
	case "active", "paused", "completed", "cancelled":
	default:
		writeErr(w, http.StatusBadRequest, "bad_status", "status must be active|paused|completed|cancelled")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(), `
UPDATE domain_warmup_plans
   SET status = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND domain = $2`, t.ID, domain, status)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status})
}

// Delete DELETE /api/v1/domain-warmup/{domain} — hard delete.
// Operator usually wants the row gone rather than cancelled;
// cancelled plans are kept by SetStatus.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "domain")))
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM domain_warmup_plans WHERE tenant_id = $1::uuid AND domain = $2`,
		t.ID, domain)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Today GET /api/v1/domain-warmup/{domain}/today.
//
// Returns the live "where we are in the ramp" view that the
// dispatcher uses. Computes day_index from (today - started_on)
// and clamps to plan length.
func (d *Deps) Today(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "domain")))
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		startedOn   time.Time
		days        int
		targetDaily int
		status      string
		sched       []byte
		lastSent    int
	)
	err = tx.QueryRow(r.Context(), `
SELECT started_on, days, target_daily, status, schedule, last_sent_count
  FROM domain_warmup_plans
 WHERE tenant_id = $1::uuid AND domain = $2`, t.ID, domain).Scan(
		&startedOn, &days, &targetDaily, &status, &sched, &lastSent)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var schedule []int
	_ = json.Unmarshal(sched, &schedule)

	today := time.Now().UTC().Truncate(24 * time.Hour)
	dayIndex := int(today.Sub(startedOn.UTC().Truncate(24*time.Hour)).Hours() / 24)
	quota := targetDaily
	atTarget := false
	if dayIndex < 0 {
		dayIndex = 0
	}
	if dayIndex >= days || dayIndex >= len(schedule) {
		atTarget = true
		dayIndex = days - 1
	} else {
		quota = schedule[dayIndex]
	}
	remaining := quota - lastSent
	if remaining < 0 {
		remaining = 0
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"domain":     domain,
		"status":     status,
		"day_index":  dayIndex,
		"day_quota":  quota,
		"sent_today": lastSent,
		"remaining":  remaining,
		"at_target":  atTarget,
	})
}

// --- schedule generation ---
//
// Standard "double daily, cap at target" curve:
//
//	day1 = max(50, target * 0.5%)
//	dayN = min(dayN-1 * 2, target)
//
// Last few days flat-line at target so the operator can
// observe-then-graduate.
func generateSchedule(target, days int) []int {
	if days <= 0 {
		return nil
	}
	first := 50
	if half := target / 200; half > first { // 0.5% of target
		first = half
	}
	if first > target {
		first = target
	}
	out := make([]int, days)
	cur := first
	for i := 0; i < days; i++ {
		if cur > target {
			cur = target
		}
		out[i] = cur
		// Double for the next day; rounded.
		next := int(math.Round(float64(cur) * 2))
		if next > target {
			next = target
		}
		cur = next
	}
	return out
}

// --- helpers ---

func scanPlan(s rowScanner) (Plan, error) {
	var p Plan
	var sched []byte
	if err := s.Scan(&p.ID, &p.Domain, &p.TargetDaily, &p.Days, &p.StartedOn,
		&p.Status, &sched, &p.LastSentCount, &p.LastObservedAt,
		&p.CreatedAt, &p.UpdatedAt); err != nil {
		return Plan{}, err
	}
	_ = json.Unmarshal(sched, &p.Schedule)
	return p, nil
}

type rowScanner interface {
	Scan(dest ...any) error
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

// ResolveTodayQuota is the dispatcher-facing helper. Returns
// (quota, sentToday, ok). ok=false when there is no plan for the
// domain (i.e. don't throttle).
func ResolveTodayQuota(ctx context.Context, pool *db.Pool, tenantID, domain string) (quota, sent int, ok bool, err error) {
	if pool == nil || tenantID == "" || domain == "" {
		return 0, 0, false, nil
	}
	tx, txErr := db.WithTenant(ctx, pool, tenantID)
	if txErr != nil {
		return 0, 0, false, fmt.Errorf("warmup quota tx: %w", txErr)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var startedOn time.Time
	var days, targetDaily, lastSent int
	var sched []byte
	err = tx.QueryRow(ctx, `
SELECT started_on, days, target_daily, schedule, last_sent_count
  FROM domain_warmup_plans
 WHERE tenant_id = $1::uuid AND domain = $2 AND status = 'active'`,
		tenantID, domain).Scan(&startedOn, &days, &targetDaily, &sched, &lastSent)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, 0, false, nil
		}
		return 0, 0, false, err
	}
	var schedule []int
	_ = json.Unmarshal(sched, &schedule)
	today := time.Now().UTC().Truncate(24 * time.Hour)
	dayIndex := int(today.Sub(startedOn.UTC().Truncate(24*time.Hour)).Hours() / 24)
	q := targetDaily
	if dayIndex >= 0 && dayIndex < len(schedule) {
		q = schedule[dayIndex]
	}
	return q, lastSent, true, nil
}
