// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

type captureAnalyticsSubscriber struct{ input subscribers.CreateInput }

func (c *captureAnalyticsSubscriber) Upsert(_ context.Context, _ string, in subscribers.CreateInput) (*subscribers.Subscriber, error) {
	c.input = in
	return &subscribers.Subscriber{ID: "sub-1"}, nil
}

func TestAnalyticsProviderTraitsPreserveRawDataWithoutReservedMetadataInjection(t *testing.T) {
	repo := &captureAnalyticsSubscriber{}
	traits := map[string]any{"plan": "free", "$geoip_continent_name": "Synthetic", "gp:qa_fixture": "True", "groups": []any{"qa"}, "nested": map[string]any{"qa": true}, "_listmonk_id": 999, "analytics_provider": "spoofed"}
	_, err := (SubscriberProfileSink{Repo: repo}).UpsertAnalyticsProfile(context.Background(), "tenant", ProviderPostHog, ProfileInput{Email: "qa@example.com", Traits: traits})
	if err != nil {
		t.Fatal(err)
	}
	props := repo.input.CustomFields
	raw, _ := props["_analytics_traits"].(map[string]any)
	if props["plan"] != "free" || props["analytics_provider"] != ProviderPostHog || raw["$geoip_continent_name"] != "Synthetic" || raw["gp:qa_fixture"] != "True" || len(raw) != len(traits) {
		t.Fatal("analytics provider traits were lost or provenance was spoofed")
	}
	for _, key := range []string{"_listmonk_id", "$geoip_continent_name", "gp:qa_fixture", "nested", "groups"} {
		if _, found := props[key]; found {
			t.Fatalf("untrusted/reserved or incompatible trait %q escaped to custom-field authority", key)
		}
	}
	if traits["analytics_provider"] != "spoofed" || repo.input.Status != subscribers.StatusUnconfirmed || !repo.input.PreserveConsentState {
		t.Fatal("provider input or canonical consent was mutated")
	}
}
