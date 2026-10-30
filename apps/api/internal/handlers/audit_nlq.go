// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_nlq.go — natural-language audit query endpoint.
//
//	POST /api/v1/audit/nlq            { query }
//	     →  { query_preview, structured_filters, results, summary, trace }
//	GET  /api/v1/audit/nlq/cost-status
//	     →  { daily_usage_tokens, daily_cap_tokens, remaining_tokens, reset_at }
//
// CloudTrail-Lake pattern: the LLM translation is exposed verbatim
// to the operator (structured_filters + trace) so a hallucinated
// query is *seen*, not silently executed against fabricated rows.
//
// Audit-NLQ gap-doc category: UX, P0.
package handlers

import (
	"context"

	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// _ keeps slog imported even when the only consumer is the embedded
// *slog.Logger on AuditHandlers (declared in audit.go). Removing this
// guard would not break compilation today, but it documents the
// expected use of slog at error sites migrated to httperror.
var _ = slog.LevelError

const nlqMaxRequestBodyBytes = 16 << 10 // 16 KiB
const nlqQueryMaxLen = 2000
const nlqDefaultLimit = 50

// nlqRequest is the wire shape of POST /api/v1/audit/nlq.
type nlqRequest struct {
	Query string `json:"query"`
}

// nlqResponse is the wire shape of POST /api/v1/audit/nlq.
type nlqResponse struct {
	QueryPreview      string                  `json:"query_preview"`
	StructuredFilters audit.StructuredFilters `json:"structured_filters"`
	InvalidFields     []string                `json:"invalid_fields,omitempty"`
	Results           []AuditRow              `json:"results"`
	TotalCount        int                     `json:"total_count"`
	Summary           string                  `json:"summary"`
	Trace             nlqTrace                `json:"trace"`
	CostStatus        nlqCostStatus           `json:"cost_status"`
}

type nlqTrace struct {
	Reasoning      string `json:"reasoning"`
	Model          string `json:"model"`
	RawLLMResponse string `json:"raw_llm_response"`
	PromptTokens   int    `json:"prompt_tokens"`
	ResponseTokens int    `json:"response_tokens"`
	SummaryTokens  int    `json:"summary_tokens"`
	CacheHit       bool   `json:"cache_hit"`
	RetentionDays  int    `json:"retention_days"`
	GeneratedAt    string `json:"generated_at"`
}

type nlqCostStatus struct {
	DailyUsageTokens int64  `json:"daily_usage_tokens"`
	DailyCapTokens   int64  `json:"daily_cap_tokens"`
	RemainingTokens  int64  `json:"remaining_tokens"`
	ResetAt          string `json:"reset_at"`
}

// QueryNaturalLanguage POST /api/v1/audit/nlq.
//
// Pipeline:
//  1. Read tenant retention (so the LLM never picks a `since` older
//     than the audit log retains).
//  2. Cache lookup keyed by (tenant_id, lower(query)) — translation
//     results live 1h to absorb repeat queries cheaply.
//  3. LLM translation, validated against AllowedFilterFields.
//  4. Execute the structured filter via the same SQL the List
//     handler uses (consistency: nlq results match the rows the
//     operator sees after clicking "apply these filters").
//  5. LLM summarisation on a bounded sample.
//  6. Charge tokens against the per-tenant daily cap.
func (h *AuditHandlers) QueryNaturalLanguage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if h.NLQLLM == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "nlq_unavailable",
			"NLQ is not configured. Set ANTHROPIC_API_KEY on the API server to enable it.")
		return
	}

	var in nlqRequest
	if err := httpbody.DecodeJSON(w, r, nlqMaxRequestBodyBytes, &in); err != nil {
		httpbody.
			// bad_json is in httperror.IsValidationCode allowlist — the JSON
			// decoder produces operator-safe messages (no DB internals).
			WriteError(w, err)
		return

	}
	q := strings.TrimSpace(in.Query)
	if q == "" {
		writeJSONErr(w, http.StatusBadRequest, "empty_query", "query is required")
		return
	}
	if len(q) > nlqQueryMaxLen {
		writeJSONErr(w, http.StatusBadRequest, "query_too_long",
			"query must be 2000 characters or fewer")
		return
	}

	// Cost-cap pre-check (no charge yet — that happens after the call
	// returns actual token usage).
	if h.NLQTracker != nil {
		_, _, rem, _ := h.NLQTracker.Status(t.ID)
		if h.NLQTrackerHasCap() && rem <= 0 {
			writeAuditNLQCostCapDenial(w,
				"daily NLQ token budget exhausted for this tenant; resets at UTC midnight")
			return
		}
	}

	// Retention lookup — best-effort, defaults to 90.
	retention := h.lookupTenantRetention(r.Context(), t.ID)

	// Cache lookup.
	cacheKey := audit.NewNLQCacheKey(t.ID, q)
	var translation *audit.TranslationResult
	if h.NLQCache != nil {
		translation = h.NLQCache.Get(cacheKey)
	}
	if translation == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		t1, err := audit.TranslateQueryToFilters(ctx, h.NLQLLM, q, retention)
		cancel()
		if err != nil {
			code, status := audit.TranslateLLMError(err)
			// TranslateLLMError returns curated codes for operator-visible
			// LLM failures (quota, timeout, malformed JSON from the model).
			// Echo only when the code is in the safe-to-echo allowlist;
			// otherwise log the raw error and return the generic 500.
			if httperror.IsValidationCode(code) {
				httperror.Write(w, status, code, httperror.MessageForStatus(status))
			} else {
				httperror.WriteInternal(w, h.Logger, err, r.Context())
			}
			return
		}
		translation = t1
		if h.NLQCache != nil {
			h.NLQCache.Put(cacheKey, translation)
		}
	}

	// Charge translation tokens.
	if h.NLQTracker != nil && !translation.CacheHit {
		_, _, exceeded := h.NLQTracker.Add(t.ID, translation.PromptTokens+translation.ResponseTokens)
		if exceeded {
			writeAuditNLQCostCapDenial(w,
				"daily NLQ token budget exhausted while answering this query")
			return
		}
	}

	// Run the structured filter against audit_log using the same SQL
	// shape as List.
	results, total, err := h.runFilteredAudit(r.Context(), t.ID, translation.Filters)
	if err != nil {
		// Infrastructure path (pgx/SQL/connection errors); err.Error()
		// would leak DB internals so route to WriteInternal which logs
		// server-side and returns the generic envelope.
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	// Summarisation — best-effort, never blocks results.
	summary := ""
	summaryTokens := 0
	if h.NLQLLM != nil {
		rowsForSummary := make([]audit.AuditRowForSummary, 0, len(results))
		for _, r := range results {
			rowsForSummary = append(rowsForSummary, projectRowForSummary(r))
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		sres, serr := audit.SummarizeAuditResults(ctx, h.NLQLLM, q, rowsForSummary, total)
		cancel()
		if serr == nil && sres != nil {
			summary = sres.Summary
			summaryTokens = sres.PromptTokens + sres.ResponseTokens
			if h.NLQTracker != nil {
				_, _, _ = h.NLQTracker.Add(t.ID, summaryTokens)
			}
		}
	}

	used, cap, rem, reset := int64(0), int64(0), int64(0), time.Time{}
	if h.NLQTracker != nil {
		used, cap, rem, reset = h.NLQTracker.Status(t.ID)
	}

	resp := nlqResponse{
		QueryPreview:      q,
		StructuredFilters: translation.Filters,
		InvalidFields:     translation.InvalidFields,
		Results:           results,
		TotalCount:        total,
		Summary:           summary,
		Trace: nlqTrace{
			Reasoning:      translation.Reasoning,
			Model:          translation.Model,
			RawLLMResponse: translation.RawLLMResponse,
			PromptTokens:   translation.PromptTokens,
			ResponseTokens: translation.ResponseTokens,
			SummaryTokens:  summaryTokens,
			CacheHit:       translation.CacheHit,
			RetentionDays:  retention,
			GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
		},
		CostStatus: nlqCostStatus{
			DailyUsageTokens: used,
			DailyCapTokens:   cap,
			RemainingTokens:  rem,
			ResetAt:          formatTime(reset),
		},
	}
	writeJSON(w, http.StatusOK, resp)
}

// NLQCostStatus GET /api/v1/audit/nlq/cost-status.
func (h *AuditHandlers) NLQCostStatus(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	used, cap, rem, reset := int64(0), int64(0), int64(0), time.Time{}
	if h.NLQTracker != nil {
		used, cap, rem, reset = h.NLQTracker.Status(t.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"daily_usage_tokens": used,
		"daily_cap_tokens":   cap,
		"remaining_tokens":   rem,
		"reset_at":           formatTime(reset),
		"nlq_available":      h.NLQLLM != nil,
	})
}

// NLQTrackerHasCap reports whether the tracker has a positive cap.
func (h *AuditHandlers) NLQTrackerHasCap() bool {
	if h.NLQTracker == nil {
		return false
	}
	_, c, _, _ := h.NLQTracker.Status("__cap_probe__")
	return c > 0
}

// runFilteredAudit executes the same SQL as List but against the
// LLM-translated filter struct. Returns (rows, total_count_matching).
func (h *AuditHandlers) runFilteredAudit(ctx context.Context, tenantID string, f audit.StructuredFilters) ([]AuditRow, int, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = nlqDefaultLimit
	}
	if limit > 500 {
		limit = 500
	}
	var since *time.Time
	if f.Since != "" {
		parsed, err := time.Parse(time.RFC3339, f.Since)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339Nano, f.Since)
			if err != nil {
				return nil, 0, errors.New("invalid since timestamp from translator")
			}
		}
		since = &parsed
	}
	tx, err := db.WithTenant(ctx, h.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const sql = `
SELECT id, action, resource_type, resource_id,
       actor_type, actor_label, user_id::text,
       host(ip), user_agent, metadata, at
FROM audit_log
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR actor_type  = $2)
  AND ($3 = '' OR actor_label = $3)
  AND ($4 = '' OR action ILIKE '%' || $4 || '%')
  AND ($5 = '' OR resource_type = $5)
  AND ($6::timestamptz IS NULL OR at >= $6::timestamptz)
  AND ($7 = '' OR resource_id ILIKE '%' || $7 || '%')
ORDER BY id DESC
LIMIT $8`

	rows, err := tx.Query(ctx, sql, tenantID,
		f.ActorType, f.ActorLabel, f.Action, f.ResourceType, since, f.ResourceID, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []AuditRow{}
	for rows.Next() {
		var ar AuditRow
		var meta map[string]any
		if err := rows.Scan(&ar.ID, &ar.Action, &ar.ResourceType, &ar.ResourceID,
			&ar.ActorType, &ar.ActorLabel, &ar.UserID,
			&ar.IP, &ar.UserAgent, &meta, &ar.At); err != nil {
			return nil, 0, err
		}
		if meta == nil {
			meta = map[string]any{}
		}
		ar.Metadata = meta
		out = append(out, ar)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	// Total count — same WHERE, no LIMIT.
	var total int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM audit_log
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR actor_type  = $2)
  AND ($3 = '' OR actor_label = $3)
  AND ($4 = '' OR action ILIKE '%' || $4 || '%')
  AND ($5 = '' OR resource_type = $5)
  AND ($6::timestamptz IS NULL OR at >= $6::timestamptz)
  AND ($7 = '' OR resource_id ILIKE '%' || $7 || '%')`,
		tenantID, f.ActorType, f.ActorLabel, f.Action, f.ResourceType, since, f.ResourceID,
	).Scan(&total); err != nil {
		// Total is non-critical; fall back to len(out).
		total = len(out)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

func (h *AuditHandlers) lookupTenantRetention(ctx context.Context, tenantID string) int {
	const def = 90
	tx, err := db.WithTenant(ctx, h.Pool, tenantID)
	if err != nil {
		return def
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var days *int
	if err := tx.QueryRow(ctx,
		`SELECT audit_retention_days FROM tenants WHERE id = $1::uuid`, tenantID,
	).Scan(&days); err != nil {
		return def
	}
	_ = tx.Commit(ctx)
	if days != nil && *days > 0 {
		return *days
	}
	return def
}

// projectRowForSummary trims an AuditRow down to the keys the
// summariser actually uses. Keeps token cost bounded.
func projectRowForSummary(r AuditRow) audit.AuditRowForSummary {
	out := audit.AuditRowForSummary{
		At:        r.At.UTC().Format(time.RFC3339),
		Action:    r.Action,
		ActorType: r.ActorType,
	}
	if r.ActorLabel != nil {
		out.ActorLabel = *r.ActorLabel
	}
	if r.ResourceType != nil {
		out.ResourceType = *r.ResourceType
	}
	if r.ResourceID != nil {
		out.ResourceID = *r.ResourceID
	}
	return out
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
