// SPDX-License-Identifier: AGPL-3.0-only
//
// Package ai_subject_lines implements the Klaviyo-style AI Subject Line
// Assistant (gap sto-ai-copywriter-subject-lines): "brief -> 3 candidates"
// generation plus a per-tenant "top performers from the last 90 days"
// panel that the compose form renders as an inspiration source.
//
// Surfaces:
//
//	POST /api/v1/ai/subject-lines/generate       (scope: write_campaigns)
//	  body: { prompt: string, tone?: string, target_audience?: string,
//	          variant_count?: int (default 3, bounded [1,5]) }
//	  -> { candidates: string[], generated_at: string, fallback: bool }
//
//	GET  /api/v1/ai/subject-lines/top-performers (scope: read_reports)
//	  query: ?days=90 (default 90, bounded [7,365])
//	         &limit=10 (default 10, bounded [1,50])
//	         &min_recipients=20 (default 20, lower bound for "real" data)
//	  -> { window_days, top: [{ campaign_id, name, subject, sent_at,
//	         recipients, opens, clicks, open_rate, click_rate }] }
//
// Why a new package rather than extending aicompose / subject_lab?
//
//   - aicompose.ComposeVariants needs an existing subject + body anchor
//     (the variants are "more like this one"); the assistant takes a
//     plain-English BRIEF, like Klaviyo's flow ("Tell us what you're
//     promoting"), and emits 3 net-new candidates from scratch.
//
//   - subject_lab is a baseline-scoring + axis-diversity workbench. It
//     does not surface top-performers and its variants endpoint requires
//     a seed_subject ≥10 chars.
//
// Both downstream services are reused via the same VoiceClient interface
// aicompose declares — we depend on aicompose.Composer (specifically the
// underlying VoiceClient + KindSubjectLine path) so a missing
// GEMINI_API_KEY surfaces as 503 with the same voice_unavailable shape.
//
// The "top performers" query reads from `campaigns` + `campaign_report_events`
// joined per-tenant under the regular tenant-RLS transaction (see
// db.WithTenant). The default 90-day window matches the gap doc; the
// window/limit/min_recipients knobs let the desktop ask for shorter or
// stricter windows when relevant.
package ai_subject_lines

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// generateJSONMaxBodyBytes bounds inbound briefs — Klaviyo's UI caps
// brief input at ~2 KiB; 8 KiB is generous-but-bounded and matches the
// budget the upstream voice service expects.
const generateJSONMaxBodyBytes int64 = 8 << 10

// defaultVariantCount mirrors Klaviyo's "3 candidates" affordance.
const defaultVariantCount = 3

// maxVariantCount caps fan-out to bound LLM cost — 5 covers
// auto-population of A/B tests (which Moosewave caps at 4 children +
// 1 control).
const maxVariantCount = 5

// Deps wires the assistant into the HTTP layer.
//
// Composer is the same aicompose.Composer wired in main.go. Pool is the
// pgxpool used for the top-performers query (RLS via db.WithTenant).
//
// Logger is used by httperror.WriteInternal so 5xx responses log
// err.Error() server-side with tenant_id+request_id, while the wire
// envelope stays generic. nil-safe at the httperror call site.
type Deps struct {
	Pool     *db.Pool
	Composer *aicompose.Composer
	Logger   *slog.Logger
}

// MountRoutes wires the two routes. Mount inside the same expensive
// LLM rate-limit group as /api/v1/ai/compose/* so the cost cap applies
// uniformly.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil {
		return
	}
	if d.Composer != nil {
		r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
			Post("/api/v1/ai/subject-lines/generate", d.Generate)
	}
	if d.Pool != nil {
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
			Get("/api/v1/ai/subject-lines/top-performers", d.TopPerformers)
	}
}

/* ---------- /generate ---------------------------------------------- */

// GenerateInput is the request shape. Matches the implementation sketch
// in the audit doc: { prompt, tone, target_audience }.
type GenerateInput struct {
	// Prompt is the user's brief — required, ≥3 chars after trim. Klaviyo
	// asks for "what you're promoting"; we accept the same kind of
	// 1-line intent ("Black Friday teaser for paid users").
	Prompt string `json:"prompt"`
	// Tone is an optional override ("witty", "formal", "urgent"). When
	// empty, the tenant's brand voice profile (if any) is applied by
	// the voice service.
	Tone string `json:"tone,omitempty"`
	// TargetAudience is optional free-form context ("paid annual users",
	// "trial users on day 7"). Surfaced to the LLM as part of system
	// context so the generated subjects reflect the recipient cohort.
	TargetAudience string `json:"target_audience,omitempty"`
	// VariantCount is the number of candidates to generate. Defaults to 3
	// (matching Klaviyo); bounded to [1,5].
	VariantCount int `json:"variant_count,omitempty"`
}

// GenerateOutput is the response shape.
type GenerateOutput struct {
	// Candidates is the deduped list of generated subject lines. Always
	// contains at least 1 entry on success; the desktop renders one
	// "Use this" / "Auto-populate A/B variants" affordance per candidate.
	Candidates []string `json:"candidates"`
	// GeneratedAt records when the composition completed.
	GeneratedAt time.Time `json:"generated_at"`
	// Fallback is true when the voice service produced fewer distinct
	// candidates than requested and we backfilled with prompt-derived
	// placeholders. The desktop renders a small "AI partial — review
	// before sending" hint when this is set so the operator knows.
	Fallback bool `json:"fallback,omitempty"`
}

// Generate handles POST /api/v1/ai/subject-lines/generate.
func (d *Deps) Generate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in GenerateInput
	if err := httpbody.DecodeJSON(w, r, generateJSONMaxBodyBytes, &in); err != nil {
		// httpbody error codes (bad_json, payload_too_large) are in the
		// httperror safe-echo allowlist — message text is operator-safe.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	prompt := strings.TrimSpace(in.Prompt)
	if len(prompt) < 3 {
		writeErr(w, http.StatusBadRequest, "prompt_too_short",
			"prompt must be at least 3 characters")
		return
	}
	if len(prompt) > 2048 {
		writeErr(w, http.StatusBadRequest, "prompt_too_long",
			"prompt must be ≤2048 characters")
		return
	}
	count := in.VariantCount
	if count == 0 {
		count = defaultVariantCount
	}
	if count < 1 || count > maxVariantCount {
		writeErr(w, http.StatusBadRequest, "bad_variant_count",
			fmt.Sprintf("variant_count must be in [1,%d]", maxVariantCount))
		return
	}
	if d.Composer == nil || d.Composer.Voice == nil {
		writeErr(w, http.StatusServiceUnavailable, "voice_unavailable",
			"AI subject-line generation is not configured")
		return
	}

	out, err := d.generate(r.Context(), t.ID, prompt, in.Tone, in.TargetAudience, count)
	if err != nil {
		switch {
		case errors.Is(err, aicompose.ErrVoiceUnavailable),
			errors.Is(err, aicompose.ErrStrictPIIGatewayUnavailable):
			writeErr(w, http.StatusServiceUnavailable, "voice_unavailable",
				"AI subject-line generation is temporarily unavailable")
		case errors.Is(err, aicompose.ErrBadRequest):
			// aicompose.ErrBadRequest is only ever wrapped with
			// operator-authored messages ("brief is required" /
			// "subject is required") — safe to echo via the
			// validation allowlist.
			httperror.WriteValidation(w, "invalid_input", err.Error())
		default:
			// Default branch catches arbitrary upstream errors from
			// Voice.Generate (HTTP transport, JSON decode, timeout,
			// provider error text). NOT safe to echo — route through
			// the generic 5xx envelope with server-side logging.
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	// EU AI Act Art. 50: these subject candidates are machine-generated.
	w.Header().Set(aidisclosure.HeaderName, "true")
	writeJSON(w, http.StatusOK, out)
}

// generate fans out N concurrent voice-service calls (one per requested
// candidate) and dedupes the result. Each call hints the LLM with the
// variant index so the prompts diversify rather than producing 3
// paraphrases of the same shape.
//
// Partial failure policy: if every call fails, propagate the first
// error (so the handler can map voice_unavailable specifically). If
// at least one call succeeds, return what we have with fallback=true
// when we needed to backfill with prompt-derived placeholders.
func (d *Deps) generate(ctx context.Context, tenantID, prompt, tone, audience string, count int) (GenerateOutput, error) {
	contextText := d.Composer.ContextText(ctx, tenantID, tone, audience)

	results := make([]string, count)
	errs := make([]error, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			variantPrompt := fmt.Sprintf(
				"Generate ONE subject line for an email campaign. "+
					"This is candidate %d of %d — make it distinct from "+
					"the other candidates in opening word, length, or "+
					"angle. Reply with just the subject line text, no "+
					"numbering, quotes, or commentary. Brief: %s",
				i+1, count, prompt,
			)
			res, err := d.Composer.Voice.Generate(ctx, tenantID, aicompose.KindSubjectLine, variantPrompt, contextText)
			if err != nil {
				errs[i] = err
				return
			}
			results[i] = sanitizeSubject(res.Text)
		}()
	}
	wg.Wait()

	deduped := dedupeNonEmpty(results)

	// If every call failed, propagate the first error so the handler
	// can map voice_unavailable specifically.
	if len(deduped) == 0 {
		for _, e := range errs {
			if e != nil {
				return GenerateOutput{}, e
			}
		}
		return GenerateOutput{}, errors.New("voice service returned empty subjects")
	}

	fallback := false
	// Backfill with prompt-derived placeholders when the LLM gave us
	// fewer than `count` distinct candidates. We never fabricate
	// content beyond "<brief truncated>" because the gap doc is
	// emphatic that we surface honest fallbacks.
	if len(deduped) < count {
		fallback = true
		base := truncate(prompt, 60)
		for len(deduped) < count {
			alt := base
			if len(deduped) > 0 {
				alt = fmt.Sprintf("%s (option %d)", base, len(deduped)+1)
			}
			// Avoid duplicating an already-present candidate.
			alreadyPresent := false
			for _, d := range deduped {
				if strings.EqualFold(strings.TrimSpace(d), strings.TrimSpace(alt)) {
					alreadyPresent = true
					break
				}
			}
			if alreadyPresent {
				alt = fmt.Sprintf("%s (option %d)", base, len(deduped)+2)
			}
			deduped = append(deduped, alt)
		}
	}

	return GenerateOutput{
		Candidates:  deduped,
		GeneratedAt: time.Now().UTC(),
		Fallback:    fallback,
	}, nil
}

// sanitizeSubject normalizes the raw voice-service text into a clean
// single-line subject. The LLM sometimes wraps in quotes, prefixes
// with "1." or "Subject:", or returns multi-line content. We
// conservatively pick the first non-empty line, strip surrounding
// quotes/list markers, and cap at 200 chars (matching the campaigns
// table's CHECK constraint).
func sanitizeSubject(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Take first non-empty line.
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	// Strip list markers: "1.", "1)", "- ", "* ", "• ".
	for _, prefix := range []string{"1. ", "1) ", "(1) ", "- ", "* ", "• "} {
		if strings.HasPrefix(s, prefix) {
			s = strings.TrimSpace(s[len(prefix):])
			break
		}
	}
	// Strip leading label like "Subject:".
	if i := strings.Index(strings.ToLower(s), "subject:"); i == 0 {
		s = strings.TrimSpace(s[len("subject:"):])
	}
	// Strip wrapping single/double/curly quotes.
	s = strings.Trim(s, `"'“”‘’ `)
	// Cap length at 200 chars to match the campaigns.subject column constraint.
	if l := len([]rune(s)); l > 200 {
		runes := []rune(s)
		s = strings.TrimSpace(string(runes[:200]))
	}
	return s
}

// dedupeNonEmpty preserves order, drops empty strings, and case-folds
// for duplicate detection so "Black Friday Deals" and "black friday
// deals" don't both make it through.
func dedupeNonEmpty(in []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		key := strings.ToLower(s)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, s)
	}
	return out
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n]))
}

/* ---------- /top-performers --------------------------------------- */

// TopPerformer is one row of the "top subject lines from the last 90
// days" panel.
type TopPerformer struct {
	CampaignID string    `json:"campaign_id"`
	Name       string    `json:"name"`
	Subject    string    `json:"subject"`
	SentAt     time.Time `json:"sent_at"`
	Recipients int       `json:"recipients"`
	Opens      int       `json:"opens"`
	Clicks     int       `json:"clicks"`
	OpenRate   float64   `json:"open_rate"`
	ClickRate  float64   `json:"click_rate"`
}

// TopPerformersOutput is the response shape.
type TopPerformersOutput struct {
	WindowDays    int            `json:"window_days"`
	MinRecipients int            `json:"min_recipients"`
	Top           []TopPerformer `json:"top"`
}

// TopPerformers handles GET /api/v1/ai/subject-lines/top-performers.
//
// Returns the tenant's highest-open-rate sent campaigns within the
// window. Default window 90d / limit 10 / min_recipients 20 keeps
// noise low — tiny test campaigns with 1 recipient and 100% open
// rate are not "top performers".
func (d *Deps) TopPerformers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	q := r.URL.Query()
	days := parseIntQuery(q.Get("days"), 90, 7, 365)
	limit := parseIntQuery(q.Get("limit"), 10, 1, 50)
	minRecipients := parseIntQuery(q.Get("min_recipients"), 20, 1, 100000)

	since := time.Now().UTC().AddDate(0, 0, -days)
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		// db.WithTenant can surface pgx connection/transaction errors —
		// never safe to echo to clients.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// We compute recipients as the distinct count of subscriber_email
	// receiving 'sent' events (denominator for open-rate) and opens
	// as distinct 'opened' subscribers — both match the convention used
	// by subject_analyzer.Buckets. Filter to campaigns with a non-empty
	// subject and enough recipients to be meaningful.
	rows, err := tx.Query(r.Context(), `
WITH per_campaign AS (
  SELECT c.id::text                                                   AS campaign_id,
         COALESCE(c.name, '')                                          AS name,
         COALESCE(c.subject, '')                                       AS subject,
         COALESCE(c.sent_at, c.updated_at, c.created_at)               AS sent_at,
         count(DISTINCT e.subscriber_email) FILTER (WHERE e.event_type = 'sent')::int    AS recipients,
         count(DISTINCT e.subscriber_email) FILTER (WHERE e.event_type = 'opened')::int  AS opens,
         count(DISTINCT e.subscriber_email) FILTER (WHERE e.event_type = 'clicked')::int AS clicks
    FROM campaigns c
    LEFT JOIN campaign_report_events e
      ON e.tenant_id = $1::uuid AND e.campaign_id = c.id
   WHERE c.tenant_id = $1::uuid
     AND c.sent_at IS NOT NULL
     AND c.sent_at >= $2
     AND c.subject IS NOT NULL AND length(c.subject) > 0
   GROUP BY c.id, c.name, c.subject, c.sent_at, c.updated_at, c.created_at
)
SELECT campaign_id, name, subject, sent_at, recipients, opens, clicks
  FROM per_campaign
 WHERE recipients >= $3
 ORDER BY (opens::float / NULLIF(recipients, 0)) DESC NULLS LAST,
          recipients DESC,
          sent_at DESC
 LIMIT $4`, t.ID, since, minRecipients, limit)
	if err != nil {
		// Raw pgx error from the analytical query — operator-only.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	out := TopPerformersOutput{
		WindowDays:    days,
		MinRecipients: minRecipients,
		Top:           []TopPerformer{},
	}
	for rows.Next() {
		var p TopPerformer
		if err := rows.Scan(&p.CampaignID, &p.Name, &p.Subject, &p.SentAt,
			&p.Recipients, &p.Opens, &p.Clicks); err != nil {
			continue
		}
		if p.Recipients > 0 {
			p.OpenRate = float64(p.Opens) / float64(p.Recipients)
			p.ClickRate = float64(p.Clicks) / float64(p.Recipients)
		}
		out.Top = append(out.Top, p)
	}
	writeJSON(w, http.StatusOK, out)
}

// parseIntQuery is a small helper that parses a query int with a
// default and clamps to [lo,hi].
func parseIntQuery(raw string, def, lo, hi int) int {
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

/* ---------- helpers ----------------------------------------------- */

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
