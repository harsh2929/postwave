// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestSplitLegacyLabel(t *testing.T) {
	cases := []struct{ in, k, l string }{
		{"[swag] Hoodie", "swag", "Hoodie"},
		{"[free] 1 month free", "free", "1 month free"},
		{"[annual] One year on us", "annual", "One year on us"},
		{"[custom] Anything", "custom", "Anything"},
		{"plain label without prefix", "custom", "plain label without prefix"},
		{"[points] thing", "points", "thing"},
		{"", "custom", ""},
	}
	for _, c := range cases {
		k, l := splitLegacyLabel(c.in)
		if k != c.k || l != c.l {
			t.Errorf("splitLegacyLabel(%q) = (%q, %q), want (%q, %q)", c.in, k, l, c.k, c.l)
		}
	}
}

func TestEncodeLegacyLabel(t *testing.T) {
	cases := []struct {
		kind, label, want string
	}{
		{"swag", "Hoodie", "[swag] Hoodie"},
		{"free", "1 month free", "[free] 1 month free"},
		{"", "Anything", "[custom] Anything"},
		{"points", "X", "[points] X"},
	}
	for _, c := range cases {
		if got := encodeLegacyLabel(c.kind, c.label); got != c.want {
			t.Errorf("encodeLegacyLabel(%q, %q) = %q, want %q", c.kind, c.label, got, c.want)
		}
	}
}

func TestDecodeLegacyMilestonesRoundTrip(t *testing.T) {
	raw := []byte(`[
		{"count":1,"reward_label":"[swag] Hoodie"},
		{"count":5,"reward_label":"[free] 1 month free"},
		{"count":10,"reward_label":"unprefixed"}
	]`)
	out := decodeLegacyMilestones(raw)
	if len(out) != 3 {
		t.Fatalf("decoded %d milestones, want 3", len(out))
	}
	if out[0].RewardKind != "swag" || out[0].RewardLabel != "Hoodie" {
		t.Errorf("milestone[0] = %+v", out[0])
	}
	if out[2].RewardKind != "custom" || out[2].RewardLabel != "unprefixed" {
		t.Errorf("milestone[2] = %+v", out[2])
	}
}

func TestDecodeLegacyMilestonesEmptyOrBadInput(t *testing.T) {
	if out := decodeLegacyMilestones(nil); out != nil {
		t.Errorf("nil input should return nil, got %v", out)
	}
	if out := decodeLegacyMilestones([]byte("not json")); out != nil {
		t.Errorf("malformed input should return nil, got %v", out)
	}
}

func TestStatsHandler503WhenRepoMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/referrals/stats", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).Stats(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503, body=%s", rec.Code, rec.Body.String())
	}
}

func TestStatsHandlerRejectsMissingTenant(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/referrals/stats", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).Stats(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401, body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreditHandler503WhenRepoMissing(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/referrals/credit",
		strings.NewReader(`{"subscriber_id":"abc"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Deps{}).Credit(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

// SetProgram normalisation: passes through reward_kind unchanged
// for known kinds; defaults to "custom" when omitted.
func TestMilestoneRewardKindNormalisation(t *testing.T) {
	// Just verify the helper invariants; the actual SetProgram
	// roundtrip needs a live DB.
	if encodeLegacyLabel("swag", "x") != "[swag] x" {
		t.Error("known kind preserved")
	}
	if encodeLegacyLabel("", "x") != "[custom] x" {
		t.Error("empty kind defaults to custom")
	}
}
