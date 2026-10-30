// Package handlers — voice drift check endpoint.
//
// POST /v1/voice/drift accepts a proposed email body + the tenant's
// VoiceProfile (looked up by X-Tenant-ID), runs the existing fidelity
// evaluator, and returns a 0..100 score + a `warn` flag the desktop
// pre-send banner uses to surface "this doesn't sound like you".
//
// The fidelity evaluator already lives at services/voice/internal/
// fidelity/evaluator.go — this handler is the thin HTTP wrapper.

package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/postwave/postwave/services/voice/internal/fidelity"
)

// DriftWarnThreshold is the score under which the pre-send UI flips
// the banner to "drift warning". Calibrated to the generation
// engine's existing auto-retry threshold of 60 — anything below 60
// is what we consider a meaningful divergence from voice.
const DriftWarnThreshold = 60.0

// DriftCriticalThreshold flips the banner to "blocked" until the
// operator acknowledges. 40 = "this doesn't read like the tenant's
// voice at all".
const DriftCriticalThreshold = 40.0

// driftRequest is the inbound shape.
type driftRequest struct {
	Body string `json:"body"`
	// Subject is included in the scoring buffer but weighted less
	// because it's structurally different from the body. Optional.
	Subject string `json:"subject,omitempty"`
	// ProfileID (G10) names the authored brand-voice profile the caller
	// wants scored against. Forwarded by the desktop pre-send banner and
	// echoed back so the operator can confirm which profile was used.
	ProfileID string `json:"profile_id,omitempty"`
	// Descriptors / BannedTerms (G10) are the authored profile's rules,
	// populated by apps/api from brand_voice_profiles before proxying.
	// They drive a deterministic overlay on top of the corpus fidelity
	// score: banned terms present pull the score down, brand-typical
	// descriptors present nudge it up. Both optional — empty => corpus
	// score only, identical to pre-G10 behaviour.
	Descriptors []string `json:"descriptors,omitempty"`
	BannedTerms []string `json:"banned_terms,omitempty"`
}

// driftResponse is the wire response.
type driftResponse struct {
	Score     float64                    `json:"score"`    // 0..100
	Severity  string                     `json:"severity"` // ok | warn | critical
	Warn      bool                       `json:"warn"`
	Critical  bool                       `json:"critical"`
	Breakdown fidelity.FidelityBreakdown `json:"breakdown"`
	// ProfileID (G10) echoes the authored profile the caller bound the
	// check to, so the desktop can confirm which voice was scored.
	ProfileID string `json:"profile_id,omitempty"`
	// AuthoredAdjustment (G10) is the signed score delta the authored
	// banned-term / descriptor overlay applied on top of the corpus
	// fidelity score. Negative = banned terms pulled it down.
	AuthoredAdjustment float64 `json:"authored_adjustment,omitempty"`
	// Suggestions is a small set of free-text hints derived from the
	// breakdown so the operator can fix the drift without re-running
	// the generator from scratch.
	Suggestions []string `json:"suggestions,omitempty"`
}

// driftCheck handles POST /v1/voice/drift.
func (h *Handler) driftCheck(w http.ResponseWriter, r *http.Request) {
	tenant := h.TenantFromRequest(r)
	if tenant == "" {
		writeChatError(w, http.StatusUnauthorized, "missing tenant")
		return
	}
	var req driftRequest
	if err := decodeRequestJSON(w, r, voiceHandlerJSONMaxBodyBytes, &req); err != nil {
		writeChatError(w, requestDecodeStatus(err), requestDecodeMessage(err))
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		writeChatError(w, http.StatusBadRequest, "body is required")
		return
	}
	prof, err := h.Store.GetProfile(r.Context(), tenant)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			// No profile yet — drift check is a no-op (no baseline to
			// compare against). Return ok with a clear hint.
			writeJSON(w, http.StatusOK, driftResponse{
				Score:    100,
				Severity: "ok",
				Suggestions: []string{
					"No voice profile yet — drift check is inactive. Build a voice profile under Settings → Voice to enable warnings.",
				},
			})
			return
		}
		writeChatError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Compose the input text: subject + body. The evaluator scores
	// the whole buffer; we strip HTML tags so the stylistic features
	// don't pick up boilerplate markup.
	buf := stripHTML(req.Subject + "\n" + req.Body)
	evaluator := h.evaluatorOrFallback()
	score, br, err := evaluator.Score(r.Context(), buf, prof)
	if err != nil {
		writeChatError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// G10 authored-rule overlay: when apps/api supplied the authored
	// profile's banned terms / descriptors, fold a deterministic
	// adjustment into the corpus fidelity score. Banned terms are the
	// strongest signal of "off-voice" — they outweigh a stylistic match.
	adjustment := authoredAdjustment(buf, req.Descriptors, req.BannedTerms)
	score = clampScore(score + adjustment)
	severity := "ok"
	warn := false
	critical := false
	if score < DriftCriticalThreshold {
		severity = "critical"
		critical = true
		warn = true
	} else if score < DriftWarnThreshold {
		severity = "warn"
		warn = true
	}
	suggestions := deriveDriftSuggestions(br)
	if adjustment < 0 {
		suggestions = append([]string{
			"Wording includes terms your brand-voice profile flags as off-voice — replace them.",
		}, suggestions...)
		if len(suggestions) > 3 {
			suggestions = suggestions[:3]
		}
	}
	writeJSON(w, http.StatusOK, driftResponse{
		Score:              score,
		Severity:           severity,
		Warn:               warn,
		Critical:           critical,
		Breakdown:          br,
		ProfileID:          strings.TrimSpace(req.ProfileID),
		AuthoredAdjustment: adjustment,
		Suggestions:        suggestions,
	})
}

// authoredAdjustment returns a signed delta (roughly [-30, +6]) applied
// to the corpus fidelity score from the authored profile's rules:
//   - each distinct banned term found in the buffer subtracts 10 (capped
//     at -30 so three hits already force a "critical");
//   - up to three brand-typical descriptors found add 2 each.
//
// Matching is case-insensitive, whitespace-trimmed, word-ish (substring
// on the lowercased buffer). Empty rule sets => 0 (no-op).
func authoredAdjustment(buf string, descriptors, banned []string) float64 {
	lower := strings.ToLower(buf)
	var delta float64
	penalty := 0
	for _, term := range banned {
		term = strings.ToLower(strings.TrimSpace(term))
		if term == "" {
			continue
		}
		if strings.Contains(lower, term) {
			penalty++
		}
	}
	if penalty > 3 {
		penalty = 3
	}
	delta -= float64(penalty) * 10

	reward := 0
	for _, d := range descriptors {
		d = strings.ToLower(strings.TrimSpace(d))
		if d == "" {
			continue
		}
		if strings.Contains(lower, d) {
			reward++
		}
	}
	if reward > 3 {
		reward = 3
	}
	delta += float64(reward) * 2
	return delta
}

func clampScore(s float64) float64 {
	if s < 0 {
		return 0
	}
	if s > 100 {
		return 100
	}
	return s
}

// evaluatorOrFallback returns the heuristic-only evaluator. We
// deliberately don't reach into h.gen for an embedding client —
// drift checks run on every send, and consuming the OpenAI
// embedding quota per send is wasteful. The stylistic + vocab +
// structural components alone produce a usable signal (the engine's
// auto-retry threshold of 60 already passes/fails purely on this
// composite at low embedding scores). Wire a real embedding
// evaluator if higher accuracy is needed for a specific tenant.
func (h *Handler) evaluatorOrFallback() fidelity.Evaluator {
	return fidelity.NewEmbeddingEvaluator(nil)
}

// stripHTML removes basic HTML markup so the evaluator sees prose,
// not tags. Doesn't try to be a full HTML parser — the email body
// rendered to text is what matters.
func stripHTML(s string) string {
	out := strings.Builder{}
	inTag := false
	for _, r := range s {
		switch r {
		case '<':
			inTag = true
		case '>':
			inTag = false
		default:
			if !inTag {
				out.WriteRune(r)
			}
		}
	}
	return out.String()
}

// deriveDriftSuggestions inspects the per-component breakdown and
// returns up to three actionable hints. Pure heuristic — small set
// of canned strings keyed by which component is weakest.
func deriveDriftSuggestions(br fidelity.FidelityBreakdown) []string {
	tips := []string{}
	if br.EmbeddingSimilarity < 0.5 {
		tips = append(tips, "Semantic style differs — try matching the tenant's typical topic framing.")
	}
	if br.StylisticDistance < 0.5 {
		tips = append(tips, "Sentence length / formality differ from past sends. Shorten or tighten.")
	}
	if br.VocabularyOverlap < 0.3 {
		tips = append(tips, "Few distinctive vocabulary matches — work in 2–3 brand-typical phrases.")
	}
	if br.StructuralMatch < 0.5 {
		tips = append(tips, "Opening hook / closing pattern differs from the tenant's typical layout.")
	}
	if len(tips) > 3 {
		tips = tips[:3]
	}
	return tips
}

// Compile-time satisfy json + context (both used by the writeJSON
// helper in this package).
var _ = json.Marshal
var _ = context.Background
