// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/reviews"
)

type fakeStampedSecretResolver struct{ json string }

func (f fakeStampedSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeStampedSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*stampedCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestStampedBackfillMapsReviews(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"id": 4321, "reviewRating": 5, "reviewTitle": "Great", "reviewMessage": "Loved it",
					"author": "Ada", "email": "Ada@Example.com", "productId": "P-1", "reviewIsVerifiedBuyer": true},
			},
			"total": 1,
		})
	}))
	defer srv.Close()

	backfiller := StampedRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: StampedSecretsCredentialResolver{Secrets: fakeStampedSecretResolver{json: `{"public_key":"pub","private_key":"priv","store_hash":"acme.myshopify.com"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderStamped, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("pub:priv"))
	if !strings.Contains(gotPath, "/reviews") || !strings.Contains(gotPath, "acme.myshopify.com") || gotAuth != wantAuth {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d", len(req.Reviews))
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "ada@example.com" || rv.Rating != 5 || rv.Title != "Great" || !rv.VerifiedBuyer || rv.ProductID != "P-1" {
		t.Fatalf("mapped = %+v", rv)
	}
	if rv.SourceID != "stamped://review/4321" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
	res := reviews.ValidateReview(reviews.Review{ReviewType: rv.ReviewType, Rating: rv.Rating, Title: rv.Title, Body: rv.Body, Status: rv.Status})
	if !res.Valid {
		t.Fatalf("mapped review fails ValidateReview: %v", res.Errors)
	}
}
