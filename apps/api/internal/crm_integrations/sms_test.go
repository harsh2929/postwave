// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

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

type fakePostscriptCredentialResolver struct{ creds PostscriptCredentials }

func (f fakePostscriptCredentialResolver) ResolvePostscript(_ context.Context, _ string, _ Integration) (PostscriptCredentials, error) {
	return f.creds, nil
}

func TestPostscriptBackfillMapsSubscribers(t *testing.T) {
	var gotPath, gotAuth, gotCursor string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCursor = r.URL.Query().Get("cursor")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"subscribers": []map[string]any{
				{"id": "sub_1", "phone_number": "+15551234567", "email": "Ada@Example.com", "first_name": "Ada", "last_name": "L"},
			},
			"next_cursor": "CUR2",
		})
	}))
	defer srv.Close()

	backfiller := PostscriptRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakePostscriptCredentialResolver{creds: PostscriptCredentials{APIKey: "ps_key"}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderPostscript, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/subscribers") || gotAuth != "Bearer ps_key" || gotCursor != "" {
		t.Fatalf("path=%q auth=%q cursor=%q", gotPath, gotAuth, gotCursor)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts = %d", len(req.Contacts))
	}
	c := req.Contacts[0]
	if c.Email != "ada@example.com" || c.Phone != "+15551234567" || c.SourceID != "postscript://subscriber/sub_1" {
		t.Fatalf("mapped = %+v", c)
	}
	if req.Cursor != "postscript:CUR2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestPostscriptBackfillResumesCursorAndKeepsPhoneOnlySubscribers(t *testing.T) {
	var gotCursor string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCursor = r.URL.Query().Get("cursor")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"subscribers": []map[string]any{
				{"id": "sub_phone_only", "phone_number": "+15550000000"},
				{"id": "sub_2", "phone_number": "+15551230000", "email": "Buyer@Example.com"},
			},
		})
	}))
	defer srv.Close()

	backfiller := PostscriptRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakePostscriptCredentialResolver{creds: PostscriptCredentials{APIKey: "ps_key"}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderPostscript, CredentialsRef: "c"}, "postscript:CUR2")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotCursor != "CUR2" {
		t.Fatalf("cursor = %q", gotCursor)
	}
	if len(req.Contacts) != 2 || req.Contacts[0].Email != "" || req.Contacts[0].Phone != "+15550000000" || req.Contacts[1].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	if req.Cursor != postscriptCursorComplete {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestPostscriptBackfillCompleteCursorSkipsProviderCall(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()

	backfiller := PostscriptRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakePostscriptCredentialResolver{creds: PostscriptCredentials{APIKey: "ps_key"}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderPostscript, CredentialsRef: "c"}, postscriptCursorComplete)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if called {
		t.Fatal("complete cursor should not call provider")
	}
	if req.Cursor != postscriptCursorComplete || len(req.Contacts) != 0 {
		t.Fatalf("request=%+v", req)
	}
}

func TestPostscriptBackfillRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "17")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (PostscriptRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakePostscriptCredentialResolver{creds: PostscriptCredentials{APIKey: "ps_key"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "t", Integration{Provider: ProviderPostscript, CredentialsRef: "c"}, "")
	var restErr CRMStaticRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 17*time.Second {
		t.Fatalf("expected Retry-After error, got %#v", err)
	}
}

type fakeAttentiveCredentialResolver struct{ creds AttentiveCredentials }

func (f fakeAttentiveCredentialResolver) ResolveAttentive(_ context.Context, _ string, _ Integration) (AttentiveCredentials, error) {
	return f.creds, nil
}

func TestAttentiveBackfillMapsSubscribers(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"subscribers": []map[string]any{
				{"id": "a_1", "phone": "+15559876543", "email": "Bo@Example.com", "firstName": "Bo", "lastName": "R"},
			},
			"nextCursor": "NXT2",
		})
	}))
	defer srv.Close()

	backfiller := AttentiveRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeAttentiveCredentialResolver{creds: AttentiveCredentials{APIKey: "att_key"}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderAttentive, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/subscribers") || gotAuth != "Bearer att_key" {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts = %d", len(req.Contacts))
	}
	c := req.Contacts[0]
	if c.Email != "bo@example.com" || c.Phone != "+15559876543" || c.SourceID != "attentive://subscriber/a_1" {
		t.Fatalf("mapped = %+v", c)
	}
	if req.Cursor != "attentive:NXT2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestAttentiveBackfillResumesCursorAndKeepsPhoneOnlySubscribers(t *testing.T) {
	var gotCursor string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCursor = r.URL.Query().Get("cursor")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"subscribers": []map[string]any{
				{"id": "phone_only", "phone": "+15550000000"},
				{"id": "a_2", "phone": "+15559870000", "email": "Buyer@Example.com"},
			},
		})
	}))
	defer srv.Close()

	backfiller := AttentiveRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeAttentiveCredentialResolver{creds: AttentiveCredentials{APIKey: "att_key"}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderAttentive, CredentialsRef: "c"}, "attentive:NXT2")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotCursor != "NXT2" {
		t.Fatalf("cursor = %q", gotCursor)
	}
	if len(req.Contacts) != 2 || req.Contacts[0].Email != "" || req.Contacts[0].Phone != "+15550000000" || req.Contacts[1].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	if req.Cursor != attentiveCursorComplete {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestAttentiveBackfillCompleteCursorSkipsProviderCall(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()

	backfiller := AttentiveRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeAttentiveCredentialResolver{creds: AttentiveCredentials{APIKey: "att_key"}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderAttentive, CredentialsRef: "c"}, attentiveCursorComplete)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if called {
		t.Fatal("complete cursor should not call provider")
	}
	if req.Cursor != attentiveCursorComplete || len(req.Contacts) != 0 {
		t.Fatalf("request=%+v", req)
	}
}

func TestAttentiveBackfillRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "19")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (AttentiveRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeAttentiveCredentialResolver{creds: AttentiveCredentials{APIKey: "att_key"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "t", Integration{Provider: ProviderAttentive, CredentialsRef: "c"}, "")
	var restErr CRMStaticRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 19*time.Second {
		t.Fatalf("expected Retry-After error, got %#v", err)
	}
}
