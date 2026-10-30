package commerce

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStripeSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewStripeSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{
		"vault://stripe/key":     `{"restricted_key":"rk_live_123"}`,
		"vault://stripe/webhook": "webhook_secret=whsec_123",
	}})

	creds, err := resolver.ResolveStripe(context.Background(), "tenant-1", Integration{
		Provider: ProviderStripe,
		Settings: map[string]any{
			"credential_ref":     "vault://stripe/key",
			"webhook_secret_ref": "vault://stripe/webhook",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creds.APIKey != "rk_live_123" || creds.WebhookSecret != "whsec_123" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestStripeRESTBackfillerPullsCustomersPage(t *testing.T) {
	var gotPath, gotQuery, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [{
				"id": "cus_123",
				"email": "JANE@example.com",
				"name": "Jane Doe",
				"phone": "+15551234567",
				"currency": "usd"
			}],
			"has_more": true
		}`))
	}))
	defer srv.Close()

	resolver := &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123"}}
	req, err := (StripeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: resolver,
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderStripe,
		Settings: map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/customers" || !strings.Contains(gotQuery, "limit=2") {
		t.Fatalf("request path=%q query=%q", gotPath, gotQuery)
	}
	if gotAuth != "Bearer rk_test_123" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if resolver.tenantID != "tenant-1" || resolver.integration.Provider != ProviderStripe {
		t.Fatalf("resolver inputs tenant=%q integration=%+v", resolver.tenantID, resolver.integration)
	}
	if len(req.Customers) != 1 {
		t.Fatalf("customers = %+v", req.Customers)
	}
	customer := req.Customers[0]
	if customer.SourceID != "stripe://customer/cus_123" || customer.Email != "jane@example.com" || customer.FirstName != "Jane" || customer.LastName != "Doe" {
		t.Fatalf("customer = %+v", customer)
	}
	state, err := decodeStripeBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "customers" || state.StartingAfter != "cus_123" {
		t.Fatalf("cursor state = %+v", state)
	}
}

func TestStripeRESTBackfillerPullsPaymentIntentsPage(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [{
				"id": "pi_123",
				"amount": 4200,
				"amount_received": 4200,
				"currency": "usd",
				"customer": "cus_123",
				"receipt_email": "BUYER@example.com",
				"status": "succeeded",
				"description": "Newsletter plan",
				"created": 1781784000
			}],
			"has_more": false
		}`))
	}))
	defer srv.Close()

	resolver := &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123"}}
	cursor := encodeStripeBackfillCursor(stripeBackfillState{Object: "payment_intents", StartingAfter: "pi_old"})
	req, err := (StripeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: resolver,
		APIBaseURL:  srv.URL,
		PageSize:    1000,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderStripe,
		Settings: map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
	}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/payment_intents" || !strings.Contains(gotQuery, "limit=100") || !strings.Contains(gotQuery, "starting_after=pi_old") {
		t.Fatalf("request path=%q query=%q", gotPath, gotQuery)
	}
	if len(req.Orders) != 1 {
		t.Fatalf("orders = %+v", req.Orders)
	}
	order := req.Orders[0]
	if order.SourceID != "stripe://payment_intent/pi_123" || order.CustomerEmail != "buyer@example.com" || order.Status != "paid" || order.TotalCents != 4200 || order.Currency != "USD" {
		t.Fatalf("order = %+v", order)
	}
	state, err := decodeStripeBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "charges" {
		t.Fatalf("cursor state = %+v", state)
	}
}

func TestStripeRESTBackfillerPullsCheckoutSessionsPage(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [{
				"id": "cs_test_123",
				"customer": "cus_123",
				"customer_details": {"email": "BUYER@example.com", "name": "Jane Doe"},
				"amount_subtotal": 4000,
				"amount_total": 4200,
				"currency": "usd",
				"payment_status": "paid",
				"status": "complete",
				"payment_intent": "pi_123",
				"subscription": "sub_123",
				"mode": "subscription",
				"created": 1781784000
			}],
			"has_more": false
		}`))
	}))
	defer srv.Close()

	cursor := encodeStripeBackfillCursor(stripeBackfillState{Object: "checkout_sessions"})
	req, err := (StripeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderStripe,
		Settings: map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
	}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/checkout/sessions" || !strings.Contains(gotQuery, "limit=100") {
		t.Fatalf("request path=%q query=%q", gotPath, gotQuery)
	}
	if len(req.Customers) != 1 || req.Customers[0].SourceID != "stripe://customer/cus_123" || req.Customers[0].Email != "buyer@example.com" {
		t.Fatalf("customers = %+v", req.Customers)
	}
	if len(req.Orders) != 1 || req.Orders[0].SourceID != "stripe://checkout_session/cs_test_123" || req.Orders[0].Status != "paid" {
		t.Fatalf("orders = %+v", req.Orders)
	}
	state, err := decodeStripeBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "payment_intents" {
		t.Fatalf("cursor state = %+v", state)
	}
}

func TestStripeRESTBackfillerPullsInvoicesPage(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [{
				"id": "in_123",
				"customer": "cus_123",
				"customer_email": "BUYER@example.com",
				"customer_name": "Jane Doe",
				"subscription": "sub_123",
				"amount_due": 4200,
				"amount_paid": 4200,
				"subtotal": 4000,
				"total": 4200,
				"currency": "usd",
				"status": "paid",
				"billing_reason": "subscription_cycle",
				"hosted_invoice_url": "https://invoice.stripe.com/i/acct/in_123",
				"status_transitions": {"paid_at": 1781784000},
				"lines": {"data": [{
					"id": "il_123",
					"description": "Newsletter Pro",
					"amount": 4200,
					"currency": "usd",
					"quantity": 1,
					"subscription": "sub_123",
					"price": {"id": "price_123", "nickname": "Pro"}
				}]}
			}],
			"has_more": false
		}`))
	}))
	defer srv.Close()

	cursor := encodeStripeBackfillCursor(stripeBackfillState{Object: "invoices"})
	req, err := (StripeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderStripe,
		Settings: map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
	}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/invoices" {
		t.Fatalf("request path=%q", gotPath)
	}
	if len(req.Orders) != 1 || req.Orders[0].SourceID != "stripe://invoice/in_123" || req.Orders[0].Status != "paid" || len(req.Orders[0].LineItems) != 1 {
		t.Fatalf("orders = %+v", req.Orders)
	}
	if len(req.ProviderEvents) != 1 || req.ProviderEvents[0].EventType != "invoice_updated" || req.ProviderEvents[0].SourceID != "stripe://invoice/in_123" {
		t.Fatalf("provider events = %+v", req.ProviderEvents)
	}
	state, err := decodeStripeBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "credit_notes" {
		t.Fatalf("cursor state = %+v", state)
	}
}

func TestStripeRESTBackfillerPaginatesLargeInvoiceLineLists(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path+"?"+r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/invoices":
			_, _ = w.Write([]byte(`{
				"data": [{
					"id": "in_123",
					"customer": "cus_123",
					"customer_email": "BUYER@example.com",
					"amount_paid": 9900,
					"total": 9900,
					"currency": "usd",
					"status": "paid",
					"lines": {
						"data": [{"id": "stale_line"}],
						"has_more": true,
						"total_count": 2,
						"url": "/v1/invoices/in_123/lines"
					}
				}],
				"has_more": false
			}`))
		case "/v1/invoices/in_123/lines":
			if r.URL.Query().Get("starting_after") == "" {
				_, _ = w.Write([]byte(`{
					"data": [{
						"id": "il_1",
						"description": "Pro plan",
						"amount": 5900,
						"currency": "usd",
						"quantity": 1,
						"pricing": {"price_details": {"price": "price_pro", "product": "prod_pro"}},
						"parent": {"subscription_item_details": {"subscription": "sub_123"}}
					}],
					"has_more": true
				}`))
				return
			}
			if r.URL.Query().Get("starting_after") != "il_1" {
				t.Fatalf("unexpected starting_after %q", r.URL.Query().Get("starting_after"))
			}
			_, _ = w.Write([]byte(`{
				"data": [{
					"id": "il_2",
					"description": "Seats",
					"amount": 4000,
					"currency": "usd",
					"quantity": 2,
					"pricing": {"price_details": {"price": "price_seats", "product": "prod_seats"}}
				}],
				"has_more": false
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (StripeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderStripe,
		Settings: map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
	}, encodeStripeBackfillCursor(stripeBackfillState{Object: "invoices"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Orders) != 1 || len(req.Orders[0].LineItems) != 2 {
		t.Fatalf("orders = %+v", req.Orders)
	}
	first := req.Orders[0].LineItems[0]
	if first["source_id"] != "stripe://invoice_line/il_1" || first["price"] != "price_pro" || first["product"] != "prod_pro" || first["subscription"] != "sub_123" {
		t.Fatalf("first line item = %+v", first)
	}
	if !hasString(calls, "/v1/invoices?limit=100") || !hasString(calls, "/v1/invoices/in_123/lines?limit=100") || !hasString(calls, "/v1/invoices/in_123/lines?limit=100&starting_after=il_1") {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestStripeRESTBackfillerPullsChargesPage(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [{
				"id": "ch_123",
				"amount": 4200,
				"amount_refunded": 500,
				"currency": "usd",
				"customer": "cus_123",
				"payment_intent": "pi_123",
				"payment_method": "pm_123",
				"balance_transaction": "txn_123",
				"receipt_url": "https://pay.stripe.com/receipts/ch_123",
				"receipt_email": "buyer@example.com",
				"status": "succeeded",
				"paid": true,
				"captured": true,
				"refunded": true,
				"disputed": false,
				"created": 1781784000,
				"billing_details": {"email": "buyer@example.com", "name": "Buyer Example"},
				"payment_method_details": {"type": "card", "card": {"brand": "visa", "last4": "4242"}},
				"outcome": {"risk_level": "normal"},
				"metadata": {"plan": "pro"}
			}],
			"has_more": false
		}`))
	}))
	defer srv.Close()

	req, err := (StripeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderStripe,
		Settings: map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
	}, encodeStripeBackfillCursor(stripeBackfillState{Object: "charges", StartingAfter: "ch_old"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/charges" || !strings.Contains(gotQuery, "starting_after=ch_old") {
		t.Fatalf("request path=%q query=%q", gotPath, gotQuery)
	}
	if len(req.ProviderEvents) != 1 {
		t.Fatalf("provider events = %+v", req.ProviderEvents)
	}
	event := req.ProviderEvents[0]
	if event.EventType != "transaction_updated" || event.Topic != "charge.refunded" || event.SourceID != "stripe://charge/ch_123" || event.CustomerEmail != "buyer@example.com" {
		t.Fatalf("charge event = %+v", event)
	}
	if event.Metadata["payment_intent"] != "pi_123" || event.Metadata["amount_refunded_cents"] != 500 || event.Metadata["receipt_url"] != "https://pay.stripe.com/receipts/ch_123" {
		t.Fatalf("charge metadata = %+v", event.Metadata)
	}
	details, _ := event.Metadata["payment_method_details"].(map[string]any)
	if details["type"] != "card" {
		t.Fatalf("payment method details = %+v", details)
	}
	state, err := decodeStripeBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "disputes" {
		t.Fatalf("cursor state = %+v", state)
	}
}

func TestStripeRESTBackfillerPullsDisputesAndCreditNotesPages(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path+"?"+r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/disputes":
			_, _ = w.Write([]byte(`{
				"data": [{
					"id": "dp_123",
					"amount": 4200,
					"currency": "usd",
					"status": "needs_response",
					"reason": "fraudulent",
					"charge": "ch_123",
					"payment_intent": "pi_123",
					"balance_transactions": [{"id": "txn_dispute"}],
					"evidence_details": {"due_by": 1784372000},
					"created": 1781784000
				}],
				"has_more": false
			}`))
		case "/v1/credit_notes":
			_, _ = w.Write([]byte(`{
				"data": [{
					"id": "cn_123",
					"amount": 900,
					"subtotal": 900,
					"total": 900,
					"currency": "usd",
					"status": "issued",
					"reason": "duplicate",
					"type": "post_payment",
					"number": "CN-0001",
					"invoice": "in_123",
					"customer": "cus_123",
					"refund": "re_123",
					"created": 1781785000,
					"lines": {"data": [{"id": "cnli_123", "description": "Adjustment", "amount": 900, "quantity": 1, "invoice_line_item": "il_123"}]}
				}],
				"has_more": false
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := StripeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123"}},
		APIBaseURL:  srv.URL,
	}
	integration := Integration{Provider: ProviderStripe, Settings: map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"}}
	disputeReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, encodeStripeBackfillCursor(stripeBackfillState{Object: "disputes"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(disputeReq.ProviderEvents) != 1 || disputeReq.ProviderEvents[0].EventType != "dispute_updated" || disputeReq.ProviderEvents[0].SourceID != "stripe://dispute/dp_123" {
		t.Fatalf("dispute events = %+v", disputeReq.ProviderEvents)
	}
	if disputeReq.ProviderEvents[0].Metadata["charge_source_id"] != "stripe://charge/ch_123" || disputeReq.ProviderEvents[0].Metadata["dispute_amount_cents"] != 4200 {
		t.Fatalf("dispute metadata = %+v", disputeReq.ProviderEvents[0].Metadata)
	}
	creditReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, encodeStripeBackfillCursor(stripeBackfillState{Object: "credit_notes"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(creditReq.ProviderEvents) != 1 || creditReq.ProviderEvents[0].EventType != "credit_note_created" || creditReq.ProviderEvents[0].SourceID != "stripe://credit_note/cn_123" {
		t.Fatalf("credit note events = %+v", creditReq.ProviderEvents)
	}
	lines, _ := creditReq.ProviderEvents[0].Metadata["lines"].([]map[string]any)
	if creditReq.ProviderEvents[0].Metadata["invoice_source_id"] != "stripe://invoice/in_123" ||
		creditReq.ProviderEvents[0].Metadata["refund_source_id"] != "stripe://refund/re_123" ||
		len(lines) != 1 ||
		lines[0]["source_id"] != "stripe://credit_note_line/cnli_123" {
		t.Fatalf("credit note metadata = %+v", creditReq.ProviderEvents[0].Metadata)
	}
	if len(calls) != 2 || !strings.HasPrefix(calls[0], "/v1/disputes?") || !strings.HasPrefix(calls[1], "/v1/credit_notes?") {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestStripeRESTBackfillerPullsSubscriptionsAndRefundsPages(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path+"?"+r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/subscriptions":
			_, _ = w.Write([]byte(`{
				"data": [{
					"id": "sub_123",
					"customer": "cus_123",
					"status": "active",
					"currency": "usd",
					"latest_invoice": "in_123",
					"collection_method": "charge_automatically",
					"start_date": 1781780000,
					"items": {"data": [{
						"id": "si_123",
						"quantity": 1,
						"current_period_start": 1781780000,
						"current_period_end": 1784372000,
						"price": {"id": "price_123", "product": "prod_123", "unit_amount": 4200, "currency": "usd", "recurring": {"interval": "month", "interval_count": 1}}
					}]}
				}],
				"has_more": false
			}`))
		case "/v1/refunds":
			_, _ = w.Write([]byte(`{
				"data": [{
					"id": "re_123",
					"amount": 1200,
					"currency": "usd",
					"status": "succeeded",
					"reason": "requested_by_customer",
					"charge": "ch_123",
					"payment_intent": "pi_123",
					"created": 1781784000
				}],
				"has_more": false
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := StripeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123"}},
		APIBaseURL:  srv.URL,
	}
	integration := Integration{Provider: ProviderStripe, Settings: map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"}}
	subReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, encodeStripeBackfillCursor(stripeBackfillState{Object: "subscriptions"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(subReq.ProviderEvents) != 1 || subReq.ProviderEvents[0].EventType != "subscription_updated" || subReq.ProviderEvents[0].SourceID != "stripe://subscription/sub_123" {
		t.Fatalf("subscription events = %+v", subReq.ProviderEvents)
	}
	if !strings.Contains(calls[0], "status=all") {
		t.Fatalf("subscription query = %q", calls[0])
	}
	refundReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, subReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(refundReq.ProviderEvents) != 1 || refundReq.ProviderEvents[0].EventType != "refund_created" || refundReq.ProviderEvents[0].SourceID != "stripe://refund/re_123" {
		t.Fatalf("refund events = %+v", refundReq.ProviderEvents)
	}
	if refundReq.Cursor != stripeCursorComplete {
		t.Fatalf("cursor = %q", refundReq.Cursor)
	}
}

func TestStripeRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		http.Error(w, `{"error":{"message":"rate limited"}}`, http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (StripeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderStripe,
		Settings: map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
	}, "")
	if err == nil {
		t.Fatal("expected rate limit error")
	}
	var rateLimit StripeRateLimitError
	if !strings.Contains(err.Error(), "retry after 30s") || !errors.As(err, &rateLimit) || rateLimit.RetryAfter.String() != "30s" {
		t.Fatalf("rate limit error = %#v", err)
	}
}
