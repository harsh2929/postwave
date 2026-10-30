package commerce

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeCommerceCredentialResolver struct {
	tenantID    string
	integration Integration
	creds       WooCommerceCredentials
	err         error
}

func (f *fakeCommerceCredentialResolver) ResolveWooCommerce(_ context.Context, tenantID string, integration Integration) (WooCommerceCredentials, error) {
	f.tenantID = tenantID
	f.integration = integration
	return f.creds, f.err
}

func TestWooCommerceRESTBackfillerPullsProductsPage(t *testing.T) {
	var gotPath, gotQuery, gotAuth string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-WP-TotalPages", "3")
		_, _ = w.Write([]byte(`[
			{
				"id": 7,
				"name": "Beanie",
				"price": "19.99",
				"currency": "USD",
				"permalink": "https://shop.example/product/beanie",
				"images": [{"src": "https://shop.example/beanie.jpg"}]
			}
		]`))
	}))
	defer srv.Close()
	resolver := &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck_test", ConsumerSecret: "cs_test"}}
	backfiller := WooCommerceRESTBackfiller{
		HTTPClient:           srv.Client(),
		Credentials:          resolver,
		PageSize:             25,
		AllowUnsafeLocalURLs: true,
	}
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "products", Page: 2})

	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		ID:       "int_1",
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
	}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/wp-json/wc/v3/products" || !strings.Contains(gotQuery, "page=2") || !strings.Contains(gotQuery, "per_page=25") {
		t.Fatalf("path=%q query=%q", gotPath, gotQuery)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ck_test:cs_test"))
	if gotAuth != wantAuth {
		t.Fatalf("auth=%q want %q", gotAuth, wantAuth)
	}
	if resolver.tenantID != "tenant-1" || resolver.integration.ID != "int_1" {
		t.Fatalf("resolver tenant=%q integration=%+v", resolver.tenantID, resolver.integration)
	}
	if len(req.Products) != 1 {
		t.Fatalf("products=%+v", req.Products)
	}
	product := req.Products[0]
	if product.SourceID != "woocommerce://product/7" || product.Title != "Beanie" || product.PriceCents != 1999 || product.Currency != "USD" {
		t.Fatalf("product=%+v", product)
	}
	state, err := decodeWooCommerceBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "products" || state.Page != 3 {
		t.Fatalf("cursor state=%+v raw=%q", state, req.Cursor)
	}
}

func TestWooCommerceRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		http.Error(w, `{"message":"rate limited"}`, http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (WooCommerceRESTBackfiller{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		AllowUnsafeLocalURLs: true,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
	}, "")
	if err == nil {
		t.Fatal("expected rate limit error")
	}
	var rateLimit WooCommerceRateLimitError
	if !strings.Contains(err.Error(), "retry after 30s") || !errors.As(err, &rateLimit) || rateLimit.RetryAfter != 30*time.Second {
		t.Fatalf("rate limit error = %#v", err)
	}
}

func TestWooCommerceRESTBackfillerAttachesProductVariations(t *testing.T) {
	var variationPages int
	var variationQuery string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/wp-json/wc/v3/products":
			w.Header().Set("X-WP-TotalPages", "1")
			_, _ = w.Write([]byte(`[
				{
					"id": 22,
					"type": "variable",
					"name": "Hoodie",
					"price": "25.00",
					"regular_price": "30.00",
					"currency": "USD",
					"permalink": "https://shop.example/product/hoodie",
					"images": [{"src": "https://shop.example/hoodie.jpg"}],
					"variations": [501, 502, 503]
				}
			]`))
		case "/wp-json/wc/v3/products/22/variations":
			variationPages++
			variationQuery = r.URL.RawQuery
			if r.URL.Query().Get("orderby") != "" || r.URL.Query().Get("order") != "" {
				t.Fatalf("variation fetch should not add date ordering query: %q", r.URL.RawQuery)
			}
			w.Header().Set("X-WP-TotalPages", "2")
			if r.URL.Query().Get("page") == "1" {
				_, _ = w.Write([]byte(`[
					{
						"id": 501,
						"sku": "HOODIE-BLUE-M",
						"price": "25.00",
						"regular_price": "30.00",
						"stock_quantity": 4,
						"manage_stock": true,
						"backorders": "notify",
						"stock_status": "instock",
						"permalink": "https://shop.example/product/hoodie?attribute_pa_color=blue",
						"image": {"src": "https://shop.example/hoodie-blue.jpg"},
						"attributes": [
							{"id": 1, "name": "Color", "slug": "pa_color", "option": "Blue"},
							{"id": 2, "name": "Size", "slug": "pa_size", "option": "M"}
						]
					},
					{
						"id": 502,
						"sku": "HOODIE-BLUE-L",
						"price": "25.00",
						"regular_price": "30.00",
						"stock_quantity": 0,
						"manage_stock": true,
						"backorders": "no",
						"stock_status": "outofstock",
						"attributes": [
							{"name": "Color", "option": "Blue"},
							{"name": "Size", "option": "L"}
						]
					}
				]`))
				return
			}
			_, _ = w.Write([]byte(`[
				{
					"id": 503,
					"sku": "HOODIE-GREEN-M",
					"price": "26.00",
					"regular_price": "30.00",
					"stock_status": "instock",
					"attributes": [
						{"name": "Color", "option": "Green"},
						{"name": "Size", "option": "M"}
					]
				}
			]`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	backfiller := WooCommerceRESTBackfiller{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		PageSize:             2,
		AllowUnsafeLocalURLs: true,
	}
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "products", Page: 1})

	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
	}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if variationPages != 2 || !strings.Contains(variationQuery, "per_page=2") {
		t.Fatalf("variationPages=%d variationQuery=%q", variationPages, variationQuery)
	}
	if len(req.Products) != 1 {
		t.Fatalf("products=%+v", req.Products)
	}
	product := req.Products[0]
	variants, _ := product.Raw["variants"].([]any)
	if len(variants) != 3 {
		t.Fatalf("variants=%+v", product.Raw["variants"])
	}
	first, _ := variants[0].(map[string]any)
	if first["source_id"] != "woocommerce://product_variant/501" || first["product_source_id"] != "woocommerce://product/22" || first["title"] != "Hoodie / Blue / M" {
		t.Fatalf("first variant=%+v", first)
	}
	if first["option1"] != "Blue" || first["option1_name"] != "Color" || first["inventory_policy"] != "continue" || first["image_url"] != "https://shop.example/hoodie-blue.jpg" {
		t.Fatalf("first variant details=%+v", first)
	}
	variantMaps := productVariantMaps(product)
	if len(variantMaps) != 3 || sourceID(variantMaps[0]) != "woocommerce://product_variant/501" {
		t.Fatalf("variant maps=%+v", variantMaps)
	}
	options := variantOptionValues(variantMaps[0])
	if options["option1"] != "Blue" || options["Color"] != "Blue" || options["Size"] != "M" {
		t.Fatalf("options=%+v", options)
	}
}

func TestWooCommerceRESTBackfillerPullsSubscriptionEventsWhenEnabled(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-WP-TotalPages", "1")
		if r.URL.Path != "/wp-json/wc/v3/subscriptions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`[
			{
				"id": 881,
				"status": "active",
				"customer_id": 42,
				"parent_id": 55,
				"currency": "USD",
				"total": "29.00",
				"billing_period": "month",
				"billing_interval": "1",
				"next_payment_date_gmt": "2026-07-01T00:00:00",
				"billing": {"email": "buyer@example.com"},
				"coupon_lines": [{"id": 901, "code": "VIP20", "discount": "5.00"}],
				"line_items": [{
					"id": 11,
					"product_id": 7,
					"name": "Monthly box",
					"quantity": 1,
					"total": "29.00",
					"sku": "BOX-MONTHLY"
				}]
			}
		]`))
	}))
	defer srv.Close()
	backfiller := WooCommerceRESTBackfiller{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		PageSize:             25,
		AllowUnsafeLocalURLs: true,
	}
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "subscriptions", Page: 1})

	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc", "subscriptions_enabled": true},
	}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/wp-json/wc/v3/subscriptions" || !strings.Contains(gotQuery, "page=1") || !strings.Contains(gotQuery, "per_page=25") {
		t.Fatalf("path=%q query=%q", gotPath, gotQuery)
	}
	if len(req.ProviderEvents) != 1 || len(req.Customers) != 0 || len(req.Products) != 0 || len(req.Orders) != 0 {
		t.Fatalf("sync request=%+v", req)
	}
	event := req.ProviderEvents[0]
	if event.EventType != "subscription_updated" || event.SourceID != "woocommerce://subscription/881" || event.CustomerEmail != "buyer@example.com" {
		t.Fatalf("event=%+v", event)
	}
	if event.Metadata["billing_period"] != "month" || event.Metadata["total_cents"] != 2900 {
		t.Fatalf("metadata=%+v", event.Metadata)
	}
	state, err := decodeWooCommerceBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "complete" {
		t.Fatalf("cursor state=%+v raw=%q", state, req.Cursor)
	}
}

func TestWooCommerceRESTBackfillerPullsRefundEvents(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-WP-TotalPages", "1")
		if r.URL.Path != "/wp-json/wc/v3/refunds" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`[
			{
				"id": 724,
				"parent_id": 63,
				"date_created": "2017-03-21T16:55:37",
				"date_created_gmt": "2017-03-21T19:55:37",
				"amount": "9.00",
				"reason": "Returned item",
				"refunded_by": 1,
				"refunded_payment": false,
				"line_items": [{
					"id": 314,
					"name": "Woo Album #2",
					"product_id": 87,
					"variation_id": 0,
					"quantity": -1,
					"subtotal": "-9.00",
					"subtotal_tax": "0.00",
					"total": "-9.00",
					"total_tax": "0.00",
					"sku": "ALBUM-2"
				}]
			}
		]`))
	}))
	defer srv.Close()
	backfiller := WooCommerceRESTBackfiller{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		PageSize:             20,
		AllowUnsafeLocalURLs: true,
	}
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "refunds", Page: 1})

	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
	}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/wp-json/wc/v3/refunds" || !strings.Contains(gotQuery, "page=1") || !strings.Contains(gotQuery, "per_page=20") {
		t.Fatalf("path=%q query=%q", gotPath, gotQuery)
	}
	if len(req.ProviderEvents) != 1 || len(req.Orders) != 0 {
		t.Fatalf("sync request=%+v", req)
	}
	event := req.ProviderEvents[0]
	if event.EventType != "refund_created" || event.Topic != "refund.created" || event.SourceID != "woocommerce://refund/724" {
		t.Fatalf("event=%+v", event)
	}
	if event.Metadata["order_source_id"] != "woocommerce://order/63" || event.Metadata["refund_cents"] != 900 || event.Metadata["reason"] != "Returned item" {
		t.Fatalf("metadata=%+v", event.Metadata)
	}
	lineItems, _ := event.Metadata["line_items"].([]map[string]any)
	if len(lineItems) != 1 || lineItems[0]["sku"] != "ALBUM-2" || lineItems[0]["total_cents"] != -900 {
		t.Fatalf("line items=%+v", event.Metadata["line_items"])
	}
	if req.Cursor != woocommerceCursorComplete {
		t.Fatalf("cursor=%q", req.Cursor)
	}
}

func TestWooCommerceRESTBackfillerSkipsSubscriptionCursorWhenDisabled(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected provider call %s", r.URL.Path)
	}))
	defer srv.Close()
	backfiller := WooCommerceRESTBackfiller{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		AllowUnsafeLocalURLs: true,
	}
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "subscriptions", Page: 1})

	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
	}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if req.Cursor != woocommerceCursorComplete || syncRequestHasPayload(req) {
		t.Fatalf("sync request=%+v", req)
	}
}

func TestWooCommerceRESTBackfillerAdvancesToNextObjectOnLastPage(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-WP-TotalPages", "1")
		_, _ = w.Write([]byte(`[
			{
				"id": 99,
				"email": "BUYER@EXAMPLE.COM",
				"first_name": "Ada",
				"last_name": "Lovelace"
			}
		]`))
	}))
	defer srv.Close()
	backfiller := WooCommerceRESTBackfiller{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		AllowUnsafeLocalURLs: true,
	}

	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Customers) != 1 || req.Customers[0].Email != "buyer@example.com" {
		t.Fatalf("customers=%+v", req.Customers)
	}
	state, err := decodeWooCommerceBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "products" || state.Page != 1 {
		t.Fatalf("cursor state=%+v raw=%q", state, req.Cursor)
	}
}

func TestWooCommerceRESTBackfillerAdvancesOrdersToRefunds(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-WP-TotalPages", "1")
		if r.URL.Path != "/wp-json/wc/v3/orders" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`[{"id":55,"status":"processing","total":"42.00","billing":{"email":"buyer@example.com"}}]`))
	}))
	defer srv.Close()
	backfiller := WooCommerceRESTBackfiller{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		AllowUnsafeLocalURLs: true,
	}
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "orders", Page: 1})

	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
	}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeWooCommerceBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "refunds" || state.Page != 1 {
		t.Fatalf("cursor state=%+v raw=%q", state, req.Cursor)
	}
}

func TestWooCommerceOrderMapping(t *testing.T) {
	req, err := wooCommerceSyncRequest("orders", []map[string]any{{
		"id":             json.Number("55"),
		"status":         "processing",
		"currency":       "USD",
		"total":          "42.50",
		"discount_total": "2.50",
		"shipping_total": "5.00",
		"total_tax":      "3.00",
		"billing": map[string]any{
			"email": "buyer@example.com",
		},
		"payment_method":       "stripe",
		"payment_method_title": "Credit card",
		"transaction_id":       "txn_55",
		"customer_id":          json.Number("42"),
		"coupon_lines": []any{
			map[string]any{"id": json.Number("91"), "code": "WELCOME10", "discount": "2.50", "discount_tax": "0.00"},
			map[string]any{"id": json.Number("92"), "code": "welcome10", "discount": "0.00", "discount_tax": "0.00"},
		},
		"refunds": []any{
			map[string]any{
				"id":               json.Number("70"),
				"parent_id":        json.Number("55"),
				"reason":           "Customer return",
				"total":            "-4.25",
				"refunded_by":      json.Number("3"),
				"refunded_payment": true,
				"line_items": []any{map[string]any{
					"id":           json.Number("10"),
					"product_id":   json.Number("7"),
					"variation_id": json.Number("11"),
					"name":         "Beanie / Blue",
					"quantity":     json.Number("-1"),
					"subtotal":     "-4.25",
					"total":        "-4.25",
					"total_tax":    "0.00",
					"sku":          "BEANIE-BLUE",
				}},
			},
		},
		"line_items": []any{map[string]any{
			"id":           9,
			"product_id":   7,
			"variation_id": 11,
			"name":         "Beanie",
			"quantity":     2,
			"price":        "18.50",
			"subtotal":     "37.00",
			"subtotal_tax": "2.00",
			"total":        "34.50",
			"total_tax":    "1.80",
			"sku":          "BEANIE-BLUE",
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Orders) != 1 {
		t.Fatalf("orders=%+v", req.Orders)
	}
	order := req.Orders[0]
	if order.SourceID != "woocommerce://order/55" || order.Status != "paid" || order.TotalCents != 4250 || order.ShippingCents != 500 {
		t.Fatalf("order=%+v", order)
	}
	if len(order.LineItems) != 1 || order.LineItems[0]["price_cents"] != 1850 || order.LineItems[0]["subtotal_cents"] != 3700 || order.LineItems[0]["total_tax_cents"] != 180 || order.LineItems[0]["sku"] != "BEANIE-BLUE" {
		t.Fatalf("line_items=%+v", order.LineItems)
	}
	if order.Attribution["payment_method"] != "stripe" || order.Attribution["payment_method_title"] != "Credit card" || order.Attribution["transaction_id"] != "txn_55" {
		t.Fatalf("bad payment attribution: %+v", order.Attribution)
	}
	codes, _ := order.Attribution["discount_codes"].([]string)
	if len(codes) != 1 || codes[0] != "WELCOME10" {
		t.Fatalf("bad discount codes: %+v", order.Attribution)
	}
	coupons, _ := order.Attribution["coupon_lines"].([]map[string]any)
	if len(coupons) != 2 || coupons[0]["source_id"] != "woocommerce://coupon_line/91" || coupons[0]["discount_cents"] != 250 {
		t.Fatalf("bad coupon lines: %+v", coupons)
	}
	refunds, _ := order.Attribution["refunds"].([]map[string]any)
	if order.Attribution["refund_cents"] != 425 || len(refunds) != 1 || refunds[0]["source_id"] != "woocommerce://refund/70" || refunds[0]["refund_cents"] != 425 {
		t.Fatalf("bad refund attribution: %+v", order.Attribution)
	}
	refundLineItems, _ := refunds[0]["line_items"].([]map[string]any)
	if len(refundLineItems) != 1 || refundLineItems[0]["quantity"] != -1 || refundLineItems[0]["total_cents"] != -425 {
		t.Fatalf("bad refund line items: %+v", refunds[0])
	}
}

func TestIntegrationSyncStateExposesWooCommerceCursor(t *testing.T) {
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "orders", Page: 4})
	updatedAt := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	state := integrationSyncState(cursor, updatedAt)
	if state == nil || state.CursorKind != "woocommerce_cursor" || state.Mode != "rest_backfill" || state.Object != "orders" {
		t.Fatalf("state=%+v", state)
	}
	complete := integrationSyncState(woocommerceCursorComplete, updatedAt)
	if complete == nil || complete.CursorKind != "woocommerce_complete" || !complete.Complete {
		t.Fatalf("complete=%+v", complete)
	}
}

func TestIntegrationSyncStateExposesWooCommerceRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "products", Page: 3})
	cursor := encodeWooCommerceRetryCursor(wooCommerceRetryState{
		Cursor:        baseCursor,
		Attempts:      2,
		NextAttemptAt: now.Add(30 * time.Minute).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "temporary WooCommerce 500",
	})

	state := integrationSyncState(cursor, now)
	if state == nil || state.CursorKind != "woocommerce_retry" || state.Mode != "rest_backfill" || state.Object != "products" {
		t.Fatalf("state=%+v", state)
	}
	if state.Attempts != 2 || state.LastStatus != "BACKFILL_FAILED" || state.LastError != "temporary WooCommerce 500" || state.RetryDue || state.RetryWaitSeconds != 1800 {
		t.Fatalf("state=%+v", state)
	}
}
