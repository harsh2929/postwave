package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdobeCommerceSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewAdobeCommerceSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{
		"vault://commerce/adobe":         `{"access_token":"Bearer admin_token_123","api_base_url":"https://api.example.com","deployment_mode":"paas"}`,
		"vault://commerce/adobe-webhook": `webhook_secret=shared_secret`,
	}})

	creds, err := resolver.ResolveAdobeCommerce(context.Background(), "tenant-1", Integration{
		Provider: ProviderAdobeCommerce,
		Settings: map[string]any{
			"credential_ref": "vault://commerce/adobe",
			"event_auth_ref": "vault://commerce/adobe-webhook",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "admin_token_123" || creds.WebhookSecret != "shared_secret" || creds.APIBaseURL != "https://api.example.com" || creds.DeploymentMode != "paas" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestAdobeCommerceRESTBackfillerPullsCustomerPage(t *testing.T) {
	var gotPath string
	var gotQuery string
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"items":[{"id":123,"email":"BUYER@example.com","firstname":"Ada","lastname":"Lovelace","group_id":1}],
			"total_count":150
		}`))
	}))
	defer srv.Close()

	req, err := (AdobeCommerceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeAdobeCommerceCredentialResolver{creds: AdobeCommerceCredentials{AccessToken: "token_123"}},
		PageSize:    100,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderAdobeCommerce,
		Settings: map[string]any{"base_url": srv.URL, "store_view_code": "default", "credential_ref": "cred_adobe"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/rest/default/V1/customers/search" || gotAuth != "Bearer token_123" {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if !strings.Contains(gotQuery, "searchCriteria%5BcurrentPage%5D=1") || !strings.Contains(gotQuery, "searchCriteria%5BpageSize%5D=100") {
		t.Fatalf("query=%q", gotQuery)
	}
	if len(req.Customers) != 1 {
		t.Fatalf("customers=%+v", req.Customers)
	}
	customer := req.Customers[0]
	if customer.SourceID != "adobe-commerce://customer/123" || customer.Email != "buyer@example.com" || customer.FirstName != "Ada" || customer.LastName != "Lovelace" {
		t.Fatalf("customer=%+v", customer)
	}
	state, err := decodeAdobeCommerceBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "customers" || state.Page != 2 {
		t.Fatalf("cursor state=%+v cursor=%q", state, req.Cursor)
	}
}

func TestAdobeCommerceMappersMapOrderAndCreditMemo(t *testing.T) {
	var orderRaw map[string]any
	if err := json.Unmarshal([]byte(`{
		"entity_id":100,
		"increment_id":"000100",
		"status":"complete",
		"customer_email":"BUYER@example.com",
		"grand_total":"42.00",
		"subtotal":"45.00",
		"discount_amount":"-5.00",
		"shipping_amount":"1.00",
		"tax_amount":"1.00",
		"order_currency_code":"USD",
		"items":[{"item_id":5,"sku":"TEE-BLACK","name":"Black tee","qty_ordered":2,"price":"21.00","row_total":"42.00"}],
		"created_at":"2026-06-18T12:00:00Z"
	}`), &orderRaw); err != nil {
		t.Fatal(err)
	}
	order := adobeCommerceOrderInput(orderRaw)
	if order.SourceID != "adobe-commerce://order/100" || order.Status != "paid" || order.TotalCents != 4200 || order.DiscountCents != 500 {
		t.Fatalf("order=%+v", order)
	}
	if order.OrderedAt == nil || !order.OrderedAt.Equal(time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("ordered_at=%v", order.OrderedAt)
	}
	if len(order.LineItems) != 1 || order.LineItems[0]["source_id"] != "adobe-commerce://order_item/5" || order.LineItems[0]["price_cents"] != 2100 {
		t.Fatalf("line_items=%+v", order.LineItems)
	}

	var memoRaw map[string]any
	if err := json.Unmarshal([]byte(`{
		"entity_id":66,
		"increment_id":"CM-66",
		"order_id":100,
		"grand_total":"12.00",
		"order_currency_code":"USD",
		"customer_email":"BUYER@example.com"
	}`), &memoRaw); err != nil {
		t.Fatal(err)
	}
	event := adobeCommerceCreditMemoEvent("sales_order_creditmemo_refund", memoRaw)
	if event.EventType != "refund_created" || event.SourceID != "adobe-commerce://creditmemo/66" || event.CustomerEmail != "buyer@example.com" {
		t.Fatalf("event=%+v", event)
	}
	if event.Metadata["refund_cents"] != 1200 || event.Metadata["order_source"] != "adobe-commerce://order/100" {
		t.Fatalf("metadata=%+v", event.Metadata)
	}
}

func TestAdobeCommerceRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "45")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (AdobeCommerceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeAdobeCommerceCredentialResolver{creds: AdobeCommerceCredentials{AccessToken: "token_123"}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderAdobeCommerce,
		Settings: map[string]any{"base_url": srv.URL, "credential_ref": "cred_adobe"},
	}, "")
	var rateLimit AdobeCommerceRateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("err=%v, want AdobeCommerceRateLimitError", err)
	}
	if rateLimit.RetryAfter != 45*time.Second || rateLimit.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("rateLimit=%+v", rateLimit)
	}
}
