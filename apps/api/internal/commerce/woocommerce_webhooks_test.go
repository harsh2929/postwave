package commerce

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWooCommerceRESTWebhookRegistrarCreatesMissingSubscriptions(t *testing.T) {
	var requests []string
	var gotAuth string
	var created []map[string]any
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.String())
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/wp-json/wc/v3/webhooks":
			w.Header().Set("X-WP-TotalPages", "1")
			_, _ = w.Write([]byte(`[]`))
		case r.Method == http.MethodPost && r.URL.Path == "/wp-json/wc/v3/webhooks":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			created = append(created, body)
			_, _ = w.Write([]byte(`{"id":142,"topic":"` + body["topic"].(string) + `","delivery_url":"` + body["delivery_url"].(string) + `","status":"active"}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer srv.Close()
	registrar := WooCommerceRESTWebhookRegistrar{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck_test", ConsumerSecret: "cs_test"}},
		Topics:               []string{"order.created", "order.updated"},
		AllowUnsafeLocalURLs: true,
	}

	summary, err := registrar.ReconcileWebhooks(context.Background(), Integration{
		Provider:      ProviderWooCommerce,
		Settings:      map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
		WebhookSecret: "wc-secret",
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Endpoint != "https://app.postwave.test/api/public/commerce/woocommerce/webhooks" || len(summary.Subscriptions) != 2 {
		t.Fatalf("summary=%+v", summary)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ck_test:cs_test"))
	if gotAuth != wantAuth {
		t.Fatalf("auth=%q want %q", gotAuth, wantAuth)
	}
	if len(created) != 2 || created[0]["secret"] != "wc-secret" || created[0]["delivery_url"] != summary.Endpoint {
		t.Fatalf("created=%+v", created)
	}
}

func TestWooCommerceRESTWebhookRegistrarAddsOptionalSubscriptionTopicsWhenEnabled(t *testing.T) {
	var topics []string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/wp-json/wc/v3/webhooks":
			w.Header().Set("X-WP-TotalPages", "1")
			_, _ = w.Write([]byte(`[]`))
		case r.Method == http.MethodPost && r.URL.Path == "/wp-json/wc/v3/webhooks":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			topic := body["topic"].(string)
			topics = append(topics, topic)
			_, _ = w.Write([]byte(`{"id":142,"topic":"` + topic + `","delivery_url":"` + body["delivery_url"].(string) + `","status":"active"}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer srv.Close()
	registrar := WooCommerceRESTWebhookRegistrar{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck_test", ConsumerSecret: "cs_test"}},
		AllowUnsafeLocalURLs: true,
	}

	summary, err := registrar.ReconcileWebhooks(context.Background(), Integration{
		Provider:      ProviderWooCommerce,
		Settings:      map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc", "subscriptions_enabled": true},
		WebhookSecret: "wc-secret",
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Subscriptions) != len(allWooCommerceWebhookTopics()) || !hasString(topics, "subscription.created") || !hasString(topics, "subscription.updated") || !hasString(topics, "subscription.deleted") {
		t.Fatalf("topics=%+v summary=%+v", topics, summary)
	}
}

func TestWooCommerceRESTWebhookRegistrarReactivatesExistingSubscription(t *testing.T) {
	var updated bool
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/wp-json/wc/v3/webhooks":
			w.Header().Set("X-WP-TotalPages", "1")
			_, _ = w.Write([]byte(`[{"id":142,"topic":"order.updated","delivery_url":"https://app.postwave.test/api/public/commerce/woocommerce/webhooks","status":"paused"}]`))
		case r.Method == http.MethodPut && r.URL.Path == "/wp-json/wc/v3/webhooks/142":
			updated = true
			_, _ = w.Write([]byte(`{"id":142,"topic":"order.updated","delivery_url":"https://app.postwave.test/api/public/commerce/woocommerce/webhooks","status":"active"}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer srv.Close()
	registrar := WooCommerceRESTWebhookRegistrar{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		Topics:               []string{"order.updated"},
		AllowUnsafeLocalURLs: true,
	}

	summary, err := registrar.ReconcileWebhooks(context.Background(), Integration{
		Provider:      ProviderWooCommerce,
		Settings:      map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
		WebhookSecret: "wc-secret",
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !updated || len(summary.Subscriptions) != 1 || !summary.Subscriptions[0].Updated || summary.Subscriptions[0].Status != "active" {
		t.Fatalf("updated=%v summary=%+v", updated, summary)
	}
}

func TestWooCommerceRESTWebhookRegistrarCleansOwnedSubscriptions(t *testing.T) {
	var deleted []string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/wp-json/wc/v3/webhooks":
			w.Header().Set("X-WP-TotalPages", "1")
			_, _ = w.Write([]byte(`[
				{"id":142,"topic":"order.updated","delivery_url":"https://app.postwave.test/api/public/commerce/woocommerce/webhooks","status":"active"},
				{"id":143,"topic":"customer.updated","delivery_url":"https://other.example/webhook","status":"active"}
			]`))
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/wp-json/wc/v3/webhooks/"):
			deleted = append(deleted, strings.TrimPrefix(r.URL.Path, "/wp-json/wc/v3/webhooks/")+"?"+r.URL.RawQuery)
			_, _ = w.Write([]byte(`{"id":142,"topic":"order.updated","delivery_url":"https://app.postwave.test/api/public/commerce/woocommerce/webhooks","status":"active"}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer srv.Close()
	registrar := WooCommerceRESTWebhookRegistrar{
		HTTPClient:           srv.Client(),
		Credentials:          &fakeCommerceCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		Topics:               []string{"order.updated", "customer.updated"},
		AllowUnsafeLocalURLs: true,
	}

	summary, err := registrar.CleanupWebhooks(context.Background(), Integration{
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"store_url": srv.URL, "credential_ref": "cred_wc"},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(deleted) != 1 || deleted[0] != "142?force=true" {
		t.Fatalf("deleted=%+v", deleted)
	}
	if len(summary.Subscriptions) != 1 || !summary.Subscriptions[0].Deleted {
		t.Fatalf("summary=%+v", summary)
	}
}
