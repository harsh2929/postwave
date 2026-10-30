// SPDX-License-Identifier: AGPL-3.0-only

package deliverability_hub

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func applyThrottleObservation(
	t *testing.T,
	previous throttleObservation,
	score int,
	qualified bool,
	at time.Time,
	maxGap time.Duration,
) throttleObservation {
	t.Helper()
	next, accepted := advanceThrottleObservation(previous, score, qualified, at, maxGap)
	if !accepted {
		t.Fatalf("observation at %s was unexpectedly rejected", at)
	}
	return next
}

func TestThrottleObservationRequiresContinuousTwentyFourHours(t *testing.T) {
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	state := throttleObservation{}
	for hour := 0; hour <= 24; hour++ {
		state = applyThrottleObservation(
			t,
			state,
			40,
			true,
			start.Add(time.Duration(hour)*time.Hour),
			2*time.Hour,
		)
		eligible := throttleObservationEligible(state)
		if hour < 24 && eligible {
			t.Fatalf("became eligible after %d hours; want at least 24", hour)
		}
		if hour == 24 && !eligible {
			t.Fatal("continuous low observations were not eligible at 24 hours")
		}
	}
}

func TestThrottleObservationSparseGapStartsFreshWindow(t *testing.T) {
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	state := throttleObservation{}
	state = applyThrottleObservation(t, state, 40, true, start, 2*time.Hour)
	state = applyThrottleObservation(t, state, 40, true, start.Add(time.Hour), 2*time.Hour)

	// A seven-hour observation gap is not continuous at an hourly cadence.
	state = applyThrottleObservation(t, state, 40, true, start.Add(8*time.Hour), 2*time.Hour)
	if state.LowSince == nil || !state.LowSince.Equal(start.Add(8*time.Hour)) {
		t.Fatalf("low_since=%v, want restart at sparse-gap observation", state.LowSince)
	}

	for hour := 9; hour <= 31; hour++ {
		state = applyThrottleObservation(
			t,
			state,
			40,
			true,
			start.Add(time.Duration(hour)*time.Hour),
			2*time.Hour,
		)
	}
	if throttleObservationEligible(state) {
		t.Fatal("23 continuous hours after a sparse gap must not be eligible")
	}
	state = applyThrottleObservation(t, state, 40, true, start.Add(32*time.Hour), 2*time.Hour)
	if !throttleObservationEligible(state) {
		t.Fatal("24 continuous hours after the restarted window must be eligible")
	}
}

func TestThrottleObservationHealthyScoreResetsWindow(t *testing.T) {
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	state := throttleObservation{}
	for hour := 0; hour <= 12; hour++ {
		state = applyThrottleObservation(
			t,
			state,
			40,
			true,
			start.Add(time.Duration(hour)*time.Hour),
			2*time.Hour,
		)
	}
	state = applyThrottleObservation(t, state, 50, true, start.Add(13*time.Hour), 2*time.Hour)
	if state.LowSince != nil || throttleObservationEligible(state) {
		t.Fatalf("healthy observation did not reset state: %+v", state)
	}

	for hour := 14; hour <= 37; hour++ {
		state = applyThrottleObservation(
			t,
			state,
			40,
			true,
			start.Add(time.Duration(hour)*time.Hour),
			2*time.Hour,
		)
	}
	if throttleObservationEligible(state) {
		t.Fatal("23 low hours after recovery must not be eligible")
	}
	state = applyThrottleObservation(t, state, 40, true, start.Add(38*time.Hour), 2*time.Hour)
	if !throttleObservationEligible(state) {
		t.Fatal("24 low hours after recovery must be eligible")
	}
}

func TestThrottleObservationRejectsStaleSample(t *testing.T) {
	latest := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)
	lowSince := latest.Add(-12 * time.Hour)
	previous := throttleObservation{
		LowSince:        &lowSince,
		LastSampledAt:   latest,
		LastScore:       40,
		SampleQualified: true,
	}
	next, accepted := advanceThrottleObservation(
		previous,
		10,
		true,
		latest.Add(-time.Hour),
		2*time.Hour,
	)
	if accepted {
		t.Fatal("stale observation was accepted")
	}
	if next.LastScore != previous.LastScore ||
		!next.LastSampledAt.Equal(previous.LastSampledAt) ||
		next.LowSince == nil || !next.LowSince.Equal(lowSince) {
		t.Fatalf("stale observation mutated state: before=%+v after=%+v", previous, next)
	}
}

func TestThrottleObservationMaxGapUsesWorkerCadence(t *testing.T) {
	w := &Worker{Deps: &Deps{HubInterval: 15 * time.Minute}}
	if got := w.throttleObservationMaxGap(); got != 30*time.Minute {
		t.Fatalf("max gap=%s, want 30m", got)
	}
	w.Deps.HubInterval = 0
	if got := w.throttleObservationMaxGap(); got != 2*time.Hour {
		t.Fatalf("default max gap=%s, want 2h", got)
	}
}

func TestThrottleClearRequiresTheInstalledCap(t *testing.T) {
	t.Parallel()
	installed := 4000
	if !throttleCapStillInstalled(&installed, 4000) {
		t.Fatal("exact override-installed cap was rejected")
	}
	changed := 3500
	if throttleCapStillInstalled(&changed, 4000) {
		t.Fatal("a later cap edit was mistaken for the override-installed cap")
	}
	if throttleCapStillInstalled(nil, 4000) {
		t.Fatal("an uncapped later state was mistaken for the installed cap")
	}
}

func TestThrottleObservationUnqualifiedSampleCannotStartOrContinueWindow(t *testing.T) {
	start := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	state := throttleObservation{}
	for hour := 0; hour <= 23; hour++ {
		state = applyThrottleObservation(
			t,
			state,
			40,
			true,
			start.Add(time.Duration(hour)*time.Hour),
			2*time.Hour,
		)
	}

	state = applyThrottleObservation(
		t,
		state,
		40,
		false,
		start.Add(24*time.Hour),
		2*time.Hour,
	)
	if state.LowSince != nil || throttleObservationEligible(state) {
		t.Fatalf("unqualified sample retained throttle continuity: %+v", state)
	}

	state = applyThrottleObservation(
		t,
		state,
		40,
		true,
		start.Add(25*time.Hour),
		2*time.Hour,
	)
	if state.LowSince == nil || !state.LowSince.Equal(start.Add(25*time.Hour)) {
		t.Fatalf("qualified window did not restart after unqualified sample: %+v", state)
	}
}

func TestObserveAndMaybeAutoThrottleReturnsDependencyError(t *testing.T) {
	w := &Worker{}
	if _, err := w.observeAndMaybeAutoThrottle(context.Background(), "tenant", 40, true, 0, time.Now()); err == nil {
		t.Fatal("nil dependencies were silently accepted")
	}
}

func TestThrottleMigrationPinsProductionInvariants(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/1845_deliverability_throttle_invariants.sql")
	if err != nil {
		t.Fatalf("read throttle migration: %v", err)
	}
	sql := strings.ToLower(string(raw))
	for _, required := range []string{
		"create unique index if not exists",
		"where cleared_at is null",
		"create table if not exists deliverability_throttle_state",
		"last_sampled_at",
		"low_since",
		"sample_qualified",
		"system:migration-1845-active-override-dedup",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration is missing invariant %q", required)
		}
	}
}

func TestRemediationReleaseMigrationPinsTruthfulKindsAndInverseCardinality(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/2036_deliverability_remediation_release_kinds.sql")
	if err != nil {
		t.Fatalf("read remediation release migration: %v", err)
	}
	sql := strings.ToLower(string(raw))
	for _, required := range []string{
		"release_kind = 'automatic_recovery'",
		"release_kind = 'manual_clear'",
		"released_snapshot_id is not null",
		"released_snapshot_id is null",
		"override_row.cleared_by <> 'auto: reputation_recovered'",
		"unresolved or unattributed deliverability remediation requires exact operator reconciliation",
		"never infer episode identity from tenant alone",
		"invalid automatic-apply snapshot evidence",
		"snapshot.tenant_id is distinct from remediation.tenant_id",
		"snapshot.score is distinct from remediation.applied_score",
		"snapshot.sample_qualified is distinct from true",
		"snapshot.model_version is distinct from '" + strings.ToLower(DeliverabilityScoreModelVersion) + "'",
		"snapshot.score >= " + strconv.Itoa(AutoThrottleScoreThreshold),
		"invalid automatic-release snapshot evidence",
		"snapshot.score is distinct from remediation.released_score",
		"snapshot.score < " + strconv.Itoa(AutoThrottleRecoveryThreshold),
		"active deliverability override is missing its exact open remediation episode",
		"inverse lifecycle cardinality",
		"active deliverability override no longer owns its installed sending cap",
		"settings.max_sends_per_hour is distinct from",
		"hard-drain every pre-route46 api/worker task",
		"rolling old/new overlap is forbidden",
		"release_kind is null",
		"defensive decoding",
		"tenant_sending_cap_mutation_receipts_committed_cap_check",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration is missing invariant %q", required)
		}
	}
}
