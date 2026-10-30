// SPDX-License-Identifier: AGPL-3.0-only
package activation_firewall

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/consent"
)

func TestPurposeForDestinationType(t *testing.T) {
	cases := []struct {
		dest string
		want consent.Purpose
	}{
		{"meta", consent.PurposeTargetedAds},
		{"google_ads", consent.PurposeTargetedAds},
		{"googleads", consent.PurposeTargetedAds},
		{"tiktok", consent.PurposeTargetedAds},
		{"linkedin", consent.PurposeTargetedAds},
		{"snap", consent.PurposeTargetedAds},
		{"ads", consent.PurposeTargetedAds},
		{"META", consent.PurposeTargetedAds}, // case-insensitive
		{"  meta  ", consent.PurposeTargetedAds},
		{"webhook", consent.PurposeEmailMarketing},
		{"warehouse", consent.PurposeProfiling},
		{"zerocopy", consent.PurposeProfiling},
		{"snowflake", consent.PurposeProfiling},
		{"bigquery", consent.PurposeProfiling},
		{"", consent.PurposeEmailMarketing},             // conservative default
		{"unknown_dest", consent.PurposeEmailMarketing}, // conservative default
	}
	for _, c := range cases {
		if got := PurposeForDestinationType(c.dest); got != c.want {
			t.Errorf("PurposeForDestinationType(%q) = %q, want %q", c.dest, got, c.want)
		}
	}
}

func TestResolvePurpose(t *testing.T) {
	// No override → destination default.
	if got := ResolvePurpose("meta", ""); got != consent.PurposeTargetedAds {
		t.Errorf("ResolvePurpose(meta, '') = %q, want targeted_ads", got)
	}
	// Valid override wins over the destination default.
	if got := ResolvePurpose("webhook", "profiling"); got != consent.PurposeProfiling {
		t.Errorf("ResolvePurpose(webhook, profiling) = %q, want profiling", got)
	}
	// Override is case/space-insensitive.
	if got := ResolvePurpose("webhook", "  Targeted_Ads "); got != consent.PurposeTargetedAds {
		t.Errorf("ResolvePurpose(webhook, ' Targeted_Ads ') = %q, want targeted_ads", got)
	}
	// Invalid override is ignored — default mapping wins (never silently
	// disables the gate).
	if got := ResolvePurpose("warehouse", "garbage"); got != consent.PurposeProfiling {
		t.Errorf("ResolvePurpose(warehouse, garbage) = %q, want profiling (default)", got)
	}
}
