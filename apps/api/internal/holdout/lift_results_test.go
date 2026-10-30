// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"strings"
	"testing"
	"time"
)

func TestConversionSetHashIsOrderIndependentAndBindsResolution(t *testing.T) {
	at := time.Date(2026, 8, 14, 9, 0, 0, 123456000, time.UTC)
	first := resolvedLiftConversion{
		ConversionID: 9, RecipientID: "00000000-0000-4000-8000-000000000009",
		Arm: "treatment", EventName: "purchase", OccurredAt: at,
		ResolutionSource: "identity_touch:email_sha256",
	}
	second := resolvedLiftConversion{
		ConversionID: 3, RecipientID: "00000000-0000-4000-8000-000000000003",
		Arm: "control", EventName: "purchase", OccurredAt: at.Add(time.Minute),
		ResolutionSource: "subscriber_email",
	}
	forward := hashResolvedConversionSet([]resolvedLiftConversion{first, second})
	reverse := hashResolvedConversionSet([]resolvedLiftConversion{second, first})
	if forward != reverse {
		t.Fatalf("conversion-set hash depends on query order: %s != %s", forward, reverse)
	}
	first.ResolutionSource = "external_id"
	if got := hashResolvedConversionSet([]resolvedLiftConversion{first, second}); got == forward {
		t.Fatal("conversion-set hash did not bind the identity-resolution evidence")
	}
}

func TestEvidenceHashRejectsAChangedPublishedCount(t *testing.T) {
	zero := 0.0
	result := &LiftResult{
		ID:            "00000000-0000-4000-8000-000000000001",
		TenantID:      "00000000-0000-4000-8000-000000000002",
		CampaignID:    "00000000-0000-4000-8000-000000000003",
		ResultVersion: LiftResultVersion, MethodologyVersion: LiftMethodologyVersion,
		Metric:      "purchase",
		WindowStart: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		WindowEnd:   time.Date(2026, 8, 8, 0, 0, 0, 0, time.UTC),
		NTreatment:  100, NControl: 100,
		ConversionsTreatment: 10, ConversionsControl: 10,
		RateTreatment: 0.1, RateControl: 0.1, Status: "powered",
		AbsoluteLift: &zero, RelativeLift: &zero, IncrementalConversions: &zero,
		PValue: 1, CILow: &zero, CIHigh: &zero,
		MinimumDetectableEffect: 0.1, MinimumRelativeEffect: 1,
		AssignmentSetSHA256:  strings.Repeat("a", 64),
		ConversionSetSHA256:  strings.Repeat("b", 64),
		MethodologyStatement: LiftMethodologyStatement,
		GeneratedAt:          time.Date(2026, 8, 8, 1, 0, 0, 0, time.UTC),
	}
	result.EvidenceSHA256 = hashLiftResultEvidence(result)
	if err := validateLiftResultEvidence(result); err != nil {
		t.Fatalf("valid evidence refused: %v", err)
	}
	result.ConversionsTreatment++
	if err := validateLiftResultEvidence(result); err == nil {
		t.Fatal("changed published count retained a valid evidence digest")
	}
}
