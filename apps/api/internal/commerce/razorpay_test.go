package commerce

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRazorpaySecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewRazorpaySecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{
		"vault://razorpay/key":     `{"key_id":"rzp_test_key","key_secret":"rzp_test_secret"}`,
		"vault://razorpay/webhook": "webhook_secret=rzp_webhook_secret",
	}})

	creds, err := resolver.ResolveRazorpay(context.Background(), "tenant-1", Integration{
		Provider: ProviderRazorpay,
		Settings: map[string]any{
			"credential_ref":     "vault://razorpay/key",
			"webhook_secret_ref": "vault://razorpay/webhook",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creds.KeyID != "rzp_test_key" || creds.KeySecret != "rzp_test_secret" || creds.WebhookSecret != "rzp_webhook_secret" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestRazorpayRESTBackfillerPullsCustomersOrdersPaymentsRefunds(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keyID, keySecret, ok := r.BasicAuth()
		if !ok || keyID != "rzp_test_key" || keySecret != "rzp_test_secret" {
			t.Fatalf("basic auth ok=%v key=%q secret=%q", ok, keyID, keySecret)
		}
		if r.URL.Query().Get("count") != "2" || r.URL.Query().Get("skip") != "0" || r.URL.Query().Get("from") != "1781780000" || r.URL.Query().Get("to") != "1781790000" {
			t.Fatalf("query = %s", r.URL.RawQuery)
		}
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/customers":
			_, _ = w.Write([]byte(`{
				"entity":"collection",
				"count":1,
				"items":[{
					"id":"cust_123",
					"entity":"customer",
					"name":"Buyer One",
					"email":"BUYER@example.com",
					"contact":"+919876543210",
					"created_at":1781784000
				}]
			}`))
		case "/v1/orders":
			_, _ = w.Write([]byte(`{
				"entity":"collection",
				"count":1,
				"items":[{
					"id":"order_123",
					"entity":"order",
					"amount":5000,
					"amount_paid":4200,
					"amount_due":800,
					"currency":"INR",
					"receipt":"Receipt 123",
					"status":"paid",
					"created_at":1781784010
				}]
			}`))
		case "/v1/payments":
			_, _ = w.Write([]byte(`{
				"entity":"collection",
				"count":1,
				"items":[{
					"id":"pay_123",
					"entity":"payment",
					"amount":4200,
					"currency":"INR",
					"status":"captured",
					"email":"BUYER@example.com",
					"order_id":"order_123",
					"method":"upi",
					"captured":true,
					"created_at":1781784020
				}]
			}`))
		case "/v1/refunds":
			_, _ = w.Write([]byte(`{
				"entity":"collection",
				"count":1,
				"items":[{
					"id":"rfnd_123",
					"entity":"refund",
					"amount":1200,
					"currency":"INR",
					"payment_id":"pay_123",
					"status":"processed",
					"receipt":"refund-receipt",
					"created_at":1781784030
				}]
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := RazorpayRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeRazorpayCredentialResolver{creds: RazorpayCredentials{KeyID: "rzp_test_key", KeySecret: "rzp_test_secret"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}
	integration := Integration{
		Provider: ProviderRazorpay,
		Settings: map[string]any{
			"account_id":     "acc_123",
			"credential_ref": "cred_razorpay",
			"backfill_from":  "1781780000",
			"backfill_to":    "1781790000",
		},
	}

	customerReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(customerReq.Customers) != 1 || customerReq.Customers[0].SourceID != "razorpay://customer/cust_123" || customerReq.Customers[0].Email != "buyer@example.com" {
		t.Fatalf("customers = %+v", customerReq.Customers)
	}

	orderReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, customerReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(orderReq.Orders) != 1 || orderReq.Orders[0].SourceID != "razorpay://order/order_123" || orderReq.Orders[0].Status != "paid" || orderReq.Orders[0].TotalCents != 4200 {
		t.Fatalf("orders = %+v", orderReq.Orders)
	}

	paymentReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, orderReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(paymentReq.Orders) != 1 || paymentReq.Orders[0].SourceID != "razorpay://payment/pay_123" || paymentReq.Orders[0].CustomerEmail != "buyer@example.com" || paymentReq.Orders[0].Status != "paid" {
		t.Fatalf("payment orders = %+v", paymentReq.Orders)
	}

	refundReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, paymentReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(refundReq.ProviderEvents) != 1 || refundReq.ProviderEvents[0].EventType != "refund_created" || refundReq.ProviderEvents[0].SourceID != "razorpay://refund/rfnd_123" {
		t.Fatalf("refund events = %+v", refundReq.ProviderEvents)
	}
	if refundReq.Cursor != razorpayCursorComplete {
		t.Fatalf("cursor = %q", refundReq.Cursor)
	}
	wantCalls := []string{"GET /v1/customers", "GET /v1/orders", "GET /v1/payments", "GET /v1/refunds"}
	if strings.Join(calls, ",") != strings.Join(wantCalls, ",") {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestRazorpayRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		http.Error(w, `{"error":{"description":"rate limited"}}`, http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (RazorpayRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeRazorpayCredentialResolver{creds: RazorpayCredentials{KeyID: "rzp_test_key", KeySecret: "rzp_test_secret"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderRazorpay,
		Settings: map[string]any{"account_id": "acc_123", "credential_ref": "cred_razorpay"},
	}, "")
	if err == nil {
		t.Fatal("expected rate limit error")
	}
	var rateLimit RazorpayRateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("err=%T %v", err, err)
	}
	if rateLimit.StatusCode != http.StatusTooManyRequests || rateLimit.RetryAfter != 30*time.Second {
		t.Fatalf("rate limit = %+v", rateLimit)
	}
}
