// Package handlers — deterministic A/B variant resolution (roadmap
// item 1).
//
// POST /v1/voice/sequences/{id}/steps/{position}/variant
// Body: { "subscriber_id": "opaque-stable-id" }
// Response: { "variant_key", "subject", "body", "body_html"?, "weight_bp" }
//
// Pure hash over (subscriber, sequence, step) — see
// generation.AssignVariant for the stable hash contract. No state is
// written: the same inputs always resolve to the same arm, so the
// desktop can use this endpoint as an authoring preview. The delivery runtime
// is currently unavailable, and analytics retains a legacy email-keyed
// fallback, so this route does not claim send-time parity until a dispatcher
// supplies the same trustworthy opaque identity and stamps variant_key.
//
// `position` addresses the TOP-LEVEL step list (the same flat 1-based
// numbering the funnel + participants use). Variants on branch steps
// are stored and validated but not resolvable through this endpoint —
// branch steps have no flat position identity on the wire today.
package handlers

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/voice/internal/generation"
)

type variantAssignmentResponse struct {
	VariantKey string `json:"variant_key"`
	Subject    string `json:"subject"`
	Body       string `json:"body"`
	BodyHTML   string `json:"body_html,omitempty"`
	WeightBP   int    `json:"weight_bp"`
}

type variantAssignmentRequest struct {
	SubscriberID string `json:"subscriber_id"`
}

// assignStepVariant handles POST /sequences/{id}/steps/{position}/variant.
func (h *Handler) assignStepVariant(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	if r.URL.RawQuery != "" {
		http.Error(w, "variant assignment does not accept query parameters", http.StatusBadRequest)
		return
	}
	id, ok := sequenceIDFromRequest(w, r)
	if !ok {
		return
	}
	pos, err := strconv.Atoi(chi.URLParam(r, "position"))
	if err != nil || pos < 1 || pos > sequenceMaxPosition {
		http.Error(w, "position must be a positive integer within the supported sequence range", http.StatusBadRequest)
		return
	}
	var req variantAssignmentRequest
	if err := decodeStrictRequestJSON(w, r, 4096, &req); err != nil {
		http.Error(w, requestDecodeMessage(err), requestDecodeStatus(err))
		return
	}
	if err := validateOpaqueSubscriberID(req.SubscriberID); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
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

	step := topLevelEmailStepAt(seq, pos)
	if step == nil {
		http.Error(w, "no email step at that position", http.StatusNotFound)
		return
	}
	variant, err := generation.AssignVariant(seq.ID, pos, req.SubscriberID, step.Email.Variants)
	if err != nil {
		if errors.Is(err, generation.ErrNoVariants) {
			http.Error(w, "step has no variants", http.StatusNotFound)
			return
		}
		// Persisted-but-invalid variant list (should be unreachable —
		// the PATCH path validates) — surface loudly.
		http.Error(w, "stored sequence variants are invalid", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, variantAssignmentResponse{
		VariantKey: variant.Key,
		Subject:    variant.Subject,
		Body:       variant.Body,
		BodyHTML:   variant.BodyHTML,
		WeightBP:   variant.WeightBP,
	})
}

// topLevelEmailStepAt resolves the top-level email step at the given
// 1-based position from whichever projection (Steps or legacy Emails)
// is authoritative. Returns nil when the position doesn't exist or
// isn't an email step. The legacy Emails projection cannot carry
// variants, so resolution there always yields a variant-less step.
func topLevelEmailStepAt(seq generation.Sequence, pos int) *generation.Step {
	steps := currentSteps(seq)
	for i := range steps {
		if steps[i].Position == pos && steps[i].Type == generation.StepTypeEmail && steps[i].Email != nil {
			return &steps[i]
		}
	}
	return nil
}
