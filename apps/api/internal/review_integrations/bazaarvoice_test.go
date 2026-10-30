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

type fakeBazaarvoiceSecretResolver struct{ json string }

func (f fakeBazaarvoiceSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeBazaarvoiceSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*bazaarvoiceCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestBazaarvoiceBackfillMapsEmaillessReviews(t *testing.T) {
	var gotPath, gotPasskey, gotOffset string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotPasskey = r.URL.Query().Get("passkey")
		gotOffset = r.URL.Query().Get("Offset")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Results": []map[string]any{
				{"Id": "r1", "Rating": 5, "Title": "Great", "ReviewText": "Loved it",
					"UserNickname": "Ada", "ProductId": "P-1", "SubmissionTime": "2026-06-20T10:00:00.000+00:00"},
			},
			"TotalResults": 250, "Limit": 100, "Offset": 0, "HasErrors": false,
		})
	}))
	defer srv.Close()

	backfiller := BazaarvoiceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: BazaarvoiceSecretsCredentialResolver{Secrets: fakeBazaarvoiceSecretResolver{json: `{"passkey":"bv_key"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderBazaarvoice, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/data/reviews.json") || gotPasskey != "bv_key" || gotOffset != "0" {
		t.Fatalf("path=%q passkey=%q offset=%q", gotPath, gotPasskey, gotOffset)
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d", len(req.Reviews))
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "" || rv.Rating != 5 || rv.Title != "Great" || rv.Body != "Loved it" || rv.ReviewerName != "Ada" || rv.ProductID != "P-1" {
		t.Fatalf("mapped = %+v", rv)
	}
	if rv.SourceID != "bazaarvoice://review/r1" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
	res := reviews.ValidateReview(reviews.Review{ReviewType: rv.ReviewType, Rating: rv.Rating, Title: rv.Title, Body: rv.Body, Status: rv.Status})
	if !res.Valid {
		t.Fatalf("mapped review fails ValidateReview: %v", res.Errors)
	}
	// TotalResults 250 > offset+limit 100 => next offset page.
	if req.Cursor != "bazaarvoice:100" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}
