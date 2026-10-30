// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/reviews"
)

type fakeReviewsIOSecretResolver struct{ json string }

func (f fakeReviewsIOSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeReviewsIOSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*reviewsIOCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestReviewsIOBackfillMapsReviews(t *testing.T) {
	var gotPath, gotStore, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotStore = r.URL.Query().Get("store")
		gotKey = r.URL.Query().Get("apikey")
		// REVIEWS.io wraps results in a paginator object (not a flat array). Rating
		// and verified_buyer arrive as strings; product reviews may omit email.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"reviews": map[string]any{
				"data": []map[string]any{
					{"store_review_id": 777, "rating": "5", "title": "Great", "review": "Loved it",
						"reviewer": map[string]any{"first_name": "Ada", "last_name": "L", "email": "Ada@Example.com", "verified_buyer": "yes"}},
					{"store_review_id": 778, "rating": 4, "review": "Nice",
						"reviewer": map[string]any{"first_name": "Bo", "last_name": "R"}},
				},
				"total": 2, "per_page": 10, "current_page": 1, "last_page": 1,
			},
		})
	}))
	defer srv.Close()

	backfiller := ReviewsIORESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ReviewsIOSecretsCredentialResolver{Secrets: fakeReviewsIOSecretResolver{json: `{"store":"acme","api_key":"rk"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderReviewsIO, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/product/review") || gotStore != "acme" || gotKey != "rk" {
		t.Fatalf("path=%q store=%q key=%q", gotPath, gotStore, gotKey)
	}
	if len(req.Reviews) != 2 {
		t.Fatalf("reviews = %d (emailless product review must still import)", len(req.Reviews))
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "ada@example.com" || rv.Rating != 5 || rv.Title != "Great" || !rv.VerifiedBuyer || rv.ReviewerName != "Ada L" {
		t.Fatalf("mapped = %+v", rv)
	}
	if rv.SourceID != "reviews-io://review/777" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
	if req.Reviews[1].ReviewerEmail != "" || req.Reviews[1].Rating != 4 {
		t.Fatalf("emailless review mapped wrong: %+v", req.Reviews[1])
	}
	res := reviews.ValidateReview(reviews.Review{ReviewType: rv.ReviewType, Rating: rv.Rating, Title: rv.Title, Body: rv.Body, Status: rv.Status})
	if !res.Valid {
		t.Fatalf("mapped review fails ValidateReview: %v", res.Errors)
	}
}
