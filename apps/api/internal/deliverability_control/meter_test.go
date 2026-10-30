// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_control

import (
	"context"
	"testing"
)

// The unknown-resource guard runs before any DB access, so a nil-pool Repo
// exercises it without a database. The metering SQL itself (plan-derived seed,
// conditional consume, and hard block) is verified against PG16.
func TestCheckAndConsume_UnknownResource(t *testing.T) {
	if _, _, err := (&Repo{}).CheckAndConsume(context.Background(), "t1", "not_a_resource"); err == nil {
		t.Fatal("expected an error for an unknown metered resource")
	}
}

func TestMeterColumns_AllowList(t *testing.T) {
	for _, res := range []string{"inbox_tests", "render_previews"} {
		if _, ok := meterColumns[res]; !ok {
			t.Errorf("metered resource %q missing from allow-list", res)
		}
	}
	if _, ok := meterColumns["'; DROP TABLE x; --"]; ok {
		t.Error("allow-list must reject arbitrary resource names")
	}
}

func TestCanonicalDeliverabilityAllowance(t *testing.T) {
	tests := []struct {
		tier     string
		wantTier string
		inbox    int
		previews int
	}{
		{tier: "sandbox", wantTier: "sandbox"},
		{tier: "studio", wantTier: "studio"},
		{tier: "launch", wantTier: "launch", inbox: 5, previews: 50},
		{tier: "growth", wantTier: "growth", inbox: 25, previews: 250},
		{tier: "scale", wantTier: "scale", inbox: 100, previews: 1000},
		{tier: "sending", wantTier: "launch", inbox: 5, previews: 50},
		{tier: "PRO", wantTier: "scale", inbox: 100, previews: 1000},
		{tier: "unknown", wantTier: "sandbox"},
	}
	for _, tt := range tests {
		t.Run(tt.tier, func(t *testing.T) {
			got := canonicalDeliverabilityAllowance(tt.tier)
			if got.Tier != tt.wantTier || got.InboxTests != tt.inbox || got.RenderPreviews != tt.previews {
				t.Fatalf("allowance(%q) = %+v, want tier=%q inbox=%d previews=%d",
					tt.tier, got, tt.wantTier, tt.inbox, tt.previews)
			}
		})
	}
}
