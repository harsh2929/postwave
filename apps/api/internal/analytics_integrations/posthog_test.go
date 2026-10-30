// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakePostHogSecretResolver struct{ json string }

func (f fakePostHogSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakePostHogSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*postHogCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errAnalyticsNotJSONSecret
}

func TestPostHogBackfillMapsPersons(t *testing.T) {
	var gotPath, gotAuth string
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"id": 7, "uuid": "uuid-p1", "distinct_ids": []any{"did-1"}, "properties": map[string]any{"email": "Ada@Example.com", "name": "Ada L"}},
			},
			"next": srvURL + "/api/projects/PROJ/persons/?cursor=NEXT",
		})
	}))
	defer srv.Close()
	srvURL = srv.URL

	backfiller := PostHogRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: PostHogSecretsCredentialResolver{Secrets: fakePostHogSecretResolver{json: `{"api_key":"phc_key"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderPostHog, CredentialsRef: "c", Settings: map[string]any{"project_id": "PROJ"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/api/projects/PROJ/persons") || gotAuth != "Bearer phc_key" {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if len(req.Profiles) != 1 {
		t.Fatalf("profiles = %d", len(req.Profiles))
	}
	p := req.Profiles[0]
	if p.Email != "ada@example.com" || p.UserID != "did-1" {
		t.Fatalf("mapped = %+v", p)
	}
	if p.SourceID != "posthog://person/uuid-p1" {
		t.Fatalf("source id = %q", p.SourceID)
	}
	if !strings.HasPrefix(req.Cursor, "posthog:") || !strings.Contains(req.Cursor, "cursor=NEXT") {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

// Older /persons responses use an integer PK and a separate stable uuid.
// Keep supporting that shape alongside current cloud UUID-string IDs.
func TestPostHogBackfillDecodesNumericIDAndPrefersUUID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"id": 12345, "uuid": "0190abc-uuid", "distinct_ids": []any{"did-1"}, "properties": map[string]any{"email": "Ada@Example.com"}},
			},
			"next": "",
		})
	}))
	defer srv.Close()

	backfiller := PostHogRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: PostHogSecretsCredentialResolver{Secrets: fakePostHogSecretResolver{json: `{"api_key":"phc_key"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderPostHog, CredentialsRef: "c", Settings: map[string]any{"project_id": "PROJ"}}, "")
	if err != nil {
		t.Fatalf("backfill must decode a numeric PostHog id: %v", err)
	}
	if len(req.Profiles) != 1 {
		t.Fatalf("profiles = %d", len(req.Profiles))
	}
	if req.Profiles[0].SourceID != "posthog://person/0190abc-uuid" {
		t.Fatalf("source id = %q, want stable uuid", req.Profiles[0].SourceID)
	}
}

func TestPostHogBackfillDecodesCloudUUIDStringID(t *testing.T) {
	const personID = "0190abcd-1234-5678-9abc-0123456789ab"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"results":[{"id":"` + personID + `","distinct_ids":["fixture-user"],"properties":{"email":"fixture@example.com","first_name":"Fixture","last_name":"User","qa_fixture":true}}],"next":null}`))
	}))
	defer srv.Close()
	b := PostHogRESTBackfiller{HTTPClient: srv.Client(), APIBaseURL: srv.URL, Credentials: PostHogSecretsCredentialResolver{Secrets: fakePostHogSecretResolver{json: `{"api_key":"test","project_id":"123"}`}}}
	page, err := b.BackfillPage(context.Background(), "t", Integration{Provider: ProviderPostHog, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Profiles) != 1 || page.Profiles[0].SourceID != "posthog://person/"+personID || page.Profiles[0].FirstName != "Fixture" || page.Profiles[0].Traits["qa_fixture"] != true || page.Cursor != postHogCursorComplete {
		t.Fatalf("cloud person did not map correctly: %+v", page)
	}
}
