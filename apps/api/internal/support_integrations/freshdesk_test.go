// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

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

type fakeFreshdeskSecretResolver struct{ json string }

func (f fakeFreshdeskSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeFreshdeskSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*freshdeskCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestFreshdeskBackfillMapsTickets(t *testing.T) {
	var gotPath, gotAuth, gotPage, gotPerPage, gotOrderBy, gotOrderType, gotInclude string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		gotOrderBy = r.URL.Query().Get("order_by")
		gotOrderType = r.URL.Query().Get("order_type")
		gotInclude = r.URL.Query().Get("include")
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"id": 77, "subject": "Refund please", "status": 2, "priority": 1,
				"tags": []string{"refund"}, "email": "Bo@Example.com", "requester_id": 9, "product_id": 12,
				"company_id": 45,
				"requester":  map[string]any{"id": 9, "name": "Bo Customer", "email": "requester@example.com", "company_id": 44},
				"updated_at": "2026-06-20T10:00:00Z"},
		})
	}))
	defer srv.Close()

	backfiller := FreshdeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FreshdeskSecretsCredentialResolver{Secrets: fakeFreshdeskSecretResolver{json: `{"api_key":"fk"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderFreshdesk, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("fk:X"))
	if !strings.Contains(gotPath, "/api/v2/tickets") || gotAuth != wantAuth || gotPage != "1" || gotPerPage != "1" || gotOrderBy != "updated_at" || gotOrderType != "desc" || gotInclude != "requester" {
		t.Fatalf("path=%q auth=%q page=%q per_page=%q order_by=%q order_type=%q include=%q", gotPath, gotAuth, gotPage, gotPerPage, gotOrderBy, gotOrderType, gotInclude)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "bo@example.com" || tk.RequesterName != "Bo Customer" || tk.Subject != "Refund please" || tk.Status != "open" || tk.Priority != "low" {
		t.Fatalf("mapped ticket = %+v", tk)
	}
	if tk.SourceID != "freshdesk://ticket/77" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if tk.Properties["freshdesk_product_id"] != "12" || tk.Properties["freshdesk_company_id"] != "45" {
		t.Fatalf("properties = %+v", tk.Properties)
	}
	// One full page returned (PageSize=1) => expect a next page cursor.
	if req.Cursor != "freshdesk:2" {
		t.Fatalf("next cursor = %q", req.Cursor)
	}
}

func TestFreshdeskBackfillFallsBackToEmbeddedRequesterEmail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("include"); got != "requester" {
			t.Fatalf("include=%q, want requester", got)
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"id": 88, "subject": "Need help", "status": 3, "priority": 2, "requester_id": 19,
				"requester": map[string]any{"id": 19, "name": "Rae Requester", "email": "Rae@Example.com", "mobile": "+15551230000", "phone": "+15557650000"}},
		})
	}))
	defer srv.Close()

	backfiller := FreshdeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FreshdeskSecretsCredentialResolver{Secrets: fakeFreshdeskSecretResolver{json: `{"api_key":"fk"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderFreshdesk, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets=%d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "rae@example.com" || tk.RequesterName != "Rae Requester" {
		t.Fatalf("ticket=%+v", tk)
	}
	if tk.Properties["freshdesk_requester_mobile"] != "+15551230000" || tk.Properties["freshdesk_requester_phone"] != "+15557650000" {
		t.Fatalf("properties=%+v", tk.Properties)
	}
}

func TestFreshdeskBackfillFiltersTicketsByProductIDLocally(t *testing.T) {
	var gotProductIDQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotProductIDQuery = r.URL.Query().Get("product_id")
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"id": 101, "subject": "Product A", "status": 2, "priority": 2, "email": "a@example.com", "product_id": 12,
				"requester": map[string]any{"id": 9, "name": "A Customer", "email": "a@example.com"}},
			{"id": 102, "subject": "Product B", "status": 2, "priority": 2, "email": "b@example.com", "product_id": 13,
				"requester": map[string]any{"id": 10, "name": "B Customer", "email": "b@example.com"}},
		})
	}))
	defer srv.Close()

	backfiller := FreshdeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FreshdeskSecretsCredentialResolver{Secrets: fakeFreshdeskSecretResolver{json: `{"api_key":"fk"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFreshdesk,
		CredentialsRef: "c",
		Settings:       map[string]any{"product_id": "12"},
	}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotProductIDQuery != "" {
		t.Fatalf("product_id query=%q; filtering should be local over ticket payload product_id", gotProductIDQuery)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets=%d, want 1: %+v", len(req.Tickets), req.Tickets)
	}
	tk := req.Tickets[0]
	if tk.SourceID != "freshdesk://ticket/101" || tk.Email != "a@example.com" || tk.Properties["freshdesk_product_id"] != "12" {
		t.Fatalf("ticket=%+v", tk)
	}
}

func TestFreshdeskBackfillAdvancesCursorWhenProductFilterSkipsFullPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"id": 103, "subject": "Different product", "status": 2, "priority": 2, "email": "skip@example.com", "product_id": 13,
				"requester": map[string]any{"id": 11, "name": "Skip Customer", "email": "skip@example.com"}},
		})
	}))
	defer srv.Close()

	backfiller := FreshdeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FreshdeskSecretsCredentialResolver{Secrets: fakeFreshdeskSecretResolver{json: `{"api_key":"fk"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFreshdesk,
		CredentialsRef: "c",
		Settings:       map[string]any{"product_id": "12"},
	}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Tickets) != 0 {
		t.Fatalf("tickets=%d, want 0: %+v", len(req.Tickets), req.Tickets)
	}
	if req.Cursor != freshdeskCursorPrefix+"2" {
		t.Fatalf("cursor=%q, want next page despite local filter", req.Cursor)
	}
}

func TestFreshdeskBackfillSkipsTicketsWithoutTicketOrRequesterEmail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"id": 99, "subject": "No identity", "status": 2, "priority": 1,
				"requester": map[string]any{"id": 31, "name": "No Email"}},
		})
	}))
	defer srv.Close()

	backfiller := FreshdeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FreshdeskSecretsCredentialResolver{Secrets: fakeFreshdeskSecretResolver{json: `{"api_key":"fk"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderFreshdesk, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Tickets) != 0 {
		t.Fatalf("tickets=%d, want 0: %+v", len(req.Tickets), req.Tickets)
	}
}

func TestFreshdeskCredentialsUseAccountDomainWithoutDoubleSuffix(t *testing.T) {
	resolver := FreshdeskSecretsCredentialResolver{Secrets: fakeFreshdeskSecretResolver{json: `{"api_key":"fk"}`}}
	creds, err := resolver.ResolveFreshdesk(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFreshdesk,
		CredentialsRef: "c",
		Settings: map[string]any{
			"account_domain": "https://Acme.freshdesk.com/helpdesk",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creds.Domain != "acme" {
		t.Fatalf("domain=%q", creds.Domain)
	}
	if got := freshdeskBaseURL("", creds); got != "https://acme.freshdesk.com" {
		t.Fatalf("base url=%q", got)
	}
	if got := freshdeskBaseURL("", FreshdeskCredentials{Domain: "acme.freshdesk.com"}); got != "https://acme.freshdesk.com" {
		t.Fatalf("full-domain base url=%q", got)
	}
}

func TestFreshdeskBackfillCapsPageSizeAndReturnsTypedRetryError(t *testing.T) {
	var gotPerPage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPerPage = r.URL.Query().Get("per_page")
		w.Header().Set("Retry-After", "120")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := FreshdeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FreshdeskSecretsCredentialResolver{Secrets: fakeFreshdeskSecretResolver{json: `{"api_key":"fk"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFreshdesk,
		CredentialsRef: "c",
		Settings:       map[string]any{"page_size": "500"},
	}, "")
	if err == nil {
		t.Fatal("expected error")
	}
	if gotPerPage != "100" {
		t.Fatalf("per_page=%q", gotPerPage)
	}
	var restErr FreshdeskRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 2*time.Minute {
		t.Fatalf("err=%T %[1]v", err)
	}
}

func TestFreshdeskRefreshTicketMapsRequester(t *testing.T) {
	var gotPath, gotInclude, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotInclude = r.URL.Query().Get("include")
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":           77,
			"subject":      "Need help",
			"status":       2,
			"priority":     3,
			"requester_id": 9,
			"product_id":   12,
			"requester":    map[string]any{"id": 9, "name": "Ada Buyer", "email": "Ada@Example.com"},
			"updated_at":   "2026-06-20T12:00:00Z",
		})
	}))
	defer srv.Close()

	backfiller := FreshdeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FreshdeskSecretsCredentialResolver{Secrets: fakeFreshdeskSecretResolver{json: `{"api_key":"fk"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshTicket(context.Background(), "tenant-1", Integration{Provider: ProviderFreshdesk, CredentialsRef: "c"}, "77")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("fk:X"))
	if gotPath != "/api/v2/tickets/77" || gotInclude != "requester" || gotAuth != wantAuth {
		t.Fatalf("path=%q include=%q auth=%q", gotPath, gotInclude, gotAuth)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].SourceID != "freshdesk://ticket/77" || req.Tickets[0].Email != "ada@example.com" {
		t.Fatalf("req=%+v", req)
	}
	if req.RunMode != "webhook" || req.Cursor != "freshdesk-webhook-77" {
		t.Fatalf("mode=%q cursor=%q", req.RunMode, req.Cursor)
	}
}
