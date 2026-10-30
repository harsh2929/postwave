// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeSkioSecretResolver struct{ json string }

func (f fakeSkioSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeSkioSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*skioCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestSkioBackfillMapsSubscriptions(t *testing.T) {
	var gotMethod, gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"Subscriptions": []map[string]any{
					{"id": "sub_1", "status": "ACTIVE",
						"StorefrontUser": map[string]any{"email": "Ada@Example.com"}},
				},
			},
		})
	}))
	defer srv.Close()

	backfiller := SkioGraphQLBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SkioSecretsCredentialResolver{Secrets: fakeSkioSecretResolver{json: `{"api_key":"skio_key"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderSkio, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotMethod != http.MethodPost || gotAuth != "API skio_key" || !strings.Contains(gotBody, "Subscriptions") {
		t.Fatalf("method=%q auth=%q body=%q", gotMethod, gotAuth, gotBody)
	}
	if len(req.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d", len(req.Subscriptions))
	}
	s := req.Subscriptions[0]
	if s.Email != "ada@example.com" || s.Status != "active" || s.SubscriptionID != "sub_1" {
		t.Fatalf("mapped = %+v", s)
	}
	if s.SourceID != "skio://subscription/sub_1" {
		t.Fatalf("source id = %q", s.SourceID)
	}
	// One full page (PageSize=1) => next offset cursor.
	if req.Cursor != "skio:1" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestSkioBackfillSurfacesGraphQLErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"errors": []map[string]any{{"message": "permission denied"}},
		})
	}))
	defer srv.Close()

	backfiller := SkioGraphQLBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SkioSecretsCredentialResolver{Secrets: fakeSkioSecretResolver{json: `{"api_key":"k"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderSkio, CredentialsRef: "c"}, "")
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("expected GraphQL error surfaced, got %v", err)
	}
}

func TestSkioBackfillCompleteCursorStops(t *testing.T) {
	backfiller := SkioGraphQLBackfiller{
		Credentials: SkioSecretsCredentialResolver{Secrets: fakeSkioSecretResolver{json: `{"api_key":"k"}`}},
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderSkio, CredentialsRef: "c"}, skioCursorComplete)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Subscriptions) != 0 || req.Cursor != skioCursorComplete {
		t.Fatalf("complete cursor should short-circuit, got %+v", req)
	}
}
