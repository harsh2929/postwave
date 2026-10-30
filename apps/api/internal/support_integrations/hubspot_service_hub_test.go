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

type fakeHubSpotServiceSecretResolver struct{ json string }

func (f fakeHubSpotServiceSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeHubSpotServiceSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*hubSpotServiceCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestHubSpotServiceHubBackfillSideloadsContactEmail(t *testing.T) {
	var gotTicketsPath, gotAuth, gotAssoc, gotContactPath, gotProperties string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch {
		case strings.Contains(r.URL.Path, "/crm/v3/objects/contacts/"):
			gotContactPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "c1", "properties": map[string]any{"email": "Ada@Example.com", "firstname": "Ada", "lastname": "L"},
			})
		case strings.Contains(r.URL.Path, "/crm/v3/objects/tickets"):
			gotTicketsPath = r.URL.Path
			gotAssoc = r.URL.Query().Get("associations")
			gotProperties = r.URL.Query().Get("properties")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []map[string]any{
					{"id": "t1", "properties": map[string]any{"subject": "Help", "hs_pipeline": "support-pipeline", "hs_pipeline_stage": "open"},
						"associations": map[string]any{"contacts": map[string]any{"results": []map[string]any{{"id": "c1"}}}}},
					{"id": "t2", "properties": map[string]any{"subject": "Skip", "hs_pipeline": "other-pipeline", "hs_pipeline_stage": "open"},
						"associations": map[string]any{"contacts": map[string]any{"results": []map[string]any{{"id": "c2"}}}}},
				},
				"paging": map[string]any{"next": map[string]any{"after": "A2"}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := HubSpotServiceHubRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HubSpotServiceHubSecretsCredentialResolver{Secrets: fakeHubSpotServiceSecretResolver{json: `{"access_token":"hub.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderHubSpotServiceHub, CredentialsRef: "c", Settings: map[string]any{"pipeline_id": "support-pipeline"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotTicketsPath, "/crm/v3/objects/tickets") || gotAuth != "Bearer hub.tok" || !strings.Contains(gotAssoc, "contact") || !strings.Contains(gotProperties, "hs_pipeline") || !strings.Contains(gotContactPath, "/crm/v3/objects/contacts/c1") {
		t.Fatalf("ticketsPath=%q auth=%q assoc=%q props=%q contactPath=%q", gotTicketsPath, gotAuth, gotAssoc, gotProperties, gotContactPath)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Help" || tk.Status != "open" || tk.ConversationID != "t1" || tk.RequesterName != "Ada L" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "hubspot-service-hub://ticket/t1" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if tk.Properties["hubspot_pipeline_id"] != "support-pipeline" {
		t.Fatalf("pipeline evidence = %+v", tk.Properties)
	}
	if req.Cursor != "hubspot-service-hub:A2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestHubSpotServiceHubRefreshTicketMapsContactEmail(t *testing.T) {
	var gotTicketPath, gotContactPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/crm/v3/objects/contacts/"):
			gotContactPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "c-refresh", "properties": map[string]any{"email": "Refresh@Example.com", "firstname": "Ada", "lastname": "Refresh"},
			})
		case strings.Contains(r.URL.Path, "/crm/v3/objects/tickets/"):
			gotTicketPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "ticket-refresh",
				"properties": map[string]any{
					"subject":             "Webhook refresh",
					"hs_pipeline":         "support-pipeline",
					"hs_pipeline_stage":   "open",
					"hs_ticket_priority":  "HIGH",
					"hs_lastmodifieddate": "2026-06-20T10:00:00Z",
				},
				"associations": map[string]any{"contacts": map[string]any{"results": []map[string]any{{"id": "c-refresh"}}}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := HubSpotServiceHubRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HubSpotServiceHubSecretsCredentialResolver{Secrets: fakeHubSpotServiceSecretResolver{json: `{"access_token":"hub.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshTicket(context.Background(), "t", Integration{Provider: ProviderHubSpotServiceHub, CredentialsRef: "c", Settings: map[string]any{"pipeline_id": "support-pipeline"}}, "ticket-refresh")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if !strings.Contains(gotTicketPath, "/crm/v3/objects/tickets/ticket-refresh") || !strings.Contains(gotContactPath, "/crm/v3/objects/contacts/c-refresh") {
		t.Fatalf("ticketPath=%q contactPath=%q", gotTicketPath, gotContactPath)
	}
	if req.RunMode != "webhook" || req.Cursor != "hubspot-service-hub-webhook-ticket-refresh" {
		t.Fatalf("req=%+v", req)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets=%d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "refresh@example.com" || tk.RequesterName != "Ada Refresh" || tk.Subject != "Webhook refresh" || tk.Priority != "high" || tk.ConversationID != "ticket-refresh" {
		t.Fatalf("ticket=%+v", tk)
	}
}

func TestHubSpotServiceHubRefreshSkipsPipelineMismatch(t *testing.T) {
	var contactCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/crm/v3/objects/contacts/"):
			contactCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "c-refresh", "properties": map[string]any{"email": "Refresh@Example.com", "firstname": "Ada", "lastname": "Refresh"},
			})
		case strings.Contains(r.URL.Path, "/crm/v3/objects/tickets/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "ticket-refresh",
				"properties": map[string]any{
					"subject":           "Webhook refresh",
					"hs_pipeline":       "other-pipeline",
					"hs_pipeline_stage": "open",
				},
				"associations": map[string]any{"contacts": map[string]any{"results": []map[string]any{{"id": "c-refresh"}}}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := HubSpotServiceHubRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HubSpotServiceHubSecretsCredentialResolver{Secrets: fakeHubSpotServiceSecretResolver{json: `{"access_token":"hub.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshTicket(context.Background(), "t", Integration{Provider: ProviderHubSpotServiceHub, CredentialsRef: "c", Settings: map[string]any{"pipeline_id": "support-pipeline"}}, "ticket-refresh")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if contactCalls != 1 || len(req.Tickets) != 0 || req.Cursor != "hubspot-service-hub-webhook-ticket-refresh" {
		t.Fatalf("contactCalls=%d req=%+v", contactCalls, req)
	}
}

func TestHubSpotServiceHubBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "29")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"message":"rate limited"}`))
	}))
	defer srv.Close()

	backfiller := HubSpotServiceHubRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: HubSpotServiceHubSecretsCredentialResolver{Secrets: fakeHubSpotServiceSecretResolver{json: `{"access_token":"hub.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderHubSpotServiceHub, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected error")
	}
	var restErr HubSpotServiceHubRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 29*time.Second {
		t.Fatalf("err=%T %[1]v rest=%+v", err, restErr)
	}
	if delay := supportRetryDelay(1, err); delay != 29*time.Second {
		t.Fatalf("retry delay=%s", delay)
	}
}
