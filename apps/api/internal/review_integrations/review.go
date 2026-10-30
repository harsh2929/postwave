// SPDX-License-Identifier: AGPL-3.0-only
//
// review.go — native Yotpo + Judge.me review provider pullers.
//
// Reviews power post-purchase review-request + UGC-in-email flows. Both add the
// provider-facing layer the review_integrations foundation lacked: credential
// resolvers + REST pullers dispatched via Deps.providerPull, landing canonical
// ReviewInput rows. The Judge.me webhook verifier already exists (signatures.go).
package review_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	judgeMeDefaultAPIBaseURL = "https://judge.me"
	yotpoDefaultAPIBaseURL   = "https://api.yotpo.com"
	reviewDefaultUserAgent   = "Moosewave Reviews Integration"
	reviewResponseMaxBytes   = 16 << 20
	reviewDefaultPageSize    = 50
)

var errNotJSONSecret = errors.New("review_integrations: secret is not JSON")

type ReviewRESTError struct {
	Operation  string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e ReviewRESTError) Error() string {
	operation := strings.TrimSpace(e.Operation)
	if operation == "" {
		operation = "review provider request"
	}
	msg := fmt.Sprintf("%s failed %d", operation, e.StatusCode)
	if e.RetryAfter > 0 {
		msg += " retry_after=" + e.RetryAfter.String()
	}
	if strings.TrimSpace(e.Snippet) != "" {
		msg += ": " + strings.TrimSpace(e.Snippet)
	}
	return msg
}

// ReviewRuntimeSecretResolver is the trusted secrets backend.
type ReviewRuntimeSecretResolver interface {
	Get(ctx context.Context, ref string) (string, error)
	GetJSON(ctx context.Context, ref string, out any) error
}

type ReviewBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

func reviewPageCursor(cursor, prefix, complete string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == complete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, prefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func reviewPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return reviewDefaultPageSize
	}
	if n > 100 {
		return 100
	}
	return n
}

func parseReviewTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05Z", "2006-01-02T15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			utc := parsed.UTC()
			return &utc
		}
	}
	return nil
}

// ---------------- Judge.me ----------------

const (
	judgeMeCursorPrefix   = "judge-me:"
	judgeMeCursorComplete = "judge-me:complete"
)

type JudgeMeCredentials struct {
	APIToken   string
	APIBaseURL string
	UserAgent  string
}

type JudgeMeCredentialResolver interface {
	ResolveJudgeMe(ctx context.Context, tenantID string, integration Integration) (JudgeMeCredentials, error)
}

type judgeMeCredentialPayload struct {
	APIToken   string `json:"api_token"`
	Token      string `json:"token"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p judgeMeCredentialPayload) credentials() (JudgeMeCredentials, error) {
	token := strings.TrimSpace(firstString(p.APIToken, p.Token))
	if token == "" {
		return JudgeMeCredentials{}, fmt.Errorf("judge.me api_token is required")
	}
	return JudgeMeCredentials{APIToken: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type JudgeMeSecretsCredentialResolver struct {
	Secrets ReviewRuntimeSecretResolver
}

func (r JudgeMeSecretsCredentialResolver) ResolveJudgeMe(ctx context.Context, _ string, integration Integration) (JudgeMeCredentials, error) {
	if r.Secrets == nil {
		return JudgeMeCredentials{}, fmt.Errorf("judge.me credential resolver is not configured")
	}
	ref := reviewCredentialRef(integration)
	if ref == "" {
		return JudgeMeCredentials{}, fmt.Errorf("judge.me credentials_ref is required")
	}
	var payload judgeMeCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return JudgeMeCredentials{}, fmt.Errorf("resolve judge.me credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return judgeMeCredentialPayload{APIToken: raw}.credentials()
}

type JudgeMeRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials JudgeMeCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type judgeMeReview struct {
	ID                int    `json:"id"`
	Rating            int    `json:"rating"`
	Title             string `json:"title"`
	Body              string `json:"body"`
	Verified          bool   `json:"verified"`
	Hidden            bool   `json:"hidden"`
	Curated           string `json:"curated"`
	ProductExternalID string `json:"product_external_id"`
	Reviewer          struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"reviewer"`
	CreatedAt string `json:"created_at"`
}

func (b JudgeMeRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderJudgeMe {
		return SyncRequest{}, fmt.Errorf("judge.me backfill requires a Judge.me integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("judge.me credential resolver is not configured")
	}
	page, done := reviewPageCursor(cursor, judgeMeCursorPrefix, judgeMeCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: judgeMeCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveJudgeMe(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := reviewEgressClient(b.HTTPClient, ProviderJudgeMe, 30*time.Second)
	perPage := reviewPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("api_token", strings.TrimSpace(creds.APIToken))
	query.Set("shop_domain", strings.TrimSpace(settingString(integration.Settings, "shop_domain")))
	query.Set("per_page", strconv.Itoa(perPage))
	query.Set("page", strconv.Itoa(page))

	var out struct {
		Reviews []judgeMeReview `json:"reviews"`
	}
	if err := reviewDoJSON(ctx, client, firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), judgeMeDefaultAPIBaseURL), "/api/v1/reviews", query, nil, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	reviewsOut := make([]ReviewInput, 0, len(out.Reviews))
	for _, rv := range out.Reviews {
		if mapped, ok := mapJudgeMeReview(rv); ok {
			reviewsOut = append(reviewsOut, mapped)
		}
	}
	nextCursor := judgeMeCursorComplete
	if len(out.Reviews) >= perPage {
		nextCursor = judgeMeCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Reviews: reviewsOut, Cursor: nextCursor}, nil
}

func mapJudgeMeReview(rv judgeMeReview) (ReviewInput, bool) {
	email := strings.ToLower(strings.TrimSpace(rv.Reviewer.Email))
	if email == "" {
		return ReviewInput{}, false
	}
	out := ReviewInput{
		SourceID:      "judge-me://review/" + strconv.Itoa(rv.ID),
		ProductID:     strings.TrimSpace(rv.ProductExternalID),
		ReviewerName:  strings.TrimSpace(rv.Reviewer.Name),
		ReviewerEmail: email,
		Rating:        rv.Rating,
		Title:         strings.TrimSpace(rv.Title),
		Body:          strings.TrimSpace(rv.Body),
		ReviewType:    "product",
		Status:        mapJudgeMeStatus(rv.Curated, rv.Hidden),
		VerifiedBuyer: rv.Verified,
	}
	return out, true
}

// mapJudgeMeStatus maps Judge.me moderation flags to a canonical review status.
// The /reviews list returns reviews in all states, so spam (curated "spam") and
// hidden reviews must not be imported as approved and shown publicly.
func mapJudgeMeStatus(curated string, hidden bool) string {
	if strings.EqualFold(strings.TrimSpace(curated), "spam") {
		return "spam"
	}
	if hidden {
		return "archived"
	}
	return "approved"
}

// ---------------- Yotpo ----------------

const (
	yotpoCursorPrefix   = "yotpo:"
	yotpoCursorComplete = "yotpo:complete"
)

type YotpoCredentials struct {
	AppKey     string
	Secret     string
	APIBaseURL string
	UserAgent  string
}

type YotpoCredentialResolver interface {
	ResolveYotpo(ctx context.Context, tenantID string, integration Integration) (YotpoCredentials, error)
}

type yotpoCredentialPayload struct {
	AppKey     string `json:"app_key"`
	Secret     string `json:"secret"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p yotpoCredentialPayload) credentials() (YotpoCredentials, error) {
	appKey := strings.TrimSpace(p.AppKey)
	secret := strings.TrimSpace(p.Secret)
	if appKey == "" || secret == "" {
		return YotpoCredentials{}, fmt.Errorf("yotpo app_key and secret are required")
	}
	return YotpoCredentials{AppKey: appKey, Secret: secret, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type YotpoSecretsCredentialResolver struct {
	Secrets ReviewRuntimeSecretResolver
}

func (r YotpoSecretsCredentialResolver) ResolveYotpo(ctx context.Context, _ string, integration Integration) (YotpoCredentials, error) {
	if r.Secrets == nil {
		return YotpoCredentials{}, fmt.Errorf("yotpo credential resolver is not configured")
	}
	ref := reviewCredentialRef(integration)
	if ref == "" {
		return YotpoCredentials{}, fmt.Errorf("yotpo credentials_ref is required")
	}
	var payload yotpoCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return YotpoCredentials{}, fmt.Errorf("resolve yotpo credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return YotpoCredentials{}, fmt.Errorf("yotpo requires a JSON {app_key, secret} secret")
}

type YotpoRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials YotpoCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type yotpoReview struct {
	ID                 int    `json:"id"`
	Score              int    `json:"score"`
	Title              string `json:"title"`
	Content            string `json:"content"`
	Name               string `json:"name"`
	Email              string `json:"email"`
	ProductID          string `json:"product_id"`
	ExternalProductID  string `json:"external_product_id"`
	OrderID            string `json:"order_id"`
	ExternalOrderID    string `json:"external_order_id"`
	CustomerID         string `json:"customer_id"`
	ExternalCustomerID string `json:"external_customer_id"`
	VerifiedBuyer      bool   `json:"verified_buyer"`
	CreatedAt          string `json:"created_at"`
}

func (b YotpoRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderYotpo {
		return SyncRequest{}, fmt.Errorf("yotpo backfill requires a Yotpo integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("yotpo credential resolver is not configured")
	}
	page, done := reviewPageCursor(cursor, yotpoCursorPrefix, yotpoCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: yotpoCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveYotpo(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := reviewEgressClient(b.HTTPClient, ProviderYotpo, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), yotpoDefaultAPIBaseURL)
	utoken, err := yotpoExchangeToken(ctx, client, baseURL, creds, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent))
	if err != nil {
		return SyncRequest{}, err
	}
	perPage := reviewPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("utoken", utoken)
	query.Set("count", strconv.Itoa(perPage))
	query.Set("page", strconv.Itoa(page))

	var out struct {
		Reviews []yotpoReview `json:"reviews"`
	}
	path := "/v1/apps/" + url.PathEscape(creds.AppKey) + "/reviews"
	if err := reviewDoJSON(ctx, client, baseURL, path, query, nil, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	reviewsOut := make([]ReviewInput, 0, len(out.Reviews))
	for _, rv := range out.Reviews {
		if mapped, ok := mapYotpoReview(rv); ok {
			reviewsOut = append(reviewsOut, mapped)
		}
	}
	nextCursor := yotpoCursorComplete
	if len(out.Reviews) >= perPage {
		nextCursor = yotpoCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Reviews: reviewsOut, Cursor: nextCursor}, nil
}

func yotpoExchangeToken(ctx context.Context, client *http.Client, baseURL string, creds YotpoCredentials, userAgent string) (string, error) {
	payload, _ := json.Marshal(map[string]string{"client_id": creds.AppKey, "client_secret": creds.Secret, "grant_type": "client_credentials"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/oauth/token", strings.NewReader(string(payload)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, reviewResponseMaxBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", ReviewRESTError{
			Operation:  "yotpo token exchange",
			StatusCode: resp.StatusCode,
			RetryAfter: parseReviewRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    reviewTruncate(string(body), 300),
		}
	}
	var raw struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return "", fmt.Errorf("decode yotpo token: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return "", fmt.Errorf("yotpo token response missing access_token")
	}
	return strings.TrimSpace(raw.AccessToken), nil
}

func mapYotpoReview(rv yotpoReview) (ReviewInput, bool) {
	email := strings.ToLower(strings.TrimSpace(rv.Email))
	if email == "" {
		return ReviewInput{}, false
	}
	out := ReviewInput{
		SourceID:      "yotpo://review/" + strconv.Itoa(rv.ID),
		ReviewerName:  strings.TrimSpace(rv.Name),
		ReviewerEmail: email,
		Rating:        rv.Score,
		Title:         strings.TrimSpace(rv.Title),
		Body:          strings.TrimSpace(rv.Content),
		ReviewType:    "product",
		Status:        "approved",
		VerifiedBuyer: rv.VerifiedBuyer,
		SubmittedAt:   parseReviewTime(rv.CreatedAt),
	}
	metadata := map[string]any{}
	if productID := strings.TrimSpace(rv.ProductID); productID != "" {
		metadata["provider_product_id"] = productID
	}
	if productID := strings.TrimSpace(rv.ExternalProductID); productID != "" {
		metadata["external_product_id"] = productID
	}
	if orderID := strings.TrimSpace(rv.OrderID); orderID != "" {
		metadata["provider_order_id"] = orderID
	}
	if orderID := strings.TrimSpace(rv.ExternalOrderID); orderID != "" {
		metadata["external_order_id"] = orderID
	}
	if customerID := strings.TrimSpace(rv.CustomerID); customerID != "" {
		metadata["provider_customer_id"] = customerID
	}
	if customerID := strings.TrimSpace(rv.ExternalCustomerID); customerID != "" {
		metadata["external_customer_id"] = customerID
	}
	if len(metadata) > 0 {
		out.Metadata = metadata
	}
	return out, true
}

// ---------------- shared ----------------

func reviewCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
}

func reviewDoJSON(ctx context.Context, client *http.Client, baseURL, path string, query url.Values, headers map[string]string, userAgent string, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse review API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, reviewResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return ReviewRESTError{
			Operation:  "review REST " + path,
			StatusCode: resp.StatusCode,
			RetryAfter: parseReviewRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    reviewTruncate(string(body), 300),
		}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode review response %s: %w", path, err)
	}
	return nil
}

func parseReviewRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds <= 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}
	when, err := http.ParseTime(value)
	if err != nil {
		return 0
	}
	delay := time.Until(when)
	if delay <= 0 {
		return 0
	}
	return delay
}

func reviewTruncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}
