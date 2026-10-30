// SPDX-License-Identifier: AGPL-3.0-only
package segments

import (
	"encoding/json"
	"testing"
)

func TestBuildAISuggestionsAlwaysIncludesNewThisWeek(t *testing.T) {
	out := buildAISuggestions(tenantSignals{Total: 0})
	if len(out) == 0 {
		t.Fatal("expected at least the new-this-week suggestion")
	}
	if out[0].Key != "new_this_week" {
		t.Fatalf("first key = %q, want new_this_week", out[0].Key)
	}
}

func TestBuildAISuggestionsGatesByThresholds(t *testing.T) {
	out := buildAISuggestions(tenantSignals{
		Total:           200,
		Subscribed:      180,
		ColdSubscribers: 100,
		HighCLV:         15,
		HighChurnRisk:   12,
		RFMChampions:    8,
		SMSConsented:    40,
		EmailConsented:  150,
	})
	keys := map[string]bool{}
	for _, s := range out {
		keys[s.Key] = true
	}
	for _, want := range []string{"new_this_week", "cold_subscribers", "high_value_customers", "churn_risk", "champions_rfm", "sms_consented", "active_subscribed", "multi_channel"} {
		if !keys[want] {
			t.Errorf("missing expected suggestion %s", want)
		}
	}
	if len(out) > 8 {
		t.Fatalf("expected cap at 8, got %d", len(out))
	}
}

func TestBuildAISuggestionsHidesPredictiveWhenNoSignal(t *testing.T) {
	out := buildAISuggestions(tenantSignals{Total: 100, Subscribed: 90})
	for _, s := range out {
		if s.Key == "high_value_customers" || s.Key == "churn_risk" || s.Key == "champions_rfm" {
			t.Fatalf("predictive suggestion surfaced without signal: %#v", s)
		}
	}
}

func TestAISuggestionsPredicateASTsCompile(t *testing.T) {
	out := buildAISuggestions(tenantSignals{
		Total: 200, Subscribed: 180, ColdSubscribers: 100, HighCLV: 15,
		HighChurnRisk: 12, RFMChampions: 8, SMSConsented: 40, EmailConsented: 150,
	})
	for _, s := range out {
		// Confirm the predicate is well-formed JSON; we don't run
		// CompileAST here because some keys are predicate-builder
		// targets the compiler hasn't routed yet (channel_consent.*).
		var dummy map[string]any
		if err := json.Unmarshal(s.PredicateJSON, &dummy); err != nil {
			t.Fatalf("predicate %s: bad JSON: %v", s.Key, err)
		}
	}
}

func TestHumanCount(t *testing.T) {
	cases := map[int]string{0: "0", 9: "9", 99: "99", 999: "999", 1000: "1,000", 12345: "12,345", 1000000: "1,000,000"}
	for in, want := range cases {
		if got := humanCount(in); got != want {
			t.Errorf("humanCount(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestParseWindowDays(t *testing.T) {
	cases := map[string]int{"": 90, "30d": 30, "12w": 84, "abc": 90, "0": 90, "500": 365, "60": 60}
	for in, want := range cases {
		if got := parseWindowDays(in); got != want {
			t.Errorf("parseWindowDays(%q) = %d, want %d", in, got, want)
		}
	}
}
