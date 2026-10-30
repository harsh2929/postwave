// SPDX-License-Identifier: AGPL-3.0-only
//
// powerreviews.go — native PowerReviews review puller.
//
// PowerReviews enterprise ratings & reviews. Read API: apikey query param +
// merchant_id, per-product reviews at /m/{merchant_id}/l/{locale}/product/
// {page_id}/reviews with paging.from/paging.size offsets. Reviewer emails are
// not exposed, so reviews land as emailless UGC (like Trustpilot/Bazaarvoice).
// Dispatched via the review providerPull. (Per-product: a store-wide backfill
// iterates product page_ids — a configured page_id pulls one product; the
// product enumeration loop is the documented follow-on.)
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
	powerReviewsDefaultAPIBaseURL = "https://readservices-b2c.powerreviews.com"
	powerReviewsDefaultLocale     = "en_US"
	powerReviewsDefaultPageSize   = 25
	powerReviewsMaxPageSize       = 100
	powerReviewsCursorPrefix      = "powerreviews:"
	powerReviewsCursorComplete    = "powerreviews:complete"
)

type PowerReviewsCredentials struct {
	APIKey     string
	MerchantID string
	APIBaseURL string
	UserAgent  string
}

type PowerReviewsCredentialResolver interface {
	ResolvePowerReviews(ctx context.Context, tenantID string, integration Integration) (PowerReviewsCredentials, error)
}

type powerReviewsCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	MerchantID string `json:"merchant_id"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p powerReviewsCredentialPayload) credentials() (PowerReviewsCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return PowerReviewsCredentials{}, fmt.Errorf("powerreviews api_key is required")
	}
	return PowerReviewsCredentials{APIKey: key, MerchantID: strings.TrimSpace(p.MerchantID), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type PowerReviewsSecretsCredentialResolver struct {
	Secrets ReviewRuntimeSecretResolver
}

func (r PowerReviewsSecretsCredentialResolver) ResolvePowerReviews(ctx context.Context, _ string, integration Integration) (PowerReviewsCredentials, error) {
	if r.Secrets == nil {
		return PowerReviewsCredentials{}, fmt.Errorf("powerreviews credential resolver is not configured")
	}
	ref := reviewCredentialRef(integration)
	if ref == "" {
		return PowerReviewsCredentials{}, fmt.Errorf("powerreviews credentials_ref is required")
	}
	var payload powerReviewsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withPowerReviewsDefaults(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return PowerReviewsCredentials{}, fmt.Errorf("resolve powerreviews credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withPowerReviewsDefaults(creds, integration), nil
			}
		}
	}
	creds, err := powerReviewsCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return PowerReviewsCredentials{}, err
	}
	return withPowerReviewsDefaults(creds, integration), nil
}

func withPowerReviewsDefaults(creds PowerReviewsCredentials, integration Integration) PowerReviewsCredentials {
	if creds.MerchantID == "" {
		creds.MerchantID = strings.TrimSpace(settingString(integration.Settings, "merchant_id"))
	}
	return creds
}

type PowerReviewsRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials PowerReviewsCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type powerReviewsResponse struct {
	Paging struct {
		TotalResults int `json:"total_results"`
		PageSize     int `json:"page_size"`
	} `json:"paging"`
	Results []struct {
		PageID  string `json:"page_id"`
		Reviews []struct {
			UgcID   string `json:"ugc_id"`
			Metrics struct {
				Rating int `json:"rating"`
			} `json:"metrics"`
			Details struct {
				Headline    string          `json:"headline"`
				Comments    string          `json:"comments"`
				Nickname    string          `json:"nickname"`
				CreatedDate json.RawMessage `json:"created_date"`
			} `json:"details"`
		} `json:"reviews"`
	} `json:"results"`
}

func (b PowerReviewsRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderPowerReviews {
		return SyncRequest{}, fmt.Errorf("powerreviews backfill requires a PowerReviews integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("powerreviews credential resolver is not configured")
	}
	from, done := powerReviewsOffsetCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: powerReviewsCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolvePowerReviews(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if creds.MerchantID == "" {
		return SyncRequest{}, fmt.Errorf("powerreviews merchant_id is required")
	}
	pageID := strings.TrimSpace(firstString(settingString(integration.Settings, "page_id"), settingString(integration.Settings, "product_id")))
	if pageID == "" {
		return SyncRequest{}, fmt.Errorf("powerreviews page_id (product) is required")
	}
	locale := firstString(strings.TrimSpace(settingString(integration.Settings, "locale")), powerReviewsDefaultLocale)
	client := reviewEgressClient(b.HTTPClient, ProviderPowerReviews, 30*time.Second)
	size := powerReviewsPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("apikey", creds.APIKey)
	query.Set("paging.from", strconv.Itoa(from))
	query.Set("paging.size", strconv.Itoa(size))
	query.Set("_format", "json")
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), powerReviewsDefaultAPIBaseURL)
	path := "/m/" + url.PathEscape(creds.MerchantID) + "/l/" + url.PathEscape(locale) + "/product/" + url.PathEscape(pageID) + "/reviews"

	var out powerReviewsResponse
	if err := reviewDoJSON(ctx, client, baseURL, path, query, nil, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	reviewsOut := make([]ReviewInput, 0)
	for _, group := range out.Results {
		for _, rv := range group.Reviews {
			if mapped, ok := mapPowerReviewsReview(rv.UgcID, rv.Metrics.Rating, rv.Details.Headline, rv.Details.Comments, rv.Details.Nickname, group.PageID, powerReviewsReviewTime(rv.Details.CreatedDate)); ok {
				reviewsOut = append(reviewsOut, mapped)
			}
		}
	}
	nextCursor := powerReviewsCursorComplete
	if len(reviewsOut) > 0 && out.Paging.TotalResults > from+size {
		nextCursor = powerReviewsCursorPrefix + strconv.Itoa(from+size)
	}
	return SyncRequest{RunMode: "backfill", Reviews: reviewsOut, Cursor: nextCursor}, nil
}

func mapPowerReviewsReview(ugcID string, rating int, headline, comments, nickname, productID string, submittedAt *time.Time) (ReviewInput, bool) {
	if rating < 1 || rating > 5 {
		return ReviewInput{}, false
	}
	if strings.TrimSpace(headline) == "" && strings.TrimSpace(comments) == "" {
		return ReviewInput{}, false
	}
	out := ReviewInput{
		SourceID:     "powerreviews://review/" + strings.TrimSpace(ugcID),
		ProductID:    strings.TrimSpace(productID),
		ReviewerName: strings.TrimSpace(nickname),
		Rating:       rating,
		Title:        strings.TrimSpace(headline),
		Body:         strings.TrimSpace(comments),
		ReviewType:   "product",
		Status:       "approved",
		SubmittedAt:  submittedAt,
	}
	return out, true
}

// powerReviewsReviewTime resolves PowerReviews' created_date, which is epoch
// milliseconds (a JSON number) but tolerates an ISO date string too.
func powerReviewsReviewTime(raw json.RawMessage) *time.Time {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return nil
	}
	if s[0] == '"' {
		var str string
		if err := json.Unmarshal(raw, &str); err == nil {
			return parseReviewTime(str)
		}
		return nil
	}
	ms, err := strconv.ParseInt(s, 10, 64)
	if err != nil || ms <= 0 {
		return nil
	}
	if ms < 1e12 { // tolerate epoch seconds
		ms *= 1000
	}
	t := time.UnixMilli(ms).UTC()
	return &t
}

func powerReviewsOffsetCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == powerReviewsCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, powerReviewsCursorPrefix))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, false
}

func powerReviewsPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return powerReviewsDefaultPageSize
	}
	if n > powerReviewsMaxPageSize {
		return powerReviewsMaxPageSize
	}
	return n
}
