// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"testing"
	"time"
)

func healthTestNow() time.Time {
	return time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
}

func healthEvidence(kind HealthEvidenceKind, ago time.Duration, code string) HealthEvidence {
	return HealthEvidence{Kind: kind, At: healthTestNow().Add(-ago), Source: "test", ReasonCode: code}
}

func TestResolveEmailHealthGradeMatrix(t *testing.T) {
	now := healthTestNow()
	tests := []struct {
		name           string
		input          HealthInput
		grade          HealthGrade
		recommendation HealthRecommendation
		eligible       bool
	}{
		{
			name: "A fresh vendor valid",
			input: HealthInput{Verification: &Result{
				Status: StatusValid, Provider: ProviderKickbox,
				CheckedAt: now.Add(-HealthVerificationFreshness),
			}},
			grade: HealthGradeA, recommendation: HealthRecommendationSend, eligible: true,
		},
		{
			name: "B click",
			input: HealthInput{Evidence: []HealthEvidence{
				healthEvidence(HealthEvidenceClick, time.Hour, "human_click"),
			}},
			grade: HealthGradeB, recommendation: HealthRecommendationSend, eligible: true,
		},
		{
			name: "A fresh valid outranks positive activity",
			input: HealthInput{
				Verification: &Result{
					Status: StatusValid, Provider: ProviderZeroBounce,
					CheckedAt: now.Add(-time.Hour),
				},
				Evidence: []HealthEvidence{healthEvidence(HealthEvidenceReply, time.Minute, "human_reply")},
			},
			grade: HealthGradeA, recommendation: HealthRecommendationSend, eligible: true,
		},
		{
			name: "B reply",
			input: HealthInput{Evidence: []HealthEvidence{
				healthEvidence(HealthEvidenceReply, time.Hour, "human_reply"),
			}},
			grade: HealthGradeB, recommendation: HealthRecommendationSend, eligible: true,
		},
		{
			name: "B delivered",
			input: HealthInput{Evidence: []HealthEvidence{
				healthEvidence(HealthEvidenceDelivered, time.Hour, "provider_delivered"),
			}},
			grade: HealthGradeB, recommendation: HealthRecommendationSend, eligible: true,
		},
		{
			name: "U reserved vendor activity is advisory",
			input: HealthInput{Evidence: []HealthEvidence{
				healthEvidence(HealthEvidenceVendorActivity, time.Hour, "vendor_activity"),
			}},
			grade: HealthGradeU, recommendation: HealthRecommendationCaution, eligible: true,
		},
		{
			name: "C catch all",
			input: HealthInput{Verification: &Result{
				Status: StatusCatchAll, Provider: ProviderKickbox, CheckedAt: now.Add(-time.Hour),
			}},
			grade: HealthGradeC, recommendation: HealthRecommendationCaution, eligible: true,
		},
		{
			name: "D recent soft bounce",
			input: HealthInput{Evidence: []HealthEvidence{
				healthEvidence(HealthEvidenceSoftBounce, time.Hour, "soft_bounce"),
			}},
			grade: HealthGradeD, recommendation: HealthRecommendationDoNotSend,
		},
		{
			name: "D ambiguous negative",
			input: HealthInput{Evidence: []HealthEvidence{
				healthEvidence(HealthEvidenceAmbiguousNegative, time.Hour, "unclassified_bounce"),
			}},
			grade: HealthGradeD, recommendation: HealthRecommendationDoNotSend,
		},
		{
			name: "D recent hard bounce",
			input: HealthInput{Evidence: []HealthEvidence{
				healthEvidence(HealthEvidenceHardBounce, time.Hour, "hard_bounce"),
			}},
			grade: HealthGradeD, recommendation: HealthRecommendationDoNotSend,
		},
		{
			name: "F complaint",
			input: HealthInput{Evidence: []HealthEvidence{
				healthEvidence(HealthEvidenceComplaint, time.Hour, "complaint"),
			}},
			grade: HealthGradeF, recommendation: HealthRecommendationBlocked,
		},
		{
			name:  "U no evidence",
			input: HealthInput{},
			grade: HealthGradeU, recommendation: HealthRecommendationCaution, eligible: true,
		},
		{
			name: "U opens alone are not high confidence",
			input: HealthInput{Evidence: []HealthEvidence{
				healthEvidence(HealthEvidenceOpen, time.Hour, "opened"),
			}},
			grade: HealthGradeU, recommendation: HealthRecommendationCaution, eligible: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.input.Email = "Person@Example.COM"
			tt.input.AsOf = now
			got := ResolveEmailHealth(tt.input)
			if got.Grade != tt.grade || got.Recommendation != tt.recommendation || got.SendEligible != tt.eligible {
				t.Fatalf("got grade=%q recommendation=%q eligible=%v; want %q %q %v; result=%+v",
					got.Grade, got.Recommendation, got.SendEligible,
					tt.grade, tt.recommendation, tt.eligible, got)
			}
			if got.Email != "person@example.com" || got.ModelVersion != HealthModelVersion ||
				!got.ComputedAt.Equal(now) || len(got.ReasonCodes) == 0 {
				t.Fatalf("incomplete contract: %+v", got)
			}
		})
	}
}

func TestAttachHealthMatchesNormalizedAddresses(t *testing.T) {
	results := []Result{{Email: "Person@Example.COM", Status: StatusValid}, {Email: "other@example.com"}}
	health := []EmailHealth{{Email: "person@example.com", Grade: HealthGradeA}}
	got := AttachHealth(results, health)
	if got[0].Health == nil || got[0].Health.Grade != HealthGradeA {
		t.Fatalf("matching result was not enriched: %+v", got[0])
	}
	if got[1].Health != nil {
		t.Fatalf("unmatched result was unexpectedly enriched: %+v", got[1])
	}
}

func TestResolveEmailHealthEveryHardVerificationStatusIsF(t *testing.T) {
	now := healthTestNow()
	for _, status := range []Status{StatusInvalid, StatusSpamtrap, StatusAbuse, StatusDoNotMail} {
		t.Run(string(status), func(t *testing.T) {
			got := ResolveEmailHealth(HealthInput{
				Email: "person@example.com", AsOf: now,
				Verification: &Result{Status: status, Provider: ProviderZeroBounce, CheckedAt: now},
			})
			if got.Grade != HealthGradeF || got.Recommendation != HealthRecommendationBlocked || got.SendEligible {
				t.Fatalf("status %q resolved to %+v", status, got)
			}
		})
	}
}

func TestResolveEmailHealthFreshnessBoundaries(t *testing.T) {
	now := healthTestNow()
	justStale := now.Add(-HealthVerificationFreshness - time.Nanosecond)
	got := ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now,
		Verification: &Result{
			Status: StatusValid, Provider: ProviderKickbox, CheckedAt: justStale,
		},
	})
	if got.Grade != HealthGradeU || got.ReasonCodes[0] != "verification_stale" {
		t.Fatalf("stale valid = %+v", got)
	}

	got = ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now,
		Evidence: []HealthEvidence{healthEvidence(
			HealthEvidenceSoftBounce, HealthSoftNegativeFreshness+time.Nanosecond, "old_soft_bounce",
		)},
	})
	if got.Grade != HealthGradeU {
		t.Fatalf("old soft bounce = %+v, want U", got)
	}

	got = ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now,
		Evidence: []HealthEvidence{healthEvidence(
			HealthEvidenceHardBounce, HealthSoftNegativeFreshness+time.Nanosecond, "old_hard_bounce",
		)},
	})
	if got.Grade != HealthGradeU {
		t.Fatalf("old hard bounce = %+v, want U", got)
	}
}

func TestResolveEmailHealthRequiresTrustedProviderForAffirmativeMailboxGrades(t *testing.T) {
	now := healthTestNow()
	for _, tt := range []struct {
		name     string
		status   Status
		provider string
	}{
		{name: "local valid", status: StatusValid, provider: ProviderLocal},
		{name: "blank valid", status: StatusValid},
		{name: "forged provider valid", status: StatusValid, provider: "KICKBOX"},
		{name: "local catch all", status: StatusCatchAll, provider: ProviderLocal},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveEmailHealth(HealthInput{
				Email: "person@example.com", AsOf: now,
				Verification: &Result{
					Status: tt.status, Provider: tt.provider, CheckedAt: now,
				},
			})
			if got.Grade != HealthGradeU || got.Recommendation != HealthRecommendationCaution {
				t.Fatalf("untrusted mailbox verdict = %+v, want U/caution", got)
			}
		})
	}
}

func TestResolveEmailHealthReservedVendorActivityCannotRetireNegative(t *testing.T) {
	now := healthTestNow()
	got := ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now,
		Evidence: []HealthEvidence{
			healthEvidence(HealthEvidenceHardBounce, 2*time.Hour, "hard_bounce"),
			healthEvidence(HealthEvidenceVendorActivity, time.Hour, "vendor_activity"),
		},
	})
	if got.Grade != HealthGradeD || got.ReasonCodes[0] != "hard_bounce" {
		t.Fatalf("reserved vendor activity retired a negative: %+v", got)
	}
}

func TestResolveEmailHealthFutureClockTolerance(t *testing.T) {
	now := healthTestNow()
	withinTolerance := ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now,
		Evidence: []HealthEvidence{{
			Kind: HealthEvidenceHardBounce, At: now.Add(healthFutureClockTolerance),
			Source: "test", ReasonCode: "future_within_tolerance",
		}},
	})
	if withinTolerance.Grade != HealthGradeD {
		t.Fatalf("within-tolerance hard bounce = %+v, want D", withinTolerance)
	}

	for _, kind := range []HealthEvidenceKind{HealthEvidenceHardBounce, HealthEvidenceComplaint} {
		got := ResolveEmailHealth(HealthInput{
			Email: "person@example.com", AsOf: now,
			Evidence: []HealthEvidence{{
				Kind: kind, At: now.Add(healthFutureClockTolerance + time.Nanosecond),
				Source: "test", ReasonCode: "implausible_future",
			}},
		})
		if got.Grade != HealthGradeU {
			t.Fatalf("implausible future %s = %+v, want U", kind, got)
		}
	}
}

func TestResolveEmailHealthNewerNegativeOverridesOlderPositive(t *testing.T) {
	now := healthTestNow()
	got := ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now,
		Evidence: []HealthEvidence{
			healthEvidence(HealthEvidenceClick, 48*time.Hour, "clicked"),
			healthEvidence(HealthEvidenceSoftBounce, time.Hour, "soft_bounce"),
		},
	})
	if got.Grade != HealthGradeD || got.ReasonCodes[0] != "soft_bounce" {
		t.Fatalf("newer negative did not win: %+v", got)
	}

	got = ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now,
		Evidence: []HealthEvidence{
			healthEvidence(HealthEvidenceSoftBounce, 48*time.Hour, "old_soft_bounce"),
			healthEvidence(HealthEvidenceReply, time.Hour, "new_reply"),
		},
	})
	if got.Grade != HealthGradeB || got.ReasonCodes[0] != "new_reply" {
		t.Fatalf("later positive did not retire non-active soft warning: %+v", got)
	}

	got = ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now,
		Evidence: []HealthEvidence{
			healthEvidence(HealthEvidenceHardBounce, 48*time.Hour, "old_hard_bounce"),
			healthEvidence(HealthEvidenceDelivered, time.Hour, "new_delivery"),
		},
	})
	if got.Grade != HealthGradeB || got.ReasonCodes[0] != "new_delivery" {
		t.Fatalf("later positive did not retire non-active hard warning: %+v", got)
	}
}

func TestResolveEmailHealthValidVerificationParticipatesInChronology(t *testing.T) {
	now := healthTestNow()
	tests := []struct {
		name        string
		validAgo    time.Duration
		negativeAgo time.Duration
		activity    []HealthEvidence
		wantGrade   HealthGrade
		wantReason  string
	}{
		{
			name: "newer valid retires older bounce", validAgo: time.Hour,
			negativeAgo: 2 * time.Hour, wantGrade: HealthGradeA,
			wantReason: "verification_valid_30d",
		},
		{
			name: "newer bounce overrides older valid", validAgo: 2 * time.Hour,
			negativeAgo: time.Hour, wantGrade: HealthGradeD,
			wantReason: "historical_bounce",
		},
		{
			name: "equal timestamp is conservative", validAgo: time.Hour,
			negativeAgo: time.Hour, wantGrade: HealthGradeD,
			wantReason: "historical_bounce",
		},
		{
			name:     "activity after bounce recovers when validation predates it",
			validAgo: 3 * time.Hour, negativeAgo: 2 * time.Hour,
			activity: []HealthEvidence{
				healthEvidence(HealthEvidenceDelivered, time.Hour, "new_delivery"),
			},
			wantGrade: HealthGradeB, wantReason: "new_delivery",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveEmailHealth(HealthInput{
				Email: "person@example.com", AsOf: now,
				Verification: &Result{
					Status: StatusValid, Provider: ProviderKickbox,
					CheckedAt: now.Add(-tt.validAgo),
				},
				Evidence: append(tt.activity, HealthEvidence{
					Kind: HealthEvidenceHardBounce, At: now.Add(-tt.negativeAgo),
					Source: "test", ReasonCode: "historical_bounce",
				}),
			})
			if got.Grade != tt.wantGrade || got.ReasonCodes[0] != tt.wantReason {
				t.Fatalf("result = %+v, want grade %s reason %s", got, tt.wantGrade, tt.wantReason)
			}
		})
	}
}

func TestResolveEmailHealthHardStopCannotBeOverridden(t *testing.T) {
	now := healthTestNow()
	got := ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now, HardStop: true,
		HardStopReasonCodes: []string{"consent_unsubscribed"},
		Verification:        &Result{Status: StatusValid, CheckedAt: now},
		Evidence: []HealthEvidence{
			healthEvidence(HealthEvidenceReply, time.Minute, "new_reply"),
		},
	})
	if got.Grade != HealthGradeF || got.Recommendation != HealthRecommendationBlocked ||
		!got.HardStop || got.SendEligible {
		t.Fatalf("hard stop was overridden: %+v", got)
	}
	if got.ReasonCodes[0] != "consent_unsubscribed" {
		t.Fatalf("hard-stop reason lost: %v", got.ReasonCodes)
	}
}

func TestResolveEmailHealthActiveSoftSuppressionIsDButBlocked(t *testing.T) {
	now := healthTestNow()
	got := ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now, HardStop: true,
		HardStopReasonCodes: []string{"suppression_soft_bounce_threshold"},
		Evidence: []HealthEvidence{
			healthEvidence(HealthEvidenceSoftBounce, time.Hour, "suppression_soft_bounce_threshold"),
		},
	})
	if got.Grade != HealthGradeD || got.Recommendation != HealthRecommendationBlocked || got.SendEligible {
		t.Fatalf("active soft suppression = %+v", got)
	}
}

func TestResolveEmailHealthConsentAndActiveHardBounceStayF(t *testing.T) {
	now := healthTestNow()
	for _, tt := range []struct {
		name   string
		codes  []string
		kind   HealthEvidenceKind
		reason string
	}{
		{
			name: "consent with recoverable bounce", codes: []string{"consent_unsubscribed"},
			kind: HealthEvidenceSoftBounce, reason: "soft_bounce",
		},
		{
			name: "active hard bounce suppression", codes: []string{"suppression_hard_bounce"},
			kind: HealthEvidenceHardBounce, reason: "hard_bounce",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveEmailHealth(HealthInput{
				Email: "person@example.com", AsOf: now, HardStop: true,
				HardStopReasonCodes: tt.codes,
				Evidence:            []HealthEvidence{healthEvidence(tt.kind, time.Hour, tt.reason)},
			})
			if got.Grade != HealthGradeF || got.Recommendation != HealthRecommendationBlocked || got.SendEligible {
				t.Fatalf("authoritative hard stop = %+v", got)
			}
		})
	}
}

func TestResolveEmailHealthReturnsDeterministicPublicEvidence(t *testing.T) {
	now := healthTestNow()
	duplicate := healthEvidence(HealthEvidenceClick, time.Hour, "Clicked By Human")
	got := ResolveEmailHealth(HealthInput{
		Email: "person@example.com", AsOf: now,
		Verification: &Result{
			Status: StatusValid, Score: intPtr(8), Provider: ProviderKickbox, CheckedAt: now.Add(-2 * time.Hour),
		},
		Evidence: []HealthEvidence{
			healthEvidence(HealthEvidenceDelivered, 3*time.Hour, "delivered"),
			duplicate, duplicate,
		},
	})
	if len(got.Evidence) != 2 {
		t.Fatalf("evidence was not deduplicated: %+v", got.Evidence)
	}
	if got.Evidence[0].ReasonCode != "clicked_by_human" || got.EvidenceAt == nil ||
		!got.EvidenceAt.Equal(got.Evidence[0].At) {
		t.Fatalf("evidence order/normalization = %+v; evidence_at=%v", got.Evidence, got.EvidenceAt)
	}
	if got.Status != StatusValid || got.Score == nil || *got.Score != 8 ||
		got.Provider != ProviderKickbox || got.CheckedAt == nil ||
		!got.CheckedAt.Equal(now.Add(-2*time.Hour)) {
		t.Fatalf("verification provenance missing: %+v", got)
	}
}

func intPtr(value int) *int { return &value }
