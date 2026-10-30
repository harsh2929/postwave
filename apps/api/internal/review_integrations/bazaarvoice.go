// SPDX-License-Identifier: AGPL-3.0-only
//
// bazaarvoice.go — native Bazaarvoice review puller (Conversations API v5.4).
//
// Bazaarvoice is an enterprise ratings & reviews platform. The display
// Conversations API authenticates with a single passkey query param and pages
// with Limit/Offset. Reviewer emails are not exposed (privacy), so reviews land
// as emailless UGC (imported; profile/event linking skipped) — same treatment
// as Trustpilot. Dispatched via the review providerPull.
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
	bazaarvoiceDefaultAPIBaseURL = "https://api.bazaarvoice.com"
	bazaarvoiceAPIVersion        = "5.4"
	bazaarvoiceDefaultPageSize   = 100
	bazaarvoiceMaxPageSize       = 100
	bazaarvoiceCursorPrefix      = "bazaarvoice:"
	bazaarvoiceCursorComplete    = "bazaarvoice:complete"
)

type BazaarvoiceCredentials struct {
	Passkey    string
	APIBaseURL string
	UserAgent  string
}

type BazaarvoiceCredentialResolver interface {
	ResolveBazaarvoice(ctx context.Context, tenantID string, integration Integration) (BazaarvoiceCredentials, error)
}

type bazaarvoiceCredentialPayload struct {
	Passkey    string `json:"passkey"`
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p bazaarvoiceCredentialPayload) credentials() (BazaarvoiceCredentials, error) {
	key := strings.TrimSpace(firstString(p.Passkey, p.APIKey, p.Token))
	if key == "" {
		return BazaarvoiceCredentials{}, fmt.Errorf("bazaarvoice passkey is required")
	}
	return BazaarvoiceCredentials{Passkey: key, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type BazaarvoiceSecretsCredentialResolver struct {
	Secrets ReviewRuntimeSecretResolver
}

func (r BazaarvoiceSecretsCredentialResolver) ResolveBazaarvoice(ctx context.Context, _ string, integration Integration) (BazaarvoiceCredentials, error) {
	if r.Secrets == nil {
		return BazaarvoiceCredentials{}, fmt.Errorf("bazaarvoice credential resolver is not configured")
	}
	ref := reviewCredentialRef(integration)
	if ref == "" {
		return BazaarvoiceCredentials{}, fmt.Errorf("bazaarvoice credentials_ref is required")
	}
	var payload bazaarvoiceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withBazaarvoiceBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return BazaarvoiceCredentials{}, fmt.Errorf("resolve bazaarvoice credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withBazaarvoiceBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := bazaarvoiceCredentialPayload{Passkey: raw}.credentials()
	if err != nil {
		return BazaarvoiceCredentials{}, err
	}
	return withBazaarvoiceBaseURL(creds, integration), nil
}

func withBazaarvoiceBaseURL(creds BazaarvoiceCredentials, integration Integration) BazaarvoiceCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type BazaarvoiceRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials BazaarvoiceCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type bazaarvoiceReview struct {
	ID             string      `json:"Id"`
	Rating         int         `json:"Rating"`
	Title          string      `json:"Title"`
	ReviewText     string      `json:"ReviewText"`
	UserNickname   string      `json:"UserNickname"`
	ProductID      string      `json:"ProductId"`
	SubmissionTime string      `json:"SubmissionTime"`
	IsRecommended  interface{} `json:"IsRecommended"`
}

type bazaarvoiceResponse struct {
	Results      []bazaarvoiceReview `json:"Results"`
	TotalResults int                 `json:"TotalResults"`
	Limit        int                 `json:"Limit"`
	Offset       int                 `json:"Offset"`
	HasErrors    bool                `json:"HasErrors"`
}

func (b BazaarvoiceRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderBazaarvoice {
		return SyncRequest{}, fmt.Errorf("bazaarvoice backfill requires a Bazaarvoice integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("bazaarvoice credential resolver is not configured")
	}
	offset, done := bazaarvoiceOffsetCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: bazaarvoiceCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveBazaarvoice(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := reviewEgressClient(b.HTTPClient, ProviderBazaarvoice, 30*time.Second)
	limit := bazaarvoicePageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("passkey", creds.Passkey)
	query.Set("apiversion", bazaarvoiceAPIVersion)
	query.Set("Limit", strconv.Itoa(limit))
	query.Set("Offset", strconv.Itoa(offset))
	query.Set("Sort", "SubmissionTime:desc")
	if pid := strings.TrimSpace(settingString(integration.Settings, "product_id")); pid != "" {
		query.Set("Filter", "ProductId:"+pid)
	}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), bazaarvoiceDefaultAPIBaseURL)

	var out bazaarvoiceResponse
	if err := reviewDoJSON(ctx, client, baseURL, "/data/reviews.json", query, nil, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	if out.HasErrors {
		return SyncRequest{}, fmt.Errorf("bazaarvoice response reported errors (check passkey/filters)")
	}
	reviewsOut := make([]ReviewInput, 0, len(out.Results))
	for _, rv := range out.Results {
		if mapped, ok := mapBazaarvoiceReview(rv); ok {
			reviewsOut = append(reviewsOut, mapped)
		}
	}
	nextCursor := bazaarvoiceCursorComplete
	if len(out.Results) > 0 && offset+limit < out.TotalResults {
		nextCursor = bazaarvoiceCursorPrefix + strconv.Itoa(offset+limit)
	}
	return SyncRequest{RunMode: "backfill", Reviews: reviewsOut, Cursor: nextCursor}, nil
}

func mapBazaarvoiceReview(rv bazaarvoiceReview) (ReviewInput, bool) {
	if rv.Rating < 1 || rv.Rating > 5 {
		return ReviewInput{}, false
	}
	if strings.TrimSpace(rv.Title) == "" && strings.TrimSpace(rv.ReviewText) == "" {
		return ReviewInput{}, false
	}
	out := ReviewInput{
		// Bazaarvoice does not expose reviewer email; imports as emailless UGC.
		SourceID:     "bazaarvoice://review/" + strings.TrimSpace(rv.ID),
		ProductID:    strings.TrimSpace(rv.ProductID),
		ReviewerName: strings.TrimSpace(rv.UserNickname),
		Rating:       rv.Rating,
		Title:        strings.TrimSpace(rv.Title),
		Body:         strings.TrimSpace(rv.ReviewText),
		ReviewType:   "product",
		Status:       "approved",
	}
	if t := parseReviewTime(rv.SubmissionTime); t != nil {
		out.SubmittedAt = t
	}
	return out, true
}

func bazaarvoiceOffsetCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == bazaarvoiceCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, bazaarvoiceCursorPrefix))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, false
}

func bazaarvoicePageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return bazaarvoiceDefaultPageSize
	}
	if n > bazaarvoiceMaxPageSize {
		return bazaarvoiceMaxPageSize
	}
	return n
}
