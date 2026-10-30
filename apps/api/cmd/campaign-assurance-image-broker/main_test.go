// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

func TestImageBrokerRejectsModelProviderCredentials(t *testing.T) {
	for _, name := range []string{
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY", "GEMINI_API_KEY",
	} {
		err := rejectModelProviderCredentials([]string{name + "=secret"})
		if err == nil || !strings.Contains(err.Error(), name) || strings.Contains(err.Error(), "secret") {
			t.Fatalf("%s rejection = %v", name, err)
		}
	}
	if err := rejectModelProviderCredentials([]string{
		"DATABASE_URL=postgres://worker", "AWS_REGION=ap-south-1",
	}); err != nil {
		t.Fatalf("required broker capability was rejected: %v", err)
	}
}
