// SPDX-License-Identifier: AGPL-3.0-only
//
// loyalty_realpayload_test.go — certifies mapLoyaltyWebhook against REAL provider
// webhook bodies taken verbatim from official docs (shapes that a naive mapper
// misses): Growave (docs.growave.io) and LoyaltyLion (developers.loyaltylion.com).
package loyalty_integrations

import "testing"

// Growave: email under customer.email, points at ROOT camelCase `currentBalance`,
// event in an X-Growave-Topic header (not the body).
func TestMapLoyaltyWebhookGrowaveRealPayload(t *testing.T) {
	body := []byte(`{
      "timestamp":"2024-05-27T06:34:39.662Z",
      "customer":{"email":"Customer@Gmail.com","phone":null,"shopifyCustomerId":5784483037269},
      "currentBalance":2000.5,
      "balanceDelta":-121.5
    }`)
	req, ok := mapLoyaltyWebhook(ProviderGrowave, body)
	if !ok || len(req.Members) != 1 {
		t.Fatalf("growave payload not mapped: ok=%v req=%+v", ok, req)
	}
	m := req.Members[0]
	if m.Email != "customer@gmail.com" {
		t.Fatalf("growave email path (customer.email) not extracted: %q", m.Email)
	}
	if m.PointsBalance != 2000 {
		t.Fatalf("growave points path (root currentBalance) not extracted: %d", m.PointsBalance)
	}
}

// LoyaltyLion program_events: customer nested under payload.properties.customer,
// topic in the body, points as a number on the customer object.
func TestMapLoyaltyWebhookLoyaltyLionProgramEvent(t *testing.T) {
	body := []byte(`{
      "id":"bff1bddb-0000-0000-0000-000000000000",
      "topic":"program_events/customer.points_earned",
      "payload":{"properties":{
        "customer":{"id":6932,"merchant_id":"2134606599","email":"Jessica@example.com",
                    "points_approved":200,"loyalty_tier_membership":null}
      }}
    }`)
	req, ok := mapLoyaltyWebhook(ProviderLoyaltyLion, body)
	if !ok || len(req.Members) != 1 {
		t.Fatalf("loyaltylion payload not mapped: ok=%v req=%+v", ok, req)
	}
	if req.Members[0].Email != "jessica@example.com" {
		t.Fatalf("loyaltylion email path (payload.properties.customer.email) not extracted: %q", req.Members[0].Email)
	}
	if req.Members[0].PointsBalance != 200 {
		t.Fatalf("loyaltylion points (payload.properties.customer.points_approved) not extracted: %d", req.Members[0].PointsBalance)
	}
	if len(req.Events) != 1 || req.Events[0].EventName != "program_events/customer.points_earned" {
		t.Fatalf("loyaltylion topic not mapped to an event: %+v", req.Events)
	}
}

// LoyaltyLion customers/update: customer at the root (no payload wrapper).
func TestMapLoyaltyWebhookLoyaltyLionCustomersUpdate(t *testing.T) {
	body := []byte(`{"topic":"customers/update","customer":{"email":"root@example.com","points_approved":50}}`)
	req, ok := mapLoyaltyWebhook(ProviderLoyaltyLion, body)
	if !ok || len(req.Members) != 1 || req.Members[0].Email != "root@example.com" {
		t.Fatalf("loyaltylion customers/update not mapped: ok=%v req=%+v", ok, req)
	}
}
