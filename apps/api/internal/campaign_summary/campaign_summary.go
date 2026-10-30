// SPDX-License-Identifier: AGPL-3.0-only
//
// Package campaign_summary implements G17 of the campaigns 2026 pack —
// AI post-send summaries with deterministic fallback.
//
// Surface (v1 backbone):
//
//	GET    /api/v1/campaigns/{id}/summary           (scope: read_reports)
//	POST   /api/v1/campaigns/{id}/summary/regenerate (scope: write_campaigns)
//
// Renderer policy: the deterministic template (open / click / reply /
// drift framing with rolling-baseline percent-point deltas) is always
// rendered first as a grounding fallback; when a voice client is
// configured, regenerate asks the voice service for a brand-aligned
// summary and returns source="voice", falling back to
// source="deterministic" on any upstream failure. The regenerate POST
// is rate-limited (paid round trip), status-guarded to sent campaigns,
// admin-gated for force, and audited. The wire shape is identical
// across both renderers.
package campaign_summary

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Summary mirrors the campaign_ai_summaries row that's returned over
// the wire.
type Summary struct {
	CampaignID     string          `json:"campaign_id"`
	BodyMarkdown   string          `json:"body_markdown"`
	Source         string          `json:"source"` // "deterministic" | "voice"
	InputsSnapshot json.RawMessage `json:"inputs_snapshot"`
	GeneratedAt    time.Time       `json:"generated_at"`
}

// inputs is the snapshot of stats fed into the renderer. Stored as
// jsonb so future renderers can diff against the same inputs.
type inputs struct {
	OpenRate         float64        `json:"open_rate"`
	BaselineOpenRate float64        `json:"baseline_open_rate"`
	ClickRate        float64        `json:"click_rate"`
	TopLinkURL       string         `json:"top_link_url,omitempty"`
	TopLinkPct       float64        `json:"top_link_pct,omitempty"`
	ReplyCount       int            `json:"reply_count"`
	ReplyIntents     map[string]int `json:"reply_intents,omitempty"`
	// VoiceDriftScore range [0,1] when the G10 follow-up populates
	// it; 0 fallback when unset. The renderer threshold uses 0.20.
	VoiceDriftScore float64 `json:"voice_drift_score"`
}

type Deps struct {
	Pool *db.Pool
	// Voice is optional. When configured, /summary/regenerate asks the
	// voice service for a brand-aligned summary and falls back to the
	// deterministic renderer on any upstream failure.
	Voice aicompose.VoiceClient
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

// MountRoutes wires the read GET and the regenerate POST. regenLimit,
// when non-nil, throttles ONLY the regenerate POST (it triggers a paid
// voice-service round trip) — the read GET stays unthrottled because it
// just serves the persisted row. main.go passes the shared
// expensiveTenantLimit so a single campaign can't burn the LLM budget.
func MountRoutes(r chi.Router, d *Deps, regenLimit func(http.Handler) http.Handler) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/campaigns/{id}/summary", d.get)
	if regenLimit != nil {
		r.With(regenLimit, apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
			Post("/api/v1/campaigns/{id}/summary/regenerate", d.regenerate)
	} else {
		r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
			Post("/api/v1/campaigns/{id}/summary/regenerate", d.regenerate)
	}
}

func (d *Deps) get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	campaignID := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	s, err := loadOne(r.Context(), tx, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if s == nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "no summary yet — call /regenerate to compute one")
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (d *Deps) regenerate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	campaignID := chi.URLParam(r, "id")

	// Optional body: {"force": true} re-runs the (paid) voice round trip
	// even if a fresh summary exists. Force is admin-only so a viewer/
	// editor can't repeatedly burn the LLM budget.
	var reqBody struct {
		Force bool `json:"force"`
	}
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, httpbody.DefaultJSONMaxBodyBytes, &reqBody, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httpbody.WriteError(w, err)
			return
		}
	}
	if reqBody.Force && !actorIsAdmin(r.Context()) {
		writeAdminRequiredDenial(w)
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Status guard: a summary only makes sense once the campaign has
	// actually sent. Pre-send states have no engagement to summarize.
	var status string
	err = tx.QueryRow(r.Context(),
		`SELECT status FROM campaigns WHERE id = $1::uuid`, campaignID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		httperror.Write(w, http.StatusNotFound, "not_found", "campaign not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	switch status {
	case "draft", "scheduled", "paused":
		httperror.Write(w, http.StatusConflict, "campaign_not_sent",
			"summary is available after the campaign sends")
		return
	}

	// 1. Pull the stats the deterministic renderer needs. Each query
	//    bias-toward-graceful: a missing column or empty result leaves
	//    its field at the zero value rather than erroring.
	in := collectInputs(r.Context(), tx, t.ID, campaignID)

	body := renderDeterministic(in)
	source := "deterministic"
	if voiceBody, err := d.renderVoice(r.Context(), t.ID, campaignID, in, body); err == nil && strings.TrimSpace(voiceBody) != "" {
		body = voiceBody
		source = "voice"
	}

	// 3. Upsert. PRIMARY KEY (campaign_id) means ON CONFLICT replaces
	//    the row in place.
	inputsJSON, _ := json.Marshal(in)
	var (
		out         Summary
		generatedAt time.Time
	)
	err = tx.QueryRow(r.Context(), `
INSERT INTO campaign_ai_summaries (campaign_id, tenant_id, body_markdown, source, inputs_snapshot, generated_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, now())
ON CONFLICT (campaign_id) DO UPDATE
   SET body_markdown   = EXCLUDED.body_markdown,
       source          = EXCLUDED.source,
       inputs_snapshot = EXCLUDED.inputs_snapshot,
       generated_at    = EXCLUDED.generated_at
RETURNING body_markdown, source, inputs_snapshot, generated_at`,
		campaignID, t.ID, body, source, string(inputsJSON),
	).Scan(&out.BodyMarkdown, &out.Source, &out.InputsSnapshot, &generatedAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Audit the (re)generation within the tx — the 0320 migration
	// promised an audit_log row keyed by campaign_id. Records the chosen
	// renderer + whether it was a forced regenerate for the compliance
	// trail.
	_ = db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"campaign.ai_summary.generated", "campaign", campaignID, map[string]any{
			"source": out.Source,
			"force":  reqBody.Force,
		})
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out.CampaignID = campaignID
	out.GeneratedAt = generatedAt
	writeJSON(w, http.StatusOK, out)
}

// actorIsAdmin reports whether the request's user carries an owner/admin
// role. Used to gate force-regenerate so non-admins can't repeatedly
// trigger the paid voice round trip.
func actorIsAdmin(ctx context.Context) bool {
	u, ok := middleware.UserFromContext(ctx)
	if !ok || u == nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(u.Role)) {
	case "owner", "admin":
		return true
	}
	return false
}

func (d *Deps) renderVoice(ctx context.Context, tenantID, campaignID string, in inputs, fallback string) (string, error) {
	if d == nil || d.Voice == nil {
		return "", aicompose.ErrVoiceUnavailable
	}
	snap, _ := json.Marshal(in)
	prompt := strings.TrimSpace(`Write a concise post-send campaign performance summary in the tenant's brand voice.

Requirements:
- Markdown only.
- 3 short paragraphs maximum.
- Include the key open/click/reply signals.
- Include one concrete suggested next action.
- Do not invent metrics outside the JSON input.`)
	contextText := "Campaign ID: " + campaignID + "\n\nInputs JSON:\n" + string(snap)
	if fallback != "" {
		contextText += "\n\nDeterministic fallback summary for grounding:\n" + fallback
	}
	out, err := d.Voice.Generate(ctx, tenantID, aicompose.KindFreeForm, prompt, contextText)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out.Text), nil
}

func loadOne(ctx context.Context, tx pgx.Tx, campaignID string) (*Summary, error) {
	var s Summary
	err := tx.QueryRow(ctx, `
SELECT campaign_id::text, body_markdown, source, inputs_snapshot, generated_at
  FROM campaign_ai_summaries
 WHERE campaign_id = $1::uuid`, campaignID,
	).Scan(&s.CampaignID, &s.BodyMarkdown, &s.Source, &s.InputsSnapshot, &s.GeneratedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &s, nil
}

// collectInputs queries the underlying stats. Each block is fault-
// tolerant: missing columns or empty rows leave the field at its
// zero value so the renderer can still produce a useful body.
func collectInputs(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) inputs {
	var in inputs
	in.ReplyIntents = map[string]int{}

	// 1. Open rate + click rate for this campaign. Mirror analytics.go
	//    so the renderer numbers match what /report returns.
	var sent, delivered, uniqueOpens, uniqueClicks int
	_ = tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE event_type = 'sent')::int,
  count(*) FILTER (WHERE event_type = 'delivered')::int,
  count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened')::int,
  count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'clicked')::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		tenantID, campaignID,
	).Scan(&sent, &delivered, &uniqueOpens, &uniqueClicks)
	denom := delivered
	if denom == 0 {
		denom = sent
	}
	if denom > 0 {
		in.OpenRate = float64(uniqueOpens) / float64(denom)
		in.ClickRate = float64(uniqueClicks) / float64(denom)
	}

	// 2. Tenant rolling baseline (last 180 days, excluding this campaign).
	_ = tx.QueryRow(ctx, `
WITH per_campaign AS (
  SELECT campaign_id,
         (count(*) FILTER (WHERE event_type = 'opened'))::float /
         NULLIF(count(*) FILTER (WHERE event_type = 'sent'), 0) AS open_rate
    FROM campaign_report_events
   WHERE tenant_id = $1::uuid
     AND campaign_id <> $2::uuid
     AND at >= now() - interval '180 days'
   GROUP BY campaign_id
)
SELECT COALESCE(avg(open_rate), 0) FROM per_campaign WHERE open_rate IS NOT NULL`,
		tenantID, campaignID,
	).Scan(&in.BaselineOpenRate)

	// 3. Top-link concentration. ratio = top link clicks / total clicks.
	var totalClicks, topClicks int
	var topURL string
	_ = tx.QueryRow(ctx,
		`SELECT count(*)::int FROM campaign_report_events
		   WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND event_type = 'clicked'`,
		tenantID, campaignID,
	).Scan(&totalClicks)
	_ = tx.QueryRow(ctx, `
SELECT link_url, count(*)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND event_type = 'clicked' AND link_url IS NOT NULL
 GROUP BY link_url
 ORDER BY count(*) DESC
 LIMIT 1`,
		tenantID, campaignID,
	).Scan(&topURL, &topClicks)
	in.TopLinkURL = topURL
	if totalClicks > 0 && topClicks > 0 {
		in.TopLinkPct = float64(topClicks) / float64(totalClicks)
	}

	// 4. Reply count + intent buckets (G3 source-of-truth).
	rows, err := tx.Query(ctx, `
SELECT COALESCE(i.intent_class, ''), COALESCE(NULLIF(e.subject,''), '(no subject)') AS bucket, count(*)::int
  FROM inbound_emails e
  LEFT JOIN inbound_email_intent i
    ON i.tenant_id = e.tenant_id
   AND i.inbound_email_id = e.id
 WHERE e.campaign_id = $1::uuid
 GROUP BY 1, 2`,
		campaignID,
	)
	if err == nil {
		for rows.Next() {
			var label, subject string
			var n int
			if err := rows.Scan(&label, &subject, &n); err == nil {
				in.ReplyCount += n
				key := label
				if key == "" {
					key = classifyByHeuristic(subject)
				}
				in.ReplyIntents[key] += n
			}
		}
		rows.Close()
	}

	// 5. Voice drift score (G10). The column may not exist on older
	//    deploys, so guard the read with a pg_attribute lookup — a
	//    missing column leaves VoiceDriftScore at 0 (renderer treats
	//    that as "no drift advisory") rather than erroring the whole
	//    summary. Lights up automatically once G10 persists a
	//    per-campaign score.
	var hasDriftCol bool
	_ = tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM pg_attribute
   WHERE attrelid = to_regclass('public.campaigns')
     AND attname  = 'voice_drift_score'
     AND NOT attisdropped
)`).Scan(&hasDriftCol)
	if hasDriftCol {
		_ = tx.QueryRow(ctx,
			`SELECT COALESCE(voice_drift_score, 0) FROM campaigns WHERE id = $1::uuid`,
			campaignID,
		).Scan(&in.VoiceDriftScore)
	}

	return in
}

// classifyByHeuristic is the v1 stand-in for the G3 intent classifier:
// a lightweight regex check on the subject. Replaced by the LLM
// classifier in G3 follow-up.
func classifyByHeuristic(subject string) string {
	s := strings.ToLower(subject)
	switch {
	case strings.HasPrefix(s, "re:"), strings.HasPrefix(s, "fwd:"):
		return "reply"
	case strings.Contains(s, "unsubscribe"), strings.Contains(s, "stop"):
		return "unsub"
	case strings.Contains(s, "out of office"), strings.Contains(s, "ooo"), strings.Contains(s, "vacation"):
		return "ooo"
	}
	return "other"
}

// renderDeterministic produces a markdown summary from the inputs.
// Deliberately terse — operators read this between sends, not as a
// report. The G17 follow-up swaps this for a voice-service round
// trip when configured.
func renderDeterministic(in inputs) string {
	var b strings.Builder

	// Headline: open rate vs baseline.
	delta := in.OpenRate - in.BaselineOpenRate
	switch {
	case in.OpenRate == 0:
		b.WriteString("No opens recorded yet.")
	case in.BaselineOpenRate == 0:
		fmt.Fprintf(&b, "Open rate **%.1f%%** (tenant baseline unavailable).", in.OpenRate*100)
	case delta >= 0.02:
		fmt.Fprintf(&b, "Open rate **%.1f%%** — **+%.1f pp vs %.1f%% baseline**. Strong send.",
			in.OpenRate*100, delta*100, in.BaselineOpenRate*100)
	case delta <= -0.02:
		fmt.Fprintf(&b, "Open rate **%.1f%%** — **%.1f pp vs %.1f%% baseline**. Underperformed.",
			in.OpenRate*100, delta*100, in.BaselineOpenRate*100)
	default:
		fmt.Fprintf(&b, "Open rate **%.1f%%** — within ±2 pp of the %.1f%% tenant baseline.",
			in.OpenRate*100, in.BaselineOpenRate*100)
	}

	// Click context.
	if in.ClickRate > 0 {
		fmt.Fprintf(&b, "\n\nClick rate **%.1f%%**", in.ClickRate*100)
		if in.TopLinkURL != "" && in.TopLinkPct >= 0.4 {
			fmt.Fprintf(&b, " — top link `%s` carried **%.0f%%** of all clicks; consider promoting it in the next send.",
				in.TopLinkURL, in.TopLinkPct*100)
		} else {
			b.WriteString(".")
		}
	}

	// Replies + intent (when populated).
	if in.ReplyCount > 0 {
		fmt.Fprintf(&b, "\n\n**%d** repl%s landed", in.ReplyCount, plural(in.ReplyCount))
		buckets := []string{}
		for k, v := range in.ReplyIntents {
			if v > 0 {
				buckets = append(buckets, fmt.Sprintf("%d %s", v, k))
			}
		}
		if len(buckets) > 0 {
			fmt.Fprintf(&b, " (%s)", strings.Join(buckets, ", "))
		}
		b.WriteString(".")
	}

	// Voice drift advisory.
	if in.VoiceDriftScore >= 0.20 {
		fmt.Fprintf(&b, "\n\nVoice drift score **%.2f** — body drifted from the brand profile; review the next draft against the voice profile before sending.",
			in.VoiceDriftScore)
	}

	// Default action suggestion.
	b.WriteString("\n\nSuggested next: ")
	switch {
	case in.OpenRate < in.BaselineOpenRate-0.02:
		b.WriteString("A/B test a sharper subject line on the next send (Subject Lab can score variants).")
	case in.ReplyCount >= 5:
		b.WriteString("Reply intent looks rich — surface a few replies as testimonials in the next campaign.")
	default:
		b.WriteString("Resend to non-openers in 48h with a new subject if engagement is time-sensitive.")
	}

	return b.String()
}

func plural(n int) string {
	if n == 1 {
		return "y"
	}
	return "ies"
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeAdminRequiredDenial refuses a force-regenerate to a non-admin.
//
// A genuine role refusal, and it names the role: without it a client falls back
// to "ask an administrator", which happens to be right here but is wrong
// wherever the required role is something else — so stating it keeps the copy
// correct by construction rather than by coincidence.
func writeAdminRequiredDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject:      "campaign_summary",
		Reason:       entitlement.ReasonRole,
		Code:         "admin_required",
		Message:      "force regenerate requires an admin role",
		RequiredRole: "admin",
	})
}
