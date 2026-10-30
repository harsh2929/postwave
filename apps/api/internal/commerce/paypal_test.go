package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPayPalSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewPayPalSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{
		"vault://paypal/client": `{"client_id":"client_123","client_secret":"secret_123","webhook_id":"WH-123","environment":"sandbox"}`,
	}})

	creds, err := resolver.ResolvePayPal(context.Background(), "tenant-1", Integration{
		Provider: ProviderPayPal,
		Settings: map[string]any{"credential_ref": "vault://paypal/client"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creds.ClientID != "client_123" || creds.ClientSecret != "secret_123" || creds.WebhookID != "WH-123" || creds.Environment != "sandbox" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestPayPalRESTBackfillerPullsTransactionSearch(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
		if r.URL.Path == "/v1/oauth2/token" {
			clientID, clientSecret, ok := r.BasicAuth()
			if !ok || clientID != "client_123" || clientSecret != "secret_123" {
				t.Fatalf("basic auth ok=%v id=%q secret=%q", ok, clientID, clientSecret)
			}
			body, _ := io.ReadAll(r.Body)
			if string(body) != "grant_type=client_credentials" {
				t.Fatalf("token body = %s", string(body))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"access_123","token_type":"Bearer","expires_in":3600}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer access_123" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if r.URL.Path != "/v1/reporting/transactions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("start_date") != "2026-06-01T00:00:00Z" || q.Get("end_date") != "2026-06-18T00:00:00Z" || q.Get("fields") != "all" || q.Get("page_size") != "2" || q.Get("page") != "1" {
			t.Fatalf("query = %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"page": 1,
			"total_pages": 1,
			"transaction_details": [{
				"transaction_info": {
					"transaction_id": "TXN123",
					"transaction_event_code": "T0006",
					"transaction_status": "S",
					"transaction_amount": {"value": "42.00", "currency_code": "USD"},
					"fee_amount": {"value": "1.20", "currency_code": "USD"},
					"transaction_initiation_date": "2026-06-18T12:00:00Z",
					"invoice_id": "INV-123"
				},
				"payer_info": {
					"account_id": "PAYER123",
					"email_address": "BUYER@example.com",
					"payer_name": {"given_name": "Buyer", "surname": "One"},
					"country_code": "US"
				},
				"cart_info": {
					"item_details": [{
						"item_name": "Newsletter plan",
						"item_quantity": "2",
						"item_unit_price": {"value": "21.00", "currency_code": "USD"},
						"total_item_amount": {"value": "42.00", "currency_code": "USD"}
					}]
				}
			}, {
				"transaction_info": {
					"transaction_id": "RFND123",
					"transaction_event_code": "T1106",
					"transaction_status": "S",
					"transaction_amount": {"value": "-5.00", "currency_code": "USD"},
					"transaction_initiation_date": "2026-06-18T13:00:00Z"
				},
				"payer_info": {"email_address": "BUYER@example.com"}
			}]
		}`))
	}))
	defer srv.Close()

	backfiller := PayPalRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client_123", ClientSecret: "secret_123", Environment: "sandbox"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderPayPal,
		Settings: map[string]any{
			"merchant_id":           "MERCHANT123",
			"credential_ref":        "cred_paypal",
			"backfill_start":        "2026-06-01T00:00:00Z",
			"backfill_end":          "2026-06-18T00:00:00Z",
			"api_base_url":          srv.URL,
			"environment":           "sandbox",
			"reporting_window_days": "31",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Customers) != 2 || req.Customers[0].SourceID != "paypal://payer/PAYER123" || req.Customers[0].Email != "buyer@example.com" || req.Customers[1].SourceID != "paypal://payer/buyer@example.com" {
		t.Fatalf("customers = %+v", req.Customers)
	}
	if len(req.Orders) != 1 || req.Orders[0].SourceID != "paypal://transaction/TXN123" || req.Orders[0].Status != "paid" || req.Orders[0].TotalCents != 4200 || len(req.Orders[0].LineItems) != 1 {
		t.Fatalf("orders = %+v", req.Orders)
	}
	if len(req.ProviderEvents) != 1 || req.ProviderEvents[0].EventType != "refund_created" || req.ProviderEvents[0].SourceID != "paypal://transaction/RFND123" {
		t.Fatalf("provider events = %+v", req.ProviderEvents)
	}
	if req.Cursor != payPalCursorComplete {
		t.Fatalf("cursor = %q", req.Cursor)
	}
	if len(calls) != 2 || !strings.HasPrefix(calls[0], "POST /v1/oauth2/token?") || !strings.HasPrefix(calls[1], "GET /v1/reporting/transactions?") {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestPayPalRESTWebhookVerifierPostsVerificationPayload(t *testing.T) {
	var verify map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/oauth2/token" {
			_, _ = w.Write([]byte(`{"access_token":"access_123","token_type":"Bearer"}`))
			return
		}
		if r.URL.Path != "/v1/notifications/verify-webhook-signature" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer access_123" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&verify); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"verification_status":"SUCCESS"}`))
	}))
	defer srv.Close()

	rawBody := []byte(`{"id":"WH-123","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAPTURE123"},"paypal_extra":"kept"}`)
	event, err := decodePayPalWebhookEvent(rawBody)
	if err != nil {
		t.Fatal(err)
	}
	headers := http.Header{
		"Paypal-Transmission-Id":   []string{"tx_123"},
		"Paypal-Transmission-Sig":  []string{"sig_123"},
		"Paypal-Transmission-Time": []string{"2026-06-18T12:00:00Z"},
		"Paypal-Auth-Algo":         []string{"SHA256withRSA"},
		"Paypal-Cert-Url":          []string{"https://api-m.paypal.com/certs/test"},
	}
	err = (PayPalRESTWebhookVerifier{HTTPClient: srv.Client(), APIBaseURL: srv.URL}).VerifyPayPalWebhook(context.Background(), PayPalCredentials{
		ClientID:     "client_123",
		ClientSecret: "secret_123",
		WebhookID:    "WH-ID",
	}, event, headers, rawBody)
	if err != nil {
		t.Fatal(err)
	}
	if verify["webhook_id"] != "WH-ID" || verify["transmission_id"] != "tx_123" || verify["transmission_sig"] != "sig_123" {
		t.Fatalf("verify payload = %+v", verify)
	}
	webhookEvent, ok := verify["webhook_event"].(map[string]any)
	if !ok || webhookEvent["paypal_extra"] != "kept" || webhookEvent["event_type"] != "PAYMENT.CAPTURE.COMPLETED" {
		t.Fatalf("webhook_event = %+v", verify["webhook_event"])
	}
}

func TestPayPalRESTWebhookResourceFetcherHydratesSparseCaptureWithOrder(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/oauth2/token":
			clientID, clientSecret, ok := r.BasicAuth()
			if !ok || clientID != "client_123" || clientSecret != "secret_123" {
				t.Fatalf("basic auth ok=%v id=%q secret=%q", ok, clientID, clientSecret)
			}
			_, _ = w.Write([]byte(`{"access_token":"access_123","token_type":"Bearer"}`))
		case "/v2/payments/captures/CAPTURE123":
			if r.Header.Get("Authorization") != "Bearer access_123" {
				t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
			}
			_, _ = w.Write([]byte(`{
				"id": "CAPTURE123",
				"status": "COMPLETED",
				"amount": {"value": "42.00", "currency_code": "USD"},
				"payee": {"merchant_id": "MERCHANT123"},
				"supplementary_data": {"related_ids": {"order_id": "ORDER123"}}
			}`))
		case "/v2/checkout/orders/ORDER123":
			if r.Header.Get("Authorization") != "Bearer access_123" {
				t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
			}
			_, _ = w.Write([]byte(`{
				"id": "ORDER123",
				"payer": {"email_address": "BUYER@example.com"},
				"purchase_units": [{
					"reference_id": "default",
					"amount": {"value": "42.00", "currency_code": "USD"},
					"payee": {"merchant_id": "MERCHANT123"},
					"items": [{
						"name": "Newsletter plan",
						"quantity": "2",
						"unit_amount": {"value": "21.00", "currency_code": "USD"}
					}]
				}]
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	event := payPalWebhookEvent{
		ID:           "WH-CAPTURE",
		EventType:    "PAYMENT.CAPTURE.COMPLETED",
		ResourceType: "capture",
		Resource:     map[string]any{"id": "CAPTURE123"},
	}
	hydrated, err := (PayPalRESTWebhookResourceFetcher{
		HTTPClient: srv.Client(),
		APIBaseURL: srv.URL,
	}).FetchPayPalWebhookResource(context.Background(), "tenant-1", Integration{Provider: ProviderPayPal}, PayPalCredentials{
		ClientID:     "client_123",
		ClientSecret: "secret_123",
		Environment:  "sandbox",
	}, event)
	if err != nil {
		t.Fatal(err)
	}
	if hydrated.Resource["id"] != "CAPTURE123" || hydrated.Resource["order_id"] != "ORDER123" || payPalMerchantIDFromWebhook(hydrated) != "MERCHANT123" {
		t.Fatalf("hydrated resource = %+v", hydrated.Resource)
	}
	order := payPalWebhookOrder("PAYMENT.CAPTURE.COMPLETED", hydrated.Resource)
	if order.SourceID != "paypal://capture/CAPTURE123" || order.CustomerEmail != "buyer@example.com" || order.TotalCents != 4200 || len(order.LineItems) != 1 {
		t.Fatalf("order = %+v", order)
	}
	if len(calls) != 3 || calls[0] != "POST /v1/oauth2/token" || calls[1] != "GET /v2/payments/captures/CAPTURE123" || calls[2] != "GET /v2/checkout/orders/ORDER123" {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestPayPalWebhookProviderEventUsesWebhookIDAndBillingTypes(t *testing.T) {
	invoice := payPalWebhookProviderEvent("INVOICING.INVOICE.PAID", payPalWebhookEvent{
		ID:              "WH-INVOICE-1",
		CreateTime:      "2026-06-18T12:00:00Z",
		EventVersion:    "1.0",
		ResourceType:    "invoices",
		ResourceVersion: "2.0",
		Summary:         "Invoice paid",
		Resource: map[string]any{
			"id":             "INV2-ABCD",
			"status":         "PAID",
			"invoice_number": "INV-2026-001",
			"invoicer":       map[string]any{"merchant_id": "MERCHANT123"},
			"amount":         map[string]any{"value": "42.00", "currency_code": "USD"},
			"primary_recipients": []any{map[string]any{
				"billing_info": map[string]any{"email_address": "BUYER@example.com"},
			}},
		},
	})
	if invoice.EventType != "invoice_paid" || invoice.SourceID != "paypal://invoice/INV2-ABCD" || invoice.ProviderEventID != "invoice_paid:paypal://webhook/WH-INVOICE-1" {
		t.Fatalf("invoice event = %+v", invoice)
	}
	if invoice.CustomerEmail != "buyer@example.com" || invoice.Metadata["merchant_id"] != "MERCHANT123" || invoice.Metadata["invoice_number"] != "INV-2026-001" {
		t.Fatalf("invoice metadata = %+v", invoice)
	}

	subscription := payPalWebhookProviderEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", payPalWebhookEvent{
		ID:           "WH-SUB-1",
		ResourceType: "subscription",
		Resource: map[string]any{
			"id":           "I-SUB123",
			"status":       "SUSPENDED",
			"plan_id":      "P-PLAN123",
			"payee":        map[string]any{"merchant_id": "MERCHANT123"},
			"subscriber":   map[string]any{"email_address": "subscriber@example.com"},
			"billing_info": map[string]any{"last_payment": map[string]any{"amount": map[string]any{"value": "19.00", "currency_code": "USD"}}},
		},
	})
	if subscription.EventType != "subscription_updated" || subscription.SourceID != "paypal://subscription/I-SUB123" || subscription.ProviderEventID != "subscription_updated:paypal://webhook/WH-SUB-1" {
		t.Fatalf("subscription event = %+v", subscription)
	}
	if subscription.Metadata["subscription_plan_id"] != "P-PLAN123" || subscription.Metadata["subscriber_email"] != "subscriber@example.com" {
		t.Fatalf("subscription metadata = %+v", subscription.Metadata)
	}

	cases := map[string]string{
		"CATALOG.PRODUCT.CREATED": "product_created",
		"CATALOG.PRODUCT.UPDATED": "product_updated",
		"CATALOG.PRODUCT.DELETED": "product_deleted",
	}
	for topic, want := range cases {
		if got := payPalProviderEventType(topic); got != want {
			t.Fatalf("payPalProviderEventType(%q) = %q, want %q", topic, got, want)
		}
	}
}

func TestPayPalRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		http.Error(w, `{"name":"RATE_LIMIT_REACHED"}`, http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (PayPalRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client_123", ClientSecret: "secret_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderPayPal,
		Settings: map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal", "backfill_start": "2026-06-01T00:00:00Z", "backfill_end": "2026-06-18T00:00:00Z"},
	}, "")
	if err == nil {
		t.Fatal("expected rate limit error")
	}
	var rateLimit PayPalRateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("err=%T %v", err, err)
	}
	if rateLimit.StatusCode != http.StatusTooManyRequests || rateLimit.RetryAfter != 30*time.Second {
		t.Fatalf("rate limit = %+v", rateLimit)
	}
}
