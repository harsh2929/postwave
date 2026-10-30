// SPDX-License-Identifier: AGPL-3.0-only
//
// flows.go — Klaviyo flow → Moosewave flow translation.
//
// Klaviyo flow shape (highly simplified, captures the cases we
// support):
//
//	{
//	  "name": "Welcome Series",
//	  "trigger": {
//	    "type": "metric",      // or "list" or "date_property"
//	    "metric": "Active on Site",
//	    "list": "newsletter",
//	    "date_property": "subscribed_at"
//	  },
//	  "actions": [
//	    {"type": "wait", "wait": {"value": 1, "unit": "days"}},
//	    {"type": "send_email", "template": "welcome"},
//	    {"type": "branch", "if": {...condition...}, "then":[...], "else":[...]}
//	  ]
//	}
//
// The output is a Moosewave-flavoured FlowBlueprint with a fixed step
// vocabulary: trigger, wait, send_email, send_sms, condition,
// add_tag, remove_tag, unsubscribe, exit.

package klaviyo_migrate

import (
	"encoding/json"
	"fmt"
	"strings"
)

// FlowBlueprint is the import-ready flow shape. Steps are linearised
// (branch nodes inline their then/else as sibling steps with
// parent_id linking).
type FlowBlueprint struct {
	Name    string      `json:"name"`
	Trigger FlowTrigger `json:"trigger"`
	Steps   []FlowStep  `json:"steps"`
}

// FlowTrigger describes what kicks off the flow.
type FlowTrigger struct {
	Type      string `json:"type"` // event | list | date_property
	EventKey  string `json:"event_key,omitempty"`
	ListKey   string `json:"list_key,omitempty"`
	DateField string `json:"date_field,omitempty"`
}

// FlowStep is one node in the flow graph.
type FlowStep struct {
	ID         string          `json:"id"`
	ParentID   string          `json:"parent_id,omitempty"`
	Branch     string          `json:"branch,omitempty"` // "then" | "else" | ""
	Type       string          `json:"type"`
	WaitMillis int64           `json:"wait_millis,omitempty"`
	Template   string          `json:"template,omitempty"`
	Tag        string          `json:"tag,omitempty"`
	Condition  json.RawMessage `json:"condition,omitempty"`
}

// FlowTranslation bundles the result with warnings.
type FlowTranslation struct {
	Flow     FlowBlueprint `json:"flow"`
	Warnings []Warning     `json:"warnings"`
}

type klaviyoFlow struct {
	Name    string          `json:"name"`
	Trigger klaviyoTrigger  `json:"trigger"`
	Actions []klaviyoAction `json:"actions"`
}

type klaviyoTrigger struct {
	Type         string `json:"type"`
	Metric       string `json:"metric"`
	List         string `json:"list"`
	DateProperty string `json:"date_property"`
}

type klaviyoAction struct {
	Type     string            `json:"type"`
	Wait     *klaviyoTimeframe `json:"wait"`
	Template string            `json:"template"`
	Tag      string            `json:"tag"`
	If       *klaviyoCondition `json:"if"`
	Then     []klaviyoAction   `json:"then"`
	Else     []klaviyoAction   `json:"else"`
}

// TranslateFlow parses a Klaviyo flow payload into a FlowBlueprint.
func TranslateFlow(payload []byte) (*FlowTranslation, error) {
	var kf klaviyoFlow
	if err := json.Unmarshal(payload, &kf); err != nil {
		return nil, fmt.Errorf("klaviyo_migrate: decode flow: %w", err)
	}
	t := &flowTrans{}
	trigger, ok := t.translateTrigger(kf.Trigger, "$.trigger")
	if !ok {
		t.warn("missing_trigger", "$.trigger", "trigger could not be translated; defaulting to manual")
		trigger = FlowTrigger{Type: "manual"}
	}
	steps := t.translateActions(kf.Actions, "", "", "$.actions")
	return &FlowTranslation{
		Flow:     FlowBlueprint{Name: kf.Name, Trigger: trigger, Steps: steps},
		Warnings: t.warnings,
	}, nil
}

type flowTrans struct {
	warnings []Warning
	counter  int
}

func (t *flowTrans) warn(code, path, msg string) {
	t.warnings = append(t.warnings, Warning{Code: code, Path: path, Message: msg})
}

func (t *flowTrans) nextID() string {
	t.counter++
	return fmt.Sprintf("step_%d", t.counter)
}

func (t *flowTrans) translateTrigger(kt klaviyoTrigger, path string) (FlowTrigger, bool) {
	switch strings.ToLower(kt.Type) {
	case "metric", "event":
		if kt.Metric == "" {
			return FlowTrigger{}, false
		}
		return FlowTrigger{Type: "event", EventKey: kt.Metric}, true
	case "list", "added_to_list":
		if kt.List == "" {
			return FlowTrigger{}, false
		}
		return FlowTrigger{Type: "list", ListKey: kt.List}, true
	case "date_property", "date":
		if kt.DateProperty == "" {
			return FlowTrigger{}, false
		}
		return FlowTrigger{Type: "date_property", DateField: kt.DateProperty}, true
	case "":
		return FlowTrigger{}, false
	}
	t.warn("unsupported_trigger", path, fmt.Sprintf("trigger type %q has no Moosewave equivalent", kt.Type))
	return FlowTrigger{}, false
}

func (t *flowTrans) translateActions(actions []klaviyoAction, parentID, branch, path string) []FlowStep {
	out := []FlowStep{}
	for i, a := range actions {
		stepPath := fmt.Sprintf("%s[%d]", path, i)
		switch strings.ToLower(a.Type) {
		case "wait", "time_delay":
			step := FlowStep{ID: t.nextID(), ParentID: parentID, Branch: branch, Type: "wait"}
			if a.Wait != nil {
				if d, ok := timeframeDuration(*a.Wait); ok {
					step.WaitMillis = d.Milliseconds()
				} else {
					t.warn("invalid_wait", stepPath, "wait timeframe could not be parsed")
				}
			}
			out = append(out, step)
			parentID = step.ID
			branch = ""
		case "send_email", "send":
			step := FlowStep{ID: t.nextID(), ParentID: parentID, Branch: branch,
				Type: "send_email", Template: a.Template}
			out = append(out, step)
			parentID = step.ID
			branch = ""
		case "send_sms":
			step := FlowStep{ID: t.nextID(), ParentID: parentID, Branch: branch,
				Type: "send_sms", Template: a.Template}
			out = append(out, step)
			parentID = step.ID
			branch = ""
		case "add_tag", "tag":
			step := FlowStep{ID: t.nextID(), ParentID: parentID, Branch: branch,
				Type: "add_tag", Tag: a.Tag}
			out = append(out, step)
			parentID = step.ID
			branch = ""
		case "remove_tag", "untag":
			step := FlowStep{ID: t.nextID(), ParentID: parentID, Branch: branch,
				Type: "remove_tag", Tag: a.Tag}
			out = append(out, step)
			parentID = step.ID
			branch = ""
		case "unsubscribe":
			step := FlowStep{ID: t.nextID(), ParentID: parentID, Branch: branch, Type: "unsubscribe"}
			out = append(out, step)
			parentID = step.ID
			branch = ""
		case "exit":
			out = append(out, FlowStep{ID: t.nextID(), ParentID: parentID, Branch: branch, Type: "exit"})
			return out // exit short-circuits the rest of this list
		case "branch", "conditional_split", "if":
			step := FlowStep{ID: t.nextID(), ParentID: parentID, Branch: branch, Type: "condition"}
			if a.If != nil {
				st := &segmentTrans{}
				node, ok := st.translateCondition(*a.If, stepPath+".if")
				t.warnings = append(t.warnings, st.warnings...)
				if ok {
					raw, _ := json.Marshal(node)
					step.Condition = raw
				} else {
					t.warn("unsupported_branch_condition", stepPath+".if",
						"branch condition could not be translated; branch unconditional")
				}
			}
			out = append(out, step)
			out = append(out, t.translateActions(a.Then, step.ID, "then", stepPath+".then")...)
			out = append(out, t.translateActions(a.Else, step.ID, "else", stepPath+".else")...)
			parentID = step.ID
			branch = ""
		case "":
			t.warn("missing_action_type", stepPath, "action has no type; skipped")
		default:
			t.warn("unsupported_action", stepPath,
				fmt.Sprintf("action %q has no Moosewave equivalent; skipped", a.Type))
		}
	}
	return out
}
