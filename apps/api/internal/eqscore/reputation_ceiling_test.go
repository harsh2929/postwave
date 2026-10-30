// SPDX-License-Identifier: AGPL-3.0-only
package eqscore

import "testing"

// The reputation sub-score used to fail only at 1.0% — 3.3x above the 0.30%
// ceiling that Gmail, Yahoo and Outlook actually enforce — and its copy told
// the operator that 1% "triggers automatic suspension of the free pool".
// There is no such suspension system, and by 1% the sending domain is
// already burnt. The fail line belongs at the provider ceiling.
func TestReputationFailsAtTheProviderCeiling(t *testing.T) {
	// 20 complaints / 5,000 sent = 0.40%: over the 0.30% ceiling, and well
	// under the old 1.0% fail line.
	sub := scoreReputation(Last7dStats{Sent: 5000, Delivered: 5000, Complained: 20})

	var got *Reason
	for i := range sub.Reasons {
		if sub.Reasons[i].Code == "complaint_rate_critical" {
			got = &sub.Reasons[i]
			break
		}
	}
	if got == nil {
		t.Fatalf("a 0.40%% complaint rate is above the enforced ceiling and must be critical; reasons = %+v", sub.Reasons)
	}
	if got.Severity != "fail" {
		t.Errorf("severity = %q, want %q", got.Severity, "fail")
	}
}

// A rate between the harm line and the ceiling should warn, not fail.
func TestReputationWarnsBetweenHarmLineAndCeiling(t *testing.T) {
	// 10 / 5,000 = 0.20%.
	sub := scoreReputation(Last7dStats{Sent: 5000, Delivered: 5000, Complained: 10})
	for _, r := range sub.Reasons {
		if r.Code == "complaint_rate_critical" {
			t.Fatalf("0.20%% is under the 0.30%% ceiling and must not be critical: %+v", r)
		}
	}
}
