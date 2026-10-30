// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

func TestVerificationRuntimeHasIndependentSafeContainmentSwitches(t *testing.T) {
	root := readAPICompositionRoot(t)
	source := root.main
	for _, required := range []string{
		`POSTWAVE_DISABLE_VERIFICATION_BULK_JOBS") != "1"`,
		`POSTWAVE_DISABLE_VERIFICATION_JOB_RUNNER") != "1"`,
		`POSTWAVE_DISABLE_SUBSCRIBER_IMPORT_WORKER") != "1"`,
		`POSTWAVE_DISABLE_RECIPIENT_HEALTH_GATE") != "1"`,
		"sending.RecipientSafetyGateForRollout(",
		"sending.NewSuppressionConvergerAdapter(sendSuppressionConverger)",
		"apiworkers.StartVerificationCachePurge(",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("verification runtime composition missing %q", required)
		}
	}

	// Health rollback must return to the canonical suppression converger, never
	// nil or a permissive checker. The functional helper has package tests; this
	// assertion pins production to that helper rather than an ad-hoc env branch.
	if strings.Contains(root.all, `Suppressions: nil, // verification`) {
		t.Fatal("verification containment may not remove canonical suppression enforcement")
	}
}
