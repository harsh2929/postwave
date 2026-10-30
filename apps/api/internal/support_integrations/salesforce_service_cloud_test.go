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

type fakeSFServiceSecretResolver struct{ json string }

func (f fakeSFServiceSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeSFServiceSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*salesforceServiceCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

type fakeSFServiceManagedStore struct {
	secrets map[string]string
}

func (f *fakeSFServiceManagedStore) GetSalesforceServiceCloudCredentialSecret(_ context.Context, _, ref string) (string, error) {
	if f == nil || f.secrets == nil {
		return "", ErrNotFound
	}
	raw, ok := f.secrets[ref]
	if !ok {
		return "", ErrNotFound
	}
	return raw, nil
}

func (f *fakeSFServiceManagedStore) PutSalesforceServiceCloudCredentialSecret(_ context.Context, _, ref string, creds SalesforceServiceCloudCredentials) error {
	if f.secrets == nil {
		f.secrets = map[string]string{}
	}
	f.secrets[ref] = salesforceServiceStoredCredentialJSON(creds)
	return nil
}

func TestSalesforceServiceCloudBackfillMapsCases(t *testing.T) {
	var gotCasePath, gotCaseAuth, gotCaseQuery, gotCommentQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("q")
		if strings.Contains(query, "FROM CaseComment") {
			gotCommentQuery = query
			_ = json.NewEncoder(w).Encode(map[string]any{
				"records": []map[string]any{
					{"Id": "00a1", "ParentId": "500x", "CommentBody": "Customer reply", "IsPublished": true, "CreatedDate": "2026-06-30T09:30:00Z",
						"CreatedBy": map[string]any{"Email": "Ada@Example.com", "Name": "Ada L"}},
					{"Id": "00a2", "ParentId": "500x", "CommentBody": "Agent follow-up", "IsPublished": true, "CreatedDate": "2026-06-30T09:35:00Z",
						"CreatedBy": map[string]any{"Email": "agent@example.com", "Name": "Agent P"}},
				},
			})
			return
		}
		gotCasePath = r.URL.Path
		gotCaseAuth = r.Header.Get("Authorization")
		gotCaseQuery = query
		_ = json.NewEncoder(w).Encode(map[string]any{
			"records": []map[string]any{
				{"Id": "500x", "Subject": "Help", "Status": "New", "Priority": "High",
					"CaseNumber": "00001001",
					"OwnerId":    "00Gxx0000000Q1A",
					"Owner":      map[string]any{"Name": "Tier 1 Queue"},
					"Contact":    map[string]any{"Email": "Ada@Example.com", "Name": "Ada L"}},
			},
			"done":           false,
			"nextRecordsUrl": "/services/data/v59.0/query/01g-2000",
		})
	}))
	defer srv.Close()

	backfiller := SalesforceServiceCloudRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SalesforceServiceCloudSecretsCredentialResolver{Secrets: fakeSFServiceSecretResolver{json: `{"access_token":"sf.tok","instance_url":"` + srv.URL + `"}`}},
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderSalesforceServiceCloud, CredentialsRef: "c", Settings: map[string]any{"case_record_type_id": "012xx000000001A", "case_queue_id": "00Gxx0000000Q1A"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotCasePath, "/services/data/") || !strings.Contains(gotCasePath, "/query") || gotCaseAuth != "Bearer sf.tok" || !strings.Contains(gotCaseQuery, "FROM Case") || !strings.Contains(gotCaseQuery, "RecordTypeId = '012xx000000001A'") || !strings.Contains(gotCaseQuery, "OwnerId = '00Gxx0000000Q1A'") || !strings.Contains(gotCaseQuery, "Owner.Name") {
		t.Fatalf("path=%q auth=%q query=%q", gotCasePath, gotCaseAuth, gotCaseQuery)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Help" || tk.Status != "New" || tk.ConversationID != "500x" || tk.RequesterName != "Ada L" || tk.Assignee != "Tier 1 Queue" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "salesforce-service-cloud://case/500x" {
		t.Fatalf("source id = %q", tk.SourceID)
	}
	if tk.Properties["salesforce_case_number"] != "00001001" {
		t.Fatalf("case number evidence = %+v", tk.Properties)
	}
	if tk.Properties["salesforce_owner_id"] != "00Gxx0000000Q1A" || tk.Properties["salesforce_owner_name"] != "Tier 1 Queue" || tk.Properties["salesforce_owner_type"] != "queue" {
		t.Fatalf("owner evidence = %+v", tk.Properties)
	}
	if !strings.Contains(gotCommentQuery, "FROM CaseComment") || !strings.Contains(gotCommentQuery, "ParentId IN ('500x')") {
		t.Fatalf("comment query = %q", gotCommentQuery)
	}
	if len(req.Messages) != 2 {
		t.Fatalf("messages = %d", len(req.Messages))
	}
	first := req.Messages[0]
	if first.SourceID != "salesforce-service-cloud://case-comment/00a1" || first.ConversationID != "500x" || first.Email != "ada@example.com" || first.Direction != "inbound" || first.SenderType != "customer" || first.BodyText != "Customer reply" {
		t.Fatalf("first message = %+v", first)
	}
	if first.OccurredAt == nil || first.Properties["salesforce_case_comment_id"] != "00a1" || first.Properties["salesforce_case_comment_published"] != true {
		t.Fatalf("first message evidence = %+v occurred=%v", first.Properties, first.OccurredAt)
	}
	second := req.Messages[1]
	if second.SourceID != "salesforce-service-cloud://case-comment/00a2" || second.Direction != "outbound" || second.SenderType != "agent" || second.Sender != "Agent P" || second.BodyText != "Agent follow-up" {
		t.Fatalf("second message = %+v", second)
	}
	if req.Cursor != "salesforce-service-cloud:/services/data/v59.0/query/01g-2000" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestSalesforceServiceCloudRefreshCaseUsesIDAndConfiguredFilters(t *testing.T) {
	var gotCaseQuery, gotCommentQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("q")
		if strings.Contains(query, "FROM CaseComment") {
			gotCommentQuery = query
			_ = json.NewEncoder(w).Encode(map[string]any{
				"records": []map[string]any{
					{"Id": "00a-refresh", "ParentId": "500refresh", "CommentBody": "CDC comment", "IsPublished": true, "CreatedDate": "2026-06-30T09:30:00Z",
						"CreatedBy": map[string]any{"Email": "agent@example.com", "Name": "Agent P"}},
				},
			})
			return
		}
		gotCaseQuery = query
		_ = json.NewEncoder(w).Encode(map[string]any{
			"records": []map[string]any{
				{"Id": "500refresh", "Subject": "CDC update", "Status": "Working", "Priority": "Medium",
					"CaseNumber":   "00002002",
					"OwnerId":      "005xx0000000U1A",
					"RecordTypeId": "012xx000000001A",
					"Owner":        map[string]any{"Name": "Agent Owner"},
					"Contact":      map[string]any{"Email": "Buyer@Example.com", "Name": "Buyer B"}},
			},
			"done": true,
		})
	}))
	defer srv.Close()

	backfiller := SalesforceServiceCloudRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SalesforceServiceCloudSecretsCredentialResolver{Secrets: fakeSFServiceSecretResolver{json: `{"access_token":"sf.tok","instance_url":"` + srv.URL + `"}`}},
	}
	req, err := backfiller.RefreshCase(context.Background(), "t", Integration{Provider: ProviderSalesforceServiceCloud, CredentialsRef: "c", Settings: map[string]any{"case_record_type_id": "012xx000000001A", "case_queue_id": "005xx0000000U1A"}}, "500refresh")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if !strings.Contains(gotCaseQuery, "FROM Case") || !strings.Contains(gotCaseQuery, "Id = '500refresh'") || !strings.Contains(gotCaseQuery, "RecordTypeId = '012xx000000001A'") || !strings.Contains(gotCaseQuery, "OwnerId = '005xx0000000U1A'") {
		t.Fatalf("case query = %q", gotCaseQuery)
	}
	if !strings.Contains(gotCommentQuery, "FROM CaseComment") || !strings.Contains(gotCommentQuery, "ParentId IN ('500refresh')") {
		t.Fatalf("comment query = %q", gotCommentQuery)
	}
	if req.RunMode != "webhook" || req.Cursor != "salesforce-service-cloud-cdc-500refresh" {
		t.Fatalf("request mode/cursor = %q/%q", req.RunMode, req.Cursor)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].SourceID != "salesforce-service-cloud://case/500refresh" || req.Tickets[0].Email != "buyer@example.com" {
		t.Fatalf("tickets = %+v", req.Tickets)
	}
	if req.Tickets[0].Properties["salesforce_record_type_id"] != "012xx000000001A" || req.Tickets[0].Properties["salesforce_owner_type"] != "user" {
		t.Fatalf("ticket evidence = %+v", req.Tickets[0].Properties)
	}
	if len(req.Messages) != 1 || req.Messages[0].SourceID != "salesforce-service-cloud://case-comment/00a-refresh" {
		t.Fatalf("messages = %+v", req.Messages)
	}
}

func TestSalesforceServiceCloudBackfillRefreshesExpiredManagedCredential(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	ref := salesforceServiceStoredCredPrefix + "support-refresh"
	store := &fakeSFServiceManagedStore{secrets: map[string]string{}}
	var serverURL string
	var tokenCalls int
	var caseAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case salesforceServiceOAuthTokenPath:
			tokenCalls++
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "rt_old" || r.Form.Get("client_id") != "cid" || r.Form.Get("client_secret") != "csec" {
				t.Fatalf("refresh form=%v", r.Form)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "at_fresh",
				"refresh_token": "rt_new",
				"instance_url":  serverURL,
				"scope":         "api refresh_token",
			})
		case "/services/data/v59.0/query":
			query := r.URL.Query().Get("q")
			if strings.Contains(query, "FROM CaseComment") {
				_ = json.NewEncoder(w).Encode(map[string]any{"records": []any{}})
				return
			}
			caseAuth = r.Header.Get("Authorization")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"records": []map[string]any{
					{"Id": "500x", "Subject": "Help", "Status": "New", "Contact": map[string]any{"Email": "Ada@Example.com"}},
				},
				"done": true,
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	serverURL = srv.URL
	expired := now.Add(-time.Minute)
	store.secrets[ref] = salesforceServiceStoredCredentialJSON(SalesforceServiceCloudCredentials{
		AccessToken:    "at_old",
		RefreshToken:   "rt_old",
		ClientID:       "cid",
		ClientSecret:   "csec",
		InstanceURL:    serverURL,
		LoginURL:       serverURL,
		TokenExpiresAt: &expired,
	})
	resolver := SalesforceServiceCloudSecretsCredentialResolver{
		Store:       store,
		OAuthClient: SalesforceServiceCloudOAuthClient{HTTPClient: srv.Client(), LoginURL: serverURL, Now: func() time.Time { return now }},
		Now:         func() time.Time { return now },
	}
	req, err := (SalesforceServiceCloudRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: resolver,
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSalesforceServiceCloud, CredentialsRef: ref}, "")
	if err != nil {
		t.Fatal(err)
	}
	if tokenCalls != 1 || caseAuth != "Bearer at_fresh" {
		t.Fatalf("tokenCalls=%d caseAuth=%q", tokenCalls, caseAuth)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].Email != "ada@example.com" {
		t.Fatalf("req=%+v", req)
	}
	if got := store.secrets[ref]; !strings.Contains(got, "at_fresh") || !strings.Contains(got, "rt_new") {
		t.Fatalf("refreshed credential was not persisted: %s", got)
	}
}

func TestSalesforceServiceCloudBackfillRefreshesAndRetriesInvalidSession(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 30, 0, 0, time.UTC)
	ref := salesforceServiceStoredCredPrefix + "support-reactive-refresh"
	store := &fakeSFServiceManagedStore{secrets: map[string]string{}}
	var serverURL string
	var tokenCalls, caseCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case salesforceServiceOAuthTokenPath:
			tokenCalls++
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "rt_old" {
				t.Fatalf("refresh form=%v", r.Form)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "at_fresh",
				"refresh_token": "rt_new",
				"instance_url":  serverURL,
			})
		case "/services/data/v59.0/query":
			query := r.URL.Query().Get("q")
			if strings.Contains(query, "FROM CaseComment") {
				if got := r.Header.Get("Authorization"); got != "Bearer at_fresh" {
					t.Fatalf("comment Authorization=%q", got)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"records": []any{}})
				return
			}
			caseCalls++
			if got := r.Header.Get("Authorization"); got == "Bearer at_old" {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode([]map[string]string{{
					"message":   "Session expired or invalid",
					"errorCode": "INVALID_SESSION_ID",
				}})
				return
			} else if got != "Bearer at_fresh" {
				t.Fatalf("Authorization=%q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"records": []map[string]any{
					{"Id": "500x", "Subject": "Help", "Status": "New", "Contact": map[string]any{"Email": "Ada@Example.com"}},
				},
				"done": true,
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	serverURL = srv.URL
	future := now.Add(time.Hour)
	store.secrets[ref] = salesforceServiceStoredCredentialJSON(SalesforceServiceCloudCredentials{
		AccessToken:    "at_old",
		RefreshToken:   "rt_old",
		ClientID:       "cid",
		ClientSecret:   "csec",
		InstanceURL:    serverURL,
		LoginURL:       serverURL,
		TokenExpiresAt: &future,
	})
	resolver := SalesforceServiceCloudSecretsCredentialResolver{
		Store:       store,
		OAuthClient: SalesforceServiceCloudOAuthClient{HTTPClient: srv.Client(), LoginURL: serverURL, Now: func() time.Time { return now }},
		Now:         func() time.Time { return now },
	}
	req, err := (SalesforceServiceCloudRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: resolver,
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSalesforceServiceCloud, CredentialsRef: ref}, "")
	if err != nil {
		t.Fatal(err)
	}
	if tokenCalls != 1 || caseCalls != 2 {
		t.Fatalf("tokenCalls=%d caseCalls=%d", tokenCalls, caseCalls)
	}
	if len(req.Tickets) != 1 || req.Tickets[0].Email != "ada@example.com" {
		t.Fatalf("req=%+v", req)
	}
	if got := store.secrets[ref]; !strings.Contains(got, "at_fresh") || !strings.Contains(got, "rt_new") {
		t.Fatalf("reactively refreshed credential was not persisted: %s", got)
	}
}

func TestSalesforceServiceCloudBackfillRefreshesAndRetriesCaseComments(t *testing.T) {
	now := time.Date(2026, 6, 30, 13, 0, 0, 0, time.UTC)
	ref := salesforceServiceStoredCredPrefix + "support-comment-refresh"
	store := &fakeSFServiceManagedStore{secrets: map[string]string{}}
	var serverURL string
	var tokenCalls, commentCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case salesforceServiceOAuthTokenPath:
			tokenCalls++
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "rt_old" {
				t.Fatalf("refresh form=%v", r.Form)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "at_fresh",
				"refresh_token": "rt_new",
				"instance_url":  serverURL,
			})
		case "/services/data/v59.0/query":
			query := r.URL.Query().Get("q")
			if strings.Contains(query, "FROM CaseComment") {
				commentCalls++
				if got := r.Header.Get("Authorization"); got == "Bearer at_old" {
					w.WriteHeader(http.StatusUnauthorized)
					_ = json.NewEncoder(w).Encode([]map[string]string{{
						"message":   "Session expired or invalid",
						"errorCode": "INVALID_SESSION_ID",
					}})
					return
				} else if got != "Bearer at_fresh" {
					t.Fatalf("comment Authorization=%q", got)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"records": []map[string]any{
						{"Id": "00a1", "ParentId": "500x", "CommentBody": "Agent reply", "CreatedDate": "2026-06-30T13:01:00Z",
							"CreatedBy": map[string]any{"Email": "agent@example.com", "Name": "Agent P"}},
					},
				})
				return
			}
			if got := r.Header.Get("Authorization"); got != "Bearer at_old" {
				t.Fatalf("case Authorization=%q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"records": []map[string]any{
					{"Id": "500x", "Subject": "Help", "Status": "New", "Contact": map[string]any{"Email": "Ada@Example.com"}},
				},
				"done": true,
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	serverURL = srv.URL
	future := now.Add(time.Hour)
	store.secrets[ref] = salesforceServiceStoredCredentialJSON(SalesforceServiceCloudCredentials{
		AccessToken:    "at_old",
		RefreshToken:   "rt_old",
		ClientID:       "cid",
		ClientSecret:   "csec",
		InstanceURL:    serverURL,
		LoginURL:       serverURL,
		TokenExpiresAt: &future,
	})
	resolver := SalesforceServiceCloudSecretsCredentialResolver{
		Store:       store,
		OAuthClient: SalesforceServiceCloudOAuthClient{HTTPClient: srv.Client(), LoginURL: serverURL, Now: func() time.Time { return now }},
		Now:         func() time.Time { return now },
	}
	req, err := (SalesforceServiceCloudRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: resolver,
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSalesforceServiceCloud, CredentialsRef: ref}, "")
	if err != nil {
		t.Fatal(err)
	}
	if tokenCalls != 1 || commentCalls != 2 {
		t.Fatalf("tokenCalls=%d commentCalls=%d", tokenCalls, commentCalls)
	}
	if len(req.Tickets) != 1 || len(req.Messages) != 1 || req.Messages[0].SourceID != "salesforce-service-cloud://case-comment/00a1" {
		t.Fatalf("req=%+v", req)
	}
	if got := store.secrets[ref]; !strings.Contains(got, "at_fresh") || !strings.Contains(got, "rt_new") {
		t.Fatalf("comment refreshed credential was not persisted: %s", got)
	}
}

func TestSalesforceServiceCloudBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"message":"slow down"}`))
	}))
	defer srv.Close()

	backfiller := SalesforceServiceCloudRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SalesforceServiceCloudSecretsCredentialResolver{Secrets: fakeSFServiceSecretResolver{json: `{"access_token":"sf.tok","instance_url":"` + srv.URL + `"}`}},
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderSalesforceServiceCloud, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected provider error")
	}
	var providerErr SalesforceServiceCloudRESTError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 2*time.Minute {
		t.Fatalf("err=%T %[1]v provider=%+v", err, providerErr)
	}
	if delay := supportRetryDelay(1, err); delay != 2*time.Minute {
		t.Fatalf("retry delay = %s", delay)
	}
}
