// Package handlers — whole-sequence draft-from-brief endpoint (desktop
// gap A26).
//
// POST /v1/voice/sequences/draft
// Body:     { "brief": string, "step_count"?: number, "tone"?: string }
// Response: { "name": string, "steps": [{ "subject", "body", "delay_hours", "position" }] }
//
// One synchronous structured-JSON Gemini call (same shape as the chat
// panel's campaign_draft kind — a draft is small enough to stay inside
// the request, unlike full template generation which goes async).
// Nothing is persisted: the desktop feeds the draft into the canvas and
// the user saves whatever they keep via the existing POST /sequences
// manual-draft path.
package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/quota"
)

const (
	// draftBriefMaxRunes bounds the free-text brief well below the 1 MiB
	// body cap so a pasted document can't blow the prompt budget.
	draftBriefMaxRunes = 8000
	draftToneMaxRunes  = 200
)

type draftSequenceRequest struct {
	Brief     string `json:"brief"`
	StepCount int    `json:"step_count,omitempty"`
	Tone      string `json:"tone,omitempty"`
}

// draftSequence handles POST /sequences/draft.
func (h *Handler) draftSequence(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	var req draftSequenceRequest
	if err := decodeRequestJSON(w, r, voiceHandlerJSONMaxBodyBytes, &req); err != nil {
		http.Error(w, requestDecodeMessage(err), requestDecodeStatus(err))
		return
	}
	req.Brief = strings.TrimSpace(req.Brief)
	if req.Brief == "" {
		http.Error(w, "brief required", http.StatusBadRequest)
		return
	}
	if utf8.RuneCountInString(req.Brief) > draftBriefMaxRunes {
		http.Error(w, fmt.Sprintf("brief too long (max %d characters)", draftBriefMaxRunes), http.StatusBadRequest)
		return
	}
	if req.StepCount < 0 || req.StepCount > generation.DraftStepCountMax {
		http.Error(w, fmt.Sprintf("step_count must be between 1 and %d", generation.DraftStepCountMax), http.StatusBadRequest)
		return
	}
	req.Tone = strings.TrimSpace(req.Tone)
	if utf8.RuneCountInString(req.Tone) > draftToneMaxRunes {
		http.Error(w, fmt.Sprintf("tone too long (max %d characters)", draftToneMaxRunes), http.StatusBadRequest)
		return
	}

	// Quota gate. One Gemini turn per call — one quota unit, same as a
	// chat / regenerate call. The distinct kind keeps the per-feature
	// breakdown in tenant_ai_usage honest even though the cap is on the
	// daily sum.
	if err := h.quotaOrNoop().CheckAndConsume(r.Context(), tenant, "sequence_draft", quota.CostMilliCredits("sequence_draft", 1)); err != nil {
		if errors.Is(err, quota.ErrOverQuota) {
			writeQuotaExceeded(w, h.quotaOrNoop(), r.Context(), tenant, "sequence_draft")
			return
		}
		http.Error(w, fmt.Sprintf("quota: %v", err), http.StatusInternalServerError)
		return
	}

	genReq := generation.DraftRequest{
		Brief:     req.Brief,
		StepCount: req.StepCount,
		Tone:      req.Tone,
	}
	// Best-effort voice profile, mirroring generateSequence: when the
	// tenant has built one, its representative samples steer the draft
	// toward the writer's voice. Absence is fine — generic marketing
	// voice is the documented fallback.
	if stored, err := h.Store.GetProfile(r.Context(), tenant); err == nil {
		genReq.Profile = stored
	}

	draft, err := h.gen.Engine.DraftFromBrief(r.Context(), genReq)
	if err != nil {
		// 503 when the LLM isn't configured, 429/502 etc. for upstream
		// failures — same mapping the chat panel uses.
		http.Error(w, err.Error(), statusForLLMError(err))
		return
	}
	writeJSON(w, http.StatusOK, draft)
}
