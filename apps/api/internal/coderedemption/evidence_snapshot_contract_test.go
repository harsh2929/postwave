// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

import (
	"os"
	"strings"
	"testing"
)

// The evidence endpoint derives its summary/total before reading the page.
// Keeping those statements on one snapshot is part of the response contract:
// otherwise concurrent attribution writes can make page_info contradict the
// returned rows and strict clients will correctly reject the receipt.
func TestCampaignEvidenceReceiptUsesOneReadOnlyRepeatableSnapshot(t *testing.T) {
	source, err := os.ReadFile("evidence.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"IsoLevel:   pgx.RepeatableRead",
		"AccessMode: pgx.ReadOnly",
		"campaignEvidenceSummarySQL",
		"campaignEvidenceItemsSQL",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("campaign evidence snapshot contract lost %q", required)
		}
	}
}

func TestCampaignEvidenceSummaryRejectsContradictoryCounts(t *testing.T) {
	valid := CampaignEvidenceSummary{
		CodeAllocations:          3,
		CodeRedemptions:          2,
		CodeLinkedOutcomes:       2,
		NoClickRedemptions:       1,
		WithClickRedemptions:     0,
		ClickEvidenceUnavailable: 1,
		VanityVisits:             2,
		VanityLinkedOutcomes:     1,
	}
	if !validCampaignEvidenceSummary(valid) {
		t.Fatal("valid authoritative summary was rejected")
	}
	tests := map[string]CampaignEvidenceSummary{
		"more redemptions than allocations": func() CampaignEvidenceSummary {
			value := valid
			value.CodeRedemptions = 4
			return value
		}(),
		"click observations do not partition redemptions": func() CampaignEvidenceSummary {
			value := valid
			value.ClickEvidenceUnavailable = 0
			return value
		}(),
		"more code outcomes than allocations": func() CampaignEvidenceSummary {
			value := valid
			value.CodeLinkedOutcomes = 4
			return value
		}(),
		"more vanity outcomes than visits": func() CampaignEvidenceSummary {
			value := valid
			value.VanityLinkedOutcomes = 3
			return value
		}(),
	}
	for name, summary := range tests {
		t.Run(name, func(t *testing.T) {
			if validCampaignEvidenceSummary(summary) {
				t.Fatalf("contradictory summary accepted: %+v", summary)
			}
		})
	}
}
