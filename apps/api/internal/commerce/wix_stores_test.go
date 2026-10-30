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

func TestWixStoresSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewWixStoresSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{
		"vault://commerce/wix":         `{"client_id":"app_123","client_secret":"secret_123","instance_id":"instance_123","api_base_url":"https://wixapis.example.test","token_url":"https://auth.example.test/oauth2/token"}`,
		"vault://commerce/wix-webhook": "secret=wix_shared_secret",
	}})

	creds, err := resolver.ResolveWixStores(context.Background(), "tenant-1", Integration{
		Provider: ProviderWixStores,
		Settings: map[string]any{
			"credential_ref":     "vault://commerce/wix",
			"webhook_secret_ref": "vault://commerce/wix-webhook",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creds.ClientID != "app_123" || creds.ClientSecret != "secret_123" || creds.InstanceID != "instance_123" || creds.WebhookSecret != "wix_shared_secret" || creds.APIBaseURL != "https://wixapis.example.test" || creds.TokenURL != "https://auth.example.test/oauth2/token" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestWixStoresWebhookEventParsesOfficialDataString(t *testing.T) {
	event := wixStoresWebhookEventFromMap(map[string]any{
		"data": `{"eventType":"wix.ecom.v1.order.created","instanceId":"instance_123","entityFqdn":"wix.ecom.v1.order","slug":"created","entityId":"order_123","siteId":"site_123"}`,
	}, nil)

	if event.Topic != "wix.ecom.v1.order.created" || event.InstanceID != "instance_123" || event.SiteID != "site_123" || event.EntityID != "order_123" {
		t.Fatalf("event=%+v", event)
	}
}

func TestDecodeWixStoresTokenAcceptsGatewayResponseShapes(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{name: "top level snake case", body: `{"access_token":"access_123"}`},
		{name: "top level camel case", body: `{"accessToken":"access_123"}`},
		{name: "top level token", body: `{"token":"Bearer access_123"}`},
		{name: "gateway body string", body: `{"statusCode":200,"body":"{\"accessToken\":\"access_123\"}"}`},
		{name: "gateway body object", body: `{"statusCode":200,"body":{"token":"access_123"}}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			token, err := decodeWixStoresToken([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if token != "access_123" {
				t.Fatalf("token=%q", token)
			}
		})
	}
}

func TestWixStoresRESTBackfillerMintsTokenAndPullsContactPage(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/oauth2/token":
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload["grant_type"] != "client_credentials" || payload["client_id"] != "app_123" || payload["client_secret"] != "secret_123" || payload["instance_id"] != "instance_123" {
				t.Fatalf("token payload=%+v", payload)
			}
			_, _ = w.Write([]byte(`{"statusCode":200,"body":"{\"access_token\":\"access_123\"}"}`))
		case "/contacts/v4/contacts/query":
			if auth := r.Header.Get("Authorization"); auth != "Bearer access_123" {
				t.Fatalf("auth=%q", auth)
			}
			if siteID := r.Header.Get("wix-site-id"); siteID != "site_123" {
				t.Fatalf("wix-site-id=%q", siteID)
			}
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			cursorPaging := mapField(mapField(payload, "query"), "cursorPaging")
			if intField(cursorPaging, "limit") != 10 {
				t.Fatalf("query payload=%+v", payload)
			}
			_, _ = w.Write([]byte(`{
				"contacts":[{
					"id":"contact_123",
					"primaryInfo":{"email":"BUYER@example.com"},
					"info":{"name":{"first":"Ada","last":"Lovelace"},"labelKeys":["vip"]}
				}],
				"pagingMetadata":{"cursors":{"next":"next_contact_cursor"}}
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (WixStoresRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{
			ClientID:     "app_123",
			ClientSecret: "secret_123",
			InstanceID:   "instance_123",
		}},
		APIBaseURL: srv.URL,
		PageSize:   10,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWixStores,
		Settings: map[string]any{
			"site_id":        "site_123",
			"instance_id":    "instance_123",
			"credential_ref": "cred_wix",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "POST /oauth2/token,POST /contacts/v4/contacts/query" {
		t.Fatalf("calls=%+v", calls)
	}
	if len(req.Customers) != 1 {
		t.Fatalf("customers=%+v", req.Customers)
	}
	customer := req.Customers[0]
	if customer.SourceID != "wix://contact/contact_123" || customer.Email != "buyer@example.com" || customer.FirstName != "Ada" || customer.LastName != "Lovelace" {
		t.Fatalf("customer=%+v", customer)
	}
	state, err := decodeWixStoresBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "contacts" || state.Cursor != "next_contact_cursor" {
		t.Fatalf("cursor state=%+v cursor=%q", state, req.Cursor)
	}
}

func TestWixStoresRESTBackfillerPullsProductsAndOrders(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer access_123" {
			t.Fatalf("auth=%q", auth)
		}
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/stores/v3/provision/version":
			_, _ = w.Write([]byte(`{"catalogVersion":"V3"}`))
		case "/stores/v3/products/query":
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if intField(mapField(mapField(payload, "query"), "cursorPaging"), "limit") != 2 {
				t.Fatalf("product query payload=%+v", payload)
			}
			_, _ = w.Write([]byte(`{
				"products":[{
					"id":"prod_123",
					"name":"Canvas tote",
					"slug":"canvas-tote",
					"price":{"amount":"24.00","currency":"USD"},
					"media":{"mainMedia":{"image":{"url":"https://cdn.example.test/tote.jpg"}}}
				}]
			}`))
		case "/ecom/v1/orders/search":
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if intField(mapField(mapField(payload, "search"), "cursorPaging"), "limit") != 2 {
				t.Fatalf("order search payload=%+v", payload)
			}
			_, _ = w.Write([]byte(`{
				"orders":[{
					"id":"order_123",
					"status":"APPROVED",
					"buyerInfo":{"email":"BUYER@example.com"},
					"priceSummary":{"total":{"amount":"42.00","currency":"USD"},"subtotal":{"amount":"40.00","currency":"USD"},"tax":{"amount":"2.00","currency":"USD"}},
					"lineItems":[{"id":"line_1","productId":"prod_123","sku":"TOTE-BLACK","productName":"Black tote","quantity":2,"price":{"amount":"21.00","currency":"USD"}}],
					"createdDate":"2026-06-18T12:00:00Z"
				}]
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := WixStoresRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{AccessToken: "access_123"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}
	integration := Integration{
		Provider: ProviderWixStores,
		Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_wix"},
	}

	productReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, encodeWixStoresBackfillCursor(wixStoresBackfillState{Object: "products"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(productReq.Products) != 1 {
		t.Fatalf("products=%+v", productReq.Products)
	}
	product := productReq.Products[0]
	if product.SourceID != "wix://product/prod_123" || product.Title != "Canvas tote" || product.PriceCents != 2400 || product.Currency != "USD" || product.URL != "/product-page/canvas-tote" {
		t.Fatalf("product=%+v", product)
	}

	orderReq, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, productReq.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(orderReq.Orders) != 1 {
		t.Fatalf("orders=%+v", orderReq.Orders)
	}
	order := orderReq.Orders[0]
	if order.SourceID != "wix://order/order_123" || order.CustomerEmail != "buyer@example.com" || order.Status != "paid" || order.TotalCents != 4200 || order.TaxCents != 200 || order.Currency != "USD" {
		t.Fatalf("order=%+v", order)
	}
	if len(order.LineItems) != 1 || order.LineItems[0]["source_id"] != "wix://order_item/line_1" || order.LineItems[0]["total_cents"] != 4200 {
		t.Fatalf("line_items=%+v", order.LineItems)
	}
	if orderReq.Cursor != wixStoresCursorComplete {
		t.Fatalf("cursor=%q", orderReq.Cursor)
	}
	if strings.Join(calls, ",") != "GET /stores/v3/provision/version,POST /stores/v3/products/query,POST /ecom/v1/orders/search" {
		t.Fatalf("calls=%+v", calls)
	}
}

func TestWixStoresRESTBackfillerUsesCatalogV1ProductPath(t *testing.T) {
	calls := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/stores/v3/provision/version":
			_, _ = w.Write([]byte(`{"catalogVersion":"V1"}`))
		case "/stores-reader/v1/products/query":
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			query := mapField(payload, "query")
			if len(mapField(query, "cursorPaging")) != 0 {
				t.Fatalf("catalog v1 should use offset paging, payload=%+v", payload)
			}
			paging := mapField(query, "paging")
			if intField(paging, "limit") != 1 || intField(paging, "offset") != 0 {
				t.Fatalf("catalog v1 paging=%+v payload=%+v", paging, payload)
			}
			_, _ = w.Write([]byte(`{
				"products":[{"id":"prod_v1","name":"V1 product"}],
				"metadata":{"totalResults":2}
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (WixStoresRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{AccessToken: "access_123"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWixStores,
		Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_wix"},
	}, encodeWixStoresBackfillCursor(wixStoresBackfillState{Object: "products"}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "GET /stores/v3/provision/version,POST /stores-reader/v1/products/query" {
		t.Fatalf("calls=%+v", calls)
	}
	state, err := decodeWixStoresBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "products" || state.Cursor != "1" {
		t.Fatalf("cursor state=%+v cursor=%q", state, req.Cursor)
	}
}

func TestWixStoresRESTBackfillerHonorsConfiguredCatalogVersion(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"products":[]}`))
	}))
	defer srv.Close()

	_, err := (WixStoresRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{AccessToken: "access_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWixStores,
		Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_wix", "catalog_version": "v1"},
	}, encodeWixStoresBackfillCursor(wixStoresBackfillState{Object: "products"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/stores-reader/v1/products/query" {
		t.Fatalf("path=%q", gotPath)
	}
}

func TestWixStoresRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "20")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (WixStoresRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{AccessToken: "access_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider: ProviderWixStores,
		Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_wix"},
	}, "")
	if err == nil {
		t.Fatal("expected rate limit error")
	}
	var rateLimit WixStoresRateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("err=%T %v", err, err)
	}
	if rateLimit.StatusCode != http.StatusTooManyRequests || rateLimit.RetryAfter != 20*time.Second {
		t.Fatalf("rate limit=%+v", rateLimit)
	}
}
