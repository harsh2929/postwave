// SPDX-License-Identifier: MIT

package canonical

import (
	"encoding/json"
	"testing"
)

func TestSubscriberStatus_RoundTrip(t *testing.T) {
	statuses := []SubscriberStatus{
		StatusEnabled,
		StatusDisabled,
		StatusBlocklisted,
		StatusUnconfirmed,
	}
	for _, s := range statuses {
		sub := Subscriber{
			Email:          "test@example.com",
			Status:         s,
			ConsentSource:  ConsentSingleOptIn,
			SourceID:       "abc",
			SourcePlatform: SourceMailchimp,
			CustomFields:   map[string]any{},
			Tags:           []string{},
		}
		b, err := json.Marshal(sub)
		if err != nil {
			t.Fatalf("marshal %s: %v", s, err)
		}
		var got Subscriber
		if err := json.Unmarshal(b, &got); err != nil {
			t.Fatalf("unmarshal %s: %v", s, err)
		}
		if got.Status != s {
			t.Errorf("status mismatch: want %q got %q", s, got.Status)
		}
	}
}

func TestSegmentNode_OrAndCondition_RoundTrip(t *testing.T) {
	tree := SegmentNode{
		Op: "or",
		Children: []SegmentNode{
			{Op: "condition", Field: "tag", Comparator: "equals", Value: "a"},
			{Op: "condition", Field: "tag", Comparator: "equals", Value: "b"},
		},
	}
	b, err := json.Marshal(tree)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got SegmentNode
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Op != "or" {
		t.Errorf("op mismatch: want %q got %q", "or", got.Op)
	}
	if len(got.Children) != 2 {
		t.Fatalf("children len: want 2 got %d", len(got.Children))
	}
	for i, c := range got.Children {
		if c.Op != "condition" {
			t.Errorf("child[%d] op: want %q got %q", i, "condition", c.Op)
		}
	}
}

func TestMigrationStatus_StringValues(t *testing.T) {
	cases := map[MigrationStatus]string{
		MigPending:              `"pending"`,
		MigAuthenticating:       `"authenticating"`,
		MigDiscovering:          `"discovering"`,
		MigDryRun:               `"dry_run"`,
		MigAwaitingConfirmation: `"awaiting_confirmation"`,
		MigImporting:            `"importing"`,
		MigCompleted:            `"completed"`,
		MigRollingBack:          `"rolling_back"`,
		MigFailed:               `"failed"`,
		MigRolledBack:           `"rolled_back"`,
	}
	for status, want := range cases {
		b, err := json.Marshal(status)
		if err != nil {
			t.Fatalf("marshal %s: %v", status, err)
		}
		if string(b) != want {
			t.Errorf("status %s: want %s got %s", status, want, string(b))
		}
	}
}
