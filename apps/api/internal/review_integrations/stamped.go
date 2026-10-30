// SPDX-License-Identifier: AGPL-3.0-only
//
// stamped.go — native Stamped review provider puller.
//
// Stamped is a high-demand Shopify reviews + loyalty app. Mirrors the
// Yotpo/Judge.me pattern: a credential resolver (public/private key pair, HTTP
// Basic) + a REST puller over the dashboard reviews API (store-hash path, page
// pagination) + canonical ReviewInput mapping dispatched via providerPull.
package review_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	stampedDefaultAPIBaseURL = "https://stamped.io"
	stampedCursorPrefix      = "stamped:"
	stampedCursorComplete    = "stamped:complete"
)

type StampedCredentials struct {
	PublicKey  string
	PrivateKey string
	StoreHash  string
	APIBaseURL string
	UserAgent  string
}

type StampedCredentialResolver interface {
	ResolveStamped(ctx context.Context, tenantID string, integration Integration) (StampedCredentials, error)
}

type stampedCredentialPayload struct {
	PublicKey  string `json:"public_key"`
	APIKey     string `json:"api_key"`
	PrivateKey string `json:"private_key"`
	Secret     string `json:"secret"`
	StoreHash  string `json:"store_hash"`
	StoreURL   string `json:"store_url"`
	StoreID    string `json:"store_id"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p stampedCredentialPayload) credentials() (StampedCredentials, error) {
	pub := strings.TrimSpace(firstString(p.PublicKey, p.APIKey))
	priv := strings.TrimSpace(firstString(p.PrivateKey, p.Secret))
	if pub == "" || priv == "" {
		return StampedCredentials{}, fmt.Errorf("stamped public_key and private_key are required")
	}
	return StampedCredentials{PublicKey: pub, PrivateKey: priv, StoreHash: strings.TrimSpace(firstString(p.StoreHash, p.StoreURL, p.StoreID)), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type StampedSecretsCredentialResolver struct {
	Secrets ReviewRuntimeSecretResolver
}

func (r StampedSecretsCredentialResolver) ResolveStamped(ctx context.Context, _ string, integration Integration) (StampedCredentials, error) {
	if r.Secrets == nil {
		return StampedCredentials{}, fmt.Errorf("stamped credential resolver is not configured")
	}
	ref := reviewCredentialRef(integration)
	if ref == "" {
		return StampedCredentials{}, fmt.Errorf("stamped credentials_ref is required")
	}
	var payload stampedCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withStampedStore(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return StampedCredentials{}, fmt.Errorf("resolve stamped credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withStampedStore(creds, integration), nil
			}
		}
	}
	return StampedCredentials{}, fmt.Errorf("stamped requires a JSON {public_key, private_key} secret")
}

func withStampedStore(creds StampedCredentials, integration Integration) StampedCredentials {
	if creds.StoreHash == "" {
		creds.StoreHash = strings.TrimSpace(firstString(settingString(integration.Settings, "store_hash"), settingString(integration.Settings, "store_url"), settingString(integration.Settings, "store_id")))
	}
	return creds
}

type StampedRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials StampedCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type stampedReview struct {
	ID              json.Number `json:"id"`
	ReviewRating    int         `json:"reviewRating"`
	ReviewTitle     string      `json:"reviewTitle"`
	ReviewMessage   string      `json:"reviewMessage"`
	Author          string      `json:"author"`
	Email           string      `json:"email"`
	ProductID       string      `json:"productId"`
	IsVerifiedBuyer bool        `json:"reviewIsVerifiedBuyer"`
}

func (b StampedRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderStamped {
		return SyncRequest{}, fmt.Errorf("stamped backfill requires a Stamped integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("stamped credential resolver is not configured")
	}
	page, done := reviewPageCursor(cursor, stampedCursorPrefix, stampedCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: stampedCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveStamped(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if creds.StoreHash == "" {
		return SyncRequest{}, fmt.Errorf("stamped store_hash or store_id is required")
	}
	client := reviewEgressClient(b.HTTPClient, ProviderStamped, 30*time.Second)
	perPage := reviewPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("take", strconv.Itoa(perPage))
	query.Set("sortReviews", "created_desc")
	headers := map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(creds.PublicKey+":"+creds.PrivateKey))}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), stampedDefaultAPIBaseURL)
	path := "/api/v2/" + url.PathEscape(creds.StoreHash) + "/dashboard/reviews"

	var out struct {
		Results []stampedReview `json:"results"`
		Total   int             `json:"total"`
	}
	if err := reviewDoJSON(ctx, client, baseURL, path, query, headers, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	reviewsOut := make([]ReviewInput, 0, len(out.Results))
	for _, rv := range out.Results {
		if mapped, ok := mapStampedReview(rv); ok {
			reviewsOut = append(reviewsOut, mapped)
		}
	}
	nextCursor := stampedCursorComplete
	if len(out.Results) >= perPage {
		nextCursor = stampedCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Reviews: reviewsOut, Cursor: nextCursor}, nil
}

func mapStampedReview(rv stampedReview) (ReviewInput, bool) {
	if rv.ReviewRating < 1 || rv.ReviewRating > 5 {
		return ReviewInput{}, false
	}
	if strings.TrimSpace(rv.ReviewTitle) == "" && strings.TrimSpace(rv.ReviewMessage) == "" {
		return ReviewInput{}, false
	}
	return ReviewInput{
		SourceID:      "stamped://review/" + strings.TrimSpace(rv.ID.String()),
		ProductID:     strings.TrimSpace(rv.ProductID),
		ReviewerName:  strings.TrimSpace(rv.Author),
		ReviewerEmail: strings.ToLower(strings.TrimSpace(rv.Email)),
		Rating:        rv.ReviewRating,
		Title:         strings.TrimSpace(rv.ReviewTitle),
		Body:          strings.TrimSpace(rv.ReviewMessage),
		ReviewType:    "product",
		Status:        "approved",
		VerifiedBuyer: rv.IsVerifiedBuyer,
	}, true
}
