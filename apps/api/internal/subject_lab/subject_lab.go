// SPDX-License-Identifier: AGPL-3.0-only
//
// Package subject_lab implements G11 of the campaigns 2026 pack:
// confidence-scored subject-line variants for the campaign create flow.
//
// Two endpoints:
//
//	POST /api/v1/subject-lab/variants  (scope: write_campaigns)
//	  Generates `count` axis-conditioned subject variants by delegating
//	  to aicompose.Composer with an axis-specific prompt prefix.
//
//	POST /api/v1/subject-lab/score     (scope: write_campaigns)
//	  Scores submitted subjects against the tenant's last-180d campaign
//	  corpus. Each subject is bucketed by its extracted attributes
//	  (length, question, all-caps, emoji, personalization); the matched
//	  bucket's distinct-recipient open rate is the point estimate and a
//	  two-sided Wilson-90% interval over the same denominator gives the confidence
//	  band. Buckets with fewer than 5 matched campaigns fall back to
//	  baseline ±15% and are flagged low_confidence.
//
// All AI delegation respects the same VoiceClient interface aicompose
// uses, so a missing GEMINI_API_KEY surfaces as 503 with the same
// voice_unavailable code as /api/v1/ai/compose/*.
package subject_lab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/feature_flags"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subject_analyzer"
)

// FlagSubjectLab gates the LLM-cost /variants endpoint. Resolved via
// tenant_feature_flags; missing => disabled, so the lab is opt-in
// (G11 spec: opt-in for the first weeks to size voice-service LLM cost
// before defaulting it on for everyone).
const FlagSubjectLab = "subject_lab"

const (
	minSubjectLabVariants = 5
	maxSubjectLabVariants = 8
)

// Deps bundles the pgx pool + the AI composer the variants route
// delegates to. Composer may be nil — /variants then returns 503 with
// the same voice_unavailable shape /api/v1/ai/compose/* uses.
type Deps struct {
	Pool     *db.Pool
	Composer *aicompose.Composer
	Logger   *slog.Logger
}

// Axis names — matches the desktop chip group.
const (
	AxisLength          = "length"
	AxisEmoji           = "emoji"
	AxisQuestion        = "question"
	AxisPersonalization = "personalization"
)

// axisPromptSuffix appends axis-specific guidance to ComposeVariants's
// brief field so the LLM produces variants that actually differ on the
// chosen axis. Keep these short — the composer already carries the
// subject + body context.
func axisPromptSuffix(axis string) string {
	switch axis {
	case AxisLength:
		return " Aim for noticeably varied lengths: at least one ≤25 chars and one ≥55 chars."
	case AxisEmoji:
		return " Use exactly one leading emoji per variant. Vary the emoji's intensity (calm → bold)."
	case AxisQuestion:
		return " Phrase each variant as a different question; vary whether it's open-ended or yes/no."
	case AxisPersonalization:
		return " Use a {{first_name}} merge tag in some variants and a {{company}} or {{city}} merge tag in others."
	}
	return ""
}

func validAxis(axis string) bool {
	switch axis {
	case AxisLength, AxisEmoji, AxisQuestion, AxisPersonalization:
		return true
	}
	return false
}

// MountRoutes wires both editor actions behind write:campaigns to mirror the
// existing /api/v1/ai/compose policy.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/subject-lab/variants", d.generate)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/subject-lab/score", d.score)
}

/* ---------- /variants ------------------------------------------- */

type variantsInput struct {
	SeedSubject    string `json:"seed_subject"`
	Axis           string `json:"axis"`
	Count          int    `json:"count"`
	BodyExcerpt    string `json:"body_excerpt"`
	VoiceProfileID string `json:"voice_profile_id"`
}

type variantsOutput struct {
	Variants    []string  `json:"variants"`
	Axis        string    `json:"axis"`
	GeneratedAt time.Time `json:"generated_at"`
}

func (d *Deps) generate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Opt-in gate: /variants is the LLM-cost endpoint. Off by default so
	// the voice-service spend is sized per-tenant before a global rollout.
	if !feature_flags.IsEnabled(r.Context(), d.Pool, t.ID, FlagSubjectLab) {
		// Through the shared contract so a client can tell this from a plan
		// denial. Both were `403 feature_disabled` prose, and the affordances are
		// opposite: an upgrade button here sends someone to a billing page that
		// cannot turn a flag on.
		entitlement.Write(w, entitlement.Denial{
			Subject: "subject_lab",
			Reason:  entitlement.ReasonFlag,
			Code:    "feature_disabled",
			Message: "Subject Lab is not enabled for this workspace",
			Remedy:  entitlement.RemedyContactWorkspaceAdmin,
		})
		return
	}
	var in variantsInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if l := len(strings.TrimSpace(in.SeedSubject)); l < 10 {
		writeErr(w, http.StatusBadRequest, "seed_too_short",
			fmt.Sprintf("seed_subject must be ≥10 chars (got %d)", l))
		return
	}
	if !validAxis(in.Axis) {
		writeErr(w, http.StatusBadRequest, "bad_axis",
			"axis must be one of: length, emoji, question, personalization")
		return
	}
	if in.Count == 0 {
		in.Count = 6
	}
	if in.Count < minSubjectLabVariants || in.Count > maxSubjectLabVariants {
		writeErr(w, http.StatusBadRequest, "bad_count",
			"count must be between 5 and 8")
		return
	}
	if d.Composer == nil || d.Composer.Voice == nil {
		writeErr(w, http.StatusServiceUnavailable, "voice_unavailable",
			"AI subject generation is not configured")
		return
	}
	// Wrap the seed with the axis suffix so the variants actually vary
	// along the requested axis. The composer carries the subject + body
	// as semantic anchors; we only need to nudge the diversity axis.
	body := strings.TrimSpace(in.BodyExcerpt)
	if body == "" {
		body = "(no body excerpt supplied — use the subject for context only)"
	}
	body += "\n\n" + axisPromptSuffix(in.Axis)
	out, err := d.Composer.ComposeVariantsUpTo(r.Context(), t.ID, aicompose.ComposeVariantsInput{
		Subject:      strings.TrimSpace(in.SeedSubject),
		Body:         body,
		VariantCount: in.Count,
		// G10 binding: condition variants on the selected authored brand
		// voice profile (the desktop pre-fetches the active one on open).
		ProfileID: strings.TrimSpace(in.VoiceProfileID),
	}, maxSubjectLabVariants)
	if err != nil {
		if errors.Is(err, aicompose.ErrVoiceUnavailable) ||
			errors.Is(err, aicompose.ErrStrictPIIGatewayUnavailable) {
			writeErr(w, http.StatusServiceUnavailable, "voice_unavailable",
				"AI subject generation is temporarily unavailable")
			return
		}
		// Surface upstream voice-service errors as 500 via WriteInternal —
		// the raw err from the voice client may include provider response
		// text or pgx fragments, so we log it server-side and return a
		// generic envelope rather than echoing err.Error() to callers.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, variantsOutput{
		Variants:    out.SubjectVariants,
		Axis:        in.Axis,
		GeneratedAt: out.GeneratedAt,
	})
}

/* ---------- /score ---------------------------------------------- */

type scoreInput struct {
	Subjects []string `json:"subjects"`
}

// ScoredVariant is the per-subject scoring result. predicted_open is the
// matched bucket's distinct-recipient open rate (or the tenant baseline when
// the bucket is too thin); ci_low / ci_high are a two-sided Wilson-90% interval
// over that same recipient denominator. Variants flagged low_confidence=true
// are below the n≥5 matched-campaign threshold and fall back to
// baseline ±15%; the desktop renders those rows muted. below_baseline is
// set when the entire confidence interval sits under the tenant baseline.
type ScoredVariant struct {
	Text          string  `json:"text"`
	Axis          string  `json:"axis"`
	PredictedOpen float64 `json:"predicted_open"`
	CILow         float64 `json:"ci_low"`
	CIHigh        float64 `json:"ci_high"`
	MatchedN      int     `json:"matched_n"`
	LowConfidence bool    `json:"low_confidence"`
	BelowBaseline bool    `json:"below_baseline"`
}

type scoreOutput struct {
	BaselineOpen float64         `json:"baseline_open"`
	WindowDays   int             `json:"window_days"`
	Variants     []ScoredVariant `json:"variants"`
}

func (d *Deps) score(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in scoreInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if len(in.Subjects) == 0 || len(in.Subjects) > 16 {
		writeErr(w, http.StatusBadRequest, "bad_count",
			"subjects must contain 1..16 entries")
		return
	}

	// Build the scoring model from the tenant's last-180d sent corpus:
	// the global baseline open rate + per-attribute-bucket aggregates.
	baseline, buckets, corpusRecipients, err := d.scoringModel(r.Context(), t.ID)
	if err != nil {
		// Infrastructure failure is not evidence of a zero-percent baseline.
		// Keep raw DB/schema detail server-side and fail closed so the desktop
		// can retain generated variants as explicitly unscored.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if corpusRecipients == 0 {
		writeErr(w, http.StatusUnprocessableEntity, "insufficient_history",
			"Not enough sent campaign history is available to score variants")
		return
	}

	out := scoreOutput{
		BaselineOpen: baseline,
		WindowDays:   180,
		Variants:     make([]ScoredVariant, 0, len(in.Subjects)),
	}
	for _, s := range in.Subjects {
		out.Variants = append(out.Variants, scoreVariant(s, baseline, buckets))
	}
	writeJSON(w, http.StatusOK, out)
}

// bucketStat aggregates the sent corpus for one attribute-bucket tuple.
// opens/sent are the pooled distinct-recipient successes/trials used for both
// the point estimate and Wilson interval, so the displayed estimate and its
// confidence band cannot disagree because of mismatched denominators.
type bucketStat struct {
	n     int   // number of matched campaigns
	opens int64 // distinct sent recipients with at least one open
	sent  int64 // distinct sent recipients
}

// bucketKey is the matched-bucket tuple from the G11 spec:
// (length_bucket, has_question, all_caps, has_emoji, has_personalize).
// Two subjects in the same bucket are treated as exchangeable for
// open-rate prediction.
func bucketKey(a subject_analyzer.Attrs) string {
	return fmt.Sprintf("%s|q=%t|caps=%t|emoji=%t|pers=%t",
		a.LengthBucket, a.HasQuestion, a.AllCaps, a.EmojiCount > 0, a.HasPersonalize)
}

// scoringModel reads the tenant's last-180d sent campaigns (subject +
// opened/sent counts), then folds them into a global baseline open rate
// and a per-bucket aggregate keyed by the subject's extracted attributes.
// Infrastructure errors are returned to the handler; they must never be
// represented as a valid 0% baseline. An honestly empty corpus returns
// totalSent=0 so the handler can emit an explicit insufficient-history state.
const scoringModelQuery = `
WITH sent_180d AS (
  SELECT id, COALESCE(subject, '') AS subject
    FROM campaigns
   WHERE status IN ('sent','completed')
     AND COALESCE(updated_at, created_at) >= now() - interval '180 days'
), recipient_outcomes AS (
  SELECT s.id AS campaign_id,
         s.subject,
         lower(btrim(e.subscriber_email::text)) AS recipient,
         bool_or(e.event_type = 'sent') AS was_sent,
         bool_or(e.event_type = 'opened') AS was_opened
    FROM sent_180d s
    JOIN campaign_report_events e
      ON e.campaign_id = s.id
     AND e.at >= now() - interval '180 days'
     AND e.event_type IN ('sent', 'opened')
   WHERE e.subscriber_email IS NOT NULL
     AND btrim(e.subscriber_email::text) <> ''
   GROUP BY s.id, s.subject, lower(btrim(e.subscriber_email::text))
)
SELECT subject,
       count(*) FILTER (WHERE was_sent AND was_opened) AS opens,
       count(*) FILTER (WHERE was_sent)                AS sent
  FROM recipient_outcomes
 GROUP BY campaign_id, subject
HAVING count(*) FILTER (WHERE was_sent) > 0`

func (d *Deps) scoringModel(
	ctx context.Context,
	tenantID string,
) (float64, map[string]*bucketStat, int64, error) {
	if d == nil || d.Pool == nil {
		return 0, nil, 0, fmt.Errorf("subject_lab: scoring store unavailable")
	}
	buckets := map[string]*bucketStat{}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return 0, nil, 0, fmt.Errorf("subject_lab: open scoring transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, scoringModelQuery)
	if err != nil {
		return 0, nil, 0, fmt.Errorf("subject_lab: query scoring corpus: %w", err)
	}
	defer rows.Close()
	var totalOpens, totalSent int64
	for rows.Next() {
		var subject string
		var opens, sent int64
		if err := rows.Scan(&subject, &opens, &sent); err != nil {
			return 0, nil, 0, fmt.Errorf("subject_lab: scan scoring corpus: %w", err)
		}
		if sent <= 0 {
			continue
		}
		if opens < 0 {
			opens = 0
		}
		if opens > sent {
			opens = sent
		}
		totalOpens += opens
		totalSent += sent
		key := bucketKey(subject_analyzer.Extract(subject))
		b := buckets[key]
		if b == nil {
			b = &bucketStat{}
			buckets[key] = b
		}
		b.n++
		b.opens += opens
		b.sent += sent
	}
	if err := rows.Err(); err != nil {
		return 0, nil, 0, fmt.Errorf("subject_lab: iterate scoring corpus: %w", err)
	}
	baseline := 0.0
	if totalSent > 0 {
		baseline = clampRate(float64(totalOpens) / float64(totalSent))
	}
	return baseline, buckets, totalSent, nil
}

// matchedSampleFloor is the campaign count below which a bucket is too
// thin to trust; the variant falls back to baseline ±15% and is flagged
// low_confidence so the desktop renders the row muted.
const matchedSampleFloor = 5

// wilson returns the Wilson score interval [low, high] for `successes`
// out of `trials` at confidence level z. z=1.645 gives a two-sided 90%
// interval. The Wilson interval is well-behaved at small n and never
// escapes [0,1], unlike the naive normal approximation.
func wilson(successes, trials int64, z float64) (float64, float64) {
	if trials <= 0 {
		return 0, 1
	}
	if math.IsNaN(z) || math.IsInf(z, 0) || z < 0 {
		return 0, 1
	}
	if successes < 0 {
		successes = 0
	}
	if successes > trials {
		successes = trials
	}
	n := float64(trials)
	p := float64(successes) / n
	z2 := z * z
	denom := 1 + z2/n
	center := (p + z2/(2*n)) / denom
	margin := (z * math.Sqrt(p*(1-p)/n+z2/(4*n*n))) / denom
	low := center - margin
	high := center + margin
	return clampRate(low), clampRate(high)
}

// wilsonZ90 is the standard-normal quantile for a two-sided 90% interval
// (5% in each tail).
const wilsonZ90 = 1.645

// scoreVariant produces the score row for one subject using the
// matched-bucket model:
//
//   - Find the bucket matching the subject's extracted attributes.
//   - With ≥5 matched campaigns: PredictedOpen = distinct-recipient open
//     rate, CI = Wilson-90% on the same (opens, sent), BelowBaseline when
//     the whole interval sits under the tenant baseline.
//   - Below the floor (or no bucket): fall back to baseline ±15% and flag
//     low_confidence — the lab is honest that it can't yet say.
func scoreVariant(text string, baseline float64, buckets map[string]*bucketStat) ScoredVariant {
	baseline = clampRate(baseline)
	attrs := subject_analyzer.Extract(text)
	b := buckets[bucketKey(attrs)]
	matchedN := 0
	if b != nil {
		matchedN = b.n
	}
	if b == nil || b.n < matchedSampleFloor || b.sent <= 0 {
		low := baseline - 0.15
		if low < 0 {
			low = 0
		}
		high := baseline + 0.15
		if high > 1 {
			high = 1
		}
		return ScoredVariant{
			Text:          text,
			Axis:          "",
			PredictedOpen: baseline,
			CILow:         low,
			CIHigh:        high,
			MatchedN:      matchedN,
			LowConfidence: true,
			BelowBaseline: false,
		}
	}
	predicted := clampRate(float64(b.opens) / float64(b.sent))
	low, high := wilson(b.opens, b.sent, wilsonZ90)
	return ScoredVariant{
		Text:          text,
		Axis:          "", // assigned by the desktop from the active axis chip
		PredictedOpen: predicted,
		CILow:         low,
		CIHigh:        high,
		MatchedN:      matchedN,
		LowConfidence: false,
		BelowBaseline: high < baseline,
	}
}

func clampRate(value float64) float64 {
	switch {
	case math.IsNaN(value), value <= 0:
		return 0
	case value >= 1:
		return 1
	default:
		return value
	}
}

/* ---------- helpers --------------------------------------------- */

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
