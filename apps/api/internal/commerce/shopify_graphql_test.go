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
)

func TestShopifyAdminGraphQLBackfillCustomers(t *testing.T) {
	var requestBody map[string]any
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if got := r.URL.String(); got != "https://demo.myshopify.com/admin/api/2026-04/graphql.json" {
			t.Fatalf("url = %s", got)
		}
		if got := r.Header.Get("X-Shopify-Access-Token"); got != "shpat_123" {
			t.Fatalf("token header = %q", got)
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &requestBody); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(requestBody["query"].(string), "customers") {
			t.Fatalf("query = %s", requestBody["query"])
		}
		return jsonResponse(http.StatusOK, `{
			"data":{
				"customers":{
					"edges":[{
						"cursor":"cursor_1",
						"node":{
							"id":"gid://shopify/Customer/1",
							"firstName":"Ada",
							"lastName":"Lovelace",
							"tags":["VIP","Wholesale"],
							"defaultEmailAddress":{
								"emailAddress":"ADA@EXAMPLE.COM",
								"marketingState":"SUBSCRIBED"
							}
						}
					}],
					"pageInfo":{"hasNextPage":true,"endCursor":"cursor_1"}
				}
			},
			"extensions":{"cost":{"requestedQueryCost":10,"actualQueryCost":5,"throttleStatus":{"maximumAvailable":1000,"currentlyAvailable":995,"restoreRate":50}}}
		}`), nil
	})}
	backfiller := ShopifyAdminGraphQLBackfiller{HTTPClient: client, PageSize: 2}

	req, err := backfiller.BackfillPage(context.Background(), Integration{
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := int(requestBody["variables"].(map[string]any)["first"].(float64)); got != 2 {
		t.Fatalf("first variable = %d", got)
	}
	if len(req.Customers) != 1 || req.Customers[0].SourceID != "gid://shopify/Customer/1" {
		t.Fatalf("customers = %+v", req.Customers)
	}
	if req.Customers[0].Email != "ada@example.com" || !req.Customers[0].AcceptsMarketing {
		t.Fatalf("customer mapping = %+v", req.Customers[0])
	}
	if req.Cursor == "" || req.Cursor == shopifyBackfillCursorComplete {
		t.Fatalf("cursor = %q", req.Cursor)
	}
	state, err := decodeShopifyBackfillCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "customers" || state.After != "cursor_1" {
		t.Fatalf("cursor state = %+v", state)
	}
}

func TestShopifyAdminGraphQLBackfillProductsAndOrders(t *testing.T) {
	t.Run("products", func(t *testing.T) {
		client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			raw, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(raw), "products") {
				t.Fatalf("request = %s", raw)
			}
			return jsonResponse(http.StatusOK, `{
				"data":{
					"products":{
						"edges":[{
							"node":{
								"id":"gid://shopify/Product/9",
								"title":"Desk Lamp",
								"handle":"desk-lamp",
								"onlineStoreUrl":"https://shop.example/products/desk-lamp",
								"featuredMedia":{"image":{"url":"https://cdn.example/lamp.jpg"}},
								"priceRangeV2":{"minVariantPrice":{"amount":"42.50","currencyCode":"CAD"}}
							}
						}],
						"pageInfo":{"hasNextPage":false,"endCursor":""}
					}
				}
			}`), nil
		})}
		cursor := encodeShopifyBackfillCursor(shopifyBackfillState{Object: "products"})
		req, err := (ShopifyAdminGraphQLBackfiller{HTTPClient: client}).BackfillPage(context.Background(), Integration{
			Provider:    ProviderShopify,
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "token",
		}, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(req.Products) != 1 || req.Products[0].PriceCents != 4250 || req.Products[0].Currency != "CAD" {
			t.Fatalf("products = %+v", req.Products)
		}
		state, _ := decodeShopifyBackfillCursor(req.Cursor)
		if state.Object != "orders" {
			t.Fatalf("next cursor = %+v", state)
		}
	})

	t.Run("orders", func(t *testing.T) {
		client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			raw, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(raw), "orders") {
				t.Fatalf("request = %s", raw)
			}
			return jsonResponse(http.StatusOK, `{
				"data":{
					"orders":{
						"edges":[{
							"node":{
								"id":"gid://shopify/Order/7",
								"name":"#1007",
								"email":"buyer@example.com",
								"createdAt":"2026-06-01T10:00:00Z",
								"processedAt":"2026-06-01T10:01:00Z",
								"displayFinancialStatus":"PAID",
								"currencyCode":"USD",
								"subtotalPriceSet":{"shopMoney":{"amount":"50.00","currencyCode":"USD"}},
								"totalDiscountsSet":{"shopMoney":{"amount":"5.00","currencyCode":"USD"}},
								"totalShippingPriceSet":{"shopMoney":{"amount":"7.00","currencyCode":"USD"}},
								"totalTaxSet":{"shopMoney":{"amount":"3.00","currencyCode":"USD"}},
								"totalPriceSet":{"shopMoney":{"amount":"55.00","currencyCode":"USD"}},
								"lineItems":{"edges":[{
									"node":{
										"id":"gid://shopify/LineItem/1",
										"name":"Desk Lamp",
										"quantity":2,
										"originalUnitPriceSet":{"shopMoney":{"amount":"25.00","currencyCode":"USD"}},
										"product":{"id":"gid://shopify/Product/9"},
										"variant":{"id":"gid://shopify/ProductVariant/3","title":"Default"}
									}
								}]}
							}
						}],
						"pageInfo":{"hasNextPage":false,"endCursor":""}
					}
				}
			}`), nil
		})}
		cursor := encodeShopifyBackfillCursor(shopifyBackfillState{Object: "orders"})
		req, err := (ShopifyAdminGraphQLBackfiller{HTTPClient: client}).BackfillPage(context.Background(), Integration{
			Provider:    ProviderShopify,
			ShopDomain:  "demo.myshopify.com",
			AccessToken: "token",
		}, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(req.Orders) != 1 || req.Orders[0].TotalCents != 5500 || req.Orders[0].Status != "paid" {
			t.Fatalf("orders = %+v", req.Orders)
		}
		if len(req.Orders[0].LineItems) != 1 || req.Orders[0].LineItems[0]["price_cents"] != 2500 {
			t.Fatalf("line items = %+v", req.Orders[0].LineItems)
		}
		if req.Cursor != shopifyBackfillCursorComplete {
			t.Fatalf("cursor = %q", req.Cursor)
		}
	})
}

func TestShopifyAdminGraphQLRateLimitError(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		resp := jsonResponse(http.StatusTooManyRequests, `{"errors":"throttled"}`)
		resp.Header.Set("Retry-After", "3")
		return resp, nil
	})}
	_, err := (ShopifyAdminGraphQLBackfiller{HTTPClient: client}).BackfillPage(context.Background(), Integration{
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "token",
	}, "")
	var httpErr *ShopifyGraphQLHTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusTooManyRequests || httpErr.RetryAfter <= 0 {
		t.Fatalf("err = %v, want 429 retry-after", err)
	}
}

func TestShopifyAdminGraphQLErrorsExposeCost(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusOK, `{
			"errors":[{"message":"Throttled"}],
			"extensions":{"cost":{"requestedQueryCost":1001,"actualQueryCost":0,"throttleStatus":{"maximumAvailable":1000,"currentlyAvailable":10,"restoreRate":50}}}
		}`), nil
	})}
	_, err := (ShopifyAdminGraphQLBackfiller{HTTPClient: client}).BackfillPage(context.Background(), Integration{
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "token",
	}, "")
	var gqlErr *ShopifyGraphQLErrors
	if !errors.As(err, &gqlErr) || gqlErr.Cost == nil || gqlErr.Cost.ThrottleStatus.CurrentlyAvailable != 10 {
		t.Fatalf("err = %v, want GraphQL cost details", err)
	}
}

func TestShopifyAdminGraphQLBulkOperationStart(t *testing.T) {
	var requestBody map[string]any
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &requestBody); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(requestBody["query"].(string), "bulkOperationRunQuery") {
			t.Fatalf("query = %s", requestBody["query"])
		}
		vars := requestBody["variables"].(map[string]any)
		if !strings.Contains(vars["query"].(string), "products") {
			t.Fatalf("bulk query = %s", vars["query"])
		}
		if got := r.Header.Get("X-Shopify-Access-Token"); got != "token" {
			t.Fatalf("token header = %q", got)
		}
		return jsonResponse(http.StatusOK, `{
			"data":{
				"bulkOperationRunQuery":{
					"bulkOperation":{
						"id":"gid://shopify/BulkOperation/720918",
						"status":"CREATED",
						"createdAt":"2026-06-18T12:00:00Z"
					},
					"userErrors":[]
				}
			}
		}`), nil
	})}

	summary, err := (ShopifyAdminGraphQLBulkOperator{HTTPClient: client}).StartBulkBackfill(context.Background(), Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "token",
	}, "products")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Status != "CREATED" || summary.OperationID != "gid://shopify/BulkOperation/720918" || summary.Object != "products" {
		t.Fatalf("summary = %+v", summary)
	}
	state, ok, err := decodeShopifyBulkOperationCursor(summary.Cursor)
	if err != nil || !ok || state.Object != "products" || state.OperationID != summary.OperationID {
		t.Fatalf("cursor state=%+v ok=%v err=%v", state, ok, err)
	}
}

func TestShopifyAdminGraphQLBulkOperationPoll(t *testing.T) {
	var requestBody map[string]any
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &requestBody); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(requestBody["query"].(string), "bulkOperation(id: $id)") {
			t.Fatalf("query = %s", requestBody["query"])
		}
		vars := requestBody["variables"].(map[string]any)
		if vars["id"] != "gid://shopify/BulkOperation/720918" {
			t.Fatalf("variables = %+v", vars)
		}
		return jsonResponse(http.StatusOK, `{
			"data":{
				"bulkOperation":{
					"id":"gid://shopify/BulkOperation/720918",
					"status":"COMPLETED",
					"errorCode":null,
					"createdAt":"2026-06-18T12:00:00Z",
					"completedAt":"2026-06-18T12:07:00Z",
					"objectCount":"57",
					"rootObjectCount":"45",
					"fileSize":"358",
					"url":"https://storage.googleapis.com/shopify/result.jsonl",
					"partialDataUrl":null
				}
			}
		}`), nil
	})}

	summary, err := (ShopifyAdminGraphQLBulkOperator{HTTPClient: client}).PollBulkBackfill(context.Background(), Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "token",
	}, "gid://shopify/BulkOperation/720918", "orders")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Status != "COMPLETED" || !summary.ResultURLPresent || summary.ObjectCount != "57" || summary.RootObjectCount != "45" {
		t.Fatalf("summary = %+v", summary)
	}
	if !strings.Contains(summary.Message, "completed") {
		t.Fatalf("message = %q", summary.Message)
	}
}

func TestShopifyAdminGraphQLBulkOperationUserErrors(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusOK, `{
			"data":{
				"bulkOperationRunQuery":{
					"bulkOperation":null,
					"userErrors":[{"field":["query"],"message":"Query must include a connection"}]
				}
			}
		}`), nil
	})}

	_, err := (ShopifyAdminGraphQLBulkOperator{HTTPClient: client}).StartBulkBackfill(context.Background(), Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "token",
	}, "customers")
	if err == nil || !strings.Contains(err.Error(), "Query must include a connection") {
		t.Fatalf("err = %v", err)
	}
}

func TestShopifyJSONLBulkResultImporterOrders(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") == "" {
			t.Fatal("missing accept header")
		}
		w.Header().Set("Content-Type", "application/jsonl")
		_, _ = io.WriteString(w, `{"id":"gid://shopify/Order/7","name":"#1007","email":"buyer@example.com","createdAt":"2026-06-01T10:00:00Z","processedAt":"2026-06-01T10:01:00Z","displayFinancialStatus":"PAID","currencyCode":"USD","subtotalPriceSet":{"shopMoney":{"amount":"50.00","currencyCode":"USD"}},"totalDiscountsSet":{"shopMoney":{"amount":"5.00","currencyCode":"USD"}},"totalShippingPriceSet":{"shopMoney":{"amount":"7.00","currencyCode":"USD"}},"totalTaxSet":{"shopMoney":{"amount":"3.00","currencyCode":"USD"}},"totalPriceSet":{"shopMoney":{"amount":"55.00","currencyCode":"USD"}}}`+"\n")
		_, _ = io.WriteString(w, `{"id":"gid://shopify/LineItem/1","__parentId":"gid://shopify/Order/7","name":"Desk Lamp","quantity":2,"originalUnitPriceSet":{"shopMoney":{"amount":"25.00","currencyCode":"USD"}},"product":{"id":"gid://shopify/Product/9"},"variant":{"id":"gid://shopify/ProductVariant/3","title":"Default"}}`+"\n")
	}))
	defer server.Close()

	req, err := (ShopifyJSONLBulkResultImporter{
		HTTPClient:           server.Client(),
		AllowUnsafeLocalURLs: true,
	}).ImportBulkResult(context.Background(), Integration{Provider: ProviderShopify}, "orders", server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Orders) != 1 {
		t.Fatalf("orders = %+v", req.Orders)
	}
	order := req.Orders[0]
	if order.SourceID != "gid://shopify/Order/7" || order.TotalCents != 5500 || order.Status != "paid" {
		t.Fatalf("order = %+v", order)
	}
	if len(order.LineItems) != 1 || order.LineItems[0]["price_cents"] != 2500 || order.LineItems[0]["product_id"] != "gid://shopify/Product/9" {
		t.Fatalf("line items = %+v", order.LineItems)
	}
}

func TestShopifyJSONLBulkResultImporterRejectsUnsafeURL(t *testing.T) {
	_, err := (ShopifyJSONLBulkResultImporter{}).ImportBulkResult(context.Background(), Integration{}, "customers", "http://127.0.0.1/result.jsonl")
	if err == nil || !strings.Contains(err.Error(), "https is required") {
		t.Fatalf("err = %v", err)
	}
}

func TestShopifyAdminGraphQLWebhookRegistrarCreatesMissingSubscriptions(t *testing.T) {
	var createdTopics []string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(r.Body)
		var req map[string]any
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		query := req["query"].(string)
		if r.Header.Get("X-Shopify-Access-Token") != "token" {
			t.Fatalf("missing token header")
		}
		switch {
		case strings.Contains(query, "webhookSubscriptions"):
			return jsonResponse(http.StatusOK, `{
				"data":{
					"webhookSubscriptions":{
						"edges":[{
							"node":{
								"id":"gid://shopify/WebhookSubscription/1",
								"topic":"CUSTOMERS_CREATE",
								"uri":"https://app.example/api/public/commerce/shopify/webhooks"
							}
						}],
						"pageInfo":{"hasNextPage":false,"endCursor":""}
					}
				}
			}`), nil
		case strings.Contains(query, "webhookSubscriptionCreate"):
			vars := req["variables"].(map[string]any)
			topic := vars["topic"].(string)
			subscription := vars["webhookSubscription"].(map[string]any)
			if subscription["uri"] != "https://app.example/api/public/commerce/shopify/webhooks" {
				t.Fatalf("webhook uri = %v", subscription["uri"])
			}
			createdTopics = append(createdTopics, topic)
			return jsonResponse(http.StatusOK, `{
				"data":{
					"webhookSubscriptionCreate":{
						"webhookSubscription":{
							"id":"gid://shopify/WebhookSubscription/2",
							"topic":"PRODUCTS_CREATE",
							"uri":"https://app.example/api/public/commerce/shopify/webhooks"
						},
						"userErrors":[]
					}
				}
			}`), nil
		default:
			t.Fatalf("unexpected query: %s", query)
		}
		return nil, nil
	})}
	registrar := ShopifyAdminGraphQLWebhookRegistrar{
		HTTPClient: client,
		Topics: []ShopifyWebhookTopic{
			{GraphQLTopic: "CUSTOMERS_CREATE", HTTPTopic: "customers/create"},
			{GraphQLTopic: "PRODUCTS_CREATE", HTTPTopic: "products/create"},
		},
	}

	summary, err := registrar.ReconcileWebhooks(context.Background(), Integration{
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "token",
	}, "https://app.example")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Endpoint != "https://app.example/api/public/commerce/shopify/webhooks" {
		t.Fatalf("endpoint = %q", summary.Endpoint)
	}
	if len(createdTopics) != 1 || createdTopics[0] != "PRODUCTS_CREATE" {
		t.Fatalf("created topics = %+v", createdTopics)
	}
	if len(summary.Subscriptions) != 2 || summary.Subscriptions[0].Created || !summary.Subscriptions[1].Created {
		t.Fatalf("summary = %+v", summary.Subscriptions)
	}
}

func TestShopifyAdminGraphQLWebhookRegistrarCleansOwnedSubscriptions(t *testing.T) {
	var deletedIDs []string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(r.Body)
		var req map[string]any
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		query := req["query"].(string)
		switch {
		case strings.Contains(query, "webhookSubscriptions"):
			return jsonResponse(http.StatusOK, `{
				"data":{
					"webhookSubscriptions":{
						"edges":[
							{"node":{"id":"gid://shopify/WebhookSubscription/1","topic":"CUSTOMERS_CREATE","uri":"https://app.example/api/public/commerce/shopify/webhooks"}},
							{"node":{"id":"gid://shopify/WebhookSubscription/2","topic":"PRODUCTS_CREATE","uri":"https://app.example/api/public/commerce/shopify/webhooks"}},
							{"node":{"id":"gid://shopify/WebhookSubscription/3","topic":"CUSTOMERS_CREATE","uri":"https://other.example/api/public/commerce/shopify/webhooks"}},
							{"node":{"id":"gid://shopify/WebhookSubscription/4","topic":"CUSTOMERS_CREATE","uri":"https://app.example/api/public/commerce/shopify/webhooks"}}
						],
						"pageInfo":{"hasNextPage":false,"endCursor":""}
					}
				}
			}`), nil
		case strings.Contains(query, "webhookSubscriptionDelete"):
			vars := req["variables"].(map[string]any)
			id := vars["id"].(string)
			deletedIDs = append(deletedIDs, id)
			return jsonResponse(http.StatusOK, `{
				"data":{
					"webhookSubscriptionDelete":{
						"deletedWebhookSubscriptionId":"`+id+`",
						"userErrors":[]
					}
				}
			}`), nil
		default:
			t.Fatalf("unexpected query: %s", query)
		}
		return nil, nil
	})}
	registrar := ShopifyAdminGraphQLWebhookRegistrar{
		HTTPClient: client,
		Topics: []ShopifyWebhookTopic{
			{GraphQLTopic: "CUSTOMERS_CREATE", HTTPTopic: "customers/create"},
		},
	}

	summary, err := registrar.CleanupWebhooks(context.Background(), Integration{
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "token",
	}, "https://app.example")
	if err != nil {
		t.Fatal(err)
	}
	if len(deletedIDs) != 2 || deletedIDs[0] != "gid://shopify/WebhookSubscription/1" || deletedIDs[1] != "gid://shopify/WebhookSubscription/4" {
		t.Fatalf("deleted IDs = %+v", deletedIDs)
	}
	if len(summary.Subscriptions) != 2 || summary.Subscriptions[0].ID != deletedIDs[0] || summary.Subscriptions[1].ID != deletedIDs[1] {
		t.Fatalf("summary = %+v", summary.Subscriptions)
	}
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
