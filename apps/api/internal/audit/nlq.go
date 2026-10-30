// SPDX-License-Identifier: AGPL-3.0-only
//
// nlq.go — Natural-language audit query pipeline.
//
// CloudTrail Lake pattern: the LLM is *only* trusted to translate
// English into a strict, schema-bound filter struct. The translated
// filter is always shown back to the operator before any results are
// rendered, so a hallucinated query is visible — not silently
// answered by a fabricated row set.
//
// Three pieces:
//
//  1. TranslateQueryToFilters — Anthropic Messages call that returns
//     JSON conforming to AllowedFilterFields. We validate the result
//     against the allow-list before handing it back; unknown fields
//     become invalid_filters errors so the UI can prompt the user
//     ("Claude tried to use 'priority' which doesn't exist").
//
//  2. SummarizeAuditResults — second Anthropic call that takes a
//     bounded slice of the result set and emits a 1-2 sentence
//     plain-English summary. Capped at SummaryMaxRows to keep token
//     cost bounded.
//
//  3. NLQCache + DailyCostTracker — process-local 1-hour cache of
//     prompt-translation results (keyed by tenant + lowercased
//     query) and a per-tenant daily token bucket. Both are kept in
//     memory; redis-backed variants are a future refinement.
//
// Audit-NLQ gap-doc category: UX, P0.
package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// AllowedFilterFields is the strict allow-list of audit_log filter
// keys the LLM may emit. Anything else is rejected.
var AllowedFilterFields = []string{
	"actor_type",
	"actor_label",
	"action",
	"resource_type",
	"resource_id",
	"since",
	"limit",
}

var allowedNLQActorTypes = map[string]struct{}{
	"":                  {},
	"human":             {},
	"agent":             {},
	"system":            {},
	"platform_operator": {},
}

// SummaryMaxRows caps how many rows we feed the summariser. The
// LLM only needs a representative sample to write 1-2 sentences and
// each extra row burns input tokens linearly.
const SummaryMaxRows = 25

// DefaultDailyTokenCap is the per-tenant daily token cap. ~250k tokens
// at Claude 3.5 Haiku pricing is well under a dollar/day even for
// chatty operators.
const DefaultDailyTokenCap int64 = 250_000

// NLQCacheTTL is how long a translated filter set stays cached.
const NLQCacheTTL = time.Hour

// StructuredFilters mirrors the wire shape the audit list endpoint
// already accepts. All fields are optional; the audit.List handler
// treats empty strings as "no filter".
type StructuredFilters struct {
	ActorType    string `json:"actor_type,omitempty"`
	ActorLabel   string `json:"actor_label,omitempty"`
	Action       string `json:"action,omitempty"`
	ResourceType string `json:"resource_type,omitempty"`
	ResourceID   string `json:"resource_id,omitempty"`
	Since        string `json:"since,omitempty"`
	Limit        int    `json:"limit,omitempty"`
}

// TranslationResult is what TranslateQueryToFilters returns.
type TranslationResult struct {
	Filters        StructuredFilters `json:"filters"`
	Reasoning      string            `json:"reasoning,omitempty"`
	InvalidFields  []string          `json:"invalid_fields,omitempty"`
	RawLLMResponse string            `json:"raw_llm_response,omitempty"`
	PromptTokens   int               `json:"prompt_tokens,omitempty"`
	ResponseTokens int               `json:"response_tokens,omitempty"`
	Model          string            `json:"model,omitempty"`
	CacheHit       bool              `json:"cache_hit,omitempty"`
}

// SummaryResult is what SummarizeAuditResults returns.
type SummaryResult struct {
	Summary        string `json:"summary"`
	PromptTokens   int    `json:"prompt_tokens,omitempty"`
	ResponseTokens int    `json:"response_tokens,omitempty"`
	Model          string `json:"model,omitempty"`
}

// AuditRowForSummary is the minimal projection of an audit row we
// send to the summariser. Tied to handlers.AuditRow but redefined
// locally so this package has no upward dependency.
type AuditRowForSummary struct {
	At           string `json:"at"`
	Action       string `json:"action"`
	ActorType    string `json:"actor_type"`
	ActorLabel   string `json:"actor_label,omitempty"`
	ResourceType string `json:"resource_type,omitempty"`
	ResourceID   string `json:"resource_id,omitempty"`
}

// LLMClient is the minimal contract for translation + summarisation.
// Matches safety.LLMClient shape so tests can fake it trivially.
type LLMClient interface {
	Complete(ctx context.Context, system, user string) (text string, promptTokens, responseTokens int, err error)
}

// ---------------- Anthropic client ----------------

const anthropicNLQMaxResponseBodyBytes int64 = 2 << 20 // 2 MiB

// AnthropicNLQClient is a tiny Messages-API client used by the NLQ
// pipeline. Mirrors safety.AnthropicClient but returns token usage so
// the daily cost tracker can charge accurately.
type AnthropicNLQClient struct {
	APIKey     string
	Model      string
	BaseURL    string
	HTTPClient *http.Client
}

// NewAnthropicNLQClient builds the Anthropic NLQ client. model
// defaults to claude-3-5-haiku-latest (cheapest current Claude); the
// caller can override via env.
func NewAnthropicNLQClient(apiKey, model, baseURL string) *AnthropicNLQClient {
	if strings.TrimSpace(model) == "" {
		model = "claude-3-5-haiku-latest"
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://api.anthropic.com"
	}
	return &AnthropicNLQClient{
		APIKey:     strings.TrimSpace(apiKey),
		Model:      strings.TrimSpace(model),
		BaseURL:    strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		HTTPClient: &http.Client{Timeout: 25 * time.Second},
	}
}

// Complete sends a system+user prompt and returns the response text
// + token usage. Errors surface verbatim so the caller can
// distinguish auth vs network vs schema failures.
func (c *AnthropicNLQClient) Complete(ctx context.Context, system, user string) (string, int, int, error) {
	if c == nil || c.APIKey == "" {
		return "", 0, 0, errors.New("anthropic NLQ client not configured")
	}
	body := map[string]any{
		"model":       c.Model,
		"max_tokens":  1024,
		"temperature": 0,
		"system":      system,
		"messages": []map[string]string{
			{"role": "user", "content": user},
		},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return "", 0, 0, err
	}
	endpoint, err := safeAnthropicURL(c.BaseURL, "/v1/messages")
	if err != nil {
		return "", 0, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return "", 0, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-api-key", c.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	res, err := c.http().Do(req)
	if err != nil {
		return "", 0, 0, err
	}
	defer func() { _ = res.Body.Close() }()
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
		Error *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	buf, err := io.ReadAll(io.LimitReader(res.Body, anthropicNLQMaxResponseBodyBytes+1))
	if err != nil {
		return "", 0, 0, err
	}
	if int64(len(buf)) > anthropicNLQMaxResponseBodyBytes {
		return "", 0, 0, errors.New("anthropic NLQ response body too large")
	}
	if err := json.Unmarshal(buf, &out); err != nil {
		return "", 0, 0, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if out.Error != nil {
			return "", 0, 0, fmt.Errorf("anthropic NLQ HTTP %d: %s: %s", res.StatusCode, out.Error.Type, out.Error.Message)
		}
		return "", 0, 0, fmt.Errorf("anthropic NLQ HTTP %d", res.StatusCode)
	}
	for _, block := range out.Content {
		if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
			return strings.TrimSpace(block.Text), out.Usage.InputTokens, out.Usage.OutputTokens, nil
		}
	}
	return "", out.Usage.InputTokens, out.Usage.OutputTokens, errors.New("anthropic NLQ returned no text")
}

func (c *AnthropicNLQClient) http() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 25 * time.Second}
}

// safeAnthropicURL is a local copy of the safety package's URL builder
// — we duplicate rather than import to avoid an upward dependency.
func safeAnthropicURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", errors.New("invalid anthropic base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", errors.New("unsupported anthropic base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", errors.New("unsafe anthropic base URL")
	}
	cleanPath := strings.TrimLeft(path, "/")
	for _, segment := range strings.Split(cleanPath, "/") {
		if segment == "." || segment == ".." || strings.Contains(segment, "\\") {
			return "", errors.New("unsafe anthropic request path")
		}
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/" + cleanPath
	return base.String(), nil
}

// ---------------- Prompts ----------------

// nlqPromptForQuery builds the system + user prompts for the
// translation call. We pin the schema, enumerate the allow-list, and
// instruct strict JSON output so the parser doesn't fight a markdown
// fence.
func nlqPromptForQuery(query string, retentionDays int) (system, user string) {
	rd := retentionDays
	if rd <= 0 {
		rd = 90
	}
	system = `You are a SQL filter translator for an audit log query system. Your job: convert the user's English question into a strict JSON filter object.

ALLOWED FIELDS (you MUST NOT emit any other field):
	actor_type      string  — exactly one of: human, agent, system, platform_operator, "" (empty = any)
  actor_label     string  — actor identifier or human name (substring match)
  action          string  — audit action substring (e.g. "subscriber.delete", "login", "export")
  resource_type   string  — exactly one of: subscriber, campaign, list, template, segment, api_key, role, "" (empty = any)
  resource_id     string  — resource identifier substring
  since           string  — RFC3339 timestamp (e.g. "2026-05-01T00:00:00Z"); omit for "all time"
  limit           number  — 1..500; default 50

RULES:
  1. Output STRICT JSON. No markdown, no fences, no prose before or after.
  2. Use the exact schema: {"filters": {…}, "reasoning": "…"}.
  3. Reasoning is one short sentence explaining your choices.
  4. If the user asks for something outside the schema (e.g. "all delete events with risk score > 5"), still emit the closest valid filter and note the limitation in reasoning.
  5. The audit log retention window is ` + fmt.Sprintf("%d", rd) + ` days — never set ` + "`since`" + ` to a date older than that.
  6. NEVER emit fields not in the allowed list. NEVER emit SQL fragments. NEVER emit shell commands.`

	user = "User query: " + strings.TrimSpace(query)
	return system, user
}

// nlqFilterSummaryPrompt builds the prompts for the summariser. We
// feed the rows as compact JSON; the LLM is asked for a 1-2 sentence
// human summary with concrete numbers.
func nlqFilterSummaryPrompt(query string, rows []AuditRowForSummary, totalCount int) (system, user string) {
	system = `You summarise audit log query results for an operator. Constraints:
  • 1-2 sentences, plain English, no markdown.
  • Cite a concrete number (count, time range, top actor) when the data supports it.
  • If results are empty: say so plainly ("No events match this query").
  • Never invent rows or numbers that aren't in the data.
  • Never speculate about intent — describe what happened, not why.`

	enc, _ := json.Marshal(rows)
	user = fmt.Sprintf(
		"Original question: %s\nTotal matching rows: %d\nSample (up to %d rows): %s",
		strings.TrimSpace(query), totalCount, len(rows), string(enc),
	)
	return system, user
}

// ---------------- Translation ----------------

// jsonFenceRE strips ```json … ``` fences when the LLM ignores our
// "no fences" instruction.
var jsonFenceRE = regexp.MustCompile("(?s)^```(?:json)?\\s*|\\s*```\\s*$")

// TranslateQueryToFilters runs the translation prompt, parses the
// JSON response, and validates the filters against the allow-list.
// retentionDays is the tenant's audit retention so the prompt can
// tell the LLM how far back to allow `since` to point.
func TranslateQueryToFilters(ctx context.Context, llm LLMClient, query string, retentionDays int) (*TranslationResult, error) {
	if llm == nil {
		return nil, errors.New("nlq: llm client not configured")
	}
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, errors.New("nlq: empty query")
	}
	system, user := nlqPromptForQuery(q, retentionDays)
	text, pin, pout, err := llm.Complete(ctx, system, user)
	if err != nil {
		return nil, fmt.Errorf("nlq translation: %w", err)
	}
	cleaned := strings.TrimSpace(jsonFenceRE.ReplaceAllString(strings.TrimSpace(text), ""))
	if cleaned == "" {
		cleaned = strings.TrimSpace(text)
	}
	var parsed struct {
		Filters   map[string]any `json:"filters"`
		Reasoning string         `json:"reasoning"`
	}
	if err := json.Unmarshal([]byte(cleaned), &parsed); err != nil {
		return &TranslationResult{
			RawLLMResponse: text,
			PromptTokens:   pin,
			ResponseTokens: pout,
		}, fmt.Errorf("nlq: malformed LLM JSON: %w", err)
	}

	allowed := map[string]struct{}{}
	for _, f := range AllowedFilterFields {
		allowed[f] = struct{}{}
	}
	invalid := []string{}
	invalidActorType := false
	out := StructuredFilters{}
	for k, v := range parsed.Filters {
		if _, ok := allowed[k]; !ok {
			invalid = append(invalid, k)
			continue
		}
		switch k {
		case "actor_type":
			actorType := strings.ToLower(strings.TrimSpace(asString(v)))
			if _, ok := allowedNLQActorTypes[actorType]; !ok {
				invalid = append(invalid, "actor_type")
				invalidActorType = true
				break
			}
			out.ActorType = actorType
		case "actor_label":
			out.ActorLabel = strings.TrimSpace(asString(v))
		case "action":
			out.Action = sanitiseFilterValue(asString(v))
		case "resource_type":
			out.ResourceType = strings.TrimSpace(asString(v))
		case "resource_id":
			out.ResourceID = sanitiseFilterValue(asString(v))
		case "since":
			s := strings.TrimSpace(asString(v))
			if s != "" {
				if _, perr := time.Parse(time.RFC3339, s); perr != nil {
					if _, perr := time.Parse(time.RFC3339Nano, s); perr != nil {
						invalid = append(invalid, "since")
						break
					}
				}
				out.Since = s
			}
		case "limit":
			if n := asInt(v); n > 0 {
				if n > 500 {
					n = 500
				}
				out.Limit = n
			}
		}
	}
	result := &TranslationResult{
		Filters:        out,
		Reasoning:      strings.TrimSpace(parsed.Reasoning),
		InvalidFields:  invalid,
		RawLLMResponse: text,
		PromptTokens:   pin,
		ResponseTokens: pout,
	}
	if invalidActorType {
		// An unknown enum must not degrade into an empty actor filter: that
		// would turn a narrowly worded question into an unfiltered audit read.
		// Reject the model translation before any database query is attempted.
		return result, errors.New("nlq: invalid actor_type translation")
	}
	return result, nil
}

// SummarizeAuditResults runs the summariser prompt on a bounded slice
// of rows. Bounded so we cap the input-token spend per query.
func SummarizeAuditResults(ctx context.Context, llm LLMClient, query string, rows []AuditRowForSummary, totalCount int) (*SummaryResult, error) {
	if llm == nil {
		return nil, errors.New("nlq: llm client not configured")
	}
	if len(rows) > SummaryMaxRows {
		rows = rows[:SummaryMaxRows]
	}
	system, user := nlqFilterSummaryPrompt(query, rows, totalCount)
	text, pin, pout, err := llm.Complete(ctx, system, user)
	if err != nil {
		return nil, fmt.Errorf("nlq summary: %w", err)
	}
	return &SummaryResult{
		Summary:        strings.TrimSpace(text),
		PromptTokens:   pin,
		ResponseTokens: pout,
	}, nil
}

// asString coerces any to string defensively.
func asString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return fmt.Sprintf("%g", t)
	case int:
		return fmt.Sprintf("%d", t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	case nil:
		return ""
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

// asInt coerces any to int defensively.
func asInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case string:
		var n int
		_, _ = fmt.Sscanf(t, "%d", &n)
		return n
	}
	return 0
}

// sanitiseFilterValue strips characters that don't belong in an ILIKE
// argument so a hallucinated SQL fragment ("'; DROP TABLE …") becomes
// inert text. We let % and _ through because the audit_log queries
// already wrap user input in `'%' || $n || '%'` and the wildcards
// are inert there.
func sanitiseFilterValue(s string) string {
	s = strings.TrimSpace(s)
	// Strip semicolons, single/double quotes, comment markers — defence
	// in depth even though pgx parameterises everything.
	r := strings.NewReplacer(
		";", "",
		"'", "",
		`"`, "",
		"--", "",
		"/*", "",
		"*/", "",
	)
	return r.Replace(s)
}

// ---------------- NLQCache ----------------

// NLQCacheKey is the dedupe key for translation results. tenant_id +
// lowercased query keeps two tenants' translations isolated.
type NLQCacheKey struct {
	TenantID string
	Query    string
}

// NewNLQCacheKey lower-cases + trims so trivial whitespace differences
// share a cache entry.
func NewNLQCacheKey(tenantID, query string) NLQCacheKey {
	return NLQCacheKey{
		TenantID: tenantID,
		Query:    strings.ToLower(strings.TrimSpace(query)),
	}
}

type nlqCacheEntry struct {
	value     *TranslationResult
	expiresAt time.Time
}

// NLQCache is a tiny TTL'd map keyed by (tenant, query). Not LRU; the
// translation set is small and the entries expire in an hour.
type NLQCache struct {
	mu  sync.Mutex
	ttl time.Duration
	m   map[NLQCacheKey]nlqCacheEntry
}

// NewNLQCache builds a cache with the given TTL.
func NewNLQCache(ttl time.Duration) *NLQCache {
	if ttl <= 0 {
		ttl = NLQCacheTTL
	}
	return &NLQCache{
		ttl: ttl,
		m:   map[NLQCacheKey]nlqCacheEntry{},
	}
}

// Get returns the cached entry if present and unexpired.
func (c *NLQCache) Get(k NLQCacheKey) *TranslationResult {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok {
		return nil
	}
	if time.Now().After(e.expiresAt) {
		delete(c.m, k)
		return nil
	}
	// Mark a copy so the caller doesn't see CacheHit=false on a hit.
	dup := *e.value
	dup.CacheHit = true
	return &dup
}

// Put stores the translation under the given key.
func (c *NLQCache) Put(k NLQCacheKey, v *TranslationResult) {
	if c == nil || v == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[k] = nlqCacheEntry{
		value:     v,
		expiresAt: time.Now().Add(c.ttl),
	}
}

// Size returns the current entry count. Exported for cost-status.
func (c *NLQCache) Size() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	// Drop expired entries opportunistically so Size is honest.
	now := time.Now()
	for k, e := range c.m {
		if now.After(e.expiresAt) {
			delete(c.m, k)
		}
	}
	return len(c.m)
}

// ---------------- DailyCostTracker ----------------

// DailyCostTracker tracks per-tenant token usage by UTC day. Reset
// happens implicitly: each tenant key is namespaced by date, so a
// fresh day starts at zero without any explicit clear.
type DailyCostTracker struct {
	mu  sync.Mutex
	cap int64
	m   map[string]int64 // key = tenantID|YYYY-MM-DD
}

// NewDailyCostTracker builds a tracker with the given daily cap. cap
// <= 0 means unlimited.
func NewDailyCostTracker(cap int64) *DailyCostTracker {
	return &DailyCostTracker{
		cap: cap,
		m:   map[string]int64{},
	}
}

func costKey(tenantID string, t time.Time) string {
	return tenantID + "|" + t.UTC().Format("2006-01-02")
}

// Add charges `tokens` against the tenant's daily budget and returns
// (used, remaining, exceeded). exceeded=true means the cap was
// breached by this call; the caller is expected to refund + 429.
func (t *DailyCostTracker) Add(tenantID string, tokens int) (used int64, remaining int64, exceeded bool) {
	if t == nil {
		return 0, 0, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	k := costKey(tenantID, time.Now())
	t.m[k] += int64(tokens)
	used = t.m[k]
	if t.cap <= 0 {
		return used, -1, false
	}
	remaining = t.cap - used
	if remaining < 0 {
		exceeded = true
		// Refund — don't double-charge if the caller retries after a 429.
		t.m[k] -= int64(tokens)
		used = t.m[k]
		remaining = t.cap - used
	}
	return used, remaining, exceeded
}

// Status returns (used, cap, remaining, resetAt) for the tenant.
func (t *DailyCostTracker) Status(tenantID string) (int64, int64, int64, time.Time) {
	if t == nil {
		return 0, 0, 0, time.Time{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	k := costKey(tenantID, time.Now())
	used := t.m[k]
	rem := t.cap - used
	if t.cap <= 0 {
		rem = -1
	}
	// Reset is UTC midnight tomorrow.
	now := time.Now().UTC()
	reset := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
	return used, t.cap, rem, reset
}

// TranslateLLMError converts an LLM transport error into a stable
// machine-readable code the HTTP layer can map to a 4xx/5xx.
func TranslateLLMError(err error) (code string, status int) {
	if err == nil {
		return "", 0
	}
	s := strings.ToLower(err.Error())
	switch {
	case strings.Contains(s, "not configured"):
		return "nlq_unavailable", http.StatusServiceUnavailable
	case strings.Contains(s, "malformed llm json"):
		return "nlq_bad_translation", http.StatusBadGateway
	case strings.Contains(s, "invalid actor_type translation"):
		return "nlq_bad_translation", http.StatusBadGateway
	case strings.Contains(s, "401") || strings.Contains(s, "unauthorized"):
		return "nlq_llm_auth", http.StatusServiceUnavailable
	case strings.Contains(s, "429"):
		return "nlq_llm_rate_limited", http.StatusTooManyRequests
	case strings.Contains(s, "context") && strings.Contains(s, "deadline"):
		return "nlq_timeout", http.StatusGatewayTimeout
	default:
		return "nlq_llm_error", http.StatusBadGateway
	}
}
