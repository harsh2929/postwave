// SPDX-License-Identifier: AGPL-3.0-only
//
// pnl_handlers.go — HTTP handlers for the Segment P&L surface
// (feature #4). Routes are registered in MountExtended (handlers.go);
// the integrator wires them via the manifest. Read routes use
// ScopeReadReports (matching attribution/holdout-lift); the holdout
// config write routes use ScopeAdmin (matching holdout.go).
//
// The core compute is factored into computeSegmentPnL(store, ...) so the
// handlers and the lift wiring are testable against a fake PnLStore with
// no live database.
package segments

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// computeSegmentPnL assembles one segment's full P&L. includeLift drives
// the (expensive) holdout cohort scan. now is injected for deterministic
// tests. Pure orchestration over the PnLStore + the pure formulas.
func computeSegmentPnL(ctx context.Context, store PnLStore, tenantID, segmentID string, windowDays int, includeLift bool, now time.Time) (*SegmentPnLResponse, error) {
	raw, err := store.SegmentPnLRaw(ctx, tenantID, segmentID, windowDays)
	if err != nil {
		return nil, err
	}

	var lift *SegmentLiftResult
	var liftReason string
	if includeLift {
		switch {
		case !raw.HasHoldout:
			liftReason = "no_holdout_configured"
		case raw.MemberCount > liftInProcessMemberCap:
			// Approved D1: don't pull a huge id list into Go memory.
			liftReason = "segment_too_large_for_in_process_lift"
		default:
			memberIDs, converted, lerr := store.SegmentLiftCohorts(ctx, tenantID, segmentID, raw.HoldoutWindow)
			if lerr != nil {
				return nil, lerr
			}
			lift = liftFromCohorts(raw.HoldoutSeed, raw.HoldoutPercent, raw.HoldoutWindow, memberIDs, converted)
			if lift == nil {
				liftReason = "no_holdout_configured"
			}
		}
	}

	return assemblePnL(raw, windowDays, lift, liftReason, now), nil
}

// SegmentPnL GET /api/v1/segments/{id}/pnl?days=&include_lift=
func (d *Deps) SegmentPnL(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "segment id required"))
		return
	}
	days, ok := parsePnLDays(r.URL.Query().Get("days"))
	if !ok {
		httperror.Write(w, http.StatusBadRequest, "bad_days", "days must be an integer in [1, 365]")
		return
	}
	includeLift := boolParam(r.URL.Query().Get("include_lift"))

	resp, err := computeSegmentPnL(r.Context(), d.Repo, t.ID, id, days, includeLift, time.Now().UTC())
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such segment"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// SegmentPnLCompare GET /api/v1/segments/pnl/compare?ids=a,b,c&days=
// Runs up to compareMaxSegments full P&L computations (sequentially —
// the cap keeps the fan-out bounded). Lift is NOT computed in compare
// (it is the per-segment slideover's job); compare focuses on the
// observed/cost pillars for ranking.
func (d *Deps) SegmentPnLCompare(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	ids := parseCompareIDs(r.URL.Query().Get("ids"))
	if len(ids) < 2 {
		httperror.Write(w, http.StatusBadRequest, "too_few_segments", "ids must list 2..5 segment ids")
		return
	}
	if len(ids) > compareMaxSegments {
		httperror.Write(w, http.StatusBadRequest, "too_many_segments", "compare accepts at most 5 segment ids")
		return
	}
	days, ok := parsePnLDays(r.URL.Query().Get("days"))
	if !ok {
		httperror.Write(w, http.StatusBadRequest, "bad_days", "days must be an integer in [1, 365]")
		return
	}

	now := time.Now().UTC()
	items := make([]SegmentPnLResponse, 0, len(ids))
	for _, id := range ids {
		resp, err := computeSegmentPnL(r.Context(), d.Repo, t.ID, id, days, false, now)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				httperror.Write(w, http.StatusNotFound, "not_found", "one of the segment ids does not exist")
				return
			}
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		items = append(items, *resp)
	}
	writeJSON(w, http.StatusOK, SegmentCompareResponse{Items: items, WindowDays: days, Days: days})
}

// segmentHoldoutInput is the POST body for holdout config.
type segmentHoldoutInput struct {
	Percent    float64 `json:"percent"`
	WindowDays int     `json:"window_days"`
}

// CreateSegmentHoldout POST /api/v1/segments/{id}/holdout
func (d *Deps) CreateSegmentHoldout(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "segment id required"))
		return
	}
	var in segmentHoldoutInput
	if err := httpbody.DecodeJSON(w, r, segmentJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Percent < 0 || in.Percent > 50 {
		httperror.Write(w, http.StatusBadRequest, "bad_percent", "percent must be in [0, 50]")
		return
	}
	if in.WindowDays == 0 {
		in.WindowDays = pnlDefaultDays
	}
	if in.WindowDays < 1 || in.WindowDays > pnlMaxDays {
		httperror.Write(w, http.StatusBadRequest, "bad_window", "window_days must be in [1, 365]")
		return
	}
	cfg, err := d.Repo.UpsertSegmentHoldout(r.Context(), t.ID, id, in.Percent, in.WindowDays)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such segment"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

// DeleteSegmentHoldout DELETE /api/v1/segments/{id}/holdout
func (d *Deps) DeleteSegmentHoldout(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "segment id required"))
		return
	}
	if err := d.Repo.DeleteSegmentHoldout(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no holdout configured for this segment"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------------------------------------------------------------------------
// Small param parsers (pure)
// ---------------------------------------------------------------------------

// boolParam interprets the conventional truthy query-param values.
func boolParam(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// parseCompareIDs splits a comma-separated id list, trimming blanks and
// de-duplicating while preserving order (first occurrence wins).
func parseCompareIDs(raw string) []string {
	parts := strings.Split(raw, ",")
	seen := make(map[string]bool, len(parts))
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}
