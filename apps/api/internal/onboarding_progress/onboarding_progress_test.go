// SPDX-License-Identifier: AGPL-3.0-only
//
// Lightweight checklist test — keeps the canonical step set stable so
// a refactor doesn't silently drop a step the desktop client relies on
// for its 5 home-page onboarding rows.

package onboarding_progress

import (
	"strings"
	"testing"
)

func TestChecklistContainsRequiredKeys(t *testing.T) {
	// Every key here is consumed by `useOnboardingProgress` in the
	// desktop client (apps/desktop/src/hooks/useOnboardingProgress.ts).
	// Removing or renaming one of these silently breaks the home-page
	// checklist for end users — the step shows as "pending" forever.
	required := []string{
		"verified_sending_identity",
		"configured_dkim_dmarc",
		"created_subscriber",
		"sent_first_campaign",
		"connected_product_events",
	}

	present := make(map[string]bool, len(checklist))
	for _, s := range checklist {
		present[s.key] = true
	}

	for _, k := range required {
		if !present[k] {
			t.Errorf("required onboarding key %q is missing from canonical checklist", k)
		}
	}
}

func TestChecklistKeysAreUnique(t *testing.T) {
	seen := make(map[string]bool, len(checklist))
	for _, s := range checklist {
		if seen[s.key] {
			t.Errorf("duplicate key %q in canonical checklist", s.key)
		}
		seen[s.key] = true
	}
}

func TestEveryChecklistStepHasNonEmptyMetadata(t *testing.T) {
	for _, s := range checklist {
		if s.key == "" {
			t.Errorf("step has empty key: %+v", s)
		}
		if s.label == "" {
			t.Errorf("step %q has empty label", s.key)
		}
		if s.description == "" {
			t.Errorf("step %q has empty description", s.key)
		}
		if s.check == "" {
			t.Errorf("step %q has empty check SQL", s.key)
		}
	}
}

func TestFirstSendRequiresRealRecipientDeliveryEvidence(t *testing.T) {
	for _, step := range checklist {
		if step.key != "sent_first_campaign" {
			continue
		}
		for _, required := range []string{"campaign_recipients", "recipient.status = 'sent'", "recipient.sent_at IS NOT NULL", "campaign.is_sandbox IS NOT TRUE"} {
			if !strings.Contains(step.check, required) {
				t.Fatalf("first-send step lost %q evidence gate", required)
			}
		}
		return
	}
	t.Fatal("sent_first_campaign step missing")
}
