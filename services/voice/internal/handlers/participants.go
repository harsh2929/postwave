// Package handlers — sequence participants endpoint (desktop gap A9).
//
// GET /v1/voice/sequences/{id}/participants?status=&sort=&page=&per_page=
//
// Lists the subscribers moving through (or done with) a sequence. The
// per-subscriber state is derived from sequence_funnel_events — the only
// per-(sequence, subscriber) table the platform writes — joined against
// the tenant's subscribers mirror for the subscriber id + lifecycle
// status. See seqstore/participants.go for the derivation rules and
// their documented deviations from a "real" enrollment table.
package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/services/voice/internal/generation"
)

// SequenceParticipant is one subscriber's derived enrollment state.
type SequenceParticipant struct {
	// SubscriberID is empty when the subscriber row no longer exists
	// (deleted after receiving sequence emails) — such participants
	// surface with status "exited".
	SubscriberID string    `json:"subscriber_id"`
	Email        string    `json:"email"`
	Status       string    `json:"status"` // active | completed | completed_goal | exited
	CurrentStep  int       `json:"current_step"`
	EnteredAt    time.Time `json:"entered_at"`
	LastEventAt  time.Time `json:"last_event_at"`
}

// SequenceParticipantQuery carries the validated filter/sort/page params
// plus the sequence's email-step count (needed to derive "completed").
type SequenceParticipantQuery struct {
	// Status filters to one derived status; empty means all.
	Status string
	// Sort is one of the participantSortKeys values (always set by the
	// handler; defaults to entered_at_desc).
	Sort    string
	Page    int // 1-based
	PerPage int
	// EmailStepCount is the number of email steps the sequence currently
	// defines. A participant whose current_step has reached it counts as
	// "completed". 0 disables the completed derivation.
	EmailStepCount int
	// GoalKind carries the sequence's goal kind ("open" / "click";
	// "conversion" and "" disable the derivation) so the store can mark
	// goal-met participants with status "completed_goal". Conversion
	// goals have no in-repo event source — see generation.SequenceGoal.
	GoalKind string
}

// goalKindOf returns the evaluable goal kind for the participant /
// stuck projections: "open" or "click", or "" when the sequence has no
// goal or a conversion goal (not evaluable in-repo).
func goalKindOf(goal *generation.SequenceGoal) string {
	if goal == nil {
		return ""
	}
	switch goal.Kind {
	case generation.GoalKindOpen, generation.GoalKindClick:
		return goal.Kind
	default:
		return ""
	}
}

// SequenceParticipantStore serves derived participant state. The only
// production implementation is Postgres-backed (seqstore) because the
// funnel-event facts live in sequence_funnel_events; there is no
// in-memory equivalent, so dev deployments without DATABASE_URL leave
// this nil and the endpoint returns 503 with Retry-After.
type SequenceParticipantStore interface {
	ListParticipants(ctx context.Context, tenantID, sequenceID string, q SequenceParticipantQuery) ([]SequenceParticipant, int, error)
}

// WithSequenceParticipants installs the participant store. Call before
// Routes(). Returns the receiver for chaining with the other With* helpers.
func (h *Handler) WithSequenceParticipants(s SequenceParticipantStore) *Handler {
	h.Participants = s
	return h
}

const (
	participantsDefaultPerPage = 50
	participantsMaxPerPage     = 200
)

// participantSortKeys whitelists the accepted ?sort= values. Bare field
// names alias their _desc variant so `?sort=entered_at` works the way
// the spec reads.
var participantSortKeys = map[string]string{
	"":                   "entered_at_desc",
	"entered_at":         "entered_at_desc",
	"entered_at_desc":    "entered_at_desc",
	"entered_at_asc":     "entered_at_asc",
	"last_event_at":      "last_event_at_desc",
	"last_event_at_desc": "last_event_at_desc",
	"last_event_at_asc":  "last_event_at_asc",
	"current_step_desc":  "current_step_desc",
	"current_step_asc":   "current_step_asc",
}

type sequenceParticipantsResponse struct {
	Items   []SequenceParticipant `json:"items"`
	Total   int                   `json:"total"`
	Page    int                   `json:"page"`
	PerPage int                   `json:"per_page"`
}

// listSequenceParticipants handles
// GET /sequences/{id}/participants?status=&sort=&page=&per_page=.
func (h *Handler) listSequenceParticipants(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	if h.Participants == nil {
		w.Header().Set("Retry-After", "30")
		http.Error(w, "sequence participants require the durable Postgres read model; retry after the database is restored", http.StatusServiceUnavailable)
		return
	}

	qs := r.URL.Query()
	status := strings.ToLower(strings.TrimSpace(qs.Get("status")))
	switch status {
	case "", "all":
		status = ""
	case "active", "completed", "completed_goal", "exited":
	default:
		http.Error(w, "invalid status (want active, completed, completed_goal, or exited)", http.StatusBadRequest)
		return
	}
	sortKey, ok := participantSortKeys[strings.ToLower(strings.TrimSpace(qs.Get("sort")))]
	if !ok {
		http.Error(w, "invalid sort (want entered_at[_asc|_desc], last_event_at[_asc|_desc], or current_step_asc|_desc)", http.StatusBadRequest)
		return
	}
	page, err := positiveIntParam(qs.Get("page"), 1)
	if err != nil {
		http.Error(w, "invalid page", http.StatusBadRequest)
		return
	}
	perPage, err := positiveIntParam(qs.Get("per_page"), participantsDefaultPerPage)
	if err != nil {
		http.Error(w, "invalid per_page", http.StatusBadRequest)
		return
	}
	if perPage > participantsMaxPerPage {
		perPage = participantsMaxPerPage
	}

	// Tenant-scoped existence check first: an unknown (or other-tenant)
	// sequence is a 404, and the row also tells us how many email steps
	// the "completed" derivation should count against.
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

	items, total, err := h.Participants.ListParticipants(r.Context(), tenant, id, SequenceParticipantQuery{
		Status:         status,
		Sort:           sortKey,
		Page:           page,
		PerPage:        perPage,
		EmailStepCount: SequenceEmailStepCount(seq),
		GoalKind:       goalKindOf(seq.Goal),
	})
	if err != nil {
		http.Error(w, "sequence participants unavailable", http.StatusInternalServerError)
		return
	}
	if items == nil {
		items = []SequenceParticipant{}
	}
	writeJSON(w, http.StatusOK, sequenceParticipantsResponse{
		Items:   items,
		Total:   total,
		Page:    page,
		PerPage: perPage,
	})
}

// SequenceEmailStepCount counts the email steps in the sequence's
// authoritative projection (top-level only — funnel events are keyed by
// the flat email position, so branch emails never appear there either).
// Exported because the stuck scanner worker (internal/stuckworker)
// needs the same derivation.
func SequenceEmailStepCount(seq generation.Sequence) int {
	if len(seq.Steps) > 0 {
		n := 0
		for _, s := range seq.Steps {
			if s.Type == generation.StepTypeEmail {
				n++
			}
		}
		return n
	}
	return len(seq.Emails)
}

// positiveIntParam parses a query param that must be a positive integer,
// returning def when the param is absent/blank.
func positiveIntParam(raw string, def int) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("must be a positive integer")
	}
	return n, nil
}
