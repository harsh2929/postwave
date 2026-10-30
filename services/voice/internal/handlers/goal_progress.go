// Package handlers — sequence goal-progress endpoint (roadmap item 2:
// goals / exit-on-goal).
//
// This handler is intentionally not mounted while the execution runtime is
// unavailable. It remains unit-tested as a future read-model implementation,
// but publishing it would misrepresent exit_on_goal as operational.
//
//	Response: {
//	  "sequence_id", "goal_kind", "exit_on_goal",
//	  "enrolled", "completed_goal",
//	  "completed_by_kind": {"open": N, "click": N, "conversion": N},
//	  "completion_rate"   // completed_goal / enrolled, 0..100
//	}
//
// Source of truth: sequence_enrollments (migration 0399). One row per
// (tenant, sequence, subscriber); completed_goal_at is set when an
// open/click goal is observed (by the listmonk-events writer once sends
// carry sequence attribution) or stamped by the dispatcher for
// conversions. This endpoint is a plain read over that table.
//
// IMPORTANT — what this does and does NOT close:
//   - It surfaces goal-completion COUNTS so the desktop can show "120 of
//     500 enrolled hit the goal".
//   - It does NOT stop sends. exit_on_goal is enforced by the EXTERNAL
//     send dispatcher, which must consult sequence_enrollments before
//     sending a step (the exact query lives in
//     apps/desktop/SEQUENCE-LOOP-ENGINE-CONTRACT.md §C). We expose the
//     goal config (goal_kind, exit_on_goal) here so operators can see
//     whether the engine SHOULD be exiting.
//
// Postgres-only (reads sequence_enrollments). A missing store is a temporary
// deployment dependency failure and returns 503 with Retry-After.
package handlers

import (
	"context"
	"net/http"
)

// SequenceGoalProgress is the goal-completion rollup for one sequence.
type SequenceGoalProgress struct {
	SequenceID      string         `json:"sequence_id"`
	GoalKind        string         `json:"goal_kind"` // "" when no goal configured
	ExitOnGoal      bool           `json:"exit_on_goal"`
	Enrolled        int            `json:"enrolled"`
	CompletedGoal   int            `json:"completed_goal"`
	CompletedByKind map[string]int `json:"completed_by_kind"`
	CompletionRate  float64        `json:"completion_rate"` // completed_goal / enrolled * 100
}

// SequenceEnrollmentStats is the raw enrollment aggregate the store
// returns; the handler layers the sequence's configured goal on top.
type SequenceEnrollmentStats struct {
	Enrolled        int
	CompletedGoal   int
	CompletedByKind map[string]int // "open"|"click"|"conversion" -> count
}

// SequenceEnrollmentStore serves enrollment/goal-completion aggregates for a
// future qualified runtime. The public route is currently unmounted.
type SequenceEnrollmentStore interface {
	EnrollmentStats(ctx context.Context, tenantID, sequenceID string) (SequenceEnrollmentStats, error)
}

// WithSequenceEnrollments installs the enrollment store. Call before
// Routes(); returns the receiver for chaining.
func (h *Handler) WithSequenceEnrollments(s SequenceEnrollmentStore) *Handler {
	h.Enrollments = s
	return h
}

// goalProgress is the unit-tested read-model handler retained for a future
// qualified runtime. genRoutes deliberately does not publish it today.
func (h *Handler) goalProgress(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	if h.Enrollments == nil {
		w.Header().Set("Retry-After", "30")
		http.Error(w, "sequence goal-progress requires the durable Postgres read model; retry after the database is restored", http.StatusServiceUnavailable)
		return
	}
	id, ok := sequenceIDFromRequest(w, r)
	if !ok {
		return
	}

	// Tenant-scoped existence check first (404 for unknown/other-tenant),
	// and it gives us the configured goal to echo back.
	seq, err := h.gen.Sequences.Get(r.Context(), tenant, id)
	if err != nil {
		if isSequenceNotFound(err) {
			http.Error(w, "sequence not found", http.StatusNotFound)
			return
		}
		http.Error(w, "sequence lookup failed", http.StatusInternalServerError)
		return
	}

	stats, err := h.Enrollments.EnrollmentStats(r.Context(), tenant, id)
	if err != nil {
		http.Error(w, "sequence goal progress unavailable", http.StatusInternalServerError)
		return
	}

	out := SequenceGoalProgress{
		SequenceID:      id,
		Enrolled:        stats.Enrolled,
		CompletedGoal:   stats.CompletedGoal,
		CompletedByKind: stats.CompletedByKind,
		CompletionRate:  goalCompletionRate(stats.CompletedGoal, stats.Enrolled),
	}
	if out.CompletedByKind == nil {
		out.CompletedByKind = map[string]int{}
	}
	if seq.Goal != nil {
		out.GoalKind = seq.Goal.Kind
		out.ExitOnGoal = seq.Goal.ExitOnGoal
	}
	writeJSON(w, http.StatusOK, out)
}

// goalCompletionRate returns completed/enrolled as a 0..100 percentage,
// guarding division by zero (an empty sequence reports 0%).
func goalCompletionRate(completed, enrolled int) float64 {
	if enrolled <= 0 {
		return 0
	}
	return float64(completed) / float64(enrolled) * 100.0
}
