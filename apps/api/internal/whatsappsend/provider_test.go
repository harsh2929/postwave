// SPDX-License-Identifier: AGPL-3.0-only
package whatsappsend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMetaCloudProvider_NotConfigured(t *testing.T) {
	p := &MetaCloudProvider{}
	if p.Configured() {
		t.Fatalf("empty provider must report unconfigured")
	}
	_, err := p.SendTemplate(context.Background(), "+15551234567", "order_shipped", "en_US", nil)
	if err == nil || err.Error() != errNotConfiguredMsg {
		t.Fatalf("expected %q, got %v", errNotConfiguredMsg, err)
	}
}

func TestMetaCloudProvider_SendsRealRequest(t *testing.T) {
	var gotAuth, gotPath, gotMethod string
	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		gotMethod = r.Method
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"messaging_product":"whatsapp","messages":[{"id":"wamid.HBgLMTU1NTEyMzQ1NjcVAg=="}]}`))
	}))
	defer srv.Close()

	p := &MetaCloudProvider{
		PhoneNumberID: "1234567890",
		AccessToken:   "test-token",
		APIVersion:    "v20.0",
		BaseURL:       srv.URL,
	}
	if !p.Configured() {
		t.Fatalf("provider with creds must report configured")
	}

	id, err := p.SendTemplate(context.Background(), "+15551234567", "order_shipped", "en_US", []string{"Ada", "#1234"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "wamid.HBgLMTU1NTEyMzQ1NjcVAg==" {
		t.Fatalf("expected provider message id to be parsed, got %q", id)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/v20.0/1234567890/messages" {
		t.Fatalf("expected the phone-number-scoped messages path, got %q", gotPath)
	}
	if gotAuth != "Bearer test-token" {
		t.Fatalf("expected bearer auth header, got %q", gotAuth)
	}
	if gotBody["messaging_product"] != "whatsapp" || gotBody["to"] != "+15551234567" || gotBody["type"] != "template" {
		t.Fatalf("unexpected request envelope: %+v", gotBody)
	}
	tmpl, _ := gotBody["template"].(map[string]any)
	if tmpl["name"] != "order_shipped" {
		t.Fatalf("expected template name in body, got %+v", tmpl)
	}
	lang, _ := tmpl["language"].(map[string]any)
	if lang["code"] != "en_US" {
		t.Fatalf("expected language code in body, got %+v", tmpl)
	}
	components, _ := tmpl["components"].([]any)
	if len(components) != 1 {
		t.Fatalf("expected one body component for the vars, got %+v", tmpl["components"])
	}
}

func TestMetaCloudProvider_ProviderErrorSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"Template name does not exist in the translation","code":132001}}`))
	}))
	defer srv.Close()

	p := &MetaCloudProvider{PhoneNumberID: "1234567890", AccessToken: "test-token", BaseURL: srv.URL}
	_, err := p.SendTemplate(context.Background(), "+15551234567", "does_not_exist", "en_US", nil)
	if err == nil {
		t.Fatalf("expected an error from a non-2xx response")
	}
}

func TestMetaCloudProvider_MissingArgs(t *testing.T) {
	p := &MetaCloudProvider{PhoneNumberID: "1", AccessToken: "t"}
	if _, err := p.SendTemplate(context.Background(), "", "name", "en_US", nil); err == nil {
		t.Fatalf("expected error for missing phone")
	}
	if _, err := p.SendTemplate(context.Background(), "+1555", "", "en_US", nil); err == nil {
		t.Fatalf("expected error for missing template name")
	}
	if _, err := p.SendTemplate(context.Background(), "+1555", "name", "", nil); err == nil {
		t.Fatalf("expected error for missing language")
	}
}
