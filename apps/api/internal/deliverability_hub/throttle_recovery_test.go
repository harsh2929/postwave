// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_hub

import (
	"testing"
	"time"
)

// A throttle a machine applied must be liftable by a machine.
//
// `observeAndMaybeAutoThrottle` installs a repair override automatically after a
// continuous 24-hour low-score period. `clearOverride` has exactly one non-test
// caller: the admin route. So a tenant whose reputation recovered stayed capped
// at half their sending rate until a human noticed and clicked — and nothing
// tells them to look, because the recovery is precisely the event that produces
// no alert.
//
// The entry rule is score < 50 sustained for 24h. Recovery must NOT be its
// mirror, or a tenant hovering at the threshold would be throttled and released
// repeatedly, and each cycle changes their send rate underneath a running
// campaign. Hysteresis: a higher exit score, sustained for its own window.

func TestRecoveryRequiresAHigherScoreThanTheEntryThreshold(t *testing.T) {
	if AutoThrottleRecoveryThreshold <= AutoThrottleScoreThreshold {
		t.Fatalf("recovery threshold %d is not above the entry threshold %d. Equal "+
			"thresholds mean a tenant sitting at the boundary is throttled and "+
			"released on alternate ticks, and each flip changes the send rate "+
			"under a running campaign.",
			AutoThrottleRecoveryThreshold, AutoThrottleScoreThreshold)
	}
}

func TestRecoveryRequiresASustainedWindow(t *testing.T) {
	// One good sample is noise. The entry rule demands 24h of evidence; release
	// must demand its own evidence rather than reacting to a single reading.
	if AutoThrottleRecoveryWindow <= 0 {
		t.Fatal("recovery has no sustain window, so a single high sample would " +
			"lift a cap installed on 24 hours of evidence")
	}
}

func TestTheRecoveryDecision(t *testing.T) {
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	long := now.Add(-(AutoThrottleRecoveryWindow + time.Hour))
	short := now.Add(-(AutoThrottleRecoveryWindow / 2))

	for _, tc := range []struct {
		name      string
		score     int
		qualified bool
		highSince *time.Time
		want      bool
		why       string
	}{
		{"recovered and sustained", AutoThrottleRecoveryThreshold + 5, true, &long, true,
			"a tenant well above the exit bar for the whole window is recovered"},
		{"recovered but not yet sustained", AutoThrottleRecoveryThreshold + 5, true, &short, false,
			"releasing on half the window is reacting to noise"},
		{"still below the exit bar", AutoThrottleRecoveryThreshold - 1, true, &long, false,
			"a score under the exit threshold is not a recovery, however long it holds"},
		{"between the two thresholds", AutoThrottleScoreThreshold + 1, true, &long, false,
			"above the ENTRY bar but below the EXIT bar is the hysteresis band — " +
				"staying throttled here is the whole point"},
		{"unqualified sample", AutoThrottleRecoveryThreshold + 5, false, &long, false,
			"an unqualified sample is not evidence in either direction"},
		{"no high period recorded", AutoThrottleRecoveryThreshold + 5, true, nil, false,
			"without a start there is no sustained window to measure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldReleaseThrottle(tc.score, tc.qualified, tc.highSince, now)
			if got != tc.want {
				t.Fatalf("shouldReleaseThrottle = %v, want %v. %s", got, tc.want, tc.why)
			}
		})
	}
}

func TestTheHighPeriodIsTrackedSymmetricallyWithTheLowOne(t *testing.T) {
	base := time.Date(2026, 8, 5, 0, 0, 0, 0, time.UTC)
	maxGap := 2 * time.Hour

	// A qualified sample above the recovery bar starts the high period.
	first, ok := advanceThrottleObservation(throttleObservation{},
		AutoThrottleRecoveryThreshold+5, true, base, maxGap)
	if !ok || first.HighSince == nil {
		t.Fatal("a qualified sample above the recovery bar did not start a high period")
	}

	// A second, later one extends rather than restarts it.
	second, _ := advanceThrottleObservation(first,
		AutoThrottleRecoveryThreshold+10, true, base.Add(time.Hour), maxGap)
	if second.HighSince == nil || !second.HighSince.Equal(*first.HighSince) {
		t.Fatalf("the high period restarted instead of extending: %v -> %v",
			first.HighSince, second.HighSince)
	}

	// A sample inside the hysteresis band clears it. This is the case the
	// two-threshold design exists for: above the ENTRY bar, below the EXIT bar,
	// accumulating evidence in neither direction.
	band, _ := advanceThrottleObservation(second,
		AutoThrottleScoreThreshold+1, true, base.Add(2*time.Hour), maxGap)
	if band.HighSince != nil {
		t.Error("a score in the hysteresis band kept the high period running, so a " +
			"tenant hovering between the thresholds would eventually be released " +
			"without ever clearing the exit bar")
	}
	if band.LowSince != nil {
		t.Error("a score in the hysteresis band started a LOW period; it is above " +
			"the entry threshold and must not count toward re-throttling either")
	}

	// A gap longer than the cadence breaks continuity, exactly as it does for
	// the low period — a worker outage is not evidence of recovery.
	afterGap, _ := advanceThrottleObservation(second,
		AutoThrottleRecoveryThreshold+5, true, base.Add(10*time.Hour), maxGap)
	if afterGap.HighSince == nil || afterGap.HighSince.Equal(*second.HighSince) {
		t.Error("a long observation gap extended the high period; 8 hours of " +
			"missing data is not 8 hours of good reputation")
	}
}

func TestAnUnqualifiedSampleDoesNotExtendTheHighPeriod(t *testing.T) {
	base := time.Date(2026, 8, 5, 0, 0, 0, 0, time.UTC)
	started, _ := advanceThrottleObservation(throttleObservation{},
		AutoThrottleRecoveryThreshold+5, true, base, 2*time.Hour)
	next, _ := advanceThrottleObservation(started,
		AutoThrottleRecoveryThreshold+5, false, base.Add(time.Hour), 2*time.Hour)
	if next.HighSince != nil {
		t.Error("an unqualified sample extended the high period. The entry rule " +
			"treats unqualified samples as no evidence; release must too, or a " +
			"tenant with too little volume to measure gets released on silence")
	}
}

func TestReleaseAndThrottleEligibilityAreMutuallyExclusive(t *testing.T) {
	// The release is invoked on the "not eligible to throttle" branch. That is
	// only correct because the two conditions cannot both hold: entry needs a
	// sustained LOW period, release needs a sustained HIGH one. Pinned so a
	// later change to either rule cannot silently make recovery unreachable —
	// the failure mode would be a tenant who never gets released, which is the
	// exact bug this work fixes.
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	old := now.Add(-48 * time.Hour)

	for _, obs := range []throttleObservation{
		{LowSince: &old, HighSince: &old, LastScore: AutoThrottleRecoveryThreshold + 5,
			SampleQualified: true, LastSampledAt: now},
		{LowSince: &old, HighSince: nil, LastScore: AutoThrottleScoreThreshold - 10,
			SampleQualified: true, LastSampledAt: now},
		{LowSince: nil, HighSince: &old, LastScore: AutoThrottleRecoveryThreshold + 5,
			SampleQualified: true, LastSampledAt: now},
	} {
		release := shouldReleaseThrottle(obs.LastScore, obs.SampleQualified, obs.HighSince, now)
		throttle := throttleObservationEligible(obs)
		if release && throttle {
			t.Fatalf("observation %+v is BOTH eligible to throttle and due for "+
				"release. The release is reachable only on the not-eligible "+
				"branch, so an observation that is both would take the throttle "+
				"path and never be released.", obs)
		}
	}
}
