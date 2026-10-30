// SPDX-License-Identifier: AGPL-3.0-only
package klaviyo_migrate

import (
	"encoding/json"
	"testing"
)

func TestTranslateFlow_MetricTriggerAndWaitThenSend(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name":    "Welcome series",
		"trigger": map[string]any{"type": "metric", "metric": "Subscribed to List"},
		"actions": []any{
			map[string]any{"type": "wait", "wait": map[string]any{"value": 1, "unit": "days"}},
			map[string]any{"type": "send_email", "template": "welcome"},
		},
	})
	out, err := TranslateFlow(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if out.Flow.Trigger.Type != "event" || out.Flow.Trigger.EventKey != "Subscribed to List" {
		t.Errorf("trigger = %+v", out.Flow.Trigger)
	}
	if len(out.Flow.Steps) != 2 {
		t.Fatalf("steps = %d", len(out.Flow.Steps))
	}
	if out.Flow.Steps[0].Type != "wait" || out.Flow.Steps[0].WaitMillis != 24*60*60*1000 {
		t.Errorf("wait step wrong: %+v", out.Flow.Steps[0])
	}
	if out.Flow.Steps[1].Type != "send_email" || out.Flow.Steps[1].Template != "welcome" {
		t.Errorf("send step wrong: %+v", out.Flow.Steps[1])
	}
	if out.Flow.Steps[1].ParentID != out.Flow.Steps[0].ID {
		t.Errorf("send should link to wait via parent_id")
	}
}

func TestTranslateFlow_ListTriggerSetsListKey(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name":    "List welcome",
		"trigger": map[string]any{"type": "list", "list": "newsletter"},
		"actions": []any{},
	})
	out, _ := TranslateFlow(in)
	if out.Flow.Trigger.Type != "list" || out.Flow.Trigger.ListKey != "newsletter" {
		t.Errorf("trigger = %+v", out.Flow.Trigger)
	}
}

func TestTranslateFlow_BranchProducesConditionAndThenElseSteps(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name":    "branched",
		"trigger": map[string]any{"type": "metric", "metric": "Subscribed"},
		"actions": []any{
			map[string]any{
				"type": "branch",
				"if": map[string]any{
					"type": "profile", "field": "country",
					"comparator": "equals", "value": "US",
				},
				"then": []any{
					map[string]any{"type": "send_email", "template": "us_welcome"},
				},
				"else": []any{
					map[string]any{"type": "send_email", "template": "intl_welcome"},
				},
			},
		},
	})
	out, err := TranslateFlow(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	// branch + 2 send steps = 3
	if len(out.Flow.Steps) != 3 {
		t.Fatalf("steps = %d, want 3, got %+v", len(out.Flow.Steps), out.Flow.Steps)
	}
	branch := out.Flow.Steps[0]
	if branch.Type != "condition" {
		t.Errorf("first step should be condition, got %s", branch.Type)
	}
	if branch.Condition == nil {
		t.Errorf("condition payload missing")
	}
	thenStep, elseStep := out.Flow.Steps[1], out.Flow.Steps[2]
	if thenStep.Branch != "then" || elseStep.Branch != "else" {
		t.Errorf("branch tags wrong: then=%q else=%q", thenStep.Branch, elseStep.Branch)
	}
	if thenStep.ParentID != branch.ID || elseStep.ParentID != branch.ID {
		t.Errorf("branch parent_ids wrong: then=%q else=%q want %q", thenStep.ParentID, elseStep.ParentID, branch.ID)
	}
}

func TestTranslateFlow_UnsupportedActionWarns(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name":    "x",
		"trigger": map[string]any{"type": "metric", "metric": "X"},
		"actions": []any{
			map[string]any{"type": "send_push_notification", "template": "p"},
		},
	})
	out, err := TranslateFlow(in)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if len(out.Warnings) == 0 || out.Warnings[0].Code != "unsupported_action" {
		t.Errorf("expected unsupported_action, got %+v", out.Warnings)
	}
}

func TestTranslateFlow_MissingTriggerFallsBackToManual(t *testing.T) {
	in := mustJSON(t, map[string]any{"name": "x"})
	out, _ := TranslateFlow(in)
	if out.Flow.Trigger.Type != "manual" {
		t.Errorf("trigger fallback = %v", out.Flow.Trigger.Type)
	}
}

func TestTranslateFlow_ExitShortCircuitsSiblingActions(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name":    "x",
		"trigger": map[string]any{"type": "metric", "metric": "X"},
		"actions": []any{
			map[string]any{"type": "exit"},
			map[string]any{"type": "send_email", "template": "never"},
		},
	})
	out, _ := TranslateFlow(in)
	if len(out.Flow.Steps) != 1 || out.Flow.Steps[0].Type != "exit" {
		t.Errorf("exit should short-circuit, got %+v", out.Flow.Steps)
	}
}

func TestTranslateFlow_TagActions(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name":    "x",
		"trigger": map[string]any{"type": "metric", "metric": "X"},
		"actions": []any{
			map[string]any{"type": "add_tag", "tag": "vip"},
			map[string]any{"type": "remove_tag", "tag": "trial"},
		},
	})
	out, _ := TranslateFlow(in)
	if len(out.Flow.Steps) != 2 {
		t.Fatalf("steps = %d", len(out.Flow.Steps))
	}
	if out.Flow.Steps[0].Type != "add_tag" || out.Flow.Steps[0].Tag != "vip" {
		t.Errorf("add_tag wrong: %+v", out.Flow.Steps[0])
	}
	if out.Flow.Steps[1].Type != "remove_tag" || out.Flow.Steps[1].Tag != "trial" {
		t.Errorf("remove_tag wrong: %+v", out.Flow.Steps[1])
	}
}

func TestTranslateFlow_NestedBranchHasCorrectParents(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name":    "nested",
		"trigger": map[string]any{"type": "metric", "metric": "Subscribed"},
		"actions": []any{
			map[string]any{
				"type": "branch",
				"if":   map[string]any{"type": "profile", "field": "country", "comparator": "equals", "value": "US"},
				"then": []any{
					map[string]any{
						"type": "branch",
						"if":   map[string]any{"type": "profile", "field": "city", "comparator": "equals", "value": "NYC"},
						"then": []any{map[string]any{"type": "send_email", "template": "nyc"}},
					},
				},
			},
		},
	})
	out, _ := TranslateFlow(in)
	// outer branch + inner branch + send_email = 3 steps
	if len(out.Flow.Steps) != 3 {
		t.Fatalf("steps = %d, want 3, dump=%+v", len(out.Flow.Steps), out.Flow.Steps)
	}
	outer := out.Flow.Steps[0]
	inner := out.Flow.Steps[1]
	send := out.Flow.Steps[2]
	if inner.ParentID != outer.ID || inner.Branch != "then" {
		t.Errorf("inner branch wrong: %+v", inner)
	}
	if send.ParentID != inner.ID || send.Branch != "then" {
		t.Errorf("send wrong: %+v", send)
	}
}

func TestTranslateFlow_JSONStable(t *testing.T) {
	in := mustJSON(t, map[string]any{
		"name":    "x",
		"trigger": map[string]any{"type": "metric", "metric": "X"},
		"actions": []any{map[string]any{"type": "send_email", "template": "t"}},
	})
	a, _ := TranslateFlow(in)
	b, _ := TranslateFlow(in)
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Errorf("translation not deterministic")
	}
}
