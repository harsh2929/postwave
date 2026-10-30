// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

type fakeMixpanelSecretResolver struct{ json string }

func (f fakeMixpanelSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeMixpanelSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*mixpanelCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errAnalyticsNotJSONSecret
}

func TestMixpanelBackfillMapsProfiles(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotProject string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotProject = r.URL.Query().Get("project_id")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"$distinct_id": "d1", "$properties": map[string]any{"$email": "Ada@Example.com", "$first_name": "Ada", "$last_name": "L"}},
			},
			"session_id": "sess1", "page": 0, "page_size": 1, "total": 2,
		})
	}))
	defer srv.Close()

	backfiller := MixpanelRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: MixpanelSecretsCredentialResolver{Secrets: fakeMixpanelSecretResolver{json: `{"username":"sa_user","secret":"sa_secret","project_id":"123"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderMixpanel, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("sa_user:sa_secret"))
	if gotMethod != http.MethodPost || !strings.Contains(gotPath, "/api/query/engage") || gotAuth != wantAuth || gotProject != "123" {
		t.Fatalf("method=%q path=%q auth=%q project=%q", gotMethod, gotPath, gotAuth, gotProject)
	}
	if len(req.Profiles) != 1 {
		t.Fatalf("profiles = %d", len(req.Profiles))
	}
	p := req.Profiles[0]
	if p.Email != "ada@example.com" || p.UserID != "d1" || p.FirstName != "Ada" {
		t.Fatalf("mapped = %+v", p)
	}
	if p.SourceID != "mixpanel://profile/d1" {
		t.Fatalf("source id = %q", p.SourceID)
	}
	if req.Cursor != "mixpanel:sess1|1" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestMixpanelRejectsPublicProjectTokenBeforeHTTP(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()
	backfiller := MixpanelRESTBackfiller{
		HTTPClient: srv.Client(), APIBaseURL: srv.URL,
		Credentials: MixpanelSecretsCredentialResolver{Secrets: fakeMixpanelSecretResolver{json: `{"token":"public-project-token","project_id":"123"}`}},
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderMixpanel, CredentialsRef: "c"}, "")
	if err == nil || calls != 0 {
		t.Fatalf("public ingestion token must not be used as profile-read authentication: calls=%d err=%v", calls, err)
	}
}

func TestMixpanelBackfillUsesDocumentedFormAndTraversesFullPages(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Query().Get("project_id") != "123" || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Error("query must keep project_id in URL and send pagination as a form POST")
		}
		if r.URL.Query().Has("page") || r.URL.Query().Has("session_id") {
			t.Error("pagination was sent as query parameters")
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.PostForm.Get("page") != strconv.Itoa(calls) || (calls > 0 && r.PostForm.Get("session_id") != "session/with+characters") {
			t.Errorf("wrong continuation form on call %d", calls)
		}
		switch calls {
		case 0:
			// `total` is the payload count here; it must not stop traversal.
			_, _ = w.Write([]byte(`{"status":"ok","page":0,"page_size":1,"total":1,"session_id":"session/with+characters","results":[{"$distinct_id":9007199254740993,"$properties":{"$email":"one@example.com"}}]}`))
		case 1:
			// Neither a repeated session_id nor total is required to continue.
			_, _ = w.Write([]byte(`{"status":"ok","page":1,"page_size":1,"results":[{"$distinct_id":"two","$properties":{"$email":"two@example.com"}}]}`))
		case 2:
			_, _ = w.Write([]byte(`{"status":"ok","page":2,"page_size":1,"results":[]}`))
		default:
			t.Error("unexpected request after terminal page")
		}
		calls++
	}))
	defer srv.Close()
	b := MixpanelRESTBackfiller{HTTPClient: srv.Client(), APIBaseURL: srv.URL, Credentials: MixpanelSecretsCredentialResolver{Secrets: fakeMixpanelSecretResolver{json: `{"username":"reader","secret":"test","project_id":"123"}`}}}
	var profiles []ProfileInput
	cursor := ""
	for range 3 {
		page, err := b.BackfillPage(context.Background(), "t", Integration{Provider: ProviderMixpanel, CredentialsRef: "c"}, cursor)
		if err != nil {
			t.Fatal(err)
		}
		profiles = append(profiles, page.Profiles...)
		cursor = page.Cursor
	}
	if calls != 3 || cursor != mixpanelCursorComplete || len(profiles) != 2 || profiles[0].UserID != "9007199254740993" || profiles[0].SourceID != "mixpanel://profile/9007199254740993" || profiles[1].UserID != "two" {
		t.Fatalf("incomplete or lossy traversal: calls=%d cursor=%q profiles=%+v", calls, cursor, profiles)
	}
}

func TestMixpanelDoesNotCertifyIncompleteOrRejectedResponses(t *testing.T) {
	for _, response := range []string{
		`{"status":"error","error":"query rejected"}`,
		`{"error":"query rejected","results":[]}`,
		`{}`,
		`{"page":0,"page_size":1,"results":[{"$distinct_id":"one","$properties":{"$email":"one@example.com"}}]}`,
		`{"page":0,"results":[{"$distinct_id":"one","$properties":{"$email":"one@example.com"}}]}`,
		`{"page":1,"results":[]}`,
		`{"page":0,"page_size":1,"results":[{"$distinct_id":true,"$properties":{"$email":"one@example.com"}}]}`,
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(response)) }))
		b := MixpanelRESTBackfiller{HTTPClient: srv.Client(), APIBaseURL: srv.URL, Credentials: MixpanelSecretsCredentialResolver{Secrets: fakeMixpanelSecretResolver{json: `{"api_secret":"test","project_id":"123"}`}}}
		page, err := b.BackfillPage(context.Background(), "t", Integration{Provider: ProviderMixpanel, CredentialsRef: "c"}, "")
		srv.Close()
		if err == nil || len(page.Profiles) != 0 {
			t.Fatal("rejected, malformed or unresumable response was accepted as a completed profile read")
		}
	}
}
