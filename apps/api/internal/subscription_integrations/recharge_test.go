// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeRechargeSecretResolver struct{ token string }

func (f fakeRechargeSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.token, nil
}
func (f fakeRechargeSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*rechargeCredentialPayload); ok {
		*dst = rechargeCredentialPayload{AccessToken: f.token}
		return nil
	}
	return errNotJSONSecret
}

func TestRechargeBackfillPageMapsSubscriptions(t *testing.T) {
	var gotPath, gotToken, gotLimit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-Recharge-Access-Token")
		gotLimit = r.URL.Query().Get("limit")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"subscriptions": []map[string]any{
				{
					"id": 9001, "customer_id": 5001, "email": "Buyer@Example.com", "status": "active",
					"product_title": "Coffee", "sku": "COF-1",
					"next_charge_scheduled_at": "2026-07-01T00:00:00", "updated_at": "2026-06-20T10:00:00",
					"order_interval_frequency": "30", "order_interval_unit": "day",
				},
			},
			"next_cursor": "",
		})
	}))
	defer srv.Close()

	backfiller := RechargeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: RechargeSecretsCredentialResolver{Secrets: fakeRechargeSecretResolver{token: "rc_tok"}},
		APIBaseURL:  srv.URL,
		PageSize:    250,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderRecharge, CredentialsRef: "cred_recharge_1"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotPath != "/subscriptions" || gotToken != "rc_tok" || gotLimit != "250" {
		t.Fatalf("request path=%q token=%q limit=%q", gotPath, gotToken, gotLimit)
	}
	if req.RunMode != "backfill" {
		t.Fatalf("run_mode = %q", req.RunMode)
	}
	if len(req.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d", len(req.Subscriptions))
	}
	sub := req.Subscriptions[0]
	if sub.Email != "buyer@example.com" {
		t.Fatalf("email = %q (want lowercased)", sub.Email)
	}
	if sub.SubscriptionID != "9001" || sub.Status != "active" || sub.SKU != "COF-1" {
		t.Fatalf("mapped subscription = %+v", sub)
	}
	if sub.SourceID != "recharge://subscription/9001" {
		t.Fatalf("source id = %q", sub.SourceID)
	}
	if req.Cursor != rechargeCursorComplete {
		t.Fatalf("cursor = %q, want complete", req.Cursor)
	}
}

func TestRechargeBackfillPageEmailless(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"subscriptions": []map[string]any{{"id": 1, "status": "active"}},
		})
	}))
	defer srv.Close()

	backfiller := RechargeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: RechargeSecretsCredentialResolver{Secrets: fakeRechargeSecretResolver{token: "t"}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderRecharge, CredentialsRef: "cred_recharge_1"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Subscriptions) != 0 {
		t.Fatalf("email-less subscription should be skipped, got %d", len(req.Subscriptions))
	}
}

func TestVerifyRechargeWebhookRoundTrip(t *testing.T) {
	// The verifier already exists; confirm a correctly-signed body passes and a
	// tampered one fails (Recharge: hex(sha256(secret + body))).
	secret := "rc_webhook_secret"
	body := []byte(`{"subscription":{"id":1}}`)
	header := rechargeTestSignature(secret, body)
	if err := VerifyRechargeWebhookSignature(secret, body, header); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	if err := VerifyRechargeWebhookSignature(secret, append(body, '!'), header); err == nil {
		t.Fatal("tampered body accepted")
	}
}

func TestRechargeChargeWebhookMapsEnrichedLifecycleEvent(t *testing.T) {
	body := []byte(`{
		"charge": {
			"id": 7001,
			"email": "VIP@Example.com",
			"customer_id": 5001,
			"subscription_ids": [9001, 9002],
			"order_id": 3001,
			"external_order_id": "shopify-1001",
			"status": "paid",
			"type": "recurring",
			"total_price": "49.99",
			"subtotal_price": "45.00",
			"total_tax": "4.99",
			"total_discounts": "5.00",
			"currency": "USD",
			"processed_at": "2026-06-29T12:34:56Z",
			"line_items": [
				{
					"id": 101,
					"subscription_id": 9001,
					"external_product_id": "prod-coffee",
					"product_title": "Coffee Club",
					"sku": "COF-1",
					"quantity": 2,
					"price": "22.50"
				}
			]
		}
	}`)

	req, ok := mapRechargeWebhookEvent("charge/paid", body, Integration{Provider: ProviderRecharge})
	if !ok {
		t.Fatal("expected charge webhook to map")
	}
	if len(req.Events) != 1 {
		t.Fatalf("events=%+v", req.Events)
	}
	event := req.Events[0]
	if event.SourceID != "recharge://charge/7001" || event.Email != "vip@example.com" || event.EventName != "recharge.charge.paid" {
		t.Fatalf("event identity=%+v", event)
	}
	if event.SubscriptionID != "9001" || event.OrderID != "3001" || event.Status != "paid" {
		t.Fatalf("event linkage=%+v", event)
	}
	if event.OccurredAt == nil || event.OccurredAt.Format("2006-01-02T15:04:05Z") != "2026-06-29T12:34:56Z" {
		t.Fatalf("occurred_at=%v", event.OccurredAt)
	}
	props := event.Properties
	for key, want := range map[string]string{
		"recharge_topic":             "charge/paid",
		"recharge_charge_id":         "7001",
		"recharge_customer_id":       "5001",
		"recharge_order_id":          "3001",
		"recharge_external_order_id": "shopify-1001",
		"recharge_charge_status":     "paid",
		"recharge_charge_type":       "recurring",
		"recharge_currency":          "USD",
		"recharge_total_price":       "49.99",
		"recharge_subtotal_price":    "45.00",
		"recharge_total_tax":         "4.99",
		"recharge_total_discounts":   "5.00",
		"recharge_processed_at":      "2026-06-29T12:34:56Z",
	} {
		if got := props[key]; got != want {
			t.Fatalf("props[%s]=%#v want %q", key, got, want)
		}
	}
	ids, ok := props["recharge_subscription_ids"].([]string)
	if !ok || len(ids) != 2 || ids[0] != "9001" || ids[1] != "9002" {
		t.Fatalf("subscription ids=%#v", props["recharge_subscription_ids"])
	}
	items, ok := props["recharge_line_items"].([]map[string]any)
	if !ok || len(items) != 1 {
		t.Fatalf("line items=%#v", props["recharge_line_items"])
	}
	if items[0]["subscription_id"] != "9001" || items[0]["external_product_id"] != "prod-coffee" || items[0]["quantity"] != "2" {
		t.Fatalf("line item=%#v", items[0])
	}
}

func rechargeTestSignature(secret string, body []byte) string {
	return rechargeHexSHA256(secret, body)
}

func TestRechargeCredentialPayloadJSON(t *testing.T) {
	// Sanity: the credential payload round-trips a raw token.
	var p rechargeCredentialPayload
	if err := json.Unmarshal([]byte(`{"access_token":"abc"}`), &p); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(p.AccessToken) != "abc" {
		t.Fatalf("payload = %+v", p)
	}
}
