// SPDX-License-Identifier: AGPL-3.0-only
package audit_alerts

import "testing"

func TestRedactChannelConfigForReadDropsCredentialAndDestinationMaterial(t *testing.T) {
	input := map[string]any{
		"routing_key": "pagerduty-secret",
		"api_token":   "jira-secret",
		"password":    "servicenow-secret",
		"webhook_url": "https://hooks.example.test/secret-path",
	}
	got := redactChannelConfigForRead(input)
	if len(got) != 0 {
		t.Fatalf("read-side channel config = %#v, want an empty redacted object", got)
	}
	if input["routing_key"] != "pagerduty-secret" {
		t.Fatal("redaction mutated the stored config input")
	}
}

func TestAlertPatchReceiptHelpersPreserveExplicitFalse(t *testing.T) {
	value := false
	if got := boolOr(&value, true); got {
		t.Fatal("boolOr ignored an explicit false patch value")
	}
	if got := alertFirstNonEmpty("new", "old"); got != "new" {
		t.Fatalf("alertFirstNonEmpty = %q, want new", got)
	}
}
