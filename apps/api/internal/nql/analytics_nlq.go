// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics_nlq.go — natural-language analytics queries.
//
//	POST /api/v1/analytics/nlq   { question }
//	     → { answer_kind, template, params, columns, rows, summary_text, trace, cost_status }
//
// Same CloudTrail-Lake posture as the audit NLQ pipeline
// (internal/audit/nlq.go): the LLM is ONLY trusted to pick one entry
// from a whitelisted template registry and fill two clamped integer
// parameters. The SQL is authored here, fully parameterized, and never
// assembled from model output — a hallucinated template id is rejected
// with invalid_template, never executed. Quotas mirror the audit NLQ
// sibling (per-tenant daily token cap via audit.DailyCostTracker). Query
// results never leave Moosewave: response summaries are deterministic and
// rendered locally after the whitelisted SQL executes.
package nql

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	analyticsNLQMaxBodyBytes int64 = 16 << 10
	questionMaxLen                 = 2000
	defaultWindowDays              = 30
	maxWindowDays                  = 90
	defaultRowLimit                = 10
	maxRowLimit                    = 50
	llmCallTimeout                 = 20 * time.Second
)

// LLMClient is the question-to-template translation contract. Structurally
// satisfied by *audit.AnthropicNLQClient so main.go wires the exact
// same gateway client the audit NLQ uses.
type LLMClient interface {
	Complete(ctx context.Context, system, user string) (text string, promptTokens, responseTokens int, err error)
}

// AnalyticsTemplate is one whitelisted, parameterized analytics query.
// SQL takes ($1 tenant uuid, $2 window start timestamptz) and — when
// NeedsLimit — ($3 row limit). The LLM can only name a template; it
// can never author SQL.
type AnalyticsTemplate struct {
	ID          string
	Description string
	AnswerKind  string // "table" (ranked/series rows) or "summary" (single aggregate row)
	NeedsLimit  bool
	SQL         string
}

// analyticsTemplates is the whitelist. ~8 templates covering the
// questions operators actually ask the analytics page.
var analyticsTemplates = []AnalyticsTemplate{
	{
		ID:          "top_campaigns_by_opens",
		Description: "Campaigns ranked by unique opens within the window.",
		AnswerKind:  "table",
		NeedsLimit:  true,
		SQL: `
SELECT c.id::text AS campaign_id, c.name AS campaign_name,
       COUNT(DISTINCT e.subscriber_email)::bigint AS unique_opens
  FROM campaigns c
  JOIN subscriber_events e
    ON e.campaign_id = c.id AND e.tenant_id = c.tenant_id
 WHERE c.tenant_id = $1::uuid
   AND e.event_type = 'opened'
   AND e.at >= $2::timestamptz
 GROUP BY c.id, c.name
 ORDER BY unique_opens DESC
 LIMIT $3`,
	},
	{
		ID:          "top_campaigns_by_clicks",
		Description: "Campaigns ranked by unique clicks within the window.",
		AnswerKind:  "table",
		NeedsLimit:  true,
		SQL: `
SELECT c.id::text AS campaign_id, c.name AS campaign_name,
       COUNT(DISTINCT e.subscriber_email)::bigint AS unique_clicks
  FROM campaigns c
  JOIN subscriber_events e
    ON e.campaign_id = c.id AND e.tenant_id = c.tenant_id
 WHERE c.tenant_id = $1::uuid
   AND e.event_type = 'clicked'
   AND e.at >= $2::timestamptz
 GROUP BY c.id, c.name
 ORDER BY unique_clicks DESC
 LIMIT $3`,
	},
	{
		ID:          "top_campaigns_by_unsubscribes",
		Description: "Campaigns ranked by unsubscribes within the window (worst first).",
		AnswerKind:  "table",
		NeedsLimit:  true,
		SQL: `
SELECT c.id::text AS campaign_id, c.name AS campaign_name,
       COUNT(DISTINCT e.subscriber_email)::bigint AS unsubscribes
  FROM campaigns c
  JOIN subscriber_events e
    ON e.campaign_id = c.id AND e.tenant_id = c.tenant_id
 WHERE c.tenant_id = $1::uuid
   AND e.event_type = 'unsubscribed'
   AND e.at >= $2::timestamptz
 GROUP BY c.id, c.name
 ORDER BY unsubscribes DESC
 LIMIT $3`,
	},
	{
		ID:          "top_campaigns_by_revenue",
		Description: "Campaign and currency rows ranked by attributed conversion revenue within the window.",
		AnswerKind:  "table",
		NeedsLimit:  true,
		SQL: `
SELECT c.id::text AS campaign_id, c.name AS campaign_name,
       UPPER(COALESCE(NULLIF(v.currency, ''), 'UNKNOWN')) AS currency,
       COALESCE(SUM(v.amount_cents), 0)::bigint AS revenue_cents,
       COUNT(*)::bigint AS conversions
  FROM conversions v
  JOIN campaigns c
    ON c.id = v.campaign_id AND c.tenant_id = v.tenant_id
 WHERE v.tenant_id = $1::uuid
   AND v.occurred_at >= $2::timestamptz
   AND v.amount_cents IS NOT NULL
 GROUP BY c.id, c.name, UPPER(COALESCE(NULLIF(v.currency, ''), 'UNKNOWN'))
 ORDER BY revenue_cents DESC
 LIMIT $3`,
	},
	{
		ID:          "subscriber_growth",
		Description: "New subscribers per day across the window (growth trend).",
		AnswerKind:  "table",
		NeedsLimit:  false,
		SQL: `
SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
       COUNT(*)::bigint AS new_subscribers
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND created_at >= $2::timestamptz
 GROUP BY 1
 ORDER BY 1`,
	},
	{
		ID:          "deliverability_summary",
		Description: "Recorded bounce, complaint, and open event counts plus the number of campaigns with any event in the window.",
		AnswerKind:  "summary",
		NeedsLimit:  false,
		SQL: `
SELECT COUNT(*) FILTER (WHERE event_type = 'bounced')::bigint    AS bounces,
       COUNT(*) FILTER (WHERE event_type = 'complained')::bigint AS complaints,
       COUNT(*) FILTER (WHERE event_type = 'opened')::bigint     AS opens,
       COUNT(DISTINCT campaign_id)::bigint                       AS campaigns_with_events
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND at >= $2::timestamptz`,
	},
	{
		ID:          "engagement_overview",
		Description: "Total opens, clicks, unsubscribes and unique engaged subscribers within the window.",
		AnswerKind:  "summary",
		NeedsLimit:  false,
		SQL: `
SELECT COUNT(*) FILTER (WHERE event_type = 'opened')::bigint       AS opens,
       COUNT(*) FILTER (WHERE event_type = 'clicked')::bigint      AS clicks,
       COUNT(*) FILTER (WHERE event_type = 'unsubscribed')::bigint AS unsubscribes,
       COUNT(DISTINCT subscriber_email)
         FILTER (WHERE event_type IN ('opened','clicked'))::bigint AS engaged_subscribers
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND at >= $2::timestamptz`,
	},
	{
		ID:          "revenue_summary",
		Description: "Attributed conversion revenue and conversion counts separated by currency within the window.",
		AnswerKind:  "table",
		NeedsLimit:  false,
		SQL: `
SELECT UPPER(COALESCE(NULLIF(currency, ''), 'UNKNOWN')) AS currency,
       COALESCE(SUM(amount_cents), 0)::bigint AS revenue_cents,
       COUNT(*)::bigint                       AS conversions,
       COUNT(DISTINCT campaign_id)
         FILTER (WHERE campaign_id IS NOT NULL)::bigint AS attributed_campaigns
  FROM conversions
 WHERE tenant_id = $1::uuid
   AND occurred_at >= $2::timestamptz
   AND amount_cents IS NOT NULL
 GROUP BY UPPER(COALESCE(NULLIF(currency, ''), 'UNKNOWN'))
 ORDER BY currency`,
	},
}

// templateByID returns the whitelisted template or nil.
func templateByID(id string) *AnalyticsTemplate {
	id = strings.ToLower(strings.TrimSpace(id))
	for i := range analyticsTemplates {
		if analyticsTemplates[i].ID == id {
			return &analyticsTemplates[i]
		}
	}
	return nil
}

// TemplateIDs lists the whitelist, for prompts + tests.
func TemplateIDs() []string {
	out := make([]string, 0, len(analyticsTemplates))
	for _, t := range analyticsTemplates {
		out = append(out, t.ID)
	}
	return out
}

// AnalyticsParams are the only knobs the LLM may set. Clamped after
// parse — out-of-range values degrade to the bounds, never error.
type AnalyticsParams struct {
	WindowDays int `json:"window_days"`
	Limit      int `json:"limit"`
}

func (p *AnalyticsParams) clamp() {
	if p.WindowDays <= 0 {
		p.WindowDays = defaultWindowDays
	}
	if p.WindowDays > maxWindowDays {
		p.WindowDays = maxWindowDays
	}
	if p.Limit <= 0 {
		p.Limit = defaultRowLimit
	}
	if p.Limit > maxRowLimit {
		p.Limit = maxRowLimit
	}
}

// AnalyticsTranslation is the validated translation result.
type AnalyticsTranslation struct {
	Template       *AnalyticsTemplate
	Params         AnalyticsParams
	Reasoning      string
	RawLLMResponse string
	PromptTokens   int
	ResponseTokens int
}

// ErrUnknownTemplate is returned when the LLM names a template outside
// the whitelist (including any attempt to smuggle SQL through the
// template field).
var ErrUnknownTemplate = errors.New("nql: llm picked a template outside the whitelist")

var analyticsJSONFenceRE = regexp.MustCompile("(?s)^```(?:json)?\\s*|\\s*```\\s*$")

// analyticsNLQPrompt pins the registry into the system prompt and
// demands strict JSON.
func analyticsNLQPrompt(question string) (system, user string) {
	var b strings.Builder
	b.WriteString(`You are a query router for an email-marketing analytics system. Convert the user's English question into ONE choice from a fixed query template list plus two integer parameters.

AVAILABLE TEMPLATES (you MUST pick exactly one id from this list):
`)
	for _, t := range analyticsTemplates {
		fmt.Fprintf(&b, "  %-32s %s\n", t.ID, t.Description)
	}
	b.WriteString(`
PARAMETERS:
  window_days  number — lookback window in days, 1..90 (default 30)
  limit        number — max rows for ranked templates, 1..50 (default 10)

RULES:
  1. Output STRICT JSON. No markdown, no fences, no prose before or after.
  2. Use the exact schema: {"template": "…", "params": {"window_days": n, "limit": n}, "reasoning": "…"}.
  3. Reasoning is one short sentence explaining your choice.
  4. If the question doesn't fit any template, pick the closest one and note the limitation in reasoning.
  5. NEVER output SQL. NEVER invent template ids. NEVER add fields outside the schema.`)
	return b.String(), "User question: " + strings.TrimSpace(question)
}

// TranslateAnalyticsQuestion runs the translation prompt and validates
// the result against the whitelist. The returned Template is always a
// registry entry — model output never reaches SQL.
func TranslateAnalyticsQuestion(ctx context.Context, llm LLMClient, question string) (*AnalyticsTranslation, error) {
	if llm == nil {
		return nil, errors.New("nql: llm client not configured")
	}
	q := strings.TrimSpace(question)
	if q == "" {
		return nil, errors.New("nql: empty question")
	}
	system, user := analyticsNLQPrompt(q)
	text, pin, pout, err := llm.Complete(ctx, system, user)
	if err != nil {
		return nil, fmt.Errorf("nlq translation: %w", err)
	}
	cleaned := strings.TrimSpace(analyticsJSONFenceRE.ReplaceAllString(strings.TrimSpace(text), ""))
	if cleaned == "" {
		cleaned = strings.TrimSpace(text)
	}
	var parsed struct {
		Template  string          `json:"template"`
		Params    AnalyticsParams `json:"params"`
		Reasoning string          `json:"reasoning"`
	}
	out := &AnalyticsTranslation{
		RawLLMResponse: text,
		PromptTokens:   pin,
		ResponseTokens: pout,
	}
	if err := json.Unmarshal([]byte(cleaned), &parsed); err != nil {
		return out, fmt.Errorf("nlq: malformed llm json: %w", err)
	}
	tpl := templateByID(parsed.Template)
	if tpl == nil {
		return out, fmt.Errorf("%w: %q", ErrUnknownTemplate, truncateForLog(parsed.Template, 120))
	}
	parsed.Params.clamp()
	out.Template = tpl
	out.Params = parsed.Params
	out.Reasoning = strings.TrimSpace(parsed.Reasoning)
	return out, nil
}

func truncateForLog(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// AnalyticsDeps wires the analytics NLQ + anomaly-brief handlers.
type AnalyticsDeps struct {
	Pool   *db.Pool
	Logger *slog.Logger
	// LLM is the shared Anthropic gateway client (same instance the
	// audit NLQ uses). nil = both endpoints return 503.
	LLM LLMClient
	// Tracker enforces the per-tenant daily token cap, mirroring the
	// audit NLQ quota posture. nil = unlimited.
	Tracker *audit.DailyCostTracker
}

// MountAnalyticsRoutes registers the analytics NLQ surface. Scoped to
// read:reports like the rest of the analytics read API.
func MountAnalyticsRoutes(r chi.Router, d *AnalyticsDeps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Post("/api/v1/analytics/nlq", d.queryNLQ)
	r.With(read).Post("/api/v1/analytics/anomaly-brief", d.anomalyBrief)
}

type analyticsNLQRequest struct {
	Question string `json:"question"`
}

type analyticsNLQResponse struct {
	Question    string           `json:"question"`
	AnswerKind  string           `json:"answer_kind"`
	Template    string           `json:"template"`
	Params      AnalyticsParams  `json:"params"`
	Columns     []string         `json:"columns"`
	Rows        []map[string]any `json:"rows"`
	SummaryText string           `json:"summary_text"`
	Trace       analyticsTrace   `json:"trace"`
}

type analyticsTrace struct {
	Reasoning      string `json:"reasoning"`
	PromptTokens   int    `json:"prompt_tokens"`
	ResponseTokens int    `json:"response_tokens"`
	SummaryTokens  int    `json:"summary_tokens"`
	GeneratedAt    string `json:"generated_at"`
}

// queryNLQ POST /api/v1/analytics/nlq.
func (d *AnalyticsDeps) queryNLQ(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.LLM == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "nlq_unavailable",
			"analytics NLQ is not configured. Set ANTHROPIC_API_KEY on the API server to enable it.")
		return
	}
	var in analyticsNLQRequest
	if err := httpbody.DecodeJSON(w, r, analyticsNLQMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	q := strings.TrimSpace(in.Question)
	if q == "" {
		httperror.Write(w, http.StatusBadRequest, "empty_question", "question is required")
		return
	}
	if utf8.RuneCountInString(q) > questionMaxLen {
		httperror.Write(w, http.StatusBadRequest, "question_too_long",
			fmt.Sprintf("question must be %d characters or fewer", questionMaxLen))
		return
	}
	if d.Tracker != nil {
		if _, _, rem, _ := d.Tracker.Status(t.ID); rem == 0 {
			writeNLQCostCapDenial(w,
				"daily NLQ token budget exhausted for this tenant; resets at UTC midnight")
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), llmCallTimeout)
	translation, err := TranslateAnalyticsQuestion(ctx, d.LLM, q)
	cancel()
	if err != nil {
		d.writeTranslateErr(w, r, translation, err)
		return
	}
	if d.Tracker != nil {
		if _, _, exceeded := d.Tracker.Add(t.ID, translation.PromptTokens+translation.ResponseTokens); exceeded {
			writeNLQCostCapDenial(w,
				"daily NLQ token budget exhausted while answering this question")
			return
		}
	}

	columns, rows, err := d.runTemplate(r.Context(), t.ID, translation.Template, translation.Params)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	summary := summarizeAnalyticsRows(
		translation.Template,
		translation.Params,
		rows,
	)

	writeJSON(w, http.StatusOK, analyticsNLQResponse{
		Question:    q,
		AnswerKind:  translation.Template.AnswerKind,
		Template:    translation.Template.ID,
		Params:      translation.Params,
		Columns:     columns,
		Rows:        rows,
		SummaryText: summary,
		Trace: analyticsTrace{
			Reasoning:      translation.Reasoning,
			PromptTokens:   translation.PromptTokens,
			ResponseTokens: translation.ResponseTokens,
			SummaryTokens:  0,
			GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
		},
	})
}

// writeTranslateErr maps translation failures onto stable codes,
// reusing audit.TranslateLLMError for the transport-shaped cases.
func (d *AnalyticsDeps) writeTranslateErr(w http.ResponseWriter, r *http.Request, translation *AnalyticsTranslation, err error) {
	if errors.Is(err, ErrUnknownTemplate) {
		// The model named something outside the whitelist — refuse
		// loudly so the UI can suggest rephrasing. 422, not 500: the
		// system worked as designed.
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_template", err.Error())
		return
	}
	code, status := audit.TranslateLLMError(err)
	if httperror.IsValidationCode(code) {
		httperror.Write(w, status, code, httperror.MessageForStatus(status))
		return
	}
	httperror.WriteInternal(w, d.Logger, err, r.Context())
	_ = translation
}

// runTemplate executes a whitelisted template under tenant RLS and
// returns generic (columns, rows). The ONLY SQL that ever runs is the
// registry literal.
func (d *AnalyticsDeps) runTemplate(ctx context.Context, tenantID string, tpl *AnalyticsTemplate, p AnalyticsParams) ([]string, []map[string]any, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	since := time.Now().UTC().AddDate(0, 0, -p.WindowDays)
	args := []any{tenantID, since}
	if tpl.NeedsLimit {
		args = append(args, p.Limit)
	}
	rows, err := tx.Query(ctx, tpl.SQL, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("template %s: %w", tpl.ID, err)
	}
	defer rows.Close()
	columns, out, err := collectGenericRows(rows)
	if err != nil {
		return nil, nil, fmt.Errorf("template %s: %w", tpl.ID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return columns, out, nil
}

// collectGenericRows materialises a pgx result set into ordered column
// names + one map per row.
func collectGenericRows(rows pgx.Rows) ([]string, []map[string]any, error) {
	fields := rows.FieldDescriptions()
	columns := make([]string, 0, len(fields))
	for _, f := range fields {
		columns = append(columns, string(f.Name))
	}
	out := []map[string]any{}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, nil, err
		}
		row := make(map[string]any, len(columns))
		for i, col := range columns {
			if i < len(values) {
				row[col] = values[i]
			}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return columns, out, nil
}

// summarizeAnalyticsRows keeps executed analytics evidence inside Moosewave.
// The external model selects a fixed template only; it never receives row
// values, campaign names, URLs, subscriber-derived evidence, or revenue.
func summarizeAnalyticsRows(
	tpl *AnalyticsTemplate,
	p AnalyticsParams,
	rows []map[string]any,
) string {
	if len(rows) == 0 {
		return fmt.Sprintf(
			"No data matched this query in the last %d days.",
			p.WindowDays,
		)
	}
	switch tpl.ID {
	case "top_campaigns_by_revenue":
		return fmt.Sprintf(
			"Returned %d campaign-and-currency row(s) for the last %d days; monetary amounts remain separated by currency.",
			len(rows),
			p.WindowDays,
		)
	case "revenue_summary":
		return fmt.Sprintf(
			"Returned %d currency bucket(s) for the last %d days; monetary amounts are not combined across currencies.",
			len(rows),
			p.WindowDays,
		)
	case "subscriber_growth":
		return fmt.Sprintf(
			"Returned %d daily subscriber-growth point(s) for the last %d days.",
			len(rows),
			p.WindowDays,
		)
	case "deliverability_summary":
		return fmt.Sprintf(
			"Returned recorded bounce, complaint, and open event counts plus campaign coverage for the last %d days.",
			p.WindowDays,
		)
	case "engagement_overview":
		return fmt.Sprintf(
			"Returned the recorded engagement totals for the last %d days.",
			p.WindowDays,
		)
	default:
		return fmt.Sprintf(
			"Returned %d result row(s) for the last %d days.",
			len(rows),
			p.WindowDays,
		)
	}
}
