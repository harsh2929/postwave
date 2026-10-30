// SPDX-License-Identifier: AGPL-3.0-only
//
// segments.go — Klaviyo segment → Moosewave astNode.
//
// Input shape (simplified Klaviyo segment JSON):
//
//	{
//	  "name": "Engaged 30d",
//	  "definition": {
//	    "operator": "AND",
//	    "condition_groups": [
//	      {
//	        "operator": "OR",
//	        "conditions": [
//	          {
//	            "type": "profile",
//	            "field": "email",
//	            "comparator": "equals",
//	            "value": "alice@x.com"
//	          },
//	          {
//	            "type": "metric",
//	            "metric": "Opened Email",
//	            "comparator": "at_least_once",
//	            "timeframe": {"value": 30, "unit": "days"}
//	          }
//	        ]
//	      }
//	    ]
//	  }
//	}
//
// Output: a Moosewave astNode tree (see segments/compile.go) plus
// warnings for any unsupported node. Unsupported nodes are dropped
// from the output (NOT silently replaced) and surfaced in warnings.

package klaviyo_migrate

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Warning is the migration's structured non-fatal notice. Code is a
// short tag (e.g. "unsupported_comparator") and Path is a JSONPath-
// style hint at where in the source the issue is.
type Warning struct {
	Code    string `json:"code"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

// SegmentTranslation is the result of TranslateSegment. AST is the
// Moosewave astNode JSON ready to hand to segments.CompileAST.
type SegmentTranslation struct {
	Name     string          `json:"name"`
	AST      json.RawMessage `json:"ast"`
	Warnings []Warning       `json:"warnings"`
}

// TranslateSegment parses a Klaviyo segment payload and produces a
// Moosewave astNode JSON. It is a pure function — no IO.
func TranslateSegment(payload []byte) (*SegmentTranslation, error) {
	var ks klaviyoSegment
	if err := json.Unmarshal(payload, &ks); err != nil {
		return nil, fmt.Errorf("klaviyo_migrate: decode segment: %w", err)
	}
	t := &segmentTrans{}
	node, ok := t.translateDefinition(ks.Definition, "$.definition")
	if !ok {
		// Empty definition compiles to TRUE on the Moosewave side,
		// which means "all subscribers". Surface a warning so the
		// admin sees the discrepancy.
		t.warn("empty_definition", "$.definition", "no conditions translated; segment matches all subscribers")
		node = map[string]any{"op": "and", "children": []any{}}
	}
	raw, err := json.Marshal(node)
	if err != nil {
		return nil, fmt.Errorf("klaviyo_migrate: marshal ast: %w", err)
	}
	return &SegmentTranslation{Name: ks.Name, AST: raw, Warnings: t.warnings}, nil
}

// --- internal types ---

type klaviyoSegment struct {
	Name       string                   `json:"name"`
	Definition klaviyoSegmentDefinition `json:"definition"`
}

type klaviyoSegmentDefinition struct {
	Operator        string                  `json:"operator"`
	ConditionGroups []klaviyoConditionGroup `json:"condition_groups"`
	Conditions      []klaviyoCondition      `json:"conditions"`
}

type klaviyoConditionGroup struct {
	Operator   string             `json:"operator"`
	Conditions []klaviyoCondition `json:"conditions"`
}

type klaviyoCondition struct {
	Type       string            `json:"type"`
	Field      string            `json:"field"`
	Comparator string            `json:"comparator"`
	Metric     string            `json:"metric"`
	List       string            `json:"list"`
	Value      json.RawMessage   `json:"value"`
	Timeframe  *klaviyoTimeframe `json:"timeframe,omitempty"`
}

type klaviyoTimeframe struct {
	Value int    `json:"value"`
	Unit  string `json:"unit"` // days, hours, weeks
}

type segmentTrans struct {
	warnings []Warning
}

func (t *segmentTrans) warn(code, path, msg string) {
	t.warnings = append(t.warnings, Warning{Code: code, Path: path, Message: msg})
}

// translateDefinition produces an AND/OR node from the Klaviyo top-
// level definition. The Klaviyo shape lets you provide EITHER inline
// conditions OR condition_groups; we accept both.
func (t *segmentTrans) translateDefinition(d klaviyoSegmentDefinition, path string) (map[string]any, bool) {
	op := strings.ToLower(strings.TrimSpace(d.Operator))
	if op == "" {
		op = "and"
	}
	children := []any{}
	for i, g := range d.ConditionGroups {
		node, ok := t.translateGroup(g, fmt.Sprintf("%s.condition_groups[%d]", path, i))
		if ok {
			children = append(children, node)
		}
	}
	for i, c := range d.Conditions {
		node, ok := t.translateCondition(c, fmt.Sprintf("%s.conditions[%d]", path, i))
		if ok {
			children = append(children, node)
		}
	}
	if len(children) == 0 {
		return nil, false
	}
	return map[string]any{"op": op, "children": children}, true
}

func (t *segmentTrans) translateGroup(g klaviyoConditionGroup, path string) (map[string]any, bool) {
	op := strings.ToLower(strings.TrimSpace(g.Operator))
	if op == "" {
		op = "and"
	}
	children := []any{}
	for i, c := range g.Conditions {
		node, ok := t.translateCondition(c, fmt.Sprintf("%s.conditions[%d]", path, i))
		if ok {
			children = append(children, node)
		}
	}
	if len(children) == 0 {
		return nil, false
	}
	return map[string]any{"op": op, "children": children}, true
}

func (t *segmentTrans) translateCondition(c klaviyoCondition, path string) (map[string]any, bool) {
	switch strings.ToLower(c.Type) {
	case "profile", "property":
		return t.translateProfileCondition(c, path)
	case "list", "is_in_list", "joined_list":
		return t.translateListCondition(c, path)
	case "metric", "event":
		return t.translateMetricCondition(c, path)
	case "":
		t.warn("missing_type", path, "condition has no type; dropped")
		return nil, false
	default:
		t.warn("unsupported_type", path,
			fmt.Sprintf("condition type %q has no Moosewave equivalent yet; dropped", c.Type))
		return nil, false
	}
}

// translateProfileCondition handles "profile" / "property" predicates.
// Klaviyo's "field" maps to either a top-level subscriber column or
// a custom field. We rely on segments.compileField for that mapping,
// so all we have to do is emit a {op:condition,field,comparator,
// value} node and pick a comparator that the Moosewave compiler
// recognises.
func (t *segmentTrans) translateProfileCondition(c klaviyoCondition, path string) (map[string]any, bool) {
	field, ok := translateProfileField(c.Field)
	if !ok {
		t.warn("unsupported_field", path,
			fmt.Sprintf("profile field %q has no Moosewave equivalent", c.Field))
		return nil, false
	}
	cmp, supported := translateComparator(c.Comparator)
	if !supported {
		t.warn("unsupported_comparator", path,
			fmt.Sprintf("comparator %q on profile field %q unsupported", c.Comparator, c.Field))
		return nil, false
	}
	return map[string]any{
		"op":         "condition",
		"field":      field,
		"comparator": cmp,
		"value":      json.RawMessage(c.Value),
	}, true
}

func (t *segmentTrans) translateListCondition(c klaviyoCondition, path string) (map[string]any, bool) {
	if c.List == "" {
		t.warn("missing_list", path, "list condition has no list id")
		return nil, false
	}
	// Moosewave models list membership as a tag predicate. Klaviyo
	// list ids are passed through as-is; the importer is expected to
	// pre-create a tag named after each list.
	v, _ := json.Marshal(c.List)
	return map[string]any{
		"op":         "condition",
		"field":      "tags",
		"comparator": "equals",
		"value":      json.RawMessage(v),
	}, true
}

// translateMetricCondition handles event-based predicates. Klaviyo's
// "Opened Email" / "Clicked Email" / "Placed Order" metrics map to
// Moosewave's last_opened_at / last_clicked_at / last_event_at fields
// (see compileField in segments/compile.go). For "at_least_once
// in N days" we emit a "greater_than" predicate against the
// timestamp.
func (t *segmentTrans) translateMetricCondition(c klaviyoCondition, path string) (map[string]any, bool) {
	field, supported := translateMetricToField(c.Metric)
	if !supported {
		t.warn("unsupported_metric", path,
			fmt.Sprintf("metric %q has no Moosewave timestamp; dropped", c.Metric))
		return nil, false
	}
	switch strings.ToLower(c.Comparator) {
	case "at_least_once", "occurred", "happened":
		if c.Timeframe == nil {
			// "Ever" semantics: timestamp not null. Moosewave's
			// compiler has no "is_not_null" predicate, so we emit a
			// far-past lower bound — 2010-01-01 — which functionally
			// matches "ever happened" for any sane email program.
			val, _ := json.Marshal("2010-01-01T00:00:00Z")
			return map[string]any{
				"op":         "condition",
				"field":      field,
				"comparator": "greater_than",
				"value":      json.RawMessage(val),
			}, true
		}
		ts, ok := isoSinceTimeframe(*c.Timeframe)
		if !ok {
			t.warn("invalid_timeframe", path, "timeframe unit must be days|hours|weeks")
			return nil, false
		}
		val, _ := json.Marshal(ts)
		return map[string]any{
			"op":         "condition",
			"field":      field,
			"comparator": "greater_than",
			"value":      json.RawMessage(val),
		}, true
	case "did_not_happen", "did_not_occur", "never":
		// Wrap a "ever happened" predicate in a NOT.
		inner, ok := t.translateMetricCondition(klaviyoCondition{
			Metric: c.Metric, Comparator: "at_least_once", Timeframe: c.Timeframe,
		}, path)
		if !ok {
			return nil, false
		}
		return map[string]any{"op": "not", "child": inner}, true
	default:
		t.warn("unsupported_event_comparator", path,
			fmt.Sprintf("metric comparator %q unsupported; only at_least_once / did_not_happen are translated", c.Comparator))
		return nil, false
	}
}

// translateProfileField rewrites Klaviyo's profile-field name into the
// Moosewave compileField vocabulary. Returns false when there's no
// good mapping (the caller emits a warning).
func translateProfileField(klField string) (string, bool) {
	k := strings.ToLower(strings.TrimSpace(klField))
	switch k {
	case "email":
		return "email", true
	case "phone_number", "phone":
		// Moosewave stores phone in custom_fields.phone; compileField
		// understands the "custom.<k>" convention.
		return "custom.phone", true
	case "first_name":
		return "custom.first_name", true
	case "last_name":
		return "custom.last_name", true
	case "city":
		return "custom.city", true
	case "country", "country_code":
		return "custom.country", true
	case "zip", "postal_code":
		return "custom.zip", true
	case "consent", "email_consent":
		return "status", true
	case "":
		return "", false
	}
	// Anything that looks like a Klaviyo property reference goes
	// into custom.* — Klaviyo "Properties About Someone" maps 1:1
	// onto Moosewave custom_fields.
	if strings.HasPrefix(k, "properties.") {
		return "custom." + strings.TrimPrefix(k, "properties."), true
	}
	if strings.HasPrefix(k, "custom.") {
		return k, true
	}
	// Fallback: treat as custom field.
	return "custom." + k, true
}

// translateComparator maps Klaviyo comparator strings to Moosewave
// compiler comparators. Returns false for ones we can't represent.
func translateComparator(klCmp string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(klCmp)) {
	case "equals", "is", "=":
		return "equals", true
	case "not_equals", "is_not", "!=":
		return "not_equals", true
	case "contains":
		return "contains", true
	case "does_not_contain", "not_contains":
		return "not_contains", true
	case "starts_with":
		return "starts_with", true
	case "ends_with":
		return "ends_with", true
	case "greater_than", ">":
		return "greater_than", true
	case "less_than", "<":
		return "less_than", true
	case "is_set", "is_not_null":
		return "is_set", true
	case "is_not_set", "is_null":
		return "is_not_set", true
	case "":
		return "", false
	}
	return "", false
}

// translateMetricToField maps the common Klaviyo metric names onto a
// Moosewave timestamp column.
func translateMetricToField(metric string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(metric)) {
	case "opened email", "open":
		return "last_opened_at", true
	case "clicked email", "click":
		return "last_clicked_at", true
	case "received email", "received":
		return "last_event_at", true
	case "placed order", "order placed", "ordered":
		return "last_event_at", true
	case "active on site", "active on email":
		return "last_event_at", true
	case "":
		return "", false
	}
	return "", false
}
