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

type fakeZohoDeskSecretResolver struct{ json string }

func (f fakeZohoDeskSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeZohoDeskSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*zohoDeskCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestZohoDeskBackfillMapsTickets(t *testing.T) {
	var gotPath, gotAuth, gotOrg, gotFrom, gotInclude, gotDepartment, gotThreadFrom, gotThreadLimit, gotThreadSort string
	detailIncludes := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/tickets":
			gotPath = r.URL.Path
			gotAuth = r.Header.Get("Authorization")
			gotOrg = r.Header.Get("orgId")
			gotFrom = r.URL.Query().Get("from")
			gotInclude = r.URL.Query().Get("include")
			gotDepartment = r.URL.Query().Get("departmentId")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"id": "101", "subject": "Help", "status": "Open", "priority": "High", "channel": "Email", "departmentId": "dept_1", "threadCount": "2", "email": "Ada@Example.com",
						"contact":      map[string]any{"email": "Ada@Example.com", "firstName": "Ada", "lastName": "L"},
						"modifiedTime": "2026-06-20T10:00:00.000Z"},
					{"id": "102", "subject": "Skip", "status": "Open", "priority": "Low", "channel": "Email", "departmentId": "dept_2", "threadCount": "0", "email": "Skip@Example.com",
						"contact":      map[string]any{"email": "Skip@Example.com", "firstName": "Skip", "lastName": "L"},
						"modifiedTime": "2026-06-20T10:00:00.000Z"},
				},
			})
		case "/api/v1/tickets/101/threads":
			gotThreadFrom = r.URL.Query().Get("from")
			gotThreadLimit = r.URL.Query().Get("limit")
			gotThreadSort = r.URL.Query().Get("sortBy")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"id": "thr_customer", "summary": "Need help", "direction": "in", "visibility": "public", "createdTime": "2026-06-20T10:01:00.000Z", "author": map[string]any{"name": "Ada L", "type": "END_USER", "email": "Ada@Example.com"}},
					{"id": "thr_agent", "summary": "Checking", "direction": "out", "visibility": "public", "createdTime": "2026-06-20T10:02:00.000Z", "author": map[string]any{"name": "Ops Agent", "type": "AGENT", "email": "agent@example.com"}},
				},
			})
		case "/api/v1/tickets/101/threads/thr_customer":
			detailIncludes = append(detailIncludes, r.URL.Query().Get("include"))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "thr_customer", "plainText": "Need help with order", "content": "<div>Need help with order</div>", "contentType": "text/html",
				"direction": "in", "visibility": "public", "channel": "EMAIL", "status": "SUCCESS", "createdTime": "2026-06-20T10:01:00.000Z",
				"author":           map[string]any{"name": "Ada L", "type": "END_USER", "email": "Ada@Example.com"},
				"fromEmailAddress": "Ada@Example.com",
			})
		case "/api/v1/tickets/101/threads/thr_agent":
			detailIncludes = append(detailIncludes, r.URL.Query().Get("include"))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "thr_agent", "plainText": "Checking now", "content": "<div>Checking now</div>", "contentType": "text/html",
				"direction": "out", "visibility": "public", "channel": "EMAIL", "status": "SUCCESS", "createdTime": "2026-06-20T10:02:00.000Z",
				"author":      map[string]any{"name": "Ops Agent", "type": "AGENT", "email": "agent@example.com"},
				"responderId": "agent_1",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	backfiller := ZohoDeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZohoDeskSecretsCredentialResolver{Secrets: fakeZohoDeskSecretResolver{json: `{"access_token":"zd.tok","org_id":"org123"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderZohoDesk, CredentialsRef: "c", Settings: map[string]any{"department_id": "dept_1"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/api/v1/tickets") || gotAuth != "Zoho-oauthtoken zd.tok" || gotOrg != "org123" || gotFrom != "1" || gotInclude != "contacts" || gotDepartment != "dept_1" {
		t.Fatalf("path=%q auth=%q org=%q from=%q include=%q department=%q", gotPath, gotAuth, gotOrg, gotFrom, gotInclude, gotDepartment)
	}
	if gotThreadFrom != "0" || gotThreadLimit != "100" || gotThreadSort != "sendDateTime" {
		t.Fatalf("thread query from=%q limit=%q sort=%q", gotThreadFrom, gotThreadLimit, gotThreadSort)
	}
	if len(detailIncludes) != 2 || detailIncludes[0] != "plainText" || detailIncludes[1] != "plainText" {
		t.Fatalf("detail includes = %+v", detailIncludes)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Help" || tk.Status != "Open" || tk.Priority != "High" || tk.ConversationID != "101" || tk.RequesterName != "Ada L" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "zoho-desk://ticket/101" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if tk.Properties["zoho_desk_department_id"] != "dept_1" {
		t.Fatalf("department evidence = %+v", tk.Properties)
	}
	if len(req.Messages) != 2 {
		t.Fatalf("messages = %d", len(req.Messages))
	}
	first := req.Messages[0]
	if first.SourceID != "zoho-desk://thread/thr_customer" || first.Direction != "inbound" || first.SenderType != "customer" || first.BodyText != "Need help with order" || first.BodyHTML != "<div>Need help with order</div>" {
		t.Fatalf("first message = %+v", first)
	}
	second := req.Messages[1]
	if second.SourceID != "zoho-desk://thread/thr_agent" || second.Direction != "outbound" || second.SenderType != "agent" || second.BodyText != "Checking now" {
		t.Fatalf("second message = %+v", second)
	}
	// One full page (PageSize=1) => next from-offset.
	if req.Cursor != "zoho-desk:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestZohoDeskRefreshTicketMapsTicketAndThreads(t *testing.T) {
	var gotTicketPath, gotTicketInclude, gotThreadPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/tickets/101":
			gotTicketPath = r.URL.Path
			gotTicketInclude = r.URL.Query().Get("include")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "101", "subject": "Webhook Help", "status": "Open", "priority": "High", "channel": "Email", "departmentId": "dept_1", "threadCount": "1", "email": "Ada@Example.com",
				"contact":      map[string]any{"email": "Ada@Example.com", "firstName": "Ada", "lastName": "L"},
				"modifiedTime": "2026-06-20T10:00:00.000Z",
			})
		case "/api/v1/tickets/101/threads":
			gotThreadPath = r.URL.Path
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{{"id": "thr_1", "summary": "Need help", "direction": "in", "visibility": "public", "createdTime": "2026-06-20T10:01:00.000Z", "author": map[string]any{"name": "Ada L", "type": "END_USER", "email": "Ada@Example.com"}}},
			})
		case "/api/v1/tickets/101/threads/thr_1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "thr_1", "plainText": "Need help", "content": "<div>Need help</div>", "direction": "in", "visibility": "public", "createdTime": "2026-06-20T10:01:00.000Z",
				"author": map[string]any{"name": "Ada L", "type": "END_USER", "email": "Ada@Example.com"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	backfiller := ZohoDeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZohoDeskSecretsCredentialResolver{Secrets: fakeZohoDeskSecretResolver{json: `{"access_token":"zd.tok","org_id":"org123"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshTicket(context.Background(), "t", Integration{Provider: ProviderZohoDesk, CredentialsRef: "c", Settings: map[string]any{"department_id": "dept_1"}}, "101")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if gotTicketPath != "/api/v1/tickets/101" || gotTicketInclude != "contacts" || gotThreadPath != "/api/v1/tickets/101/threads" {
		t.Fatalf("ticket path=%q include=%q thread path=%q", gotTicketPath, gotTicketInclude, gotThreadPath)
	}
	if req.RunMode != "webhook" || req.Cursor != "zoho-desk-webhook-101" {
		t.Fatalf("mode/cursor = %q/%q", req.RunMode, req.Cursor)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].SourceID != "zoho-desk://ticket/101" || req.Tickets[0].Email != "ada@example.com" {
		t.Fatalf("tickets = %+v", req.Tickets)
	}
	if len(req.Messages) != 1 || req.Messages[0].SourceID != "zoho-desk://thread/thr_1" || req.Messages[0].BodyText != "Need help" {
		t.Fatalf("messages = %+v", req.Messages)
	}
}

func TestZohoDeskBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "34")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := ZohoDeskRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ZohoDeskSecretsCredentialResolver{Secrets: fakeZohoDeskSecretResolver{json: `{"access_token":"zd.tok","org_id":"org123"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderZohoDesk, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected rate-limit error")
	}
	var restErr ZohoDeskRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 34*time.Second {
		t.Fatalf("restErr = %#v err=%v", restErr, err)
	}
	cfg, cfgErr := supportBackfillConfig(ProviderZohoDesk)
	if cfgErr != nil {
		t.Fatalf("missing Zoho Desk retry config: %v", cfgErr)
	}
	now := time.Date(2026, 7, 1, 13, 0, 0, 0, time.UTC)
	retryCursor := supportBackfillRetryCursor(cfg, zohoDeskCursorPrefix+"2", "BACKFILL_FAILED", err, now)
	state, ok, err := decodeSupportRetryCursor(cfg, retryCursor)
	if err != nil || !ok {
		t.Fatalf("decode retry cursor ok=%v err=%v cursor=%q", ok, err, retryCursor)
	}
	if state.NextAttemptAt != now.Add(34*time.Second).Format(time.RFC3339) {
		t.Fatalf("next attempt = %q", state.NextAttemptAt)
	}
}

func TestZohoDeskCredentialResolverAcceptsOrganizationIDSetting(t *testing.T) {
	resolver := ZohoDeskSecretsCredentialResolver{Secrets: fakeZohoDeskSecretResolver{json: `{"access_token":"zd.tok"}`}}
	creds, err := resolver.ResolveZohoDesk(context.Background(), "t", Integration{
		CredentialsRef: "c",
		Settings:       map[string]any{"organization_id": "org123"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if creds.OrgID != "org123" {
		t.Fatalf("org id = %q", creds.OrgID)
	}
}
