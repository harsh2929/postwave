package flowbuilder

import (
	"strings"
	"testing"
)

// FieldSpec.Required was declared in the catalog and read NOWHERE. Validate()
// checked ids, types, duplicates and edges — but never whether a node actually
// carried the fields its own catalog entry marks as required.
//
// So a send_email node with no template_id validated clean, reported
// Executable:true, shipped — and then failed at runtime for every subscriber
// who reached it. The builder blessed a graph it knew could not run.
func TestValidate_RejectsANodeMissingARequiredField(t *testing.T) {
	out := Validate(GraphValidateRequest{
		EntryID: "n1",
		Nodes: []NodeSpec{
			{ID: "n1", Type: "send_email"}, // template_id is Required in the catalog
		},
	})
	// The graph stays structurally Valid — half-built drafts must still
	// validate. What must NOT happen is calling it Executable: that is the
	// bug. It used to report Executable:true and then fail at runtime for
	// every subscriber who reached the node.
	if out.Executable {
		t.Fatal("a send_email node with no template_id can never run — it must not be reported Executable")
	}
	joined := strings.Join(out.Warnings, " | ")
	if !strings.Contains(joined, "template_id") {
		t.Errorf("the warning should name the missing field; got %q", joined)
	}
}

// The happy authoring path must still pass structural validation. Runtime
// execution remains independently unavailable.
func TestValidate_AcceptsANodeWithItsRequiredFields(t *testing.T) {
	out := Validate(GraphValidateRequest{
		EntryID: "n1",
		Nodes: []NodeSpec{
			{ID: "n1", Type: "send_email", Action: map[string]any{"template_id": "7"}},
		},
	})
	if !out.Valid {
		t.Fatalf("a complete send_email node must validate; errors=%v", out.Errors)
	}
	if out.Executable || out.Runtime.ExecutionEnabled {
		t.Fatalf("a complete node must not override the runtime containment: %+v", out)
	}
}

// An empty string is not a value.
func TestValidate_TreatsABlankRequiredFieldAsMissing(t *testing.T) {
	out := Validate(GraphValidateRequest{
		EntryID: "n1",
		Nodes: []NodeSpec{
			{ID: "n1", Type: "send_email", Action: map[string]any{"template_id": "   "}},
		},
	})
	if out.Executable {
		t.Fatal("a blank required field is a missing required field — not executable")
	}
}
