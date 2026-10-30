// SPDX-License-Identifier: AGPL-3.0-only
//
// Package llmactions implements the runtime for the `llm_action` step
// type — a flow-builder node that prompts an LLM per recipient,
// parses the output into a typed value (number / boolean /
// single_select / list / string), and persists the value into the
// journey_attributes table so subsequent multi-split branch nodes can
// branch on it.
//
// Replaces the legacy webhook-out + decisioning pattern: rather than
// shipping subscriber attributes out to an external scoring service
// and waiting for a webhook reply, the flow runtime inlines the LLM
// call. Each invocation is recorded in llm_action_invocations for
// inspector / replay tooling.
//
// Why this lives in apps/api rather than the voice service: the
// runtime needs cheap, tenant-scoped access to journey_attributes for
// the downstream branch evaluator (which lives in apps/api). The
// model call itself still delegates to aicompose.VoiceClient so the
// upstream LLM-provider abstraction stays in one place.
//
// Surface (per the audit sketch):
//
//	body: {
//	  prompt_template:        string  // {{first_name}} merge-field syntax
//	  model:                  string  // optional model hint, free-form
//	  output_type:            string  // number|boolean|single_select|list|string
//	  output_attribute_name:  string  // becomes journey_attributes.name
//	  retry_count:            int     // 0..3, defaults to 1
//	  allowed_values:         []string // single_select only
//	}
//
// Failure modes (in order of severity, all soft):
//
//   - missing VoiceClient   → status=model_failed, no attribute write
//   - model error           → retry up to RetryCount, then status=model_failed
//   - parse error           → status=parse_failed, no attribute write
//   - empty subscriber/tenant → status=skipped
package llmactions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotConfigured is surfaced when the executor is invoked without a
// VoiceClient wired. Callers can short-circuit + fall back to a no-op.
var ErrNotConfigured = errors.New("llmactions: voice client not configured")

// OutputType is one of the five typed-output variants the runner can
// parse. The string values match the JSON wire-format the desktop
// canvas and the flowbuilder catalog use.
type OutputType string

const (
	OutputNumber       OutputType = "number"
	OutputBoolean      OutputType = "boolean"
	OutputSingleSelect OutputType = "single_select"
	OutputList         OutputType = "list"
	OutputString       OutputType = "string"
)

// IsValidOutputType reports whether s is one of the five typed-output
// variants. Used by the validator + the persistence layer.
func IsValidOutputType(s string) bool {
	switch OutputType(strings.TrimSpace(strings.ToLower(s))) {
	case OutputNumber, OutputBoolean, OutputSingleSelect, OutputList, OutputString:
		return true
	}
	return false
}

// NormalizeOutputType lowercases + trims, defaulting to "string" when
// the input is empty so the catalogue's "optional" defaulting matches
// what the parser expects.
func NormalizeOutputType(s string) OutputType {
	t := OutputType(strings.TrimSpace(strings.ToLower(s)))
	if !IsValidOutputType(string(t)) {
		return OutputString
	}
	return t
}

// MaxRetryCount caps RetryCount so a misconfigured flow can't burn a
// tenant's AI quota in a tight loop. Three retries × N subscribers is
// already past the point where the human operator should fix the
// prompt, not the runtime.
const MaxRetryCount = 3

// MaxPromptTemplateBytes caps the rendered-prompt size so a runaway
// merge-field expansion can't OOM the runner.
const MaxPromptTemplateBytes = 8192

// Config is the LLM-action step's parsed configuration. Lives on the
// flow-graph node under `llm_action: {...}`; the runner unmarshals it
// with FromMap before each invocation so the on-disk shape can grow
// fields without breaking older runners.
type Config struct {
	PromptTemplate      string     `json:"prompt_template"`
	Model               string     `json:"model,omitempty"`
	OutputType          OutputType `json:"output_type"`
	OutputAttributeName string     `json:"output_attribute_name"`
	RetryCount          int        `json:"retry_count,omitempty"`
	AllowedValues       []string   `json:"allowed_values,omitempty"`
}

// Validate checks a Config for the required fields. Returns nil if the
// step is well-formed enough to execute. The flow-builder validator
// calls this when a node of type llm_action is encountered.
func (c *Config) Validate() error {
	if c == nil {
		return errors.New("llm_action: config is required")
	}
	if strings.TrimSpace(c.PromptTemplate) == "" {
		return errors.New("llm_action: prompt_template is required")
	}
	if len(c.PromptTemplate) > MaxPromptTemplateBytes {
		return fmt.Errorf("llm_action: prompt_template exceeds %d bytes", MaxPromptTemplateBytes)
	}
	if !IsValidOutputType(string(c.OutputType)) {
		return fmt.Errorf("llm_action: output_type %q is not one of number|boolean|single_select|list|string", c.OutputType)
	}
	name := strings.TrimSpace(c.OutputAttributeName)
	if name == "" {
		return errors.New("llm_action: output_attribute_name is required")
	}
	if !attrNameRe.MatchString(name) {
		return errors.New("llm_action: output_attribute_name must match [a-zA-Z_][a-zA-Z0-9_]{0,63}")
	}
	if c.RetryCount < 0 || c.RetryCount > MaxRetryCount {
		return fmt.Errorf("llm_action: retry_count must be 0..%d", MaxRetryCount)
	}
	if NormalizeOutputType(string(c.OutputType)) == OutputSingleSelect && len(c.AllowedValues) == 0 {
		return errors.New("llm_action: allowed_values is required when output_type is single_select")
	}
	return nil
}

// attrNameRe enforces the journey_attributes.name shape — postgres
// identifier-ish so branch nodes can reference it without quoting.
var attrNameRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`)

// FromMap parses a flow-graph node's `llm_action` payload into a typed
// Config. Forgiving on input shape — accepts the canonical keys plus
// camelCase variants the desktop occasionally emits.
func FromMap(m map[string]any) (*Config, error) {
	if m == nil {
		return nil, errors.New("llm_action: config map is nil")
	}
	out := &Config{}
	if v, ok := stringIn(m, "prompt_template", "promptTemplate", "prompt"); ok {
		out.PromptTemplate = v
	}
	if v, ok := stringIn(m, "model"); ok {
		out.Model = v
	}
	if v, ok := stringIn(m, "output_type", "outputType"); ok {
		out.OutputType = NormalizeOutputType(v)
	}
	if v, ok := stringIn(m, "output_attribute_name", "outputAttributeName", "attribute"); ok {
		out.OutputAttributeName = strings.TrimSpace(v)
	}
	if v, ok := intIn(m, "retry_count", "retryCount"); ok {
		out.RetryCount = v
	}
	if vals, ok := stringSliceIn(m, "allowed_values", "allowedValues", "options"); ok {
		out.AllowedValues = vals
	}
	return out, nil
}

// RenderResult is the parsed-output bundle a single invocation produces.
type RenderResult struct {
	Status         string     `json:"status"` // "ok" | "parse_failed" | "model_failed" | "skipped"
	OutputType     OutputType `json:"output_type"`
	Value          any        `json:"value,omitempty"`
	RawResponse    string     `json:"raw_response,omitempty"`
	RenderedPrompt string     `json:"rendered_prompt,omitempty"`
	Model          string     `json:"model,omitempty"`
	RetryCount     int        `json:"retry_count"`
	LatencyMs      int        `json:"latency_ms"`
	Error          string     `json:"error,omitempty"`
}

// ExecuteInput is the per-recipient invocation envelope. The runtime
// (flow worker / inspector dry-run) constructs one of these per
// subscriber, hands it to Execute, and forwards the typed value into
// the next branch node.
type ExecuteInput struct {
	TenantID     string
	RunID        string
	FlowID       string
	NodeID       string
	SubscriberID string
	// MergeFields is the per-recipient merge-field map (e.g. first_name,
	// last_seen_at). Render() expands `{{key}}` placeholders against it.
	MergeFields map[string]string
}

// Executor binds a Config-driven LLM action invocation to a VoiceClient
// + a pgx pool. Stateless across calls; safe to share.
type Executor struct {
	Voice aicompose.VoiceClient
	Pool  *db.Pool
	// Now is a clock injection for tests. nil → time.Now().
	Now func() time.Time
}

// Execute renders the prompt, calls the model with up to RetryCount
// retries, parses the typed output, writes the attribute to
// journey_attributes, and appends an llm_action_invocations row.
//
// Returns a RenderResult that always has a Status field — callers
// inspect Status to decide whether to advance the flow.
func (e *Executor) Execute(ctx context.Context, cfg *Config, in ExecuteInput) (RenderResult, error) {
	out := RenderResult{
		OutputType: NormalizeOutputType(string(cfg.OutputType)),
		Model:      strings.TrimSpace(cfg.Model),
	}
	if err := cfg.Validate(); err != nil {
		out.Status = "skipped"
		out.Error = err.Error()
		return out, err
	}
	if strings.TrimSpace(in.TenantID) == "" || strings.TrimSpace(in.SubscriberID) == "" {
		out.Status = "skipped"
		out.Error = "tenant_id and subscriber_id required"
		return out, nil
	}
	rendered, err := Render(cfg.PromptTemplate, in.MergeFields)
	if err != nil {
		out.Status = "skipped"
		out.Error = err.Error()
		_ = e.recordInvocation(ctx, cfg, in, out)
		return out, nil
	}
	out.RenderedPrompt = rendered

	if e.Voice == nil {
		out.Status = "model_failed"
		out.Error = ErrNotConfigured.Error()
		_ = e.recordInvocation(ctx, cfg, in, out)
		return out, ErrNotConfigured
	}

	start := e.now()
	maxTries := cfg.RetryCount + 1
	if maxTries < 1 {
		maxTries = 1
	}
	var lastErr error
	for attempt := 0; attempt < maxTries; attempt++ {
		out.RetryCount = attempt
		gen, gerr := e.Voice.Generate(ctx, in.TenantID, aicompose.KindFreeForm, rendered, "")
		if gerr != nil {
			lastErr = gerr
			continue
		}
		out.RawResponse = gen.Text
		parsed, perr := ParseOutput(out.OutputType, gen.Text, cfg.AllowedValues)
		if perr != nil {
			lastErr = perr
			// Parse failure is "real" once we've used all retries, but
			// retrying a parse miss with the same prompt won't help —
			// short-circuit to status=parse_failed.
			out.Status = "parse_failed"
			out.Error = perr.Error()
			out.LatencyMs = int(e.now().Sub(start) / time.Millisecond)
			_ = e.recordInvocation(ctx, cfg, in, out)
			return out, nil
		}
		out.Value = parsed
		out.Status = "ok"
		out.Error = ""
		out.LatencyMs = int(e.now().Sub(start) / time.Millisecond)
		if werr := e.writeAttribute(ctx, cfg, in, parsed); werr != nil {
			// Persistence failure: surface as model_failed so the
			// inspector flags the run; the downstream branch evaluator
			// won't see the attribute and the flow's fallback path
			// kicks in (typically NoBranch / default).
			out.Status = "model_failed"
			out.Error = "attribute_write: " + werr.Error()
		}
		_ = e.recordInvocation(ctx, cfg, in, out)
		return out, nil
	}
	out.Status = "model_failed"
	if lastErr != nil {
		out.Error = lastErr.Error()
	} else {
		out.Error = "model returned no output after retries"
	}
	out.LatencyMs = int(e.now().Sub(start) / time.Millisecond)
	_ = e.recordInvocation(ctx, cfg, in, out)
	return out, nil
}

// Render expands `{{key}}` placeholders against fields. Unknown keys
// are left as the empty string (matches Customer.io behavior — they
// don't error on unmatched merge fields, they swallow them).
//
// The renderer is deliberately tiny — no conditionals, no nesting —
// because the prompt template is a model input, not a logic engine.
// If a tenant wants logic they should put it in the prompt itself.
func Render(template string, fields map[string]string) (string, error) {
	if len(template) > MaxPromptTemplateBytes {
		return "", fmt.Errorf("llm_action: prompt_template exceeds %d bytes", MaxPromptTemplateBytes)
	}
	// {{ key }} or {{key}} — single regex pass.
	out := mergeFieldRe.ReplaceAllStringFunc(template, func(m string) string {
		match := mergeFieldRe.FindStringSubmatch(m)
		if len(match) < 2 {
			return m
		}
		key := strings.TrimSpace(match[1])
		if v, ok := fields[key]; ok {
			return v
		}
		return ""
	})
	if len(out) > MaxPromptTemplateBytes {
		out = out[:MaxPromptTemplateBytes]
	}
	return out, nil
}

var mergeFieldRe = regexp.MustCompile(`\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}`)

// ParseOutput coerces the model's raw text into the requested typed
// value. Each branch is documented inline.
func ParseOutput(t OutputType, raw string, allowed []string) (any, error) {
	text := strings.TrimSpace(raw)
	switch NormalizeOutputType(string(t)) {
	case OutputNumber:
		// Strip $ ,% etc — model often emits a numeric token wrapped
		// in punctuation. Take the first float64-parseable substring.
		num, ok := firstFloat(text)
		if !ok {
			return nil, fmt.Errorf("output is not a number: %q", trimForError(text))
		}
		return num, nil
	case OutputBoolean:
		switch strings.ToLower(strings.Trim(text, " \t\n.!\"'")) {
		case "true", "yes", "y", "1":
			return true, nil
		case "false", "no", "n", "0":
			return false, nil
		}
		return nil, fmt.Errorf("output is not a boolean: %q", trimForError(text))
	case OutputSingleSelect:
		want := strings.ToLower(text)
		for _, opt := range allowed {
			if strings.ToLower(strings.TrimSpace(opt)) == want {
				return opt, nil
			}
		}
		// Fall back to substring match on the longest first — guards
		// against the LLM wrapping the answer ("My choice: high").
		var best string
		for _, opt := range allowed {
			o := strings.TrimSpace(opt)
			if o == "" {
				continue
			}
			if strings.Contains(want, strings.ToLower(o)) && len(o) > len(best) {
				best = o
			}
		}
		if best != "" {
			return best, nil
		}
		return nil, fmt.Errorf("output %q not in allowed values %v", trimForError(text), allowed)
	case OutputList:
		// Try JSON array first; otherwise split on commas / newlines.
		if strings.HasPrefix(text, "[") {
			var arr []string
			if err := json.Unmarshal([]byte(text), &arr); err == nil {
				out := make([]string, 0, len(arr))
				for _, v := range arr {
					v = strings.TrimSpace(v)
					if v != "" {
						out = append(out, v)
					}
				}
				return out, nil
			}
		}
		var parts []string
		for _, raw := range strings.FieldsFunc(text, func(r rune) bool {
			return r == ',' || r == '\n' || r == ';'
		}) {
			v := strings.TrimSpace(raw)
			v = strings.Trim(v, "-•*\"' \t")
			if v != "" {
				parts = append(parts, v)
			}
		}
		if len(parts) == 0 {
			return nil, fmt.Errorf("output is not a list: %q", trimForError(text))
		}
		return parts, nil
	case OutputString:
		return text, nil
	}
	return nil, fmt.Errorf("unknown output_type")
}

// writeAttribute upserts the (tenant, run, subscriber, name) row in
// journey_attributes. Uses ON CONFLICT so a re-run replaces the prior
// value rather than collecting historical copies — the audit trail
// lives in llm_action_invocations.
func (e *Executor) writeAttribute(ctx context.Context, cfg *Config, in ExecuteInput, value any) error {
	if e.Pool == nil {
		// Pool-less mode is supported for tests / dry-runs; the caller
		// gets the parsed value via the RenderResult and is responsible
		// for handing it to the next branch in-memory.
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, e.Pool, in.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	flowID := strings.TrimSpace(in.FlowID)
	runID := strings.TrimSpace(in.RunID)
	if runID == "" || flowID == "" {
		// Without a run_id we can't key the upsert; this is a dry-run
		// path and we just no-op the write (RenderResult.Value still
		// carries the parsed value).
		return nil
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO journey_attributes
    (tenant_id, run_id, flow_id, subscriber_id, name, output_type, value, source_node_id, updated_at)
VALUES
    ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8, now())
ON CONFLICT (tenant_id, run_id, subscriber_id, name) DO UPDATE
   SET output_type    = EXCLUDED.output_type,
       value          = EXCLUDED.value,
       source_node_id = EXCLUDED.source_node_id,
       updated_at     = now()`,
		in.TenantID, runID, flowID, in.SubscriberID,
		strings.TrimSpace(cfg.OutputAttributeName),
		string(NormalizeOutputType(string(cfg.OutputType))),
		string(raw), strings.TrimSpace(in.NodeID)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// recordInvocation appends one llm_action_invocations row. Best-effort
// — failure here never fails the underlying step.
func (e *Executor) recordInvocation(ctx context.Context, cfg *Config, in ExecuteInput, out RenderResult) error {
	if e.Pool == nil || strings.TrimSpace(in.TenantID) == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, e.Pool, in.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var parsedRaw any
	if out.Value != nil {
		raw, err := json.Marshal(out.Value)
		if err == nil {
			parsedRaw = string(raw)
		}
	}
	var runID, flowID, subscriberID any
	if v := strings.TrimSpace(in.RunID); v != "" {
		runID = v
	}
	if v := strings.TrimSpace(in.FlowID); v != "" {
		flowID = v
	}
	if v := strings.TrimSpace(in.SubscriberID); v != "" {
		subscriberID = v
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO llm_action_invocations
    (tenant_id, run_id, flow_id, node_id, subscriber_id,
     model, output_type, output_attribute, rendered_prompt, raw_response,
     parsed_value, retry_count, latency_ms, status, error)
VALUES
    ($1::uuid, $2, $3, $4, $5,
     $6, $7, $8, $9, $10,
     $11, $12, $13, $14, NULLIF($15, ''))`,
		in.TenantID, runID, flowID, strings.TrimSpace(in.NodeID), subscriberID,
		strings.TrimSpace(cfg.Model),
		string(NormalizeOutputType(string(cfg.OutputType))),
		strings.TrimSpace(cfg.OutputAttributeName),
		out.RenderedPrompt, out.RawResponse,
		parsedRaw, out.RetryCount, out.LatencyMs, out.Status, out.Error); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (e *Executor) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now().UTC()
}

// --- tiny helpers ----------------------------------------------------

func stringIn(m map[string]any, keys ...string) (string, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok {
				return s, true
			}
		}
	}
	return "", false
}

func intIn(m map[string]any, keys ...string) (int, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch x := v.(type) {
			case int:
				return x, true
			case int64:
				return int(x), true
			case float64:
				return int(x), true
			case string:
				if n, err := strconv.Atoi(strings.TrimSpace(x)); err == nil {
					return n, true
				}
			}
		}
	}
	return 0, false
}

func stringSliceIn(m map[string]any, keys ...string) ([]string, bool) {
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			continue
		}
		switch x := v.(type) {
		case []string:
			return x, true
		case []any:
			out := make([]string, 0, len(x))
			for _, item := range x {
				if s, ok := item.(string); ok {
					out = append(out, s)
				}
			}
			return out, true
		}
	}
	return nil, false
}

// firstFloat finds the first numeric token in s and parses it as
// float64. Tolerates currency / percent / comma noise.
func firstFloat(s string) (float64, bool) {
	match := numberRe.FindString(s)
	if match == "" {
		return 0, false
	}
	clean := strings.ReplaceAll(match, ",", "")
	n, err := strconv.ParseFloat(clean, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

var numberRe = regexp.MustCompile(`-?\d[\d,]*(\.\d+)?`)

// trimForError truncates s to a sensible length so the error payload
// surfaced to operators isn't multi-KB. 80 chars is the sweet spot
// between "useful diagnostic" and "spam in the inspector".
func trimForError(s string) string {
	if len(s) <= 80 {
		return s
	}
	return s[:80] + "…"
}
