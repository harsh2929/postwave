// SPDX-License-Identifier: AGPL-3.0-only
//
// Package inactive_keys surfaces API keys that haven't been used
// in a long time. Two distinct operator concerns this addresses:
//
//   1. Dead keys — created for a project that was sunset; sitting
//      around as expand-the-blast-radius credentials nobody owns
//   2. Leaked-but-unused — a credential leaked to a contractor
//      that hasn't been called yet, which a quarterly audit
//      should catch BEFORE it's exercised
//
// The api_keys table already has `last_used_at` (updated by the
// auth middleware on every successful lookup). All we add is:
//
//   * a query that flags rows where last_used_at < now - threshold
//   * the threshold defaults to 90 days (industry guidance from
//     NIST SP 800-63B and OWASP API security top 10)
//
// We never auto-revoke. Old keys may be backup credentials kept
// for break-glass scenarios; revocation is always a deliberate
// operator decision. The package returns the list; the operator
// chooses.
//
// Surfaces:
//
//   GET /api/v1/inactive-keys?days=90        list keys inactive for N+ days

package inactive_keys

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// errors with request/tenant context without exposing details to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// Alert is one row.
type Alert struct {
	ID               string     `json:"id"`
	Label            string     `json:"label"`
	Prefix           string     `json:"prefix"`
	ActorType        string     `json:"actor_type"`
	CreatedAt        time.Time  `json:"created_at"`
	LastUsedAt       *time.Time `json:"last_used_at,omitempty"`
	DaysSinceLastUse int        `json:"days_since_last_use"`
	NeverUsed        bool       `json:"never_used"`
	Severity         string     `json:"severity"` // 'warn' | 'high' | 'critical'
}

// MountRoutes registers the admin endpoint.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/inactive-keys", d.List)
}

// List GET /api/v1/inactive-keys?days=90.
//
// `days` is the threshold; default 90. Severity is layered:
//   - warn:     never used + >7 days since creation
//   - high:     last_used > threshold OR never used + >30 days
//   - critical: last_used > 2*threshold OR never used + >90 days
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	threshold := 90
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 365 {
			threshold = n
		}
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -threshold)

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Pull all non-revoked keys. The threshold + severity logic
	// runs in Go because it's clearer there than in SQL CASE.
	rows, err := tx.Query(r.Context(), `
SELECT id::text, COALESCE(label, ''), COALESCE(prefix, ''),
       COALESCE(actor_type, 'human'), created_at, last_used_at
  FROM api_keys
 WHERE tenant_id = $1::uuid
   AND revoked_at IS NULL
 ORDER BY COALESCE(last_used_at, created_at) ASC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	now := time.Now().UTC()
	out := []Alert{}
	for rows.Next() {
		var a Alert
		if err := rows.Scan(&a.ID, &a.Label, &a.Prefix, &a.ActorType,
			&a.CreatedAt, &a.LastUsedAt); err != nil {
			continue
		}
		if a.LastUsedAt == nil {
			a.NeverUsed = true
			a.DaysSinceLastUse = int(now.Sub(a.CreatedAt) / (24 * time.Hour))
		} else {
			a.DaysSinceLastUse = int(now.Sub(*a.LastUsedAt) / (24 * time.Hour))
		}

		// Skip keys that are still within threshold AND have been used.
		if !a.NeverUsed && a.LastUsedAt.After(cutoff) {
			continue
		}
		// Skip never-used keys created in the last week — operator
		// just provisioned them, haven't deployed yet.
		if a.NeverUsed && a.DaysSinceLastUse < 7 {
			continue
		}
		a.Severity = severity(a, threshold)
		out = append(out, a)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"threshold_days": threshold,
		"keys":           out,
		"count":          len(out),
	})
}

func severity(a Alert, threshold int) string {
	d := a.DaysSinceLastUse
	if a.NeverUsed {
		switch {
		case d >= 90:
			return "critical"
		case d >= 30:
			return "high"
		default:
			return "warn"
		}
	}
	switch {
	case d >= 2*threshold:
		return "critical"
	case d >= threshold:
		return "high"
	default:
		return "warn"
	}
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

var _ = errors.New
