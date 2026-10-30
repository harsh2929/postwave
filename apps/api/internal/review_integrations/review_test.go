// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeReviewSecretResolver struct{ json string }

func (f fakeReviewSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeReviewSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	switch dst := out.(type) {
	case *judgeMeCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	case *yotpoCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestJudgeMeBackfillMapsReviews(t *testing.T) {
	var gotPath, gotToken, gotShop string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.URL.Query().Get("api_token")
		gotShop = r.URL.Query().Get("shop_domain")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"reviews": []map[string]any{
				{"id": 11, "rating": 5, "title": "Great", "body": "Loved it", "verified": true, "product_external_id": "P-1",
					"reviewer": map[string]any{"name": "Ada", "email": "Ada@Example.com"}, "created_at": "2026-06-20T10:00:00Z"},
			},
			"per_page": 10, "current_page": 1,
		})
	}))
	defer srv.Close()

	backfiller := JudgeMeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: JudgeMeSecretsCredentialResolver{Secrets: fakeReviewSecretResolver{json: `{"api_token":"jm_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderJudgeMe, CredentialsRef: "c", Settings: map[string]any{"shop_domain": "acme.myshopify.com"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/reviews") || gotToken != "jm_tok" || gotShop != "acme.myshopify.com" {
		t.Fatalf("path=%q token=%q shop=%q", gotPath, gotToken, gotShop)
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d", len(req.Reviews))
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "ada@example.com" || rv.Rating != 5 || rv.Title != "Great" || !rv.VerifiedBuyer || rv.ProductID != "P-1" {
		t.Fatalf("mapped review = %+v", rv)
	}
	if rv.SourceID != "judge-me://review/11" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
}

// Judge.me's /reviews list returns reviews in all states; spam and hidden
// reviews must not be imported as approved.
func TestJudgeMeMapsModerationStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"reviews": []map[string]any{
				{"id": 1, "rating": 5, "body": "spammy", "curated": "spam", "reviewer": map[string]any{"email": "a@example.com"}},
				{"id": 2, "rating": 4, "body": "hidden one", "hidden": true, "curated": "ok", "reviewer": map[string]any{"email": "b@example.com"}},
				{"id": 3, "rating": 5, "body": "good", "curated": "ok", "reviewer": map[string]any{"email": "c@example.com"}},
			},
			"per_page": 10, "current_page": 1,
		})
	}))
	defer srv.Close()

	backfiller := JudgeMeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: JudgeMeSecretsCredentialResolver{Secrets: fakeReviewSecretResolver{json: `{"api_token":"jm_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderJudgeMe, CredentialsRef: "c", Settings: map[string]any{"shop_domain": "acme.myshopify.com"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	got := map[string]string{}
	for _, rv := range req.Reviews {
		got[rv.SourceID] = rv.Status
	}
	if got["judge-me://review/1"] != "spam" {
		t.Fatalf("spam review status = %q", got["judge-me://review/1"])
	}
	if got["judge-me://review/2"] != "archived" {
		t.Fatalf("hidden review status = %q", got["judge-me://review/2"])
	}
	if got["judge-me://review/3"] != "approved" {
		t.Fatalf("normal review status = %q", got["judge-me://review/3"])
	}
}

func TestYotpoBackfillExchangesTokenThenMapsReviews(t *testing.T) {
	var tokenCalled bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/oauth/token"):
			tokenCalled = true
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "utoken123"})
		case strings.Contains(r.URL.Path, "/reviews"):
			if r.URL.Query().Get("utoken") != "utoken123" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"reviews": []map[string]any{
					{"id": 22, "score": 4, "title": "Nice", "content": "Good", "name": "Bo", "email": "Bo@Example.com", "product_id": "Y-1", "external_order_id": "ORDER-22", "customer_id": "CUST-22", "verified_buyer": true, "created_at": "2026-06-20T10:00:00Z"},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := YotpoRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: YotpoSecretsCredentialResolver{Secrets: fakeReviewSecretResolver{json: `{"app_key":"APPK","secret":"SEC"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderYotpo, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !tokenCalled {
		t.Fatal("yotpo did not exchange app_key/secret for a utoken")
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d", len(req.Reviews))
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "bo@example.com" || rv.Rating != 4 || rv.Body != "Good" || !rv.VerifiedBuyer {
		t.Fatalf("mapped review = %+v", rv)
	}
	if rv.SubmittedAt == nil || rv.SubmittedAt.Format("2006-01-02T15:04:05Z") != "2026-06-20T10:00:00Z" {
		t.Fatalf("submitted_at = %v", rv.SubmittedAt)
	}
	if rv.ProductID != "" || rv.Metadata["provider_product_id"] != "Y-1" {
		t.Fatalf("mapped product evidence = product_id:%q metadata:%+v", rv.ProductID, rv.Metadata)
	}
	if rv.OrderID != "" || rv.Metadata["external_order_id"] != "ORDER-22" || rv.Metadata["provider_customer_id"] != "CUST-22" {
		t.Fatalf("mapped order/customer evidence = order_id:%q metadata:%+v", rv.OrderID, rv.Metadata)
	}
	if rv.SourceID != "yotpo://review/22" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
}

func TestYotpoBackfillSurfacesRetryAfterOnProviderFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := YotpoRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: YotpoSecretsCredentialResolver{Secrets: fakeReviewSecretResolver{json: `{"app_key":"APPK","secret":"SEC"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderYotpo, CredentialsRef: "c"}, "")
	var restErr ReviewRESTError
	if !errors.As(err, &restErr) {
		t.Fatalf("expected ReviewRESTError, got %T %[1]v", err)
	}
	if restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter.String() != "7s" {
		t.Fatalf("rest error = %+v", restErr)
	}
}

func TestVerifyJudgeMeWebhookExists(t *testing.T) {
	// The verifier already exists (JUDGEME-HMAC-SHA256); confirm a valid signature
	// passes and a tampered one fails via the package helper.
	secret := "jm_webhook"
	body := []byte(`{"id":1}`)
	header := judgeMeTestSignature(secret, body)
	if !VerifyJudgeMeWebhookSignature(secret, body, header) {
		t.Fatal("valid signature rejected")
	}
	if VerifyJudgeMeWebhookSignature(secret, append(body, '!'), header) {
		t.Fatal("tampered body accepted")
	}
}

func judgeMeTestSignature(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
