// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import "testing"

func TestMapLoyaltyWebhookExtractsMemberAndEvent(t *testing.T) {
	body := []byte(`{"event":"points.earned","customer":{"email":"Ada@Example.com"},"points_balance":320,"vip_tier":{"name":"Gold"}}`)
	req, ok := mapLoyaltyWebhook("growave", body)
	if !ok {
		t.Fatal("expected mapped")
	}
	if len(req.Members) != 1 {
		t.Fatalf("members = %d", len(req.Members))
	}
	m := req.Members[0]
	if m.Email != "ada@example.com" || m.PointsBalance != 320 || m.VIPTier != "Gold" {
		t.Fatalf("member = %+v", m)
	}
	if m.SourceID != "growave://webhook/ada@example.com" {
		t.Fatalf("source id = %q", m.SourceID)
	}
	if len(req.Events) != 1 || req.Events[0].EventName != "points.earned" || req.Events[0].Email != "ada@example.com" {
		t.Fatalf("events = %+v", req.Events)
	}
	if req.RunMode != "webhook" {
		t.Fatalf("run mode = %q", req.RunMode)
	}
}

func TestMapLoyaltyWebhookTopLevelEmailNoTier(t *testing.T) {
	req, ok := mapLoyaltyWebhook("marsello", []byte(`{"email":"Bo@x.com","points":50}`))
	if !ok {
		t.Fatal("expected mapped")
	}
	if len(req.Members) != 1 || req.Members[0].Email != "bo@x.com" || req.Members[0].PointsBalance != 50 {
		t.Fatalf("member = %+v", req.Members)
	}
	if req.Members[0].VIPTier != "" {
		t.Fatalf("unexpected tier %q", req.Members[0].VIPTier)
	}
	// No event field => no event row.
	if len(req.Events) != 0 {
		t.Fatalf("events = %d", len(req.Events))
	}
}

func TestMapLoyaltyWebhookDataWrappedAndStringTier(t *testing.T) {
	body := []byte(`{"topic":"vip_tier.changed","data":{"customer_email":"Cara@x.com","tier":"Platinum"}}`)
	req, ok := mapLoyaltyWebhook("loyaltylion", body)
	if !ok {
		t.Fatal("expected mapped")
	}
	if req.Members[0].Email != "cara@x.com" || req.Members[0].VIPTier != "Platinum" {
		t.Fatalf("member = %+v", req.Members[0])
	}
	if req.Events[0].EventName != "vip_tier.changed" {
		t.Fatalf("event = %+v", req.Events[0])
	}
}

func TestMapLoyaltyWebhookNoEmailSkipped(t *testing.T) {
	if _, ok := mapLoyaltyWebhook("growave", []byte(`{"event":"points.earned","points":10}`)); ok {
		t.Fatal("payload without email must not map")
	}
}
