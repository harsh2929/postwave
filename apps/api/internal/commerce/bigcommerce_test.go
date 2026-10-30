package commerce

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeBigCommerceCredentialResolver struct {
	tenantID    string
	integration Integration
	creds       BigCommerceCredentials
	err         error
}

func (f *fakeBigCommerceCredentialResolver) ResolveBigCommerce(_ context.Context, tenantID string, integration Integration) (BigCommerceCredentials, error) {
	f.tenantID = tenantID
	f.integration = integration
	return f.creds, f.err
}

func TestBigCommerceRESTBackfillerPullsCustomersPage(t *testing.T) {
	var gotPath, gotQuery, gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotToken = r.Header.Get("X-Auth-Token")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [{
				"id": 1024,
				"email": "JANE@example.com",
				"first_name": "Jane",
				"last_name": "Doe",
				"customer_group_id": 3,
				"accepts_product_review_abandoned_cart_emails": true
			}],
			"meta": {"pagination": {"current_page": 1, "total_pages": 2}}
		}`))
	}))
	defer srv.Close()

	resolver := &fakeBigCommerceCredentialResolver{creds: BigCommerceCredentials{AccessToken: "token_bc"}}
	req, err := (BigCommerceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: resolver,
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderBigCommerce,
		Settings: map[string]any{"store_hash": "ABC123", "credential_ref": "cred_bc"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/stores/abc123/v3/customers" || !strings.Contains(gotQuery, "limit=2") || !strings.Contains(gotQuery, "page=1") {
		t.Fatalf("request path=%q query=%q", gotPath, gotQuery)
	}
	if gotToken != "token_bc" {
		t.Fatalf("X-Auth-Token = %q", gotToken)
	}
	if resolver.tenantID != "tenant-1" || resolver.integration.Provider != ProviderBigCommerce {
		t.Fatalf("resolver inputs tenant=%q integration=%+v", resolver.tenantID, resolver.integration)
	}
	if len(req.Customers) != 1 {
		t.Fatalf("customers = %+v", req.Customers)
	}
	customer := req.Customers[0]
	if customer.SourceID != "bigcommerce://customer/1024" || customer.Email != "jane@example.com" || !customer.AcceptsMarketing {
		t.Fatalf("customer = %+v", customer)
	}
	if len(customer.Tags) != 1 || customer.Tags[0] != "bigcommerce_customer_group:3" {
		t.Fatalf("tags = %+v", customer.Tags)
	}
	state, err := decodeBigCommerceBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "customers" || state.Page != 2 {
		t.Fatalf("cursor state = %+v", state)
	}
}

func TestBigCommerceRESTBackfillerPullsProductsWithVariants(t *testing.T) {
	var variantPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/stores/abc123/v3/catalog/products":
			if got := r.URL.Query().Get("include"); got != "images" {
				t.Fatalf("include query = %q", got)
			}
			_, _ = w.Write([]byte(`{
				"data": [{
					"id": 77,
					"name": "Fog Linen Towel",
					"price": 55.99,
					"custom_url": {"url": "/fog-linen-towel/"},
					"primary_image": {"url_standard": "https://cdn.example/product.jpg"}
				}],
				"meta": {"pagination": {"current_page": 1, "total_pages": 1}}
			}`))
		case "/stores/abc123/v3/catalog/products/77/variants":
			variantPath = r.URL.Path
			_, _ = w.Write([]byte(`{
				"data": [{
					"id": 382,
					"product_id": 77,
					"sku": "TOWEL-BEIGE",
					"calculated_price": 49.99,
					"retail_price": 59.99,
					"inventory_level": 4,
					"image_url": "https://cdn.example/variant.jpg",
					"option_values": [{"option_display_name": "Color", "label": "Beige"}]
				}],
				"meta": {"pagination": {"current_page": 1, "total_pages": 1}}
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (BigCommerceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeBigCommerceCredentialResolver{creds: BigCommerceCredentials{AccessToken: "token_bc"}},
		APIBaseURL:  srv.URL,
		PageSize:    10,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderBigCommerce,
		Settings: map[string]any{"store_hash": "abc123", "default_currency": "usd"},
	}, encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "products", Page: 1}))
	if err != nil {
		t.Fatal(err)
	}
	if variantPath == "" {
		t.Fatalf("variant endpoint was not called")
	}
	if len(req.Products) != 1 {
		t.Fatalf("products = %+v", req.Products)
	}
	product := req.Products[0]
	if product.SourceID != "bigcommerce://product/77" || product.Title != "Fog Linen Towel" || product.PriceCents != 5599 || product.Currency != "USD" {
		t.Fatalf("product = %+v", product)
	}
	variants := rawArray(product.Raw["variants"])
	if len(variants) != 1 {
		t.Fatalf("variants = %+v", product.Raw["variants"])
	}
	variant := variants[0].(map[string]any)
	if variant["source_id"] != "bigcommerce://product_variant/382" || variant["option1"] != "Beige" || cents(variant["compare_at_price"]) != 5999 {
		t.Fatalf("variant = %+v", variant)
	}
	if req.Cursor != encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 1}) {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestBigCommerceRESTBackfillerPullsOrdersWithProductsAndCoupons(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/stores/abc123/v2/orders":
			if got := r.URL.Query().Get("sort"); got != "date_created:asc" {
				t.Fatalf("sort query = %q", got)
			}
			_, _ = w.Write([]byte(`[
				{
					"id": 149,
					"billing_address": {"email": "buyer@example.com"},
					"status": "Awaiting Fulfillment",
					"subtotal_inc_tax": "361.9500",
					"discount_amount": "5.0000",
					"shipping_cost_inc_tax": "10.0000",
					"total_tax": "25.6300",
					"total_inc_tax": "366.9500",
					"currency_code": "USD",
					"date_created": "2026-06-01T10:00:00+00:00",
					"payment_method": "Credit Card",
					"channel_id": 1
				}
			]`))
		case "/stores/abc123/v2/orders/149/products":
			_, _ = w.Write([]byte(`[
				{
					"id": 65,
					"order_id": 149,
					"product_id": 77,
					"name": "Fog Linen Chambray Towel",
					"sku": "S-ORAN",
					"price_inc_tax": "65.2300",
					"total_inc_tax": "65.2300",
					"total_tax": "9.2400",
					"quantity": 1,
					"product_options": [{"display_name": "Size", "display_value": "S"}]
				}
			]`))
		case "/stores/abc123/v2/orders/149/coupons":
			_, _ = w.Write([]byte(`[{"id": 3, "code": "WELCOME", "amount": 5, "discount": 5, "type": 2}]`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (BigCommerceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeBigCommerceCredentialResolver{creds: BigCommerceCredentials{AccessToken: "token_bc"}},
		APIBaseURL:  srv.URL,
		PageSize:    250,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderBigCommerce,
		Settings: map[string]any{"store_hash": "abc123"},
	}, encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 1}))
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Orders) != 1 {
		t.Fatalf("orders = %+v", req.Orders)
	}
	order := req.Orders[0]
	if order.SourceID != "bigcommerce://order/149" || order.Status != "paid" || order.TotalCents != 36695 || order.DiscountCents != 500 {
		t.Fatalf("order = %+v", order)
	}
	if len(order.LineItems) != 1 || order.LineItems[0]["source_id"] != "bigcommerce://line_item/65" || order.LineItems[0]["sku"] != "S-ORAN" {
		t.Fatalf("line items = %+v", order.LineItems)
	}
	codes, _ := order.Attribution["discount_codes"].([]string)
	if len(codes) != 1 || codes[0] != "WELCOME" {
		t.Fatalf("discount codes = %+v", order.Attribution["discount_codes"])
	}
	if order.OrderedAt == nil || !order.OrderedAt.Equal(time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("ordered_at = %+v", order.OrderedAt)
	}
	if req.Cursor != bigCommerceCursorComplete {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestBigCommerceSecretsCredentialResolverParsesRawToken(t *testing.T) {
	resolver := NewBigCommerceSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{"ref": "Bearer token_bc"}})
	creds, err := resolver.ResolveBigCommerce(context.Background(), "tenant-1", Integration{Settings: map[string]any{"credential_ref": "ref"}})
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "token_bc" {
		t.Fatalf("creds = %+v", creds)
	}
}

func TestIntegrationSyncStateExposesBigCommerceCursor(t *testing.T) {
	cursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "products", Page: 3})
	state := integrationSyncState(cursor, time.Now())
	raw, _ := json.Marshal(state)
	if state == nil || state.CursorKind != "bigcommerce_cursor" || state.Mode != "rest_backfill" || state.Object != "products" {
		t.Fatalf("state = %s", raw)
	}
	if integrationSyncState(bigCommerceCursorComplete, time.Now()).CursorKind != "bigcommerce_complete" {
		t.Fatalf("complete state = %+v", integrationSyncState(bigCommerceCursorComplete, time.Now()))
	}
}

func TestBigCommerceDefaultWebhookScopesCoverLifecycleAndInventory(t *testing.T) {
	required := []string{
		"store/customer/created",
		"store/customer/updated",
		"store/customer/deleted",
		"store/product/created",
		"store/product/updated",
		"store/product/deleted",
		"store/product/inventory/updated",
		"store/product/inventory/order/updated",
		"store/order/created",
		"store/order/updated",
		"store/order/archived",
		"store/order/statusUpdated",
		"store/order/refund/created",
		"store/order/transaction/created",
		"store/order/transaction/updated",
	}
	for _, scope := range required {
		if !hasString(defaultBigCommerceWebhookScopes, scope) {
			t.Fatalf("default BigCommerce scopes missing %s: %+v", scope, defaultBigCommerceWebhookScopes)
		}
	}
	seen := map[string]struct{}{}
	for _, scope := range defaultBigCommerceWebhookScopes {
		normalized := normalizeBigCommerceWebhookScope(scope)
		if _, ok := seen[normalized]; ok {
			t.Fatalf("duplicate BigCommerce webhook scope %q in %+v", scope, defaultBigCommerceWebhookScopes)
		}
		seen[normalized] = struct{}{}
	}
}

func TestBigCommerceRESTWebhookRegistrarCreatesMissingHookWithSecretHeader(t *testing.T) {
	var createdBody map[string]any
	var gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		gotToken = r.Header.Get("X-Auth-Token")
		switch r.Method + " " + r.URL.Path {
		case "GET /stores/abc123/v3/hooks":
			_, _ = w.Write([]byte(`{"data":[],"meta":{"pagination":{"total_pages":1}}}`))
		case "POST /stores/abc123/v3/hooks":
			if err := json.NewDecoder(r.Body).Decode(&createdBody); err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write([]byte(`{"id":201,"scope":"store/order/updated","destination":"https://app.example/api/public/commerce/bigcommerce/webhooks","is_active":true}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	summary, err := (BigCommerceRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: &fakeBigCommerceCredentialResolver{creds: BigCommerceCredentials{AccessToken: "token_bc"}},
		APIBaseURL:  srv.URL,
		Scopes:      []string{"store/order/updated"},
	}).ReconcileWebhooks(context.Background(), Integration{
		TenantID:      "tenant-1",
		Provider:      ProviderBigCommerce,
		Settings:      map[string]any{"store_hash": "abc123"},
		WebhookSecret: "secret_bc",
	}, "https://app.example")
	if err != nil {
		t.Fatal(err)
	}
	if gotToken != "token_bc" {
		t.Fatalf("X-Auth-Token = %q", gotToken)
	}
	headers, _ := createdBody["headers"].(map[string]any)
	if createdBody["scope"] != "store/order/updated" || headers[bigCommerceWebhookSecretHeader] != "secret_bc" {
		t.Fatalf("created body = %+v", createdBody)
	}
	if len(summary.Subscriptions) != 1 || !summary.Subscriptions[0].Created {
		t.Fatalf("summary = %+v", summary)
	}
}

func TestBigCommerceRESTWebhookRegistrarReactivatesOwnedHook(t *testing.T) {
	var updatedBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /stores/abc123/v3/hooks":
			_, _ = w.Write([]byte(`{"data":[{"id":201,"scope":"store/order/updated","destination":"https://app.example/api/public/commerce/bigcommerce/webhooks","is_active":false}],"meta":{"pagination":{"total_pages":1}}}`))
		case "PUT /stores/abc123/v3/hooks/201":
			if err := json.NewDecoder(r.Body).Decode(&updatedBody); err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write([]byte(`{"id":201,"scope":"store/order/updated","destination":"https://app.example/api/public/commerce/bigcommerce/webhooks","is_active":true}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	summary, err := (BigCommerceRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: &fakeBigCommerceCredentialResolver{creds: BigCommerceCredentials{AccessToken: "token_bc"}},
		APIBaseURL:  srv.URL,
		Scopes:      []string{"store/order/updated"},
	}).ReconcileWebhooks(context.Background(), Integration{
		TenantID:      "tenant-1",
		Provider:      ProviderBigCommerce,
		Settings:      map[string]any{"store_hash": "abc123"},
		WebhookSecret: "secret_bc",
	}, "https://app.example")
	if err != nil {
		t.Fatal(err)
	}
	if updatedBody["is_active"] != true {
		t.Fatalf("updated body = %+v", updatedBody)
	}
	if len(summary.Subscriptions) != 1 || !summary.Subscriptions[0].Updated || !summary.Subscriptions[0].Active {
		t.Fatalf("summary = %+v", summary)
	}
}
