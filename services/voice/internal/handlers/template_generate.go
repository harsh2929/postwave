// Package handlers — on-brand AI template generator (roadmap item 4).
//
// POST /v1/voice/templates/generate
// Body:     { "brief": string, "kind"?: "newsletter"|"promo"|"announcement", "tone"?: string }
// Response: { "name": string, "subject": string, "body_html": string, "body_mjml"?: string }
//
// One synchronous structured-JSON LLM call, conditioned on the tenant's
// brand-voice profile when one is built (same best-effort lookup the
// sequences/draft endpoint uses). Nothing is persisted: the caller
// decides whether to save the result via POST /templates (admin) or use
// it directly in a campaign.
//
// Quota: one unit of the per-tenant daily AI budget, kind
// "template_generate", mirroring the sibling LLM endpoints.
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
	// templateGenBriefMaxRunes matches the sequences/draft brief cap.
	templateGenBriefMaxRunes = 8000
	templateGenToneMaxRunes  = 200
)

type generateTemplateRequest struct {
	Brief      string                            `json:"brief"`
	Kind       string                            `json:"kind,omitempty"`
	Tone       string                            `json:"tone,omitempty"`
	References []generation.TemplateGenReference `json:"references,omitempty"`
}

// generateTemplateFromBrief handles POST /templates/generate.
func (h *Handler) generateTemplateFromBrief(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		http.Error(w, "missing tenant", http.StatusUnauthorized)
		return
	}
	var req generateTemplateRequest
	if err := decodeRequestJSON(w, r, voiceHandlerJSONMaxBodyBytes, &req); err != nil {
		http.Error(w, requestDecodeMessage(err), requestDecodeStatus(err))
		return
	}
	req.Brief = strings.TrimSpace(req.Brief)
	if req.Brief == "" {
		http.Error(w, "brief required", http.StatusBadRequest)
		return
	}
	if utf8.RuneCountInString(req.Brief) > templateGenBriefMaxRunes {
		http.Error(w, fmt.Sprintf("brief too long (max %d characters)", templateGenBriefMaxRunes), http.StatusBadRequest)
		return
	}
	req.Kind = strings.ToLower(strings.TrimSpace(req.Kind))
	if !generation.ValidTemplateGenKind(req.Kind) {
		http.Error(w, `kind must be one of "newsletter", "promo", "announcement"`, http.StatusBadRequest)
		return
	}
	req.Tone = strings.TrimSpace(req.Tone)
	if utf8.RuneCountInString(req.Tone) > templateGenToneMaxRunes {
		http.Error(w, fmt.Sprintf("tone too long (max %d characters)", templateGenToneMaxRunes), http.StatusBadRequest)
		return
	}
	if len(req.References) > 3 {
		http.Error(w, "references supports at most 3 items", http.StatusBadRequest)
		return
	}

	// Quota gate. One LLM turn per call — one quota unit; the distinct
	// kind keeps the per-feature breakdown in tenant_ai_usage honest.
	if err := h.quotaOrNoop().CheckAndConsume(r.Context(), tenant, "template_generate", quota.CostMilliCredits("template_generate", 1)); err != nil {
		if errors.Is(err, quota.ErrOverQuota) {
			writeQuotaExceeded(w, h.quotaOrNoop(), r.Context(), tenant, "template_generate")
			return
		}
		http.Error(w, fmt.Sprintf("quota: %v", err), http.StatusInternalServerError)
		return
	}

	genReq := generation.TemplateGenRequest{
		Brief:      req.Brief,
		Kind:       req.Kind,
		Tone:       req.Tone,
		References: req.References,
	}
	// Best-effort brand-voice profile, mirroring sequences/draft: when
	// built, its representative samples steer the template toward the
	// writer's voice. Absence falls back to generic marketing voice.
	if stored, err := h.Store.GetProfile(r.Context(), tenant); err == nil {
		genReq.Profile = stored
	}

	tmpl, err := h.gen.Engine.GenerateTemplate(r.Context(), genReq)
	if err != nil {
		// 503 when the LLM isn't configured; 429/502 etc. for upstream
		// failures — same mapping as the chat panel + sequences/draft.
		http.Error(w, err.Error(), statusForLLMError(err))
		return
	}
	writeJSON(w, http.StatusOK, tmpl)
}
