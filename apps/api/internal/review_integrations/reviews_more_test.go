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

type fakeMoreReviewSecretResolver struct{ json string }

func (f fakeMoreReviewSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeMoreReviewSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	switch dst := out.(type) {
	case *okendoCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	case *looxCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	case *trustpilotCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

// assertReviewValidates guards that a mapped review survives the canonical
// reviews.ValidateReview gate the ProductReviewSink applies at import time
// (rating 1-5, status in the allowed set, title-or-body present).
func assertReviewValidates(t *testing.T, rv ReviewInput) {
	t.Helper()
	res := reviews.ValidateReview(reviews.Review{
		ReviewType:    firstString(rv.ReviewType, "product"),
		ReviewerEmail: rv.ReviewerEmail,
		Rating:        rv.Rating,
		Title:         rv.Title,
		Body:          rv.Body,
		Status:        firstString(rv.Status, "pending"),
	})
	if !res.Valid {
		t.Fatalf("mapped review fails ValidateReview: %v (status=%q)", res.Errors, rv.Status)
	}
}

func TestJudgeMeAndYotpoStatusValidates(t *testing.T) {
	// Regression: the live-review status must be in the canonical allowed set
	// {pending,approved,rejected,spam,archived}; "published" is rejected.
	jm, ok := mapJudgeMeReview(judgeMeReview{ID: 1, Rating: 5, Title: "t", Body: "b", Reviewer: struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	}{Name: "A", Email: "a@b.com"}})
	if !ok {
		t.Fatal("judge.me map failed")
	}
	assertReviewValidates(t, jm)
	yo, ok := mapYotpoReview(yotpoReview{ID: 2, Score: 4, Title: "t", Content: "b", Name: "B", Email: "b@c.com"})
	if !ok {
		t.Fatal("yotpo map failed")
	}
	assertReviewValidates(t, yo)
}

func TestOkendoBackfillMapsReviews(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-api-key")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"reviews": []map[string]any{
				{"reviewId": "rv1", "rating": 5, "title": "Great", "body": "Loved it",
					"productId": "P-1", "verifiedPurchase": true,
					"reviewer": map[string]any{"name": "Ada", "email": "Ada@Example.com"}},
			},
			"nextCursor": "CUR2",
		})
	}))
	defer srv.Close()

	backfiller := OkendoRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: OkendoSecretsCredentialResolver{Secrets: fakeMoreReviewSecretResolver{json: `{"api_key":"ok_key","store_id":"store-9"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderOkendo, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/stores/store-9/reviews") || gotKey != "ok_key" {
		t.Fatalf("path=%q key=%q", gotPath, gotKey)
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d", len(req.Reviews))
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "ada@example.com" || rv.Rating != 5 || !rv.VerifiedBuyer || rv.ProductID != "P-1" {
		t.Fatalf("mapped = %+v", rv)
	}
	if rv.SourceID != "okendo://review/rv1" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
	if req.Cursor != "okendo:CUR2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
	assertReviewValidates(t, rv)
}

func TestLooxBackfillMapsReviews(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("apikey")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"reviews": []map[string]any{
				{"id": 88, "rating": 4, "title": "Nice", "content": "Good", "name": "Bo",
					"email": "Bo@Example.com", "product_id": "L-1", "verified": true},
			},
		})
	}))
	defer srv.Close()

	backfiller := LooxRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: LooxSecretsCredentialResolver{Secrets: fakeMoreReviewSecretResolver{json: `{"api_key":"loox_key"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderLoox, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/reviews") || gotKey != "loox_key" {
		t.Fatalf("path=%q key=%q", gotPath, gotKey)
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d", len(req.Reviews))
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "bo@example.com" || rv.Rating != 4 || rv.Body != "Good" || rv.ProductID != "L-1" {
		t.Fatalf("mapped = %+v", rv)
	}
	if rv.SourceID != "loox://review/88" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
	if req.Cursor != "loox:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
	assertReviewValidates(t, rv)
}

func TestTrustpilotBackfillMapsEmaillessReviews(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("apikey")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"reviews": []map[string]any{
				{"id": "tp1", "stars": 5, "title": "Excellent", "text": "Top service",
					"consumer": map[string]any{"displayName": "Cara K"}},
			},
		})
	}))
	defer srv.Close()

	backfiller := TrustpilotRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: TrustpilotSecretsCredentialResolver{Secrets: fakeMoreReviewSecretResolver{json: `{"api_key":"tp_key","business_unit_id":"bu-1"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderTrustpilot, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/business-units/bu-1/reviews") || gotKey != "tp_key" {
		t.Fatalf("path=%q key=%q", gotPath, gotKey)
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d (Trustpilot reviews are emailless but still import)", len(req.Reviews))
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "" || rv.Rating != 5 || rv.Title != "Excellent" || rv.ReviewerName != "Cara K" {
		t.Fatalf("mapped = %+v", rv)
	}
	if rv.SourceID != "trustpilot://review/tp1" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
	assertReviewValidates(t, rv)
}
