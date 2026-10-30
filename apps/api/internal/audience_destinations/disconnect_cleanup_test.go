package audience_destinations

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestAudienceDestinationDisconnectCleanupEvidenceIsOperatorManaged(t *testing.T) {
	dest := &Destination{
		Provider:           ProviderMeta,
		ExternalAudienceID: "23850000000000000",
		Status:             StatusActive,
		rawConfig: map[string]any{
			"credential_ref":   "vault://integrations/meta/ads-token",
			"provider_cleanup": map[string]any{"status": "spoofed"},
		},
	}

	cleanup := audienceDestinationDisconnectCleanupEvidence(dest)
	if cleanup == nil {
		t.Fatal("cleanup evidence is nil")
	}
	if cleanup.Provider != string(ProviderMeta) ||
		cleanup.Status != "operator_action_required" ||
		cleanup.PostwaveStatus != string(StatusDisconnected) ||
		cleanup.ProviderCleanupPosture != "operator_managed_provider_console" ||
		cleanup.ManagedProviderCleanup {
		t.Fatalf("cleanup evidence has unexpected status/posture: %+v", cleanup)
	}
	if _, err := time.Parse(time.RFC3339, cleanup.RecordedAt); err != nil {
		t.Fatalf("recorded_at is not RFC3339: %q", cleanup.RecordedAt)
	}
	if cleanup.ProviderScopeType != "meta_audience_id" ||
		cleanup.ProviderScopeID != "23850000000000000" ||
		cleanup.ExternalAudienceID != "23850000000000000" {
		t.Fatalf("scope evidence = %+v", cleanup)
	}
	if !cleanup.CredentialRefPresent {
		t.Fatal("credential_ref should be reflected without exposing its value")
	}
	joined := strings.Join(append(cleanup.ProviderCleanupEvidence, cleanup.ProviderConsoleActions...), "\n")
	for _, want := range []string{
		"did not call Meta provider-side audience deletion APIs",
		"remove or clear the Meta Custom Audience",
		"revoke or rotate Meta ads access tokens",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("cleanup evidence/actions missing %q: %+v", want, cleanup)
		}
	}
	for _, effect := range cleanup.PostwaveEffects {
		if strings.Contains(strings.ToLower(effect), "delete") {
			t.Fatalf("local effect should not overclaim provider deletion: %q", effect)
		}
	}
}

func TestAudienceDestinationDisconnectCleanupScopeUsesProviderSpecificIDs(t *testing.T) {
	cases := []struct {
		provider Provider
		config   map[string]any
		scope    string
		id       string
	}{
		{ProviderGoogleAds, map[string]any{"user_list_id": "customers/123/userLists/456"}, "google_ads_user_list_id", "customers/123/userLists/456"},
		{ProviderTikTok, map[string]any{"audience_id": "aud_tiktok"}, "tiktok_audience_id", "aud_tiktok"},
		{ProviderLinkedIn, map[string]any{"segment_id": "urn:li:dmpSegment:123"}, "linkedin_segment_id", "urn:li:dmpSegment:123"},
		{ProviderSnap, map[string]any{"segment_id": "snap-seg"}, "snap_segment_id", "snap-seg"},
	}

	for _, tc := range cases {
		t.Run(string(tc.provider), func(t *testing.T) {
			scope, id := audienceDestinationCleanupScope(tc.provider, "", tc.config)
			if scope != tc.scope || id != tc.id {
				t.Fatalf("scope/id = %q/%q, want %q/%q", scope, id, tc.scope, tc.id)
			}
		})
	}
}

func TestStripAudienceProviderCleanupRemovesCallerSuppliedEvidence(t *testing.T) {
	cfg := stripAudienceProviderCleanup(map[string]any{
		"credential_ref":   "vault://ads/meta",
		"audience_id":      "aud-123",
		"provider_cleanup": map[string]any{"status": "stale"},
	})
	if _, ok := cfg["provider_cleanup"]; ok {
		t.Fatalf("provider_cleanup was not stripped: %+v", cfg)
	}
	raw := marshalDestinationConfig(cfg)
	var persisted map[string]any
	if err := json.Unmarshal(raw, &persisted); err != nil {
		t.Fatalf("marshalDestinationConfig produced invalid JSON: %v", err)
	}
	if persisted["credential_ref"] != "vault://ads/meta" || persisted["audience_id"] != "aud-123" {
		t.Fatalf("config values were not preserved: %+v", persisted)
	}
}
