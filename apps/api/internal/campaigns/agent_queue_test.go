// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-helper tests for the agent send path (1.3b). The full
// QueueCampaignForAgent flow is exercised via the DB-backed queue tests;
// here we lock the queueError→model-message extraction so the compliance
// block (which carries its message in Body, not Message) is surfaced to
// the agent instead of a bare status code.
package campaigns

import (
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/limits"
)

func TestMessageFromQueueErrorBody(t *testing.T) {
	cases := []struct {
		name string
		body any
		want string
	}{
		{"nil body", nil, ""},
		{"non-map body", "oops", ""},
		{"compliance block (map[string]string error)", map[string]any{
			"error": map[string]string{
				"code":    "email_compliance_blocked",
				"message": "Complete sender compliance requirements before queueing.",
			},
			"compliance": map[string]any{"ready": false},
		}, "Complete sender compliance requirements before queueing."},
		{"map[string]any error shape", map[string]any{
			"error": map[string]any{"message": "something specific"},
		}, "something specific"},
		{"error present but no message", map[string]any{
			"error": map[string]string{"code": "x"},
		}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := messageFromQueueErrorBody(c.body); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

// The quota body, which this file did not cover — and an adversarial review
// showed the gap mattered. Putting an entitlement.Denial STRUCT into
// queueError.Body made `messageFromQueueErrorBody` match neither of its arms
// (map[string]string / map[string]any), so an agent that hit the monthly-send
// cap stopped being told which cap, which tier, and by how much, and received
// "campaign cannot be queued (status 402)" instead.
//
// That is a net LOSS of the actionability the denial contract exists to add, on
// the one surface — an autonomous agent — least able to recover from a bare
// status code.
func TestAgentGetsThePlanLimitDetailNotABareStatus(t *testing.T) {
	limErr := &limits.Error{
		Resource: limits.ResourceMonthlySends, Tier: "studio", Limit: 2000, Current: 1990,
	}
	qe := quotaExceededQueueError(limErr)
	if qe == nil {
		t.Fatal("a limits.Error must map to a quota queueError")
	}

	// Either channel the agent path reads must carry the explanation.
	fromBody := messageFromQueueErrorBody(qe.Body)
	if qe.Message == "" && fromBody == "" {
		t.Fatal("neither queueError.Message nor the body carries a message; the agent " +
			"would be told only 'campaign cannot be queued (status 402)'")
	}
	msg := qe.Message
	if msg == "" {
		msg = fromBody
	}
	for _, want := range []string{"monthly_sends", "studio"} {
		if !strings.Contains(msg, want) {
			t.Errorf("agent message %q does not mention %q", msg, want)
		}
	}
}
