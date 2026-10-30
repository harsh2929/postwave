package runtime

import (
	"context"
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// TestEngine_ABTestAssignsAndRecords drives two subscribers through an ab_test
// node and asserts each is bucketed into a variant whose assignment is recorded
// (assigned counter bumped), deterministically and exactly once.
func TestEngine_ABTestAssignsAndRecords(t *testing.T) {
	e, _, q, st, r := buildEngine(t)
	auto := &canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: "list_join"}},
		EntryID:  "ab1",
		Nodes: []canonical.AutomationNode{
			{ID: "ab1", Type: "ab_test", Variants: []canonical.AutomationSplitVariant{
				{ID: "control", Percentage: 50, Next: ""},
				{ID: "B", Percentage: 50, Next: ""},
			}},
		},
	}
	r.PutAutomation(auto)
	r.PutSubscriber("t", canonical.Subscriber{Email: "a@x.com", Status: canonical.StatusEnabled})
	r.PutSubscriber("t", canonical.Subscriber{Email: "b@x.com", Status: canonical.StatusEnabled})
	for _, email := range []string{"a@x.com", "b@x.com"} {
		if err := e.Trigger(context.Background(), "a", "list_join", email, nil); err != nil {
			t.Fatalf("trigger %s: %v", email, err)
		}
	}
	drain(t, e, q)

	// Two subscribers → two assignments, summing to 2 across variants.
	totalAssigned := 0
	for _, res := range st.abResults {
		totalAssigned += res.assigned
	}
	if totalAssigned != 2 {
		t.Fatalf("want 2 total assignments, got %d (%+v)", totalAssigned, st.abResults)
	}
	if len(st.abAssign) != 2 {
		t.Fatalf("want 2 subscriber assignments, got %d", len(st.abAssign))
	}
}

// TestMemoryStore_ABAssignmentAndConversion exercises the store contract:
// earliest-wins assignment, assigned/converted counters, and conversion
// attribution to the right variant.
func TestMemoryStore_ABAssignmentAndConversion(t *testing.T) {
	st := NewMemoryStore()
	ctx := context.Background()
	a := ABAssignment{TenantID: "t", AutomationID: "a", NodeID: "ab1", SubscriberEmail: "u@x.com", VariantID: "B"}
	if err := st.RecordABAssignment(ctx, a); err != nil {
		t.Fatalf("assign: %v", err)
	}
	// Re-assign same subscriber → earliest-wins, no double count.
	if err := st.RecordABAssignment(ctx, a); err != nil {
		t.Fatalf("re-assign: %v", err)
	}
	res := st.abResults["t|a|ab1|B"]
	if res == nil || res.assigned != 1 {
		t.Fatalf("assigned should be 1 (earliest-wins), got %+v", res)
	}

	// Convert.
	n, err := st.RecordABConversion(ctx, "t", "a", "u@x.com")
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if n != 1 || res.converted != 1 {
		t.Fatalf("want 1 conversion on variant B, got n=%d converted=%d", n, res.converted)
	}
	// Re-convert → already converted, no double count.
	if n2, _ := st.RecordABConversion(ctx, "t", "a", "u@x.com"); n2 != 0 {
		t.Fatalf("re-conversion should be a no-op, got %d", n2)
	}

	// Missing keys rejected.
	if err := st.RecordABAssignment(ctx, ABAssignment{TenantID: "t"}); err == nil {
		t.Fatal("expected error for assignment missing keys")
	}
}
