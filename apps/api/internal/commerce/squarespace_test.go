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

func TestSquarespaceSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewSquarespaceSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{
		"vault://commerce/squarespace":         `{"api_key":"sq_api_123","api_base_url":"https://api.squarespace.test","user_agent":"Moosewave Test"}`,
		"vault://commerce/squarespace-webhook": "webhook_secret=abcdef0123456789",
	}})

	creds, err := resolver.ResolveSquarespace(context.Background(), "tenant-1", Integration{
		Provider: ProviderSquarespace,
		Settings: map[string]any{
			"credential_ref":     "vault://commerce/squarespace",
			"webhook_secret_ref": "vault://commerce/squarespace-webhook",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "sq_api_123" || creds.WebhookSecret != "abcdef0123456789" || creds.APIBaseURL != "https://api.squarespace.test" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds = %+v", creds)
	}
}

func TestSquarespaceRESTBackfillerPullsContactsProductsAndOrders(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sq_api_123" {
			t.Fatalf("authorization header = %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("User-Agent") != "Moosewave Test" {
			t.Fatalf("user-agent header = %q", r.Header.Get("User-Agent"))
		}
		seen = append(seen, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/v1/contacts":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"contacts":[{"id":"contact_123","firstName":"Ada","lastName":"Lovelace","primaryEmail":{"email":"ADA@example.com","acceptsMarketing":{"acceptsMarketing":true}}}],
				"pagination":{"nextPageCursor":"contact_cursor_2"}
			}`))
		case "/v2/commerce/products":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"products":[{"id":"prod_123","name":"Canvas tote","url":"/shop/p/canvas-tote","images":[{"url":"https://img.example/tote.jpg"}],"variants":[{"pricing":{"basePrice":{"value":24,"currency":"USD"}}}]}],
				"pagination":{}
			}`))
		case "/1.0/commerce/orders":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"result":[{"id":"order_123","customerEmail":"BUYER@example.com","paymentState":"PAID","subtotal":{"value":40,"currency":"USD"},"discountTotal":{"value":0,"currency":"USD"},"shippingTotal":{"value":1,"currency":"USD"},"taxTotal":{"value":1,"currency":"USD"},"grandTotal":{"value":42,"currency":"USD"},"lineItems":[{"id":"line_1","productId":"prod_123","variantId":"var_123","sku":"TOTE-BLACK","productName":"Black tote","quantity":2,"unitPricePaid":{"value":21,"currency":"USD"}}],"createdOn":"2026-06-18T12:00:00Z"}],
				"pagination":{}
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	backfiller := SquarespaceRESTBackfiller{
		HTTPClient: server.Client(),
		Credentials: &fakeSquarespaceCredentialResolver{creds: SquarespaceCredentials{
			AccessToken: "sq_api_123",
			APIBaseURL:  server.URL,
			UserAgent:   "Moosewave Test",
		}},
	}
	integration := Integration{Provider: ProviderSquarespace, Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_sq"}}

	contactsReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(contactsReq.Customers) != 1 || contactsReq.Customers[0].SourceID != "squarespace://contact/contact_123" || contactsReq.Customers[0].Email != "ada@example.com" || !contactsReq.Customers[0].AcceptsMarketing {
		t.Fatalf("customers = %+v", contactsReq.Customers)
	}
	contactState, err := decodeSquarespaceBackfillCursor(contactsReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if contactState.Object != "contacts" || contactState.Cursor != "contact_cursor_2" {
		t.Fatalf("contact cursor = %+v", contactState)
	}

	productsReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: "products"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(productsReq.Products) != 1 || productsReq.Products[0].SourceID != "squarespace://product/prod_123" || productsReq.Products[0].Title != "Canvas tote" || productsReq.Products[0].PriceCents != 2400 || productsReq.Products[0].Currency != "USD" {
		t.Fatalf("products = %+v", productsReq.Products)
	}

	ordersReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: "orders"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(ordersReq.Orders) != 1 {
		t.Fatalf("orders = %+v", ordersReq.Orders)
	}
	order := ordersReq.Orders[0]
	if order.SourceID != "squarespace://order/order_123" || order.CustomerEmail != "buyer@example.com" || order.Status != "paid" || order.TotalCents != 4200 || order.Currency != "USD" {
		t.Fatalf("order = %+v", order)
	}
	if len(order.LineItems) != 1 || order.LineItems[0]["source_id"] != "squarespace://order_item/line_1" || order.LineItems[0]["total_cents"] != 4200 {
		t.Fatalf("line items = %+v", order.LineItems)
	}
	if ordersReq.Cursor != squarespaceCursorComplete {
		t.Fatalf("order cursor = %q", ordersReq.Cursor)
	}
	if !hasString(seen, "/v1/contacts?") || !hasString(seen, "/v2/commerce/products?") || !hasString(seen, "/1.0/commerce/orders?") {
		t.Fatalf("paths = %+v", seen)
	}
}

func TestSquarespaceRESTBackfillerEnrichesThinProductListItems(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		switch r.URL.Path {
		case "/v2/commerce/products":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"products":[{"id":"prod_123","name":"Canvas tote","urlSlug":"canvas-tote"}],
				"pagination":{}
			}`))
		case "/v2/commerce/products/prod_123":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"products":[{"id":"prod_123","name":"Canvas tote","url":"/shop/p/canvas-tote","images":[{"url":"https://img.example/tote.jpg"}],"variants":[{"id":"var_123","sku":"TOTE","pricing":{"basePrice":{"value":24,"currency":"USD"}}}]}]
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	req, err := (SquarespaceRESTBackfiller{
		HTTPClient: server.Client(),
		Credentials: &fakeSquarespaceCredentialResolver{creds: SquarespaceCredentials{
			AccessToken: "sq_api_123",
			APIBaseURL:  server.URL,
			UserAgent:   "Moosewave Test",
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderSquarespace,
		Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_sq"},
	}, encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: "products"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Products) != 1 {
		t.Fatalf("products = %+v", req.Products)
	}
	product := req.Products[0]
	if product.PriceCents != 2400 || product.Currency != "USD" || product.ImageURL != "https://img.example/tote.jpg" {
		t.Fatalf("product was not enriched from detail endpoint: %+v", product)
	}
	if !hasString(seen, "/v2/commerce/products") || !hasString(seen, "/v2/commerce/products/prod_123") {
		t.Fatalf("paths = %+v", seen)
	}
}

func TestSquarespaceRESTBackfillerFetchesOrderByID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/1.0/commerce/orders/order_123" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.Header.Get("User-Agent") == "" {
			t.Fatal("missing User-Agent")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"order_123","customerEmail":"buyer@example.com","paymentState":"PAID","grandTotal":{"value":42,"currency":"USD"}}`))
	}))
	defer server.Close()

	order, err := (SquarespaceRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: &fakeSquarespaceCredentialResolver{creds: SquarespaceCredentials{AccessToken: "sq_api_123", APIBaseURL: server.URL}},
	}).FetchSquarespaceOrder(context.Background(), "tenant-1", Integration{
		Provider: ProviderSquarespace,
		Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_sq"},
	}, "order_123")
	if err != nil {
		t.Fatal(err)
	}
	if order.SourceID != "squarespace://order/order_123" || order.TotalCents != 4200 {
		t.Fatalf("order = %+v", order)
	}
}

func TestSquarespaceRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		http.Error(w, `{"message":"slow down"}`, http.StatusTooManyRequests)
	}))
	defer server.Close()

	_, err := (SquarespaceRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: &fakeSquarespaceCredentialResolver{creds: SquarespaceCredentials{AccessToken: "sq_api_123", APIBaseURL: server.URL}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderSquarespace,
		Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_sq"},
	}, "")

	var rateLimit SquarespaceRateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("expected rate limit error, got %v", err)
	}
	if rateLimit.RetryAfter != 7*time.Second || !strings.Contains(rateLimit.Snippet, "slow down") {
		t.Fatalf("rate limit = %+v", rateLimit)
	}
}
