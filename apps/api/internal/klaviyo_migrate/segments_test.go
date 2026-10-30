// SPDX-License-Identifier: AGPL-3.0-only
package klaviyo_migrate

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func TestTranslateSegment_ProfileEqualsEmail(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name": "Specific subscriber",
		"definition": map[string]any{
			"operator": "AND",
			"conditions": []any{
				map[string]any{
					"type": "profile", "field": "email",
					"comparator": "equals", "value": "alice@example.com",
				},
			},
		},
	})
	out, err := TranslateSegment(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if out.Name != "Specific subscriber" {
		t.Errorf("name = %q", out.Name)
	}
	if len(out.Warnings) != 0 {
		t.Errorf("unexpected warnings: %+v", out.Warnings)
	}
	var tree map[string]any
	if err := json.Unmarshal(out.AST, &tree); err != nil {
		t.Fatalf("unmarshal ast: %v", err)
	}
	if tree["op"] != "and" {
		t.Errorf("top op = %v", tree["op"])
	}
	children, _ := tree["children"].([]any)
	if len(children) != 1 {
		t.Fatalf("children = %d", len(children))
	}
	cond := children[0].(map[string]any)
	if cond["field"] != "email" || cond["comparator"] != "equals" {
		t.Errorf("cond = %+v", cond)
	}
}

func TestTranslateSegment_ListJoinedBecomesTagsEquals(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name": "newsletter members",
		"definition": map[string]any{
			"conditions": []any{
				map[string]any{"type": "list", "list": "newsletter"},
			},
		},
	})
	out, err := TranslateSegment(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	var tree map[string]any
	_ = json.Unmarshal(out.AST, &tree)
	cond := tree["children"].([]any)[0].(map[string]any)
	if cond["field"] != "tags" {
		t.Errorf("list translation should map to tags, got %v", cond["field"])
	}
}

func TestTranslateSegment_MetricAtLeastOnceProducesGreaterThanTimestamp(t *testing.T) {
	timeNow = func() time.Time { return time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC) }
	defer func() { timeNow = time.Now }()

	in := mustJSON(t, map[string]any{
		"definition": map[string]any{
			"conditions": []any{
				map[string]any{
					"type": "metric", "metric": "Opened Email",
					"comparator": "at_least_once",
					"timeframe":  map[string]any{"value": 30, "unit": "days"},
				},
			},
		},
	})
	out, err := TranslateSegment(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	var tree map[string]any
	_ = json.Unmarshal(out.AST, &tree)
	cond := tree["children"].([]any)[0].(map[string]any)
	if cond["field"] != "last_opened_at" || cond["comparator"] != "greater_than" {
		t.Errorf("metric mapping wrong: %+v", cond)
	}
	rawVal, _ := json.Marshal(cond["value"])
	if !strings.Contains(string(rawVal), "2026-05-02") {
		t.Errorf("expected 30-day cutoff at 2026-05-02, got value=%s", rawVal)
	}
}

func TestTranslateSegment_DidNotOccurWrapsInNot(t *testing.T) {
	timeNow = func() time.Time { return time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC) }
	defer func() { timeNow = time.Now }()

	in := mustJSON(t, map[string]any{
		"definition": map[string]any{
			"conditions": []any{
				map[string]any{
					"type": "metric", "metric": "Clicked Email",
					"comparator": "did_not_happen",
					"timeframe":  map[string]any{"value": 14, "unit": "days"},
				},
			},
		},
	})
	out, err := TranslateSegment(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	var tree map[string]any
	_ = json.Unmarshal(out.AST, &tree)
	cond := tree["children"].([]any)[0].(map[string]any)
	if cond["op"] != "not" {
		t.Errorf("did_not_happen should wrap in not, got %v", cond["op"])
	}
}

func TestTranslateSegment_UnsupportedCondition_DroppedWithWarning(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"definition": map[string]any{
			"conditions": []any{
				map[string]any{"type": "predictive_clv", "comparator": "greater_than"},
			},
		},
	})
	out, err := TranslateSegment(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if len(out.Warnings) == 0 {
		t.Errorf("expected warning, got none")
	}
}

func TestTranslateSegment_NestedGroupsORandANDPreserved(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"definition": map[string]any{
			"operator": "OR",
			"condition_groups": []any{
				map[string]any{
					"operator": "AND",
					"conditions": []any{
						map[string]any{"type": "profile", "field": "city", "comparator": "equals", "value": "NYC"},
						map[string]any{"type": "profile", "field": "country", "comparator": "equals", "value": "US"},
					},
				},
				map[string]any{
					"operator": "AND",
					"conditions": []any{
						map[string]any{"type": "profile", "field": "city", "comparator": "equals", "value": "SF"},
					},
				},
			},
		},
	})
	out, err := TranslateSegment(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	var tree map[string]any
	_ = json.Unmarshal(out.AST, &tree)
	if tree["op"] != "or" {
		t.Errorf("outer op = %v, want or", tree["op"])
	}
	children := tree["children"].([]any)
	if len(children) != 2 {
		t.Errorf("expected 2 groups, got %d", len(children))
	}
	first := children[0].(map[string]any)
	if first["op"] != "and" {
		t.Errorf("inner op = %v, want and", first["op"])
	}
}

func TestTranslateSegment_EmptyDefinitionWarns(t *testing.T) {
	in := mustJSON(t, map[string]any{"name": "all", "definition": map[string]any{}})
	out, err := TranslateSegment(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if len(out.Warnings) == 0 || out.Warnings[0].Code != "empty_definition" {
		t.Errorf("expected empty_definition warning, got %+v", out.Warnings)
	}
}

func TestTranslateSegment_PropertiesPrefixMapsToCustom(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"definition": map[string]any{
			"conditions": []any{
				map[string]any{
					"type": "profile", "field": "properties.loyalty_tier",
					"comparator": "equals", "value": "gold",
				},
			},
		},
	})
	out, _ := TranslateSegment(in)
	var tree map[string]any
	_ = json.Unmarshal(out.AST, &tree)
	cond := tree["children"].([]any)[0].(map[string]any)
	if cond["field"] != "custom.loyalty_tier" {
		t.Errorf("properties.* should map to custom.*, got %v", cond["field"])
	}
}

func TestTranslateSegment_UnsupportedComparatorDroppedWithWarning(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"definition": map[string]any{
			"conditions": []any{
				map[string]any{
					"type": "profile", "field": "email",
					"comparator": "within_radius", "value": "10mi",
				},
			},
		},
	})
	out, _ := TranslateSegment(in)
	if len(out.Warnings) == 0 || out.Warnings[0].Code != "unsupported_comparator" {
		t.Errorf("expected unsupported_comparator warning, got %+v", out.Warnings)
	}
}
