package commerce

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSquareSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewSquareSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{
		"vault://square/token":   `{"access_token":"Bearer sq0atp_123"}`,
		"vault://square/webhook": "webhook_signature_key=sig_123",
	}})

	creds, err := resolver.ResolveSquare(context.Background(), "tenant-1", Integration{
		Provider: ProviderSquare,
		Settings: map[string]any{
			"credential_ref":           "vault://square/token",
			"webhook_signature_ref":    "vault://square/webhook",
			"webhook_notification_url": "https://api.postwave.test/api/public/commerce/square/webhooks",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "sq0atp_123" || creds.WebhookSignatureKey != "sig_123" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestSquareRESTBackfillerPullsCustomersOrdersPaymentsRefunds(t *testing.T) {
	calls := []string{}
	bodies := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls = append(calls, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
		bodies = append(bodies, string(body))
		if r.Header.Get("Authorization") != "Bearer sq0atp_123" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Square-Version") != squareAPIVersion {
			t.Fatalf("Square-Version = %q", r.Header.Get("Square-Version"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/customers/search":
			_, _ = w.Write([]byte(`{
				"customers": [{
					"id": "cust_123",
					"email_address": "BUYER@example.com",
					"given_name": "Buyer",
					"family_name": "One",
					"preferences": {"email_unsubscribed": false}
				}]
			}`))
		case "/v2/catalog/search":
			if !strings.Contains(string(body), `"object_types":["ITEM"]`) ||
				!strings.Contains(string(body), `"include_related_objects":true`) ||
				!strings.Contains(string(body), `"include_deleted_objects":true`) {
				t.Fatalf("catalog body = %s", string(body))
			}
			_, _ = w.Write([]byte(`{
				"objects": [{
					"type": "ITEM",
					"id": "item_123",
					"updated_at": "2026-06-18T12:00:00Z",
					"present_at_all_locations": true,
					"item_data": {
						"name": "Monthly plan",
						"description": "Newsletter membership",
						"product_type": "REGULAR",
						"visibility": "PUBLIC",
						"image_ids": ["img_123"],
						"variations": [{
							"type": "ITEM_VARIATION",
							"id": "var_123",
							"item_variation_data": {
								"item_id": "item_123",
								"name": "Standard",
								"sku": "PLAN-STANDARD",
								"pricing_type": "FIXED_PRICING",
								"price_money": {"amount": 4200, "currency": "USD"},
								"ordinal": 1,
								"sellable": true,
								"stockable": false
							}
						}]
					}
				}, {
					"type": "ITEM",
					"id": "item_deleted",
					"is_deleted": true,
					"updated_at": "2026-06-18T12:05:00Z"
				}],
				"related_objects": [{
					"type": "IMAGE",
					"id": "img_123",
					"image_data": {"url": "https://img.example/square-plan.jpg"}
				}]
			}`))
		case "/v2/orders/search":
			_, _ = w.Write([]byte(`{
				"orders": [{
					"id": "ord_123",
					"location_id": "loc_123",
					"customer_id": "cust_123",
					"state": "COMPLETED",
					"created_at": "2026-06-18T12:00:00Z",
					"total_money": {"amount": 4200, "currency": "USD"},
					"net_amounts": {
						"total_money": {"amount": 4000, "currency": "USD"},
						"discount_money": {"amount": 500, "currency": "USD"},
						"service_charge_money": {"amount": 200, "currency": "USD"},
						"tax_money": {"amount": 300, "currency": "USD"}
					},
					"line_items": [{
						"uid": "line_1",
						"name": "Monthly plan",
						"quantity": "2",
						"total_money": {"amount": 4200, "currency": "USD"}
					}],
					"fulfillments": [{"recipient": {"email_address": "BUYER@example.com"}}]
				}]
			}`))
		case "/v2/payments":
			_, _ = w.Write([]byte(`{
				"payments": [{
					"id": "pay_123",
					"buyer_email_address": "BUYER@example.com",
					"status": "COMPLETED",
					"created_at": "2026-06-18T12:01:00Z",
					"amount_money": {"amount": 4200, "currency": "USD"},
					"total_money": {"amount": 4200, "currency": "USD"},
					"customer_id": "cust_123",
					"order_id": "ord_123",
					"location_id": "loc_123"
				}]
			}`))
		case "/v2/refunds":
			_, _ = w.Write([]byte(`{
				"refunds": [{
					"id": "ref_123",
					"amount_money": {"amount": 1200, "currency": "USD"},
					"status": "COMPLETED",
					"reason": "requested_by_customer",
					"payment_id": "pay_123",
					"order_id": "ord_123",
					"location_id": "loc_123",
					"created_at": "2026-06-18T12:02:00Z"
				}]
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := SquareRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeSquareCredentialResolver{creds: SquareCredentials{AccessToken: "sq0atp_123"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}
	integration := Integration{
		Provider: ProviderSquare,
		Settings: map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_square", "location_id": "loc_123"},
	}

	customerReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(customerReq.Customers) != 1 || customerReq.Customers[0].SourceID != "square://customer/cust_123" || customerReq.Customers[0].Email != "buyer@example.com" {
		t.Fatalf("customers = %+v", customerReq.Customers)
	}
	if !strings.Contains(bodies[0], `"field":"CREATED_AT"`) {
		t.Fatalf("customer body = %s", bodies[0])
	}

	productReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, customerReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(productReq.Products) != 1 {
		t.Fatalf("products = %+v", productReq.Products)
	}
	product := productReq.Products[0]
	if product.SourceID != "square://product/item_123" || product.Title != "Monthly plan" || product.PriceCents != 4200 || product.Currency != "USD" || product.ImageURL != "https://img.example/square-plan.jpg" {
		t.Fatalf("product = %+v", product)
	}
	if len(productReq.ProductDeletions) != 1 || productReq.ProductDeletions[0].SourceID != "square://product/item_deleted" || productReq.ProductDeletions[0].Topic != "catalog.item.deleted" {
		t.Fatalf("product deletions = %+v", productReq.ProductDeletions)
	}
	variants := rawArray(product.Raw["variants"])
	if len(variants) != 1 {
		t.Fatalf("variants = %+v", product.Raw["variants"])
	}

	orderReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, productReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(orderReq.Orders) != 1 {
		t.Fatalf("orders = %+v", orderReq.Orders)
	}
	order := orderReq.Orders[0]
	if order.SourceID != "square://order/ord_123" || order.SubtotalCents != 4000 || order.DiscountCents != 500 || order.ShippingCents != 200 || order.TaxCents != 300 || order.TotalCents != 4200 {
		t.Fatalf("order = %+v", order)
	}
	if !strings.Contains(bodies[2], `"location_ids":["loc_123"]`) || !strings.Contains(bodies[2], `"return_entries":false`) {
		t.Fatalf("order body = %s", bodies[2])
	}

	paymentReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, orderReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(paymentReq.Orders) != 1 || paymentReq.Orders[0].SourceID != "square://payment/pay_123" || paymentReq.Orders[0].Status != "paid" {
		t.Fatalf("payment orders = %+v", paymentReq.Orders)
	}
	if !strings.Contains(calls[3], "/v2/payments?") || !strings.Contains(calls[3], "location_id=loc_123") || !strings.Contains(calls[3], "limit=2") {
		t.Fatalf("payment call = %q", calls[3])
	}

	refundReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, paymentReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(refundReq.ProviderEvents) != 1 || refundReq.ProviderEvents[0].EventType != "refund_created" || refundReq.ProviderEvents[0].SourceID != "square://refund/ref_123" {
		t.Fatalf("refund events = %+v", refundReq.ProviderEvents)
	}
	if refundReq.Cursor != squareCursorComplete {
		t.Fatalf("cursor = %q", refundReq.Cursor)
	}
}

func TestSquareRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		http.Error(w, `{"errors":[{"detail":"rate limited"}]}`, http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (SquareRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeSquareCredentialResolver{creds: SquareCredentials{AccessToken: "sq0atp_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderSquare,
		Settings: map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_square"},
	}, "")
	if err == nil {
		t.Fatal("expected rate limit error")
	}
	var rateLimit SquareRateLimitError
	if !strings.Contains(err.Error(), "retry after 30s") || !errors.As(err, &rateLimit) || rateLimit.RetryAfter.String() != "30s" {
		t.Fatalf("rate limit error = %#v", err)
	}
}
