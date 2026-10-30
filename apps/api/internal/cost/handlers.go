// SPDX-License-Identifier: AGPL-3.0-only
package cost

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Handlers is the HTTP surface over the cost ledger.
type Handlers struct {
	Repo   *Repo
	Logger *slog.Logger
}

// Aggregate GET /api/v1/costs?since=24h&by=api_key_id,kind
func (h *Handlers) Aggregate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	q := r.URL.Query()
	since, err := ParseSince(q.Get("since"))
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	var groupBy []string
	by := strings.TrimSpace(q.Get("by"))
	if by == "" {
		by = strings.TrimSpace(q.Get("group_by"))
	}
	if by != "" {
		for _, g := range strings.Split(by, ",") {
			g = strings.TrimSpace(g)
			if g != "" {
				groupBy = append(groupBy, g)
			}
		}
	}
	rows, err := h.Repo.Aggregate(r.Context(), t.ID, since, groupBy)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rows":     rows,
		"buckets":  rows,
		"since":    since,
		"group_by": strings.Join(groupBy, ","),
	})
}

// Ledger GET /api/v1/costs/ledger?since=24h&cursor=&limit=
func (h *Handlers) Ledger(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	q := r.URL.Query()
	since, err := ParseSince(q.Get("since"))
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	limit := 100
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	var cursor int64
	if v := q.Get("cursor"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			cursor = n
		}
	}
	rows, err := h.Repo.LedgerPage(r.Context(), t.ID, since, cursor, limit)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	resp := map[string]any{"rows": rows}
	if len(rows) == limit {
		resp["nextCursor"] = strconv.FormatInt(rows[len(rows)-1].ID, 10)
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
