// SPDX-License-Identifier: AGPL-3.0-only
//
// reviewsio.go — native REVIEWS.io review puller.
//
// REVIEWS.io is a widely-used product + company reviews platform. Mirrors the
// Okendo/Stamped pattern: a credential resolver (public store key + private API
// key) + a REST puller over the product review API (store/apikey query params,
// page pagination; the apikey unlocks reviewer emails) + canonical ReviewInput
// mapping dispatched via providerPull.
package review_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	reviewsIODefaultAPIBaseURL = "https://api.reviews.io"
	reviewsIOCursorPrefix      = "reviews-io:"
	reviewsIOCursorComplete    = "reviews-io:complete"
)

type ReviewsIOCredentials struct {
	Store      string
	APIKey     string
	APIBaseURL string
	UserAgent  string
}

type ReviewsIOCredentialResolver interface {
	ResolveReviewsIO(ctx context.Context, tenantID string, integration Integration) (ReviewsIOCredentials, error)
}

type reviewsIOCredentialPayload struct {
	Store      string `json:"store"`
	StoreID    string `json:"store_id"`
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p reviewsIOCredentialPayload) credentials() (ReviewsIOCredentials, error) {
	store := strings.TrimSpace(firstString(p.Store, p.StoreID))
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if store == "" {
		return ReviewsIOCredentials{}, fmt.Errorf("reviews.io store is required")
	}
	return ReviewsIOCredentials{Store: store, APIKey: key, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type ReviewsIOSecretsCredentialResolver struct {
	Secrets ReviewRuntimeSecretResolver
}

func (r ReviewsIOSecretsCredentialResolver) ResolveReviewsIO(ctx context.Context, _ string, integration Integration) (ReviewsIOCredentials, error) {
	if r.Secrets == nil {
		return ReviewsIOCredentials{}, fmt.Errorf("reviews.io credential resolver is not configured")
	}
	ref := reviewCredentialRef(integration)
	if ref == "" {
		return ReviewsIOCredentials{}, fmt.Errorf("reviews.io credentials_ref is required")
	}
	var payload reviewsIOCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withReviewsIOStore(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ReviewsIOCredentials{}, fmt.Errorf("resolve reviews.io credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withReviewsIOStore(creds, integration), nil
			}
		}
	}
	return ReviewsIOCredentials{}, fmt.Errorf("reviews.io requires a JSON {store, api_key} secret")
}

func withReviewsIOStore(creds ReviewsIOCredentials, integration Integration) ReviewsIOCredentials {
	if creds.Store == "" {
		creds.Store = strings.TrimSpace(firstString(settingString(integration.Settings, "store"), settingString(integration.Settings, "store_id")))
	}
	return creds
}

type ReviewsIORESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials ReviewsIOCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type reviewsIOReview struct {
	StoreReviewID json.Number     `json:"store_review_id"`
	Rating        json.RawMessage `json:"rating"`
	Title         string          `json:"title"`
	Review        string          `json:"review"`
	Reviewer      struct {
		FirstName     string `json:"first_name"`
		LastName      string `json:"last_name"`
		Email         string `json:"email"`
		VerifiedBuyer any    `json:"verified_buyer"`
	} `json:"reviewer"`
	Product struct {
		SKU string `json:"sku"`
	} `json:"product"`
	DateCreated string `json:"date_created"`
}

// reviewsIOResponse: REVIEWS.io wraps product reviews in a Laravel-style
// paginator object under "reviews" (a "data" array), not a flat array.
type reviewsIOResponse struct {
	Reviews struct {
		Data []reviewsIOReview `json:"data"`
	} `json:"reviews"`
}

func (b ReviewsIORESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderReviewsIO {
		return SyncRequest{}, fmt.Errorf("reviews.io backfill requires a REVIEWS.io integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("reviews.io credential resolver is not configured")
	}
	page, done := reviewPageCursor(cursor, reviewsIOCursorPrefix, reviewsIOCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: reviewsIOCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveReviewsIO(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := reviewEgressClient(b.HTTPClient, ProviderReviewsIO, 30*time.Second)
	perPage := reviewPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("store", creds.Store)
	if creds.APIKey != "" {
		query.Set("apikey", creds.APIKey)
	}
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(perPage))
	if sku := strings.TrimSpace(settingString(integration.Settings, "sku")); sku != "" {
		query.Set("sku", sku)
	}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), reviewsIODefaultAPIBaseURL)

	var out reviewsIOResponse
	if err := reviewDoJSON(ctx, client, baseURL, "/product/review", query, nil, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	rows := out.Reviews.Data
	reviewsOut := make([]ReviewInput, 0, len(rows))
	for _, rv := range rows {
		if mapped, ok := mapReviewsIOReview(rv); ok {
			reviewsOut = append(reviewsOut, mapped)
		}
	}
	nextCursor := reviewsIOCursorComplete
	if len(rows) >= perPage {
		nextCursor = reviewsIOCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Reviews: reviewsOut, Cursor: nextCursor}, nil
}

func mapReviewsIOReview(rv reviewsIOReview) (ReviewInput, bool) {
	rating := reviewsIORating(rv.Rating)
	if rating < 1 || rating > 5 {
		return ReviewInput{}, false
	}
	if strings.TrimSpace(rv.Title) == "" && strings.TrimSpace(rv.Review) == "" {
		return ReviewInput{}, false
	}
	// Product reviews are emailless unless the private apikey unlocks them; import
	// either way and attach the email when present.
	return ReviewInput{
		SourceID:      "reviews-io://review/" + strings.TrimSpace(rv.StoreReviewID.String()),
		ProductID:     strings.TrimSpace(rv.Product.SKU),
		ReviewerName:  strings.TrimSpace(rv.Reviewer.FirstName + " " + rv.Reviewer.LastName),
		ReviewerEmail: strings.ToLower(strings.TrimSpace(rv.Reviewer.Email)),
		Rating:        rating,
		Title:         strings.TrimSpace(rv.Title),
		Body:          strings.TrimSpace(rv.Review),
		ReviewType:    "product",
		Status:        "approved",
		VerifiedBuyer: reviewsIOTruthy(rv.Reviewer.VerifiedBuyer),
	}, true
}

// reviewsIORating parses a rating that may arrive as a JSON number (4) or a
// JSON string ("4").
func reviewsIORating(raw json.RawMessage) int {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	n, _ := strconv.Atoi(s)
	return n
}

// reviewsIOTruthy coerces a verified-buyer flag that may be a bool or a string
// ("yes"/"true"/"1").
func reviewsIOTruthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		switch strings.ToLower(strings.TrimSpace(t)) {
		case "yes", "true", "1":
			return true
		}
	}
	return false
}
