package runtime

import (
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

func TestEvaluate(t *testing.T) {
	sub := canonical.Subscriber{
		Email:  "alice@example.com",
		Status: canonical.StatusEnabled,
		Tags:   []string{"vip", "beta"},
		CustomFields: map[string]interface{}{
			"plan":      "pro",
			"mrr_cents": float64(4900),
		},
	}

	cases := []struct {
		name string
		cond canonical.SegmentCondition
		want bool
	}{
		{"email eq", canonical.SegmentCondition{Field: "email", Comparator: "eq", Value: "alice@example.com"}, true},
		{"email neq", canonical.SegmentCondition{Field: "email", Comparator: "neq", Value: "bob@x"}, true},
		{"email contains", canonical.SegmentCondition{Field: "email", Comparator: "contains", Value: "example"}, true},
		{"status eq", canonical.SegmentCondition{Field: "status", Comparator: "eq", Value: "enabled"}, true},
		{"tag contains", canonical.SegmentCondition{Field: "tags", Comparator: "contains", Value: "vip"}, true},
		{"tag not_contains", canonical.SegmentCondition{Field: "tags", Comparator: "not_contains", Value: "ghost"}, true},
		{"custom plan eq", canonical.SegmentCondition{Field: "custom.plan", Comparator: "eq", Value: "pro"}, true},
		{"custom mrr gt", canonical.SegmentCondition{Field: "custom.mrr_cents", Comparator: "gt", Value: float64(1000)}, true},
		{"custom mrr lte", canonical.SegmentCondition{Field: "custom.mrr_cents", Comparator: "lte", Value: float64(4900)}, true},
		{"missing field exists false", canonical.SegmentCondition{Field: "custom.churned", Comparator: "exists"}, false},
		{"missing field not_exists true", canonical.SegmentCondition{Field: "custom.churned", Comparator: "not_exists"}, true},
		{"unknown comparator false", canonical.SegmentCondition{Field: "email", Comparator: "weird", Value: "x"}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(tc.cond, sub)
			if got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
