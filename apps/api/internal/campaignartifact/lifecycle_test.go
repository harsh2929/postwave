// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"strings"
	"testing"
)

func TestValidPlanTransitionMatchesDatabaseLifecycle(t *testing.T) {
	t.Parallel()
	states := []string{
		PlanPreparing, PlanReady, PlanCertified, PlanStale,
		PlanSuperseded, PlanFailed,
	}
	allowed := map[[2]string]bool{
		{PlanPreparing, PlanFailed}:     true,
		{PlanReady, PlanCertified}:      true,
		{PlanReady, PlanStale}:          true,
		{PlanReady, PlanSuperseded}:     true,
		{PlanReady, PlanFailed}:         true,
		{PlanCertified, PlanStale}:      true,
		{PlanCertified, PlanSuperseded}: true,
		{PlanStale, PlanSuperseded}:     true,
	}
	for _, current := range states {
		for _, target := range states {
			if got, want := validPlanTransition(current, target), allowed[[2]string{current, target}]; got != want {
				t.Errorf("validPlanTransition(%q,%q)=%v, want %v", current, target, got, want)
			}
		}
	}
}

func TestFailureCodePatternMatchesDatabaseConstraint(t *testing.T) {
	t.Parallel()
	for _, valid := range []string{"COMPILER_FAILED", "A", "A" + strings.Repeat("9", 95)} {
		if !failureCodePattern.MatchString(valid) {
			t.Errorf("valid failure code %q rejected", valid)
		}
	}
	for _, invalid := range []string{"", "lowercase", "1LEADING", "HAS-DASH", "A B", "A" + strings.Repeat("9", 96)} {
		if failureCodePattern.MatchString(invalid) {
			t.Errorf("invalid failure code %q accepted", invalid)
		}
	}
}
