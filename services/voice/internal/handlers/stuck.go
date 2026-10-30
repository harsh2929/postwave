// Package handlers — stuck-participant detection (roadmap item 3) and
// in-repo goal evaluation (roadmap item 2).
//
// GET /v1/voice/sequences/{id}/stuck[?days=N]
// Response: { "items": [{subscriber_id, email, current_step, idle_days}],
//
//	"threshold_days": N }
//
// A participant is "stuck" when they are still active in the sequence
// (subscriber exists + not disabled/blocklisted), have NOT received the
// final email, have NOT met the sequence goal (open/click goals are
// derivable from sequence_funnel_events; conversion goals have no
// in-repo event source and never evaluate as met), and their last
// funnel event is older than the threshold.
//
// The threshold comes from the sequence's `stuck_after_days` setting
// (tenant-configurable via PATCH; default off). `?days=N` overrides it
// for ad-hoc exploration without changing the stored setting.
//
// The same evaluation feeds the stuck scanner worker
// (internal/stuckworker), which emits a `sequence.participants.stuck`
// webhook.fanout outbox event — the cheapest real notification channel
// in the platform: apps/api's gateway worker already expands outbox
// rows into per-subscription webhook deliveries the desktop consumes.
package handlers

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/services/voice/internal/generation"
)

// ParticipantActivity is one subscriber's raw per-sequence activity
// aggregate, derived from sequence_funnel_events + the subscribers
// mirror. The pure evaluators below (GoalMet / EvaluateStuck) run on
// these rows so the threshold/goal/completion logic is unit-testable
// with fake events, while the SQL stays a plain aggregation.
type ParticipantActivity struct {
	SubscriberID string
	Email        string
	// CurrentStep is 1-based: max(position)+1 over the subscriber's
	// funnel rows (positions are 0-indexed in the table).
	CurrentStep int
	// LastEventAt is the greatest of sent/opened/clicked timestamps.
	LastEventAt time.Time
	// AnyOpen / AnyClick are true when any funnel row for this
	// subscriber has opened_at / clicked_at set.
	AnyOpen  bool
	AnyClick bool
	// SubscriberActive is false when the subscriber row is gone or its
	// lifecycle status is disabled/blocklisted — such participants are
	// "exited" and never stuck.
	SubscriberActive bool
}

// SequenceActivityStore lists raw per-subscriber activity for one
// sequence. Postgres-only (reads sequence_funnel_events); a missing store is
// reported as a temporary 503 dependency failure.
type SequenceActivityStore interface {
	ListActivity(ctx context.Context, tenantID, sequenceID string) ([]ParticipantActivity, error)
}

// WithSequenceActivity installs the activity store. Call before
// Routes(); returns the receiver for chaining.
func (h *Handler) WithSequenceActivity(s SequenceActivityStore) *Handler {
	h.Activity = s
	return h
}

// StuckParticipant is one row of the stuck report.
type StuckParticipant struct {
	SubscriberID string `json:"subscriber_id"`
	Email        string `json:"email"`
	CurrentStep  int    `json:"current_step"`
	IdleDays     int    `json:"idle_days"`
}

type stuckResponse struct {
	Items         []StuckParticipant `json:"items"`
	ThresholdDays int                `json:"threshold_days"`
}

// stuckReportMaxItems caps the report (and the worker's alert payload
// source) so a huge sequence can't produce a megabyte response.
const stuckReportMaxItems = 500

// GoalMet evaluates a sequence goal against one participant's event
// aggregate. Conversion goals always return false in-repo — there is no
// sequence conversion event source in this repository (see the
// SequenceGoal doc in generation/types.go).
func GoalMet(goal *generation.SequenceGoal, a ParticipantActivity) bool {
	if goal == nil {
		return false
	}
	switch goal.Kind {
	case generation.GoalKindOpen:
		return a.AnyOpen
	case generation.GoalKindClick:
		return a.AnyClick
	default: // conversion — no in-repo event source
		return false
	}
}

// EvaluateStuck filters activity rows down to the stuck participants
// for a sequence. Pure function (no I/O, caller supplies now) so it is
// exercised by table-driven tests with fake events.
//
// Rules, in order:
//   - thresholdDays < 1 → nothing is stuck (feature off);
//   - inactive subscribers (deleted/disabled/blocklisted) are exited,
//     not stuck;
//   - participants who received the final email (current_step >=
//     emailStepCount, when known) completed the sequence;
//   - participants who met the goal are done — alerting on them would
//     be noise regardless of exit_on_goal;
//   - everyone else is stuck when their last event is older than the
//     threshold.
//
// Results are sorted most-idle first and capped at stuckReportMaxItems.
func EvaluateStuck(rows []ParticipantActivity, thresholdDays, emailStepCount int, goal *generation.SequenceGoal, now time.Time) []StuckParticipant {
	out := []StuckParticipant{}
	if thresholdDays < 1 {
		return out
	}
	cutoff := now.Add(-time.Duration(thresholdDays) * 24 * time.Hour)
	for _, a := range rows {
		if !a.SubscriberActive {
			continue
		}
		if emailStepCount > 0 && a.CurrentStep >= emailStepCount {
			continue
		}
		if GoalMet(goal, a) {
			continue
		}
		if a.LastEventAt.IsZero() || !a.LastEventAt.Before(cutoff) {
			continue
		}
		idle := int(now.Sub(a.LastEventAt).Hours() / 24)
		out = append(out, StuckParticipant{
			SubscriberID: a.SubscriberID,
			Email:        a.Email,
			CurrentStep:  a.CurrentStep,
			IdleDays:     idle,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IdleDays != out[j].IdleDays {
			return out[i].IdleDays > out[j].IdleDays
		}
		return out[i].Email < out[j].Email
	})
	if len(out) > stuckReportMaxItems {
		out = out[:stuckReportMaxItems]
	}
	return out
}

// listStuckParticipants handles GET /sequences/{id}/stuck.
func (h *Handler) listStuckParticipants(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	if h.Activity == nil {
		w.Header().Set("Retry-After", "30")
		http.Error(w, "stuck-participant report requires the durable Postgres read model; retry after the database is restored", http.StatusServiceUnavailable)
		return
	}
	id, ok := sequenceIDFromRequest(w, r)
	if !ok {
		return
	}
	seq, err := h.gen.Sequences.Get(r.Context(), tenant, id)
	if err != nil {
		if isSequenceNotFound(err) {
			http.Error(w, "sequence not found", http.StatusNotFound)
			return
		}
		http.Error(w, "sequence lookup failed", http.StatusInternalServerError)
		return
	}

	threshold := seq.StuckAfterDays
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		n, perr := positiveIntParam(raw, 0)
		if perr != nil || n > stuckAfterDaysMax {
			http.Error(w, fmt.Sprintf("days must be a positive integer <= %d", stuckAfterDaysMax), http.StatusBadRequest)
			return
		}
		threshold = n
	}
	if threshold < 1 {
		http.Error(w, "stuck_after_days is not configured on this sequence (PATCH it or pass ?days=N)", http.StatusBadRequest)
		return
	}

	rows, err := h.Activity.ListActivity(r.Context(), tenant, id)
	if err != nil {
		http.Error(w, "sequence activity unavailable", http.StatusInternalServerError)
		return
	}
	items := EvaluateStuck(rows, threshold, SequenceEmailStepCount(seq), seq.Goal, time.Now().UTC())
	writeJSON(w, http.StatusOK, stuckResponse{Items: items, ThresholdDays: threshold})
}
