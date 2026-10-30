// Package handlers — sequence send-performance endpoint (SEQ-009).
//
// GET /v1/voice/sequences/{id}/performance returns aggregate send performance
// for a sequence: reached / opened / clicked per email position plus a
// sequence-level rollup of DISTINCT subscribers. The facts live in
// sequence_funnel_events (migration 0052) — the same table the participant
// view derives from — so this only surfaces what the dispatcher actually
// recorded. It deliberately reports ONLY reached/opened/clicked: bounced,
// delivered, and unsubscribed are NOT tracked per-sequence-email, so inventing
// them would be a fabricated metric.
package handlers

import (
	"context"
	"net/http"
)

// SequencePerformanceStore serves aggregate funnel performance. The only
// production implementation is Postgres-backed (the facts live in
// sequence_funnel_events); dev deployments without DATABASE_URL leave this nil
// and the endpoint returns 503 with Retry-After, exactly like Participants.
type SequencePerformanceStore interface {
	Performance(ctx context.Context, tenantID, sequenceID string) (SequencePerformance, error)
}

// WithSequencePerformance installs the performance store. Call before Routes().
func (h *Handler) WithSequencePerformance(s SequencePerformanceStore) *Handler {
	h.Performance = s
	return h
}

// SequencePerformancePosition is one email step's aggregate send performance.
// Position is 1-based on the wire (the funnel table stores 0-indexed positions;
// see the participants contract).
type SequencePerformancePosition struct {
	Position int `json:"position"`
	// Reached is how many subscribers received this email (funnel rows).
	Reached int `json:"reached"`
	Opened  int `json:"opened"`
	Clicked int `json:"clicked"`
}

// SequencePerformance is the sequence-level rollup plus per-position rows.
// The rollup counts DISTINCT subscribers (a subscriber who opened three emails
// counts once), so open/click rates read against people, not sends.
type SequencePerformance struct {
	// Reached/Opened/Clicked are DISTINCT-subscriber counts across the whole
	// sequence.
	Reached   int                           `json:"reached"`
	Opened    int                           `json:"opened"`
	Clicked   int                           `json:"clicked"`
	Positions []SequencePerformancePosition `json:"positions"`
}

// getSequencePerformance handles GET /sequences/{id}/performance.
func (h *Handler) getSequencePerformance(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	if h.Performance == nil {
		w.Header().Set("Retry-After", "30")
		http.Error(w, "sequence performance requires the durable Postgres read model; retry after the database is restored", http.StatusServiceUnavailable)
		return
	}

	// Tenant-scoped existence check first: an unknown (or other-tenant)
	// sequence is a 404, mirroring the participants endpoint.
	id, ok := sequenceIDFromRequest(w, r)
	if !ok {
		return
	}
	if _, err := h.gen.Sequences.Get(r.Context(), tenant, id); err != nil {
		if isSequenceNotFound(err) {
			http.Error(w, "sequence not found", http.StatusNotFound)
			return
		}
		http.Error(w, "sequence lookup failed", http.StatusInternalServerError)
		return
	}

	perf, err := h.Performance.Performance(r.Context(), tenant, id)
	if err != nil {
		http.Error(w, "sequence performance unavailable", http.StatusInternalServerError)
		return
	}
	if perf.Positions == nil {
		perf.Positions = []SequencePerformancePosition{}
	}
	writeJSON(w, http.StatusOK, perf)
}
