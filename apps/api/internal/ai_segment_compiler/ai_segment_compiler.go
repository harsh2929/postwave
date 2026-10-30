// Package ai_segment_compiler implements SUB-064 / SUB-027 — the LLM
// fallback for natural-language → SegmentAST translation.
//
// The Moosewave segments service has two compilers:
//
//  1. segments.CompileText (rules-based) — deterministic phrase
//     matching. Cheap, predictable, but only covers a small surface.
//     Returns 422 when it can't safely compile a description.
//
//  2. ai_segment_compiler.CompileFromNL (this package) — a structured
//     LLM call that emits a JSON AST matching the predicate registry.
//     Strict allow-list validation: every referenced predicate must
//     exist in the registry; every time-window value must parse via
//     the grammar described in the system prompt.
//
// The handler chooses which compiler to run based on the `engine`
// query-string: rules (default) or ai. The frontend retries with
// engine=ai when the rules-based compiler returns 422.
//
// SECURITY: this package never trusts the model output. The validator
// rejects:
//   - any predicate key not in the supplied registry
//   - any unknown boolean op
//   - any malformed time-window value (not parseable as iso8601,
//     "now-Nd", "last_N_days", or an integer literal)
//   - any AST node beyond a reasonable depth/size budget
//
// The returned NutritionFacts struct is the explainability payload the
// desktop renders below the prompt input: list of inferred predicates,
// list of inferred time windows, and the source attribution.
package ai_segment_compiler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Provider is the minimal LLM contract this package depends on. It
// mirrors the safety / audit-nlq surfaces so the existing Anthropic
// client (apps/api/internal/safety.AnthropicClient,
// apps/api/internal/audit.AnthropicNLQClient) can be adapted with a
// trivial shim — we keep the dependency boundary thin so tests don't
// need to spin up the real client.
type Provider interface {
	Complete(ctx context.Context, system, user string) (text string, err error)
}

// PredicateDef is the registry projection this compiler needs. Mirrors
// segments.PredicateDefinition but kept structural so this package
// doesn't import the segments package (would create a cycle once the
// segments handler imports us back).
type PredicateDef struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Category    string   `json:"category"`
	ValueType   string   `json:"value_type"`
	Comparators []string `json:"comparators"`
	Options     []string `json:"options,omitempty"`
}

// SegmentAST is the validated AST returned to the caller. It is
// json.RawMessage so the segments package can pass it through to the
// existing AST compiler (CompileAST) without us re-defining the canonical
// shape — segments owns the shape, we just promise it parses.
type SegmentAST struct {
	AST            json.RawMessage `json:"ast"`
	NutritionFacts NutritionFacts  `json:"nutrition_facts"`
}

// NutritionFacts is the explainability payload the UI renders next to
// the compiled chips. The desktop uses it for the small line
// "Predicates: opened, clicked. Time windows: last 7d. Source: ai-compiler".
type NutritionFacts struct {
	Predicates  []string `json:"predicates"`
	TimeWindows []string `json:"time_windows"`
	Source      string   `json:"source"`
	Model       string   `json:"model,omitempty"`
}

// ErrProviderUnavailable is the sentinel the handler maps to HTTP 503.
var ErrProviderUnavailable = errors.New("ai_segment_compiler: provider unavailable")

// ErrEmptyPrompt is returned when the operator submits an empty prompt.
var ErrEmptyPrompt = errors.New("ai_segment_compiler: prompt required")

const (
	maxNodeDepth        = 12
	maxNodeFanout       = 32
	maxTotalNodes       = 128
	maxRawASTBytes      = 64 << 10
	maxPromptCharacters = 4096
)

// CompileFromNL takes a natural-language description and emits a
// validated SegmentAST. The caller is responsible for supplying the
// per-tenant predicate registry (already resolved from
// segments.Repo.PredicateRegistry); we don't fetch it here because
// callers may want to filter / extend the catalog before we see it.
//
// tenantID is passed straight through to the provider for quota
// accounting and is otherwise unused by this package.
func CompileFromNL(ctx context.Context, provider Provider, tenantID, prompt string, registry []PredicateDef) (*SegmentAST, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return nil, ErrEmptyPrompt
	}
	if utf8.RuneCountInString(prompt) > maxPromptCharacters {
		return nil, fmt.Errorf("ai_segment_compiler: prompt exceeds %d characters", maxPromptCharacters)
	}
	if provider == nil {
		return nil, ErrProviderUnavailable
	}

	allowed := allowedKeySet(registry)
	system := BuildSystemPrompt(registry)
	user := buildUserPrompt(prompt)

	raw, err := provider.Complete(ctx, system, user)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrProviderUnavailable, err)
	}
	stripped := extractJSON(raw)
	if stripped == "" {
		return nil, fmt.Errorf("ai_segment_compiler: provider returned no JSON")
	}
	if len(stripped) > maxRawASTBytes {
		return nil, fmt.Errorf("ai_segment_compiler: provider response too large (%d bytes)", len(stripped))
	}

	var node astNode
	decoder := json.NewDecoder(strings.NewReader(stripped))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&node); err != nil {
		return nil, fmt.Errorf("ai_segment_compiler: decode AST: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("multiple JSON values")
		}
		return nil, fmt.Errorf("ai_segment_compiler: decode AST: %w", err)
	}
	preds := newAccumulator()
	windows := newAccumulator()
	nodeCount := 0
	if err := validateNode(node, allowed, preds, windows, 0, &nodeCount); err != nil {
		return nil, err
	}

	canonical, err := json.Marshal(node)
	if err != nil {
		return nil, fmt.Errorf("ai_segment_compiler: re-encode AST: %w", err)
	}
	_ = tenantID
	return &SegmentAST{
		AST: canonical,
		NutritionFacts: NutritionFacts{
			Predicates:  preds.sorted(),
			TimeWindows: windows.sorted(),
			Source:      "ai-compiler",
		},
	}, nil
}

// BuildSystemPrompt assembles the catalog-aware system prompt.
// Exposed for tests so we can assert the predicate inventory is
// faithfully rendered.
func BuildSystemPrompt(registry []PredicateDef) string {
	var b strings.Builder
	b.WriteString("You are an expert audience segment compiler.\n")
	b.WriteString("Your only job is to translate the operator's natural-language description into a strict JSON AST that the Moosewave segment engine can execute.\n\n")
	b.WriteString("OUTPUT RULES:\n")
	b.WriteString("  1. Emit ONE JSON object. No prose, no markdown fences, no commentary before or after.\n")
	b.WriteString("  2. Every leaf node has shape {\"op\":\"condition\",\"field\":\"<predicate.key>\",\"comparator\":\"<one-of-allowed>\",\"value\":<json scalar>}.\n")
	b.WriteString("  3. Boolean composition: {\"op\":\"and|or\",\"children\":[…]} or {\"op\":\"not\",\"child\":{…}}.\n")
	b.WriteString("  4. You MUST ONLY use predicate keys that appear in the catalog below. Any other field is a compile error.\n")
	b.WriteString("  5. Time windows accepted by `value` are: an ISO-8601 timestamp (e.g. 2026-01-01T00:00:00Z), a relative offset like `now-7d`, `now-30d`, `now+1d`, or an integer literal for numeric predicates.\n")
	b.WriteString("  6. If the operator asks for an audience you cannot safely encode from this catalog, return {\"op\":\"unsupported\"}. It will be rejected safely; never invent fields.\n\n")
	b.WriteString("BOOLEAN OPERATORS: and, or, not.\n\n")
	b.WriteString("PREDICATE CATALOG (key — type — comparators — allowed values when present):\n")
	for _, p := range registry {
		comparators := strings.Join(p.Comparators, ", ")
		if comparators == "" {
			comparators = "equals"
		}
		options := ""
		if len(p.Options) > 0 {
			options = " — values: " + strings.Join(p.Options, ", ")
		}
		fmt.Fprintf(&b, "  - %s — %s — %s%s\n", p.Key, p.ValueType, comparators, options)
	}
	b.WriteString("\nReturn only the JSON.")
	return b.String()
}

func buildUserPrompt(prompt string) string {
	return "Operator description:\n" + prompt + "\n\nReturn the JSON AST now."
}

// ---------------- internal AST + validation ----------------

// astNode mirrors segments.astNode but lives here because validating
// the structure is the whole point of this package — we do not want to
// import a private struct from segments and then promise to keep it
// in sync.
type astNode struct {
	Op         string          `json:"op"`
	Children   []astNode       `json:"children,omitempty"`
	Child      *astNode        `json:"child,omitempty"`
	Field      string          `json:"field,omitempty"`
	Comparator string          `json:"comparator,omitempty"`
	Value      json.RawMessage `json:"value,omitempty"`
}

func allowedKeySet(registry []PredicateDef) map[string]PredicateDef {
	out := make(map[string]PredicateDef, len(registry))
	for _, p := range registry {
		out[strings.ToLower(p.Key)] = p
	}
	return out
}

func validateNode(n astNode, registry map[string]PredicateDef, preds, windows *accumulator, depth int, nodeCount *int) error {
	if depth > maxNodeDepth {
		return fmt.Errorf("ai_segment_compiler: AST too deep (>%d)", maxNodeDepth)
	}
	(*nodeCount)++
	if *nodeCount > maxTotalNodes {
		return fmt.Errorf("ai_segment_compiler: AST has too many nodes (>%d)", maxTotalNodes)
	}
	switch strings.ToLower(n.Op) {
	case "and", "or":
		if n.Child != nil || n.Children == nil || len(n.Children) == 0 || n.Field != "" || n.Comparator != "" || n.Value != nil {
			return fmt.Errorf("ai_segment_compiler: %s must contain only one or more children", strings.ToUpper(n.Op))
		}
		if len(n.Children) > maxNodeFanout {
			return fmt.Errorf("ai_segment_compiler: too many children at op=%s", n.Op)
		}
		for _, ch := range n.Children {
			if err := validateNode(ch, registry, preds, windows, depth+1, nodeCount); err != nil {
				return err
			}
		}
		return nil
	case "not":
		if n.Field != "" || n.Comparator != "" || n.Value != nil {
			return errors.New("ai_segment_compiler: NOT cannot contain condition properties")
		}
		if n.Child != nil && n.Children != nil {
			return errors.New("ai_segment_compiler: NOT must use exactly one child representation")
		}
		if n.Child != nil {
			return validateNode(*n.Child, registry, preds, windows, depth+1, nodeCount)
		}
		if len(n.Children) == 1 {
			return validateNode(n.Children[0], registry, preds, windows, depth+1, nodeCount)
		}
		return errors.New("ai_segment_compiler: NOT node has no child")
	case "condition":
		if n.Child != nil || n.Children != nil {
			return errors.New("ai_segment_compiler: condition cannot contain child nodes")
		}
		key := strings.ToLower(strings.TrimSpace(n.Field))
		if key == "" {
			return errors.New("ai_segment_compiler: condition missing field")
		}
		def, ok := registry[key]
		if !ok {
			return fmt.Errorf("ai_segment_compiler: unknown predicate %q", n.Field)
		}
		if n.Comparator == "" {
			return fmt.Errorf("ai_segment_compiler: predicate %q missing comparator", n.Field)
		}
		if !comparatorAllowed(def.Comparators, n.Comparator) {
			return fmt.Errorf("ai_segment_compiler: comparator %q not allowed for predicate %q", n.Comparator, n.Field)
		}
		if err := validateOption(n.Value, def.Options, n.Field); err != nil {
			return err
		}
		if window, looksLikeWindow, err := validateValue(n.Value, def, n.Comparator); err != nil {
			return err
		} else if looksLikeWindow && window != "" {
			windows.add(window)
		}
		preds.add(def.Key)
		return nil
	default:
		return fmt.Errorf("ai_segment_compiler: unknown op %q", n.Op)
	}
}

func comparatorAllowed(allowed []string, got string) bool {
	g := strings.ToLower(strings.TrimSpace(got))
	for _, a := range allowed {
		if strings.EqualFold(a, g) {
			return true
		}
	}
	return false
}

func validateOption(raw json.RawMessage, options []string, field string) error {
	if len(options) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("ai_segment_compiler: predicate %q requires declared values", field)
	}
	values := []string{}
	switch typed := value.(type) {
	case string:
		values = append(values, typed)
	case []any:
		for _, item := range typed {
			stringValue, ok := item.(string)
			if !ok {
				return fmt.Errorf("ai_segment_compiler: predicate %q requires declared string values", field)
			}
			values = append(values, stringValue)
		}
	default:
		return fmt.Errorf("ai_segment_compiler: predicate %q requires declared string values", field)
	}
	for _, candidate := range values {
		allowed := false
		for _, option := range options {
			if candidate == option {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("ai_segment_compiler: value %q is not allowed for predicate %q", candidate, field)
		}
	}
	return nil
}

// validateValue checks the value against both the predicate's declared
// value type and comparator. This is deliberately stricter than merely
// checking that the JSON parses: accepting (for example) a string for a
// boolean predicate would make an AI draft look reviewable and then fail
// only when the production SQL compiler executes it.
// Returns (windowLabel, isWindow, err). windowLabel is the trimmed
// canonical form ("last 7d", "now-30d", etc.) collected into the
// NutritionFacts payload.
func validateValue(raw json.RawMessage, def PredicateDef, comparator string) (string, bool, error) {
	comparator = strings.ToLower(strings.TrimSpace(comparator))
	if comparatorTakesNoValue(comparator) {
		if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
			return "", false, nil
		}
		return "", false, fmt.Errorf("ai_segment_compiler: comparator %q for predicate %q must not include a value", comparator, def.Key)
	}
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return "", false, fmt.Errorf("ai_segment_compiler: predicate %q requires a value", def.Key)
	}

	v, err := decodeJSONValue(raw)
	if err != nil {
		return "", false, fmt.Errorf("ai_segment_compiler: malformed value for predicate %q: %w", def.Key, err)
	}

	if comparator == "in" || comparator == "not_in" {
		values, ok := v.([]any)
		if !ok || len(values) == 0 {
			return "", false, fmt.Errorf("ai_segment_compiler: comparator %q for predicate %q requires a non-empty array", comparator, def.Key)
		}
		for _, value := range values {
			if err := validateScalarType(value, def.ValueType, def.Key); err != nil {
				return "", false, err
			}
		}
		return "", false, nil
	}

	switch strings.ToLower(strings.TrimSpace(def.ValueType)) {
	case "tag":
		if comparator == "added_in_last_days" || comparator == "removed_in_last_days" {
			if err := validateTagLifecycleValue(v, def.Key); err != nil {
				return "", false, err
			}
			return "", false, nil
		}
		if err := validateScalarType(v, "string", def.Key); err != nil {
			return "", false, err
		}
	case "engagement_date":
		days, label, err := positiveDayWindow(v)
		if err != nil {
			return "", false, fmt.Errorf("ai_segment_compiler: predicate %q %w", def.Key, err)
		}
		if days > 36500 {
			return "", false, fmt.Errorf("ai_segment_compiler: predicate %q day window exceeds 36500", def.Key)
		}
		return label, true, nil
	case "metric_aggregate":
		if err := validateMetricValue(v, comparator, def.Key); err != nil {
			return "", false, err
		}
	case "date", "datetime":
		s, ok := v.(string)
		if !ok || strings.TrimSpace(s) == "" {
			return "", false, fmt.Errorf("ai_segment_compiler: predicate %q requires an ISO-8601 or relative date string", def.Key)
		}
		s = strings.TrimSpace(s)
		if !dateValueValid(s) {
			return "", false, fmt.Errorf("ai_segment_compiler: malformed time window %q", s)
		}
		return s, true, nil
	default:
		if err := validateScalarType(v, def.ValueType, def.Key); err != nil {
			return "", false, err
		}
	}
	return "", false, nil
}

func comparatorTakesNoValue(comparator string) bool {
	switch comparator {
	case "is_null", "is_not_null", "exists", "not_exists", "ever", "never":
		return true
	default:
		return false
	}
}

func decodeJSONValue(raw json.RawMessage) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("multiple JSON values")
		}
		return nil, err
	}
	return value, nil
}

func validateScalarType(value any, valueType, field string) error {
	switch strings.ToLower(strings.TrimSpace(valueType)) {
	case "number":
		if _, ok := value.(json.Number); !ok {
			return fmt.Errorf("ai_segment_compiler: predicate %q requires a numeric value", field)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("ai_segment_compiler: predicate %q requires a boolean value", field)
		}
	case "enum", "string", "custom_field", "segment":
		valueString, ok := value.(string)
		if !ok || strings.TrimSpace(valueString) == "" {
			return fmt.Errorf("ai_segment_compiler: predicate %q requires a non-empty string value", field)
		}
	default:
		return fmt.Errorf("ai_segment_compiler: predicate %q has unsupported value type %q", field, valueType)
	}
	return nil
}

func validateTagLifecycleValue(value any, field string) error {
	object, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("ai_segment_compiler: predicate %q requires {tag, days}", field)
	}
	if len(object) != 2 {
		return fmt.Errorf("ai_segment_compiler: predicate %q requires exactly {tag, days}", field)
	}
	tag, ok := object["tag"].(string)
	if !ok || strings.TrimSpace(tag) == "" {
		return fmt.Errorf("ai_segment_compiler: predicate %q requires a non-empty tag", field)
	}
	days, ok := positiveInteger(object["days"])
	if !ok || days > 36500 {
		return fmt.Errorf("ai_segment_compiler: predicate %q days must be an integer from 1 to 36500", field)
	}
	return nil
}

func validateMetricValue(value any, comparator, field string) error {
	if number, ok := value.(json.Number); ok {
		if comparator == "in_last_days" || comparator == "more_than_days_ago" {
			if days, valid := positiveInteger(number); !valid || days > 36500 {
				return fmt.Errorf("ai_segment_compiler: predicate %q day window must be an integer from 1 to 36500", field)
			}
		}
		return nil
	}
	object, ok := value.(map[string]any)
	if !ok || len(object) == 0 {
		return fmt.Errorf("ai_segment_compiler: predicate %q requires a number or metric aggregate object", field)
	}
	allowed := map[string]bool{"count": true, "value": true, "days": true, "event_name": true, "aggregation": true, "property": true}
	for key, item := range object {
		if !allowed[key] {
			return fmt.Errorf("ai_segment_compiler: predicate %q contains unknown metric property %q", field, key)
		}
		switch key {
		case "count", "value":
			if _, valid := item.(json.Number); !valid {
				return fmt.Errorf("ai_segment_compiler: predicate %q metric %s must be numeric", field, key)
			}
		case "days":
			if days, valid := positiveInteger(item); !valid || days > 36500 {
				return fmt.Errorf("ai_segment_compiler: predicate %q metric days must be an integer from 1 to 36500", field)
			}
		case "event_name", "property":
			if text, valid := item.(string); !valid || strings.TrimSpace(text) == "" {
				return fmt.Errorf("ai_segment_compiler: predicate %q metric %s must be a non-empty string", field, key)
			}
		case "aggregation":
			text, valid := item.(string)
			if !valid || !oneOf(strings.ToLower(strings.TrimSpace(text)), "count", "sum", "avg", "min", "max") {
				return fmt.Errorf("ai_segment_compiler: predicate %q has unsupported metric aggregation", field)
			}
		}
	}
	if comparator == "in_last_days" || comparator == "more_than_days_ago" {
		if _, hasDays := object["days"]; !hasDays {
			return fmt.Errorf("ai_segment_compiler: predicate %q window comparator requires metric days", field)
		}
	} else if _, hasValue := object["value"]; !hasValue {
		if _, hasCount := object["count"]; !hasCount {
			return fmt.Errorf("ai_segment_compiler: predicate %q numeric comparator requires metric value or count", field)
		}
	}
	return nil
}

func positiveDayWindow(value any) (int, string, error) {
	if days, ok := positiveInteger(value); ok {
		return days, strconv.Itoa(days) + " days", nil
	}
	text, ok := value.(string)
	if !ok {
		return 0, "", errors.New("requires a positive integer day window")
	}
	text = strings.ToLower(strings.TrimSpace(text))
	if !strings.HasPrefix(text, "now-") || !strings.HasSuffix(text, "d") {
		return 0, "", errors.New("requires a positive integer or now-Nd window")
	}
	days, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(text, "now-"), "d"))
	if err != nil || days <= 0 {
		return 0, "", errors.New("requires a positive integer or now-Nd window")
	}
	return days, text, nil
}

func positiveInteger(value any) (int, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	integer, err := strconv.Atoi(number.String())
	return integer, err == nil && integer > 0
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func dateValueValid(value string) bool {
	low := strings.ToLower(strings.TrimSpace(value))
	if relativeWindowRE.MatchString(low) {
		directionIndex := strings.IndexAny(low, "+-")
		if directionIndex < 0 || !strings.HasSuffix(low, "d") {
			return false
		}
		days, err := strconv.Atoi(strings.TrimSuffix(low[directionIndex+1:], "d"))
		return err == nil && days > 0 && days <= 36500
	}
	if _, err := time.Parse(time.RFC3339, value); err == nil {
		return true
	}
	_, err := time.Parse("2006-01-02", value)
	return err == nil
}

var relativeWindowRE = regexp.MustCompile(`^now[+-]\d+d$`)

// extractJSON pulls the first balanced JSON object from the raw
// model response. LLMs sometimes wrap output in ```json fences or
// add a sentence before the JSON; we strip those defensively. We do
// NOT use regex — we walk the string so we handle nested braces.
func extractJSON(raw string) string {
	s := strings.TrimSpace(raw)
	// Strip ```json … ``` fences if present.
	if strings.HasPrefix(s, "```") {
		// drop opening fence line
		if idx := strings.Index(s, "\n"); idx >= 0 {
			s = s[idx+1:]
		}
		if i := strings.LastIndex(s, "```"); i >= 0 {
			s = s[:i]
		}
		s = strings.TrimSpace(s)
	}
	// Find the first { and matching closing }.
	start := strings.Index(s, "{")
	if start < 0 {
		return ""
	}
	depth := 0
	inString := false
	escape := false
	for i := start; i < len(s); i++ {
		ch := s[i]
		if escape {
			escape = false
			continue
		}
		switch ch {
		case '\\':
			if inString {
				escape = true
			}
		case '"':
			inString = !inString
		case '{':
			if !inString {
				depth++
			}
		case '}':
			if !inString {
				depth--
				if depth == 0 {
					return s[start : i+1]
				}
			}
		}
	}
	return ""
}

// accumulator collects unique strings; sorts them on read for stable
// output.
type accumulator struct {
	seen map[string]struct{}
}

func newAccumulator() *accumulator { return &accumulator{seen: map[string]struct{}{}} }

func (a *accumulator) add(k string) {
	k = strings.TrimSpace(k)
	if k == "" {
		return
	}
	a.seen[k] = struct{}{}
}

func (a *accumulator) sorted() []string {
	out := make([]string, 0, len(a.seen))
	for k := range a.seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
