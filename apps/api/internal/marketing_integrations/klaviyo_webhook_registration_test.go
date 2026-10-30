// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestKlaviyoRESTWebhookRegistrarCreatesAndDeletesWebhook(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 30, 0, 0, time.UTC)
	endpoint := "https://app.postwave.test/api/public/marketing-integrations/klaviyo/webhooks/token_123"
	created := false
	deleted := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Klaviyo-API-Key pk_test" {
			t.Fatalf("authorization=%q", got)
		}
		if got := r.Header.Get("revision"); got != klaviyoDefaultAPIRevision {
			t.Fatalf("revision=%q", got)
		}
		w.Header().Set("Content-Type", "application/vnd.api+json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/webhooks":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/webhooks":
			created = true
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			data := body["data"].(map[string]any)
			attrs := data["attributes"].(map[string]any)
			if data["type"] != "webhook" ||
				attrs["endpoint_url"] != endpoint ||
				attrs["secret_key"] != "secret" ||
				attrs["enabled"] != true {
				t.Fatalf("create body=%+v", body)
			}
			topics := data["relationships"].(map[string]any)["webhook-topics"].(map[string]any)["data"].([]any)
			if len(topics) != 1 || topics[0].(map[string]any)["id"] != "event:klaviyo.sent_sms" {
				t.Fatalf("topics=%+v", topics)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(klaviyoWebhookTestResponse("klaviyo_wh_123", endpoint, []string{"event:klaviyo.sent_sms"}))
		case r.Method == http.MethodDelete && r.URL.Path == "/api/webhooks/klaviyo_wh_123":
			deleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	resolver := NewKlaviyoSecretsCredentialResolver(fakeKlaviyoSecretResolver{values: map[string]string{
		"cred":       `{"api_key":"pk_test"}`,
		"secret_ref": "secret",
	}})
	registrar := KlaviyoRESTWebhookRegistrar{
		HTTPClient:     server.Client(),
		Credentials:    resolver,
		WebhookSecrets: fakeKlaviyoSecretResolver{values: map[string]string{"secret_ref": "secret"}},
		APIBaseURL:     server.URL + "/api",
		Now:            func() time.Time { return now },
	}
	integration := Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderKlaviyo,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"account_id":                 "acct_123",
			"klaviyo_webhook_token":      "token_123",
			"klaviyo_webhook_secret_ref": "secret_ref",
			"klaviyo_webhook_topics":     []string{"event:klaviyo.sent_sms"},
		},
	}
	out, err := registrar.ReconcileWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !created || !out.Created || !out.Verified || out.WebhookID != "klaviyo_wh_123" || out.Endpoint != endpoint {
		t.Fatalf("created=%v summary=%+v", created, out)
	}
	integration.Settings["klaviyo_webhook_id"] = out.WebhookID
	integration.Settings["klaviyo_webhook_endpoint"] = out.Endpoint
	cleanup, err := registrar.CleanupWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !deleted || !cleanup.Deleted || cleanup.WebhookID != "klaviyo_wh_123" {
		t.Fatalf("deleted=%v cleanup=%+v", deleted, cleanup)
	}
}

func TestKlaviyoRESTWebhookRegistrarUsesBearerForOAuthCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer oauth_access" {
			t.Fatalf("authorization=%q", got)
		}
		w.Header().Set("Content-Type", "application/vnd.api+json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/webhooks":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/webhooks":
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(klaviyoWebhookTestResponse("klaviyo_wh_oauth", "https://app.postwave.test/api/public/marketing-integrations/klaviyo/webhooks/token_123", []string{"event:klaviyo.sent_sms"}))
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	registrar := KlaviyoRESTWebhookRegistrar{
		HTTPClient:     server.Client(),
		Credentials:    NewKlaviyoSecretsCredentialResolver(fakeKlaviyoSecretResolver{values: map[string]string{"cred": `{"access_token":"oauth_access"}`}}),
		WebhookSecrets: fakeKlaviyoSecretResolver{values: map[string]string{"secret_ref": "secret"}},
		APIBaseURL:     server.URL + "/api",
	}
	out, err := registrar.ReconcileWebhook(context.Background(), Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderKlaviyo,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"klaviyo_webhook_token":      "token_123",
			"klaviyo_webhook_secret_ref": "secret_ref",
			"klaviyo_webhook_topics":     []string{"event:klaviyo.sent_sms"},
		},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !out.Created || out.WebhookID != "klaviyo_wh_oauth" {
		t.Fatalf("summary=%+v", out)
	}
}

func TestKlaviyoRESTWebhookRegistrarRepairsStoredWebhookDrift(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 45, 0, 0, time.UTC)
	endpoint := "https://app.postwave.test/api/public/marketing-integrations/klaviyo/webhooks/token_123"
	patched := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.api+json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/webhooks/klaviyo_wh_123":
			_ = json.NewEncoder(w).Encode(klaviyoWebhookTestResponse("klaviyo_wh_123", "https://old.example.test/webhook", []string{"event:klaviyo.sent_sms"}))
		case r.Method == http.MethodPatch && r.URL.Path == "/api/webhooks/klaviyo_wh_123":
			patched = true
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			data := body["data"].(map[string]any)
			attrs := data["attributes"].(map[string]any)
			if data["id"] != "klaviyo_wh_123" || attrs["endpoint_url"] != endpoint || attrs["secret_key"] != "secret" {
				t.Fatalf("patch body=%+v", body)
			}
			_ = json.NewEncoder(w).Encode(klaviyoWebhookTestResponse("klaviyo_wh_123", endpoint, []string{"event:klaviyo.sent_sms"}))
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	registrar := KlaviyoRESTWebhookRegistrar{
		HTTPClient:     server.Client(),
		Credentials:    NewKlaviyoSecretsCredentialResolver(fakeKlaviyoSecretResolver{values: map[string]string{"cred": "pk_test"}}),
		WebhookSecrets: fakeKlaviyoSecretResolver{values: map[string]string{"secret_ref": "secret"}},
		APIBaseURL:     server.URL + "/api",
		Now:            func() time.Time { return now },
	}
	out, err := registrar.ReconcileWebhook(context.Background(), Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderKlaviyo,
		CredentialsRef: "cred",
		Settings: map[string]any{
			"klaviyo_webhook_id":         "klaviyo_wh_123",
			"klaviyo_webhook_token":      "token_123",
			"klaviyo_webhook_secret_ref": "secret_ref",
			"klaviyo_webhook_topics":     "event:klaviyo.sent_sms",
		},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !patched || !out.Updated || !out.Repaired || out.RepairReason != "stored_webhook_drifted" || out.Endpoint != endpoint {
		t.Fatalf("patched=%v summary=%+v", patched, out)
	}
}

func klaviyoWebhookTestResponse(id, endpoint string, topics []string) map[string]any {
	topicData := make([]map[string]string, 0, len(topics))
	for _, topic := range topics {
		topicData = append(topicData, map[string]string{"type": "webhook-topic", "id": strings.TrimSpace(topic)})
	}
	return map[string]any{
		"data": map[string]any{
			"type": "webhook",
			"id":   id,
			"attributes": map[string]any{
				"name":         "Moosewave Klaviyo system webhook",
				"endpoint_url": endpoint,
				"enabled":      true,
			},
			"relationships": map[string]any{
				"webhook-topics": map[string]any{"data": topicData},
			},
		},
	}
}
