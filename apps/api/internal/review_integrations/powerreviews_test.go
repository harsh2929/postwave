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

type fakePowerReviewsSecretResolver struct{ json string }

func (f fakePowerReviewsSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakePowerReviewsSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*powerReviewsCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestPowerReviewsBackfillMapsEmaillessReviews(t *testing.T) {
	var gotPath, gotKey, gotFrom string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.URL.Query().Get("apikey")
		gotFrom = r.URL.Query().Get("paging.from")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"paging": map[string]any{"total_results": 250, "page_size": 25, "current_page_number": 1},
			"results": []map[string]any{
				{"page_id": "P-1", "reviews": []map[string]any{
					{"ugc_id": "rev1", "metrics": map[string]any{"rating": 5},
						"details": map[string]any{"headline": "Great", "comments": "Loved it", "nickname": "Ada"}},
				}},
			},
		})
	}))
	defer srv.Close()

	backfiller := PowerReviewsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: PowerReviewsSecretsCredentialResolver{Secrets: fakePowerReviewsSecretResolver{json: `{"api_key":"pr_key","merchant_id":"12345"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderPowerReviews, CredentialsRef: "c", Settings: map[string]any{"page_id": "P-1", "locale": "en_US"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/m/12345/l/en_US/product/P-1/reviews") || gotKey != "pr_key" || gotFrom != "0" {
		t.Fatalf("path=%q key=%q from=%q", gotPath, gotKey, gotFrom)
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d", len(req.Reviews))
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "" || rv.Rating != 5 || rv.Title != "Great" || rv.Body != "Loved it" || rv.ReviewerName != "Ada" || rv.ProductID != "P-1" {
		t.Fatalf("mapped = %+v", rv)
	}
	if rv.SourceID != "powerreviews://review/rev1" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
	res := reviews.ValidateReview(reviews.Review{ReviewType: rv.ReviewType, Rating: rv.Rating, Title: rv.Title, Body: rv.Body, Status: rv.Status})
	if !res.Valid {
		t.Fatalf("mapped review fails ValidateReview: %v", res.Errors)
	}
	// total_results 250 > from+page_size (25) => next offset page.
	if req.Cursor != "powerreviews:25" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

// PowerReviews sends created_date as epoch milliseconds (a JSON number). Decoding
// it into a Go string fails the whole page, so this guards the realistic shape.
func TestPowerReviewsParsesEpochCreatedDate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"paging": map[string]any{"total_results": 1, "page_size": 25},
			"results": []map[string]any{
				{"page_id": "P-1", "reviews": []map[string]any{
					{"ugc_id": "rev1", "metrics": map[string]any{"rating": 5},
						"details": map[string]any{"headline": "Great", "comments": "Loved it", "nickname": "Ada", "created_date": 1782604800000}},
				}},
			},
		})
	}))
	defer srv.Close()

	backfiller := PowerReviewsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: PowerReviewsSecretsCredentialResolver{Secrets: fakePowerReviewsSecretResolver{json: `{"api_key":"pr_key","merchant_id":"12345"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderPowerReviews, CredentialsRef: "c", Settings: map[string]any{"page_id": "P-1", "locale": "en_US"}}, "")
	if err != nil {
		t.Fatalf("backfill must decode an epoch-ms created_date number: %v", err)
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d", len(req.Reviews))
	}
	if req.Reviews[0].SubmittedAt == nil || req.Reviews[0].SubmittedAt.Year() != 2026 {
		t.Fatalf("created_date epoch not parsed: %v", req.Reviews[0].SubmittedAt)
	}
}
