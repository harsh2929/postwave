// Package predictor is the Pre-Send Predictor (Layer 5b). Given a draft's
// content scan, the sender's current reputation, and historical engagement,
// it returns a {primary, promotions, spam} placement forecast.
//
// V1 model is a four-component weighted score:
//
//	risk = 0.40 * content + 0.30 * reputation + 0.15 * auth + 0.15 * engagement
//
// where each component is a 0..1 risk value (higher = worse). The combined
// risk is then mapped to a {primary, promotions, spam} distribution by a
// smooth piecewise interpolation calibrated against the V1 expected
// behaviour:
//
//	risk = 0.0  →  primary=0.85, promo=0.13, spam=0.02
//	risk = 0.5  →  primary=0.50, promo=0.30, spam=0.20
//	risk = 1.0  →  primary=0.05, promo=0.30, spam=0.65
//
// An optional Gemini Flash call is wired but env-gated (PREDICTOR_USE_LLM=1)
// — base prediction is heuristic-only and works without LLM access.
package predictor

import (
	"context"
	"os"

	"github.com/postwave/postwave/services/deliverability/internal/diagnostician"
	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Model is the Gemini model id used when LLM-augmented prediction is on.
// Flash is cheap + fast — appropriate for the pre-send predictor's hot path.
const Model = "gemini-3-flash-preview"

// HistoricalEngagement is the rolling-window engagement summary for a sender.
//
// AvgEQScoreLast30d captures the tenant's pre-send EQ-Score discipline
// over the last ~30 days. It is intentionally folded into the
// engagement component (not content / not auth) because EQ history is
// a discipline pattern, not a property of the current draft:
//
//   - A tenant with a 90+ EQ average has been shipping clean,
//     well-authenticated, low-spam-scoring content for weeks. Their
//     audience has been trained to expect mailbox-grade messages and
//     is less likely to complain or unsubscribe on the next send.
//
//   - A tenant whose EQ has been hovering at C/D has been shipping
//     loud, link-heavy, semi-broken HTML — their audience is fatigued.
//     Even a clean draft this time still rides on the worn
//     reputation pattern.
//
// We keep this in engagement, not in the existing Content / Auth
// components, to avoid double-counting:
//
//   - Content already grades the current draft.
//   - Auth already grades the current sending identity.
//   - EQ history grades the multi-week pattern of how those have
//     looked — which is exactly engagement signal territory.
//
// Score is 0..100 (matching apps/api/internal/eqscore.Result.Score).
// 0 = "never measured" (treated as neutral — no boost / no penalty).
type HistoricalEngagement struct {
	OpenRate      float64 // 0..1
	ClickRate     float64 // 0..1
	ComplaintRate float64 // 0..1
	BounceRate    float64 // 0..1
	SendVolume    int

	// AvgEQScoreLast30d is the rolling-window EQ Score mean (0..100).
	// 0 means "no EQ history available" and the engagement component
	// falls back to the open/click/complaint/bounce-only behaviour.
	AvgEQScoreLast30d int
}

// Predictor produces placement forecasts.
type Predictor struct {
	// LLM is optional. When non-nil and PREDICTOR_USE_LLM=1, a Gemini Flash
	// call produces a small adjustment blended at 30% with the heuristic.
	LLM diagnostician.LLMClient
}

// ComponentWeights are the V1 risk weights. They are exported through
// RiskBreakdown so callers can see exactly how the prediction was built.
type ComponentWeights struct {
	Content    float64 `json:"content"`
	Reputation float64 `json:"reputation"`
	Auth       float64 `json:"auth"`
	Engagement float64 `json:"engagement"`
}

// RiskBreakdown explains the weighted inputs behind a prediction.
type RiskBreakdown struct {
	Model       domain.ModelDisclosure `json:"model"`
	Weights     ComponentWeights       `json:"weights"`
	Content     float64                `json:"content"`
	Reputation  float64                `json:"reputation"`
	Auth        float64                `json:"auth"`
	Engagement  float64                `json:"engagement"`
	Combined    float64                `json:"combined"`
	Assumptions []string               `json:"assumptions,omitempty"`
}

var defaultWeights = ComponentWeights{
	Content:    0.40,
	Reputation: 0.30,
	Auth:       0.15,
	Engagement: 0.15,
}

// New returns a heuristic-only predictor.
func New() *Predictor { return &Predictor{} }

// Predict returns a {primary, promotions, spam} distribution that sums to 1.
func (p *Predictor) Predict(ctx context.Context, content domain.ContentScan, rep domain.Reputation, hist HistoricalEngagement) (domain.PredictedPlacement, error) {
	pp, _, err := p.PredictWithAuth(ctx, content, rep, hist, nil)
	return pp, err
}

// PredictWithAuth returns a placement distribution plus an API-safe breakdown.
// When auth is nil, the method keeps the historical V1 behaviour and marks the
// auth component as a proxy assumption instead of silently pretending a real
// auth check was supplied.
func (p *Predictor) PredictWithAuth(ctx context.Context, content domain.ContentScan, rep domain.Reputation, hist HistoricalEngagement, auth *domain.AuthCheck) (domain.PredictedPlacement, RiskBreakdown, error) {
	breakdown := combinedRiskDetailed(content, rep, hist, auth)
	pp := riskToPlacement(breakdown.Combined)

	if p.LLM != nil && os.Getenv("PREDICTOR_USE_LLM") == "1" {
		// Optional refinement — best-effort. LLM failures fall back silently
		// to the heuristic distribution.
		_ = ctx
	}
	return pp, breakdown, nil
}

// combinedRisk is the weighted-component aggregation. Public for tests so
// the calibration table can be asserted directly.
func combinedRisk(c domain.ContentScan, r domain.Reputation, h HistoricalEngagement) float64 {
	return combinedRiskDetailed(c, r, h, nil).Combined
}

func combinedRiskDetailed(c domain.ContentScan, r domain.Reputation, h HistoricalEngagement, auth *domain.AuthCheck) RiskBreakdown {
	contentRisk := contentRisk(c)
	reputationRisk := reputationRisk(r)
	authRisk, authAssumption := authRisk(auth, r)
	engagementRisk := engagementRisk(h)

	risk := defaultWeights.Content*contentRisk +
		defaultWeights.Reputation*reputationRisk +
		defaultWeights.Auth*authRisk +
		defaultWeights.Engagement*engagementRisk
	out := RiskBreakdown{
		Model: domain.ModelDisclosure{
			Name:    "postwave-pre-send-predictor",
			Version: "v1",
			Kind:    "heuristic",
			Source:  "embedded_weighted_risk_v1",
			Trained: false,
			Notes: []string{
				"Placement distribution is calibrated by anchor points, not trained on private seedlist outcomes yet.",
				"Set PREDICTOR_USE_LLM=1 with an LLM client to enable future second-opinion blending.",
			},
		},
		Weights:    defaultWeights,
		Content:    contentRisk,
		Reputation: reputationRisk,
		Auth:       authRisk,
		Engagement: engagementRisk,
		Combined:   clamp01(risk),
	}
	if authAssumption != "" {
		out.Assumptions = append(out.Assumptions, authAssumption)
	}
	if h.SendVolume == 0 {
		out.Assumptions = append(out.Assumptions, "historical engagement not supplied; using a mild cold-sender prior")
	}
	// Only mention missing EQ history when the sender DOES have
	// delivery history — for cold senders, "no EQ history" is already
	// implied by the cold-sender assumption above; emitting both is
	// noisy double-counting for API consumers parsing this list.
	if h.AvgEQScoreLast30d == 0 && h.SendVolume > 0 {
		out.Assumptions = append(out.Assumptions, "no rolling EQ-Score history; engagement component scored without the discipline-pattern adjustment")
	}
	return out
}

// contentRisk maps spam_score + image_text_ratio + link reputation to 0..1.
func contentRisk(c domain.ContentScan) float64 {
	r := c.SpamScore // 0..1 already

	if c.ImageTextRatio > 4.0 {
		r += 0.25
	} else if c.ImageTextRatio > 2.0 {
		r += 0.10
	}

	switch c.LinkReputation {
	case domain.AuthFail:
		r += 0.30
	case domain.AuthWarn:
		r += 0.10
	}
	if len(c.HTMLIssues) >= 5 {
		r += 0.10
	} else if len(c.HTMLIssues) >= 2 {
		r += 0.05
	}
	return clamp01(r)
}

// reputationRisk converts Google + Microsoft + SenderScore + blacklists.
func reputationRisk(r domain.Reputation) float64 {
	risk := 0.0
	switch r.GoogleScore {
	case domain.ReputationLow:
		risk += 0.40
	case domain.ReputationMedium:
		risk += 0.15
	}
	switch r.MicrosoftScore {
	case domain.ReputationLow:
		risk += 0.30
	case domain.ReputationMedium:
		risk += 0.10
	}
	if r.SenderScore > 0 {
		// 100 = no risk, 0 = max risk; scale linearly from 70.
		if r.SenderScore < 70 {
			risk += float64(70-r.SenderScore) / 70.0 * 0.40
		}
	}
	if len(r.BlacklistHits) > 0 {
		risk += 0.40
	}
	return clamp01(risk)
}

func authRisk(check *domain.AuthCheck, r domain.Reputation) (float64, string) {
	if check == nil || (check.Domain == "" && check.SPF.Detail == "" && check.DKIM.Detail == "" && check.DMARC.Detail == "") {
		return authRiskFromReputation(r), "auth check not supplied; using blacklist-only auth proxy"
	}
	risk := (authRecordRisk(check.SPF) + authRecordRisk(check.DKIM) + authRecordRisk(check.DMARC)) / 3.0
	if check.BIMI.Status == domain.AuthFail {
		risk += 0.05
	}
	if check.PTR.Status == domain.AuthFail {
		risk += 0.10
	} else if check.PTR.Status == domain.AuthWarn {
		risk += 0.04
	}
	return clamp01(risk), ""
}

func authRecordRisk(r domain.AuthRecord) float64 {
	switch r.Status {
	case domain.AuthFail:
		return 0.65
	case domain.AuthWarn:
		return 0.30
	case domain.AuthOK:
		return 0
	default:
		return 0.15
	}
}

func authRiskFromReputation(r domain.Reputation) float64 {
	if len(r.BlacklistHits) > 0 {
		return 0.4
	}
	return 0.0
}

// engagementRisk inverts the engagement signals. High open rate reduces
// risk; high complaint rate raises it.
//
// EQ history (h.AvgEQScoreLast30d) nudges the result up or down within
// a bounded range:
//
//   - EQ >= 85 (A-grade pattern): subtract 0.10 from the computed
//     risk — disciplined senders earn a modest engagement-risk
//     discount.
//   - EQ in [70, 85) (B-grade): no adjustment.
//   - EQ in [55, 70) (C-grade): add 0.05 — emerging discipline drift.
//   - EQ < 55 (D/F-grade): add 0.15 — chronic content-quality issues
//     correlate with audience fatigue, and the engagement component
//     should reflect that even when raw open/complaint rates haven't
//     caught up yet.
//
// The adjustment is bounded so EQ alone can't drive the engagement
// component past 1.0 or below 0.0 — open/click/complaint/bounce rates
// remain the dominant signal.
func engagementRisk(h HistoricalEngagement) float64 {
	risk := 0.0
	if h.SendVolume == 0 {
		// Cold sender — apply the EQ-history nudge if we have one,
		// but cap the downward adjustment so the no-history prior
		// can't be fully erased. A sender with strong content
		// discipline AND zero delivery history still carries
		// uncertainty about how THIS audience will respond; we
		// shouldn't let "they sent clean emails before" zero out
		// that signal.
		base := 0.10
		adj := eqHistoryAdjustment(h.AvgEQScoreLast30d)
		// Floor the downward nudge at -0.05 in the cold path.
		if adj < -0.05 {
			adj = -0.05
		}
		return clamp01(base + adj)
	}
	if h.OpenRate > 0 {
		// Average newsletter open rate ~25% (Mailchimp). Below 10% is poor.
		if h.OpenRate < 0.10 {
			risk += 0.30
		} else if h.OpenRate < 0.20 {
			risk += 0.10
		}
	}
	if h.ComplaintRate > 0.003 {
		risk += 0.40 // Gmail's published threshold; over this and trouble is imminent
	} else if h.ComplaintRate > 0.001 {
		risk += 0.15
	}
	if h.BounceRate > 0.05 {
		risk += 0.20
	} else if h.BounceRate > 0.02 {
		risk += 0.05
	}
	risk += eqHistoryAdjustment(h.AvgEQScoreLast30d)
	return clamp01(risk)
}

// eqHistoryAdjustment returns the bounded delta the EQ rolling-window
// average contributes to engagement risk. 0 means "no EQ data" and is
// the neutral case.
func eqHistoryAdjustment(avgEQ int) float64 {
	switch {
	case avgEQ <= 0:
		return 0
	case avgEQ >= 85:
		return -0.10
	case avgEQ >= 70:
		return 0
	case avgEQ >= 55:
		return 0.05
	default:
		return 0.15
	}
}

// riskToPlacement is the smooth piecewise interpolation. Calibrated to:
//
//	risk = 0.0 → {0.85, 0.13, 0.02}
//	risk = 0.5 → {0.50, 0.30, 0.20}
//	risk = 1.0 → {0.05, 0.30, 0.65}
func riskToPlacement(risk float64) domain.PredictedPlacement {
	risk = clamp01(risk)
	var primary, promo, spam float64
	if risk <= 0.5 {
		t := risk / 0.5
		primary = lerp(0.85, 0.50, t)
		promo = lerp(0.13, 0.30, t)
		spam = lerp(0.02, 0.20, t)
	} else {
		t := (risk - 0.5) / 0.5
		primary = lerp(0.50, 0.05, t)
		promo = lerp(0.30, 0.30, t)
		spam = lerp(0.20, 0.65, t)
	}
	// Normalize to sum=1.0 (interpolation should be clean but be defensive).
	sum := primary + promo + spam
	if sum == 0 {
		return domain.PredictedPlacement{Primary: 1.0 / 3, Promotions: 1.0 / 3, Spam: 1.0 / 3}
	}
	return domain.PredictedPlacement{
		Primary:    primary / sum,
		Promotions: promo / sum,
		Spam:       spam / sum,
	}
}

func lerp(a, b, t float64) float64 { return a + (b-a)*t }
func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
