package flowbuilder

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// postValidate drives the real HTTP handler, not Validate() directly. The two
// are NOT equivalent: the handler decodes into GraphValidateRequest with
// httpbody.DecodeJSON, which rejects unknown fields, while the in-process
// callers (CreateVersion → ValidateFlowGraph → graphValidateRequest) reach
// Validate through a permissive json round-trip. Every bug in this file lives
// in that gap.
func postValidate(t *testing.T, body any) (int, GraphValidateResponse, string) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/flow-builder/validate", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Deps{}).ValidateGraph(rec, req)

	var out GraphValidateResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out, rec.Body.String()
}

// A REAL authored node, exactly as apps/web writes it: type-specific fields sit
// FLAT on the node (apps/web/src/lib/flows-api.ts FlowNode — template_id,
// sms_body, duration_seconds, webhook_url are top-level), and the canvas adds
// `position` (presentation-only, round-tripped through save/load because
// FlowGraph.Nodes is []map[string]any).
//
// The handler must accept that node. It is the only node shape any authoring
// surface in this repository produces.
func TestValidateGraph_AcceptsTheNodeShapeTheEditorActuallyAuthors(t *testing.T) {
	status, _, body := postValidate(t, map[string]any{
		"entry_id": "n1",
		"nodes": []map[string]any{
			{
				"id":          "n1",
				"type":        "send_email",
				"template_id": "42",
				"position":    map[string]any{"x": 120, "y": 40},
			},
		},
	})
	if status == http.StatusBadRequest {
		t.Fatalf("the validator rejected the only node shape the editor produces: %s", strings.TrimSpace(body))
	}
	if status != http.StatusOK {
		t.Fatalf("expected 200 for a structurally sound graph, got %d: %s", status, strings.TrimSpace(body))
	}
}

// The catalog marks send_email.template_id Required. A node that CARRIES it —
// in the place the editor writes it — must not be reported as missing it.
//
// missingRequiredFields used to read node.Action[key] only, so it looked for
// "template_id" inside the `action` object, which only the `action` node type
// has. Every send_email/send_sms/wait/webhook node in every workspace was
// therefore reported incomplete, whether or not it was.
func TestValidateGraph_DoesNotInventAMissingFieldForAFlatlyAuthoredNode(t *testing.T) {
	_, out, _ := postValidate(t, map[string]any{
		"entry_id": "n1",
		"nodes": []map[string]any{
			{"id": "n1", "type": "send_email", "template_id": "42"},
		},
	})
	joined := strings.Join(out.Warnings, " | ")
	if strings.Contains(joined, "template_id") {
		t.Fatalf("template_id IS set on the node; the validator must not report it missing: %s", joined)
	}
}

// The `action` node's catalog FieldSpec key is the dotted path "action.kind",
// and the value lives at node.action.kind. Reading Action["action.kind"] finds
// nothing, so a fully configured action node was also always "incomplete".
func TestValidateGraph_ResolvesADottedRequiredFieldPath(t *testing.T) {
	_, out, _ := postValidate(t, map[string]any{
		"entry_id": "n1",
		"nodes": []map[string]any{
			{"id": "n1", "type": "action", "action": map[string]any{"kind": "add_tag", "tag": "vip"}},
		},
	})
	joined := strings.Join(out.Warnings, " | ")
	if strings.Contains(joined, "action.kind") {
		t.Fatalf("action.kind IS set; the validator must not report it missing: %s", joined)
	}
}

// A genuinely absent required field must still be reported — the fix must not
// turn the check off.
func TestValidateGraph_StillReportsAGenuinelyAbsentRequiredField(t *testing.T) {
	_, out, _ := postValidate(t, map[string]any{
		"entry_id": "n1",
		"nodes":    []map[string]any{{"id": "n1", "type": "send_email"}},
	})
	if !strings.Contains(strings.Join(out.Warnings, " | "), "template_id") {
		t.Fatalf("a send_email with no template_id anywhere must warn; got %v", out.Warnings)
	}
	if out.Executable {
		t.Fatal("an incomplete node must never be reported executable")
	}
}

// Blank is absent: an empty template_id is not a template id.
func TestValidateGraph_TreatsABlankFlatRequiredFieldAsMissing(t *testing.T) {
	_, out, _ := postValidate(t, map[string]any{
		"entry_id": "n1",
		"nodes":    []map[string]any{{"id": "n1", "type": "send_email", "template_id": "   "}},
	})
	if !strings.Contains(strings.Join(out.Warnings, " | "), "template_id") {
		t.Fatalf("a blank template_id is a missing template_id; got %v", out.Warnings)
	}
}

// A graph with real structural faults still answers 422 and names them.
func TestValidateGraph_ReportsStructuralErrorsWith422(t *testing.T) {
	status, out, _ := postValidate(t, map[string]any{
		"entry_id": "nowhere",
		"nodes":    []map[string]any{{"id": "n1", "type": "exit"}},
		"edges":    []map[string]any{{"from": "n1", "to": "ghost"}},
	})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("an invalid graph must answer 422, got %d", status)
	}
	if out.Valid {
		t.Fatal("a graph with a dangling entry_id and a dangling edge is not valid")
	}
	joined := strings.Join(out.Errors, " | ")
	if !strings.Contains(joined, "entry_id") || !strings.Contains(joined, "ghost") {
		t.Fatalf("both faults must be named: %v", out.Errors)
	}
}

// The number a client shows next to "steps" comes from these counters, so they
// must agree with the node array they were computed from.
func TestValidateGraph_CountsEveryNode(t *testing.T) {
	_, out, _ := postValidate(t, map[string]any{
		"nodes": []map[string]any{
			{"id": "a", "type": "send_email", "template_id": "1"},
			{"id": "b", "type": "wait", "duration_seconds": 3600},
			{"id": "c", "type": "exit"},
		},
	})
	if total := out.Supported + out.Planned + out.Unsupported; total != 3 {
		t.Fatalf("3 nodes in, %d counted (supported=%d planned=%d unsupported=%d)",
			total, out.Supported, out.Planned, out.Unsupported)
	}
}
