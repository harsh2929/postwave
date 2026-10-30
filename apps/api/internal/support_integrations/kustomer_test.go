// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

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

type fakeKustomerSecretResolver struct{ json string }

func (f fakeKustomerSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeKustomerSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*kustomerCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestKustomerBackfillSideloadsCustomerEmail(t *testing.T) {
	var gotConvPath, gotAuth, gotCustPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch {
		case strings.Contains(r.URL.Path, "/v1/customers/"):
			gotCustPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"id": "cust1", "type": "customer",
					"attributes": map[string]any{"name": "Ada L", "emails": []map[string]any{{"email": "Ada@Example.com"}}}},
			})
		case strings.Contains(r.URL.Path, "/v1/conversations"):
			gotConvPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"id": "conv1", "type": "conversation",
						"attributes":    map[string]any{"name": "Order help", "status": "open", "updatedAt": "2026-06-20T10:00:00Z"},
						"relationships": map[string]any{"customer": map[string]any{"data": map[string]any{"id": "cust1", "type": "customer"}}}},
				},
				"meta": map[string]any{"page": 1, "pageCount": 2, "totalCount": 60},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := KustomerRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: KustomerSecretsCredentialResolver{Secrets: fakeKustomerSecretResolver{json: `{"api_key":"kust.jwt"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderKustomer, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotConvPath, "/v1/conversations") || gotAuth != "Bearer kust.jwt" || !strings.Contains(gotCustPath, "/v1/customers/cust1") {
		t.Fatalf("convPath=%q auth=%q custPath=%q", gotConvPath, gotAuth, gotCustPath)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Order help" || tk.Status != "open" || tk.ConversationID != "conv1" || tk.RequesterName != "Ada L" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "kustomer://conversation/conv1" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if req.Cursor != "kustomer:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestKustomerRefreshConversationMapsCustomerEmail(t *testing.T) {
	var gotConvPath, gotCustPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/v1/conversations/"):
			gotConvPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"id":   "conv-refresh",
					"type": "conversation",
					"attributes": map[string]any{
						"name":      "Sparse callback refresh",
						"status":    "open",
						"updatedAt": "2026-06-20T10:00:00Z",
					},
					"relationships": map[string]any{
						"customer": map[string]any{"data": map[string]any{"id": "cust-refresh", "type": "customer"}},
					},
				},
			})
		case strings.Contains(r.URL.Path, "/v1/customers/"):
			gotCustPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"id": "cust-refresh", "type": "customer",
					"attributes": map[string]any{"name": "Ada Refresh", "emails": []map[string]any{{"email": "Refresh@Example.com"}}}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := KustomerRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: KustomerSecretsCredentialResolver{Secrets: fakeKustomerSecretResolver{json: `{"api_key":"kust.jwt"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshConversation(context.Background(), "t", Integration{Provider: ProviderKustomer, CredentialsRef: "c"}, "conv-refresh")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if !strings.Contains(gotConvPath, "/v1/conversations/conv-refresh") || !strings.Contains(gotCustPath, "/v1/customers/cust-refresh") {
		t.Fatalf("convPath=%q custPath=%q", gotConvPath, gotCustPath)
	}
	if req.RunMode != "webhook" || req.Cursor != "kustomer-webhook-conv-refresh" {
		t.Fatalf("req=%+v", req)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets=%d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "refresh@example.com" || tk.RequesterName != "Ada Refresh" || tk.Subject != "Sparse callback refresh" || tk.ConversationID != "conv-refresh" {
		t.Fatalf("ticket=%+v", tk)
	}
}

func TestKustomerBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "17")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate limited"}`))
	}))
	defer srv.Close()

	backfiller := KustomerRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: KustomerSecretsCredentialResolver{Secrets: fakeKustomerSecretResolver{json: `{"api_key":"kust.jwt"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderKustomer, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected error")
	}
	var restErr KustomerRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 17*time.Second {
		t.Fatalf("err=%T %[1]v rest=%+v", err, restErr)
	}
	if delay := supportRetryDelay(1, err); delay != 17*time.Second {
		t.Fatalf("retry delay=%s", delay)
	}
}
