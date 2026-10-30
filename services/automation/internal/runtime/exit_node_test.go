package runtime

import (
	"context"
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// The flowbuilder catalog advertises `exit` as RuntimeStatus:"supported", and
// Validate() reports Executable:true for a graph containing it — but runNode's
// switch had no case for it, so it fell through to `unknown node type "exit"`,
// failed, retried 5 times and deadlettered. The project's own flowbuilder test
// builds a graph terminating in {ID:"end", Type:"exit"}.
//
// An exit node is the most ordinary thing in a journey: "stop here". It must
// terminate the run cleanly.
func TestExitNode_TerminatesTheJourneyCleanly(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "n1",
		Nodes: []canonical.AutomationNode{
			{ID: "n1", Type: "send_email", TemplateID: "1"},
			{ID: "end", Type: "exit"},
		},
		Edges: []canonical.AutomationEdge{{From: "n1", To: "end"}},
	})

	if err := e.Trigger(context.Background(), "a", "list_join", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	// drain() t.Fatal()s if Execute returns an error, so reaching the assertions
	// at all proves the exit node did not blow up the journey.
	drain(t, e, q)

	if len(lm.sends) != 1 {
		t.Fatalf("the journey should have sent once then exited; sent %d", len(lm.sends))
	}
}

// An exit node reached directly must not send, and must not error.
func TestExitNode_AsEntryIsANoOp(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "end",
		Nodes:    []canonical.AutomationNode{{ID: "end", Type: "exit"}},
	})
	if err := e.Trigger(context.Background(), "a", "list_join", "u@x.com", nil); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
	if len(lm.sends) != 0 {
		t.Fatalf("an exit node must not send; sent %d", len(lm.sends))
	}
}
