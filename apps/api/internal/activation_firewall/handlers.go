// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — the firewall's HTTP surface:
//
//	GET /api/v1/activation-exclusions   → {"items":[ExclusionReceipt…],"count":int}
//
// The compliance-auditor list of withheld profiles. Admin scope: rows
// carry subscriber emails, so this is gated higher than a plain list
// read. Per-run receipt DOWNLOAD and the pre-flight PREVIEW count live in
// the audience_destinations package (sync_handlers.go) because they hang
// off a sync/run id — see the integration manifest. This package owns
// the cross-run compliance list.
//
// Receipts are compliance-internal (not public SDK), so the route is
// classified admin-web in route-contracts.json.
package activation_firewall

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the firewall list handler.
type Deps struct {
	Store  Store
	Logger *slog.Logger
}

// MountRoutes registers the compliance list endpoint. Admin scope —
// receipts carry subscriber emails.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Store == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/activation-exclusions", d.ListExclusions)
}

// ListExclusions GET /api/v1/activation-exclusions?since=&limit=&run_type=&purpose=.
func (d *Deps) ListExclusions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	f := ListFilter{
		RunType: strings.TrimSpace(r.URL.Query().Get("run_type")),
		Purpose: strings.TrimSpace(r.URL.Query().Get("purpose")),
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("since")); raw != "" {
		if ts, err := time.Parse(time.RFC3339, raw); err == nil {
			f.Since = &ts
		} else {
			httperror.Write(w, http.StatusBadRequest, "invalid_since",
				"since must be an RFC3339 timestamp")
			return
		}
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			f.Limit = n
		}
	}
	if f.RunType != "" && f.RunType != RunTypeAudienceSync && f.RunType != RunTypeZerocopyTrigger {
		httperror.Write(w, http.StatusBadRequest, "invalid_run_type",
			"run_type must be audience_sync or zerocopy_trigger")
		return
	}
	items, err := d.Store.ListExclusions(r.Context(), t.ID, f)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
