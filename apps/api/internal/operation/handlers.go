// SPDX-License-Identifier: AGPL-3.0-only
package operation

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps is the HTTP surface for the shared operations view.
type Deps struct {
	Aggregator *Aggregator
	Logger     *slog.Logger
}

// MountRoutes registers GET /api/v1/operations.
//
// One route, deliberately. The value here is the ABSENCE of a per-family route:
// twenty families each already have their own page, and the question this
// answers — "is the thing I started finished?" — is the one nobody could ask
// without knowing which of twenty pages to look at.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/operations", d.List)
}

// List GET /api/v1/operations?state=running,queued&limit=50
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.Aggregator == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "unavailable", "operations view unavailable")
		return
	}

	q := Query{Limit: parseLimit(r.URL.Query().Get("limit"))}
	states, badState := parseStates(r.URL.Query().Get("state"))
	if badState != "" {
		// Named rather than ignored. A client filtering on a state that does not
		// exist would otherwise get an empty list and read it as "nothing is
		// running", which is the single most misleading answer this endpoint
		// could give.
		httperror.Write(w, http.StatusBadRequest, "unknown_state",
			"unknown state "+strconv.Quote(badState))
		return
	}
	q.States = states

	records, degraded, err := d.Aggregator.List(r.Context(), t.ID, q)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if records == nil {
		records = []Record{}
	}
	body := map[string]any{"data": records}
	if len(degraded) > 0 {
		// Surfaced, not logged. A partial view that says it is partial can be
		// acted on; one that silently omits a family is how "my job vanished"
		// becomes a support ticket.
		body["degraded_kinds"] = degraded
	}
	writeJSON(w, http.StatusOK, body)
}

func parseLimit(raw string) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0
	}
	return n
}

// parseStates resolves the filter, reporting the first unrecognised value.
func parseStates(raw string) ([]State, string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, ""
	}
	var out []State
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(strings.ToLower(part))
		if part == "" {
			continue
		}
		if !IsCanonicalState(State(part)) {
			return nil, part
		}
		out = append(out, State(part))
	}
	return out, ""
}

// IsCanonicalState reports whether s is a state this view can filter on.
//
// `unknown` is accepted: it is the one state nothing maps onto, and filtering
// for it is exactly how an operator would find rows whose status the registry
// has not caught up with.
func IsCanonicalState(s State) bool {
	switch s {
	case StateQueued, StateRunning, StateSucceeded, StateFailed,
		StateCancelled, StateExpired, StatePartial, StatePreview, StateUnknown:
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
