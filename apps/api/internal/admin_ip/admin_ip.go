// SPDX-License-Identifier: AGPL-3.0-only
//
// Package admin_ip exposes the operator-facing CRUD for the per-
// tenant admin IP allowlist (tenants.admin_ip_allowlist).
//
// Endpoints (admin-scoped):
//
//   GET /api/v1/admin/ip-allowlist           current entries
//   PUT /api/v1/admin/ip-allowlist           replace the whole list
//
// We don't expose per-entry add/remove deliberately: forgetting to
// re-add your own IP locks you out. The replace-the-list endpoint
// forces the operator to send the full intended set, which
// surfaces "wait I deleted my own IP" mistakes BEFORE they fire.

package admin_ip

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MaxEntries caps the per-tenant allowlist size. 100 is comfortably
// above any real corporate VPN exit pool.
const MaxEntries = 100

// Deps wires the handlers.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers GET + PUT.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/admin/ip-allowlist", d.Get)
	r.With(admin).Put("/api/v1/admin/ip-allowlist", d.Put)
}

// Get GET /api/v1/admin/ip-allowlist.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant in context")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var entries []string
	if err := tx.QueryRow(r.Context(),
		`SELECT COALESCE(admin_ip_allowlist, ARRAY[]::text[])
		   FROM tenants WHERE id = $1::uuid`, t.ID).Scan(&entries); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries":                    entries,
		"max":                        MaxEntries,
		"empty_means_no_restriction": true,
	})
}

// PutInput is the body of PUT /api/v1/admin/ip-allowlist.
type PutInput struct {
	Entries []string `json:"entries"`
}

// Put PUT /api/v1/admin/ip-allowlist. Replaces the whole list.
//
// Validates every entry as a single IP or CIDR. An invalid entry
// fails the whole request (rather than silently skipping) so the
// operator notices the typo IMMEDIATELY — the lockout case is the
// canonical example where silent acceptance is dangerous.
func (d *Deps) Put(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant in context")
		return
	}
	var in PutInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if len(in.Entries) > MaxEntries {
		httperror.Write(w, http.StatusBadRequest, "too_many_entries",
			"allowlist capped at 100 entries")
		return
	}
	// Validate every entry up-front. Bail on the first invalid one
	// so the operator sees exactly which entry's bad.
	for i, e := range in.Entries {
		e = strings.TrimSpace(e)
		if e == "" {
			httperror.Write(w, http.StatusBadRequest, "empty_entry",
				"entry "+intToStr(i)+" is empty")
			return
		}
		if !validIPOrCIDR(e) {
			httperror.Write(w, http.StatusBadRequest, "invalid_entry",
				"entry "+intToStr(i)+" is not a valid IP or CIDR: "+e)
			return
		}
		in.Entries[i] = e
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// tenants.admin_ip_allowlist is NOT NULL DEFAULT '{}'. An omitted or null
	// `entries` decodes to a nil slice, which encodes as SQL NULL, and a column
	// DEFAULT does not apply to a statement that names the column -- so the
	// natural way to CLEAR an allowlist (send no entries) was a 500.
	//
	// Clearing is a legitimate operation: the empty list is exactly how a tenant
	// turns admin IP restriction back off. Unrestricted is the empty list, not
	// the absent one.
	entries := in.Entries
	if entries == nil {
		entries = []string{}
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE tenants SET admin_ip_allowlist = $1::text[] WHERE id = $2::uuid`,
		entries, t.ID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Echo what was PERSISTED, not the raw decoded field. in.Entries is still
	// nil when the caller cleared the list, and `{"entries": null}` is the
	// server-side twin of the crash class this API's own clients keep hitting:
	// a JSON null lands in a typed array, and the first .map() on it throws.
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// validIPOrCIDR accepts a single IPv4/IPv6 OR a CIDR.
func validIPOrCIDR(s string) bool {
	if strings.Contains(s, "/") {
		_, _, err := net.ParseCIDR(s)
		return err == nil
	}
	return net.ParseIP(s) != nil
}

// intToStr — tiny strconv.Itoa avoiding the import.
func intToStr(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	buf := [20]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// LookupForTenant is the middleware's allowlist source. Wired into
// middleware.AdminIPAllowlist via this signature so the middleware
// package stays free of the db import.
func LookupForTenant(pool *db.Pool) middleware.LookupAdminAllowlist {
	return func(ctx context.Context, tenantID string) ([]string, error) {
		if pool == nil || strings.TrimSpace(tenantID) == "" {
			return nil, errors.New("admin IP allowlist store is not configured")
		}
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			return nil, err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var entries []string
		err = tx.QueryRow(ctx,
			`SELECT COALESCE(admin_ip_allowlist, ARRAY[]::text[])
			   FROM tenants WHERE id = $1::uuid`, tenantID).Scan(&entries)
		if err != nil {
			return nil, err
		}
		return entries, tx.Commit(ctx)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
