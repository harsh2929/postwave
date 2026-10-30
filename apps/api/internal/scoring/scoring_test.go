// SPDX-License-Identifier: AGPL-3.0-only
package scoring

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestDefaultRulesUseOnlyCatalogEvents(t *testing.T) {
	allowed := map[string]bool{}
	for _, item := range EventCatalog {
		if allowed[item.EventType] {
			t.Fatalf("duplicate event catalog entry %q", item.EventType)
		}
		allowed[item.EventType] = true
	}
	for eventType := range DefaultRules {
		if !allowed[eventType] {
			t.Fatalf("default scoring event %q cannot exist in subscriber_events", eventType)
		}
	}
	if _, stale := DefaultRules["form_submit"]; stale {
		t.Fatal("form_submit is not in the subscriber_events vocabulary")
	}
}

func TestNormalizeRulesCanonicalizesAndBoundsInput(t *testing.T) {
	got, reason := normalizeRules([]Rule{
		{ID: "ignored", EventType: " replied ", Weight: 9, Note: "  human reply  "},
		{EventType: "clicked", Weight: 4},
	})
	if reason != "" {
		t.Fatalf("normalize valid rules: %s", reason)
	}
	if len(got) != 2 || got[0].EventType != "clicked" || got[1].EventType != "replied" {
		t.Fatalf("rules were not canonically sorted: %+v", got)
	}
	if got[1].ID != "" || got[1].Note != "human reply" {
		t.Fatalf("server-controlled id/trim contract failed: %+v", got[1])
	}

	tests := []struct {
		name  string
		rules []Rule
	}{
		{name: "unknown event", rules: []Rule{{EventType: "form_submit", Weight: 1}}},
		{name: "duplicate event", rules: []Rule{{EventType: "clicked", Weight: 1}, {EventType: "clicked", Weight: 2}}},
		{name: "low weight", rules: []Rule{{EventType: "clicked", Weight: -1001}}},
		{name: "high weight", rules: []Rule{{EventType: "clicked", Weight: 1001}}},
		{name: "control note", rules: []Rule{{EventType: "clicked", Weight: 1, Note: "one\ntwo"}}},
		{name: "long note", rules: []Rule{{EventType: "clicked", Weight: 1, Note: strings.Repeat("x", 241)}}},
		{name: "too many", rules: append(defaultRuleRows(), Rule{EventType: "delivered", Weight: 0}, Rule{EventType: "suppressed", Weight: 0}, Rule{EventType: "consent_changed", Weight: 0}, Rule{EventType: "custom", Weight: 0}, Rule{EventType: "identified", Weight: 0}, Rule{EventType: "merged", Weight: 0}, Rule{EventType: "status_changed", Weight: 0}, Rule{EventType: "lifecycle_stage_changed", Weight: 0}, Rule{EventType: "opened", Weight: 0})},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, reason := normalizeRules(tc.rules); reason == "" {
				t.Fatalf("normalizeRules unexpectedly accepted %+v", tc.rules)
			}
		})
	}
}

func TestRuleSetVersionIsSemanticAndOrderIndependent(t *testing.T) {
	left := []Rule{
		{ID: "one", EventType: "clicked", Weight: 5, Note: "signal"},
		{ID: "two", EventType: "opened", Weight: 1},
	}
	right := []Rule{
		{ID: "new-two", EventType: "opened", Weight: 1},
		{ID: "new-one", EventType: "clicked", Weight: 5, Note: " signal "},
	}
	version := ruleSetVersion(left)
	if !validRuleSetVersion(version) {
		t.Fatalf("invalid generated version %q", version)
	}
	if version != ruleSetVersion(right) {
		t.Fatalf("order/id/outer whitespace changed the semantic version")
	}
	changed := append([]Rule(nil), right...)
	changed[1].Weight = 6
	if version == ruleSetVersion(changed) {
		t.Fatal("weight mutation did not change the version")
	}
	for _, invalid := range []string{"", "sha256:", "md5:" + strings.Repeat("0", 64), "sha256:" + strings.Repeat("z", 64)} {
		if validRuleSetVersion(invalid) {
			t.Fatalf("accepted invalid version %q", invalid)
		}
	}
}

func TestManualRecomputeFailsClosedWithoutTouchingDatabase(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/scoring/recompute", nil)
	req = req.WithContext(middleware.WithTenant(
		req.Context(),
		&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000018"},
	))
	rec := httptest.NewRecorder()
	deps.RecomputeNow(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("manual recompute status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "scoring_recompute_unavailable") ||
		strings.Contains(rec.Body.String(), `"updated"`) {
		t.Fatalf("manual recompute returned an unsafe contract: %s", rec.Body.String())
	}

	unauthenticated := httptest.NewRecorder()
	deps.RecomputeNow(
		unauthenticated,
		httptest.NewRequest(http.MethodPost, "/api/v1/scoring/recompute", nil),
	)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unscoped manual recompute status=%d", unauthenticated.Code)
	}
}
