// SPDX-License-Identifier: AGPL-3.0-only
//
// reviews_more.go — native Okendo + Loox + Trustpilot review provider pullers.
//
// Three more REST pullers on the review_integrations foundation, mirroring the
// Yotpo/Judge.me pattern (credential resolver + REST puller + canonical
// ReviewInput mapping dispatched via Deps.providerPull). Okendo and Loox are
// top Shopify review apps (verified-buyer product reviews); Trustpilot is
// brand-wide service reviews whose consumer email is not exposed — those land
// as emailless reviews (still imported; profile/event linking is skipped).
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
	okendoDefaultAPIBaseURL     = "https://api.okendo.io"
	looxDefaultAPIBaseURL       = "https://loox.io"
	trustpilotDefaultAPIBaseURL = "https://api.trustpilot.com"
)

// ---------------- Okendo ----------------

const (
	okendoCursorPrefix   = "okendo:"
	okendoCursorComplete = "okendo:complete"
)

type OkendoCredentials struct {
	APIKey     string
	StoreID    string
	APIBaseURL string
	UserAgent  string
}

type OkendoCredentialResolver interface {
	ResolveOkendo(ctx context.Context, tenantID string, integration Integration) (OkendoCredentials, error)
}

type okendoCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	StoreID    string `json:"store_id"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p okendoCredentialPayload) credentials() (OkendoCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return OkendoCredentials{}, fmt.Errorf("okendo api_key is required")
	}
	return OkendoCredentials{APIKey: key, StoreID: strings.TrimSpace(p.StoreID), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type OkendoSecretsCredentialResolver struct {
	Secrets ReviewRuntimeSecretResolver
}

func (r OkendoSecretsCredentialResolver) ResolveOkendo(ctx context.Context, _ string, integration Integration) (OkendoCredentials, error) {
	if r.Secrets == nil {
		return OkendoCredentials{}, fmt.Errorf("okendo credential resolver is not configured")
	}
	ref := reviewCredentialRef(integration)
	if ref == "" {
		return OkendoCredentials{}, fmt.Errorf("okendo credentials_ref is required")
	}
	var payload okendoCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withOkendoStore(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return OkendoCredentials{}, fmt.Errorf("resolve okendo credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withOkendoStore(creds, integration), nil
			}
		}
	}
	creds, err := okendoCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return OkendoCredentials{}, err
	}
	return withOkendoStore(creds, integration), nil
}

func withOkendoStore(creds OkendoCredentials, integration Integration) OkendoCredentials {
	if creds.StoreID == "" {
		creds.StoreID = firstString(settingString(integration.Settings, "store_id"), settingString(integration.Settings, "subscriber_id"))
	}
	return creds
}

type OkendoRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials OkendoCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type okendoReview struct {
	ReviewID         string `json:"reviewId"`
	Rating           int    `json:"rating"`
	Title            string `json:"title"`
	Body             string `json:"body"`
	ProductID        string `json:"productId"`
	VerifiedPurchase bool   `json:"verifiedPurchase"`
	Reviewer         struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"reviewer"`
}

func (b OkendoRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderOkendo {
		return SyncRequest{}, fmt.Errorf("okendo backfill requires an Okendo integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("okendo credential resolver is not configured")
	}
	state := decodeOpaqueCursor(cursor, okendoCursorPrefix, okendoCursorComplete)
	if state == okendoCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: okendoCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveOkendo(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if creds.StoreID == "" {
		return SyncRequest{}, fmt.Errorf("okendo store_id is required")
	}
	client := reviewHTTPClient(b.HTTPClient, ProviderOkendo)
	perPage := reviewPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("limit", strconv.Itoa(perPage))
	if state != "" {
		query.Set("cursor", state)
	}
	headers := map[string]string{"x-api-key": creds.APIKey}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), okendoDefaultAPIBaseURL)

	var out struct {
		Reviews    []okendoReview `json:"reviews"`
		NextCursor string         `json:"nextCursor"`
	}
	path := "/v1/stores/" + url.PathEscape(creds.StoreID) + "/reviews"
	if err := reviewDoJSON(ctx, client, baseURL, path, query, headers, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	reviewsOut := make([]ReviewInput, 0, len(out.Reviews))
	for _, rv := range out.Reviews {
		if mapped, ok := mapOkendoReview(rv); ok {
			reviewsOut = append(reviewsOut, mapped)
		}
	}
	nextCursor := okendoCursorComplete
	if strings.TrimSpace(out.NextCursor) != "" {
		nextCursor = okendoCursorPrefix + strings.TrimSpace(out.NextCursor)
	}
	return SyncRequest{RunMode: "backfill", Reviews: reviewsOut, Cursor: nextCursor}, nil
}

func mapOkendoReview(rv okendoReview) (ReviewInput, bool) {
	if rv.Rating < 1 || rv.Rating > 5 {
		return ReviewInput{}, false
	}
	if strings.TrimSpace(rv.Title) == "" && strings.TrimSpace(rv.Body) == "" {
		return ReviewInput{}, false
	}
	return ReviewInput{
		SourceID:      "okendo://review/" + strings.TrimSpace(rv.ReviewID),
		ProductID:     strings.TrimSpace(rv.ProductID),
		ReviewerName:  strings.TrimSpace(rv.Reviewer.Name),
		ReviewerEmail: strings.ToLower(strings.TrimSpace(rv.Reviewer.Email)),
		Rating:        rv.Rating,
		Title:         strings.TrimSpace(rv.Title),
		Body:          strings.TrimSpace(rv.Body),
		ReviewType:    "product",
		Status:        "approved",
		VerifiedBuyer: rv.VerifiedPurchase,
	}, true
}

// ---------------- Loox ----------------

const (
	looxCursorPrefix   = "loox:"
	looxCursorComplete = "loox:complete"
)

type LooxCredentials struct {
	APIKey     string
	APIBaseURL string
	UserAgent  string
}

type LooxCredentialResolver interface {
	ResolveLoox(ctx context.Context, tenantID string, integration Integration) (LooxCredentials, error)
}

type looxCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p looxCredentialPayload) credentials() (LooxCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return LooxCredentials{}, fmt.Errorf("loox api_key is required")
	}
	return LooxCredentials{APIKey: key, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type LooxSecretsCredentialResolver struct {
	Secrets ReviewRuntimeSecretResolver
}

func (r LooxSecretsCredentialResolver) ResolveLoox(ctx context.Context, _ string, integration Integration) (LooxCredentials, error) {
	if r.Secrets == nil {
		return LooxCredentials{}, fmt.Errorf("loox credential resolver is not configured")
	}
	ref := reviewCredentialRef(integration)
	if ref == "" {
		return LooxCredentials{}, fmt.Errorf("loox credentials_ref is required")
	}
	var payload looxCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return LooxCredentials{}, fmt.Errorf("resolve loox credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return looxCredentialPayload{APIKey: raw}.credentials()
}

type LooxRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials LooxCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type looxReview struct {
	ID        json.Number `json:"id"`
	Rating    int         `json:"rating"`
	Title     string      `json:"title"`
	Content   string      `json:"content"`
	Name      string      `json:"name"`
	Email     string      `json:"email"`
	ProductID string      `json:"product_id"`
	Verified  bool        `json:"verified"`
}

func (b LooxRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderLoox {
		return SyncRequest{}, fmt.Errorf("loox backfill requires a Loox integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("loox credential resolver is not configured")
	}
	page, done := reviewPageCursor(cursor, looxCursorPrefix, looxCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: looxCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveLoox(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := reviewHTTPClient(b.HTTPClient, ProviderLoox)
	perPage := reviewPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("limit", strconv.Itoa(perPage))
	query.Set("page", strconv.Itoa(page))
	headers := map[string]string{"apikey": creds.APIKey}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), looxDefaultAPIBaseURL)

	var out struct {
		Reviews []looxReview `json:"reviews"`
	}
	if err := reviewDoJSON(ctx, client, baseURL, "/api/v1/reviews", query, headers, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	reviewsOut := make([]ReviewInput, 0, len(out.Reviews))
	for _, rv := range out.Reviews {
		if mapped, ok := mapLooxReview(rv); ok {
			reviewsOut = append(reviewsOut, mapped)
		}
	}
	nextCursor := looxCursorComplete
	if len(out.Reviews) >= perPage {
		nextCursor = looxCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Reviews: reviewsOut, Cursor: nextCursor}, nil
}

func mapLooxReview(rv looxReview) (ReviewInput, bool) {
	if rv.Rating < 1 || rv.Rating > 5 {
		return ReviewInput{}, false
	}
	if strings.TrimSpace(rv.Title) == "" && strings.TrimSpace(rv.Content) == "" {
		return ReviewInput{}, false
	}
	return ReviewInput{
		SourceID:      "loox://review/" + strings.TrimSpace(rv.ID.String()),
		ProductID:     strings.TrimSpace(rv.ProductID),
		ReviewerName:  strings.TrimSpace(rv.Name),
		ReviewerEmail: strings.ToLower(strings.TrimSpace(rv.Email)),
		Rating:        rv.Rating,
		Title:         strings.TrimSpace(rv.Title),
		Body:          strings.TrimSpace(rv.Content),
		ReviewType:    "product",
		Status:        "approved",
		VerifiedBuyer: rv.Verified,
	}, true
}

// ---------------- Trustpilot ----------------

const (
	trustpilotCursorPrefix   = "trustpilot:"
	trustpilotCursorComplete = "trustpilot:complete"
)

type TrustpilotCredentials struct {
	APIKey         string
	BusinessUnitID string
	APIBaseURL     string
	UserAgent      string
}

type TrustpilotCredentialResolver interface {
	ResolveTrustpilot(ctx context.Context, tenantID string, integration Integration) (TrustpilotCredentials, error)
}

type trustpilotCredentialPayload struct {
	APIKey         string `json:"api_key"`
	Token          string `json:"token"`
	BusinessUnitID string `json:"business_unit_id"`
	APIBaseURL     string `json:"api_base_url"`
	UserAgent      string `json:"user_agent"`
}

func (p trustpilotCredentialPayload) credentials() (TrustpilotCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return TrustpilotCredentials{}, fmt.Errorf("trustpilot api_key is required")
	}
	return TrustpilotCredentials{APIKey: key, BusinessUnitID: strings.TrimSpace(p.BusinessUnitID), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type TrustpilotSecretsCredentialResolver struct {
	Secrets ReviewRuntimeSecretResolver
}

func (r TrustpilotSecretsCredentialResolver) ResolveTrustpilot(ctx context.Context, _ string, integration Integration) (TrustpilotCredentials, error) {
	if r.Secrets == nil {
		return TrustpilotCredentials{}, fmt.Errorf("trustpilot credential resolver is not configured")
	}
	ref := reviewCredentialRef(integration)
	if ref == "" {
		return TrustpilotCredentials{}, fmt.Errorf("trustpilot credentials_ref is required")
	}
	var payload trustpilotCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withTrustpilotBusinessUnit(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return TrustpilotCredentials{}, fmt.Errorf("resolve trustpilot credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withTrustpilotBusinessUnit(creds, integration), nil
			}
		}
	}
	creds, err := trustpilotCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return TrustpilotCredentials{}, err
	}
	return withTrustpilotBusinessUnit(creds, integration), nil
}

func withTrustpilotBusinessUnit(creds TrustpilotCredentials, integration Integration) TrustpilotCredentials {
	if creds.BusinessUnitID == "" {
		creds.BusinessUnitID = settingString(integration.Settings, "business_unit_id")
	}
	return creds
}

type TrustpilotRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials TrustpilotCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type trustpilotReview struct {
	ID       string `json:"id"`
	Stars    int    `json:"stars"`
	Title    string `json:"title"`
	Text     string `json:"text"`
	Consumer struct {
		DisplayName string `json:"displayName"`
		Email       string `json:"email"`
	} `json:"consumer"`
	CreatedAt string `json:"createdAt"`
}

func (b TrustpilotRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderTrustpilot {
		return SyncRequest{}, fmt.Errorf("trustpilot backfill requires a Trustpilot integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("trustpilot credential resolver is not configured")
	}
	page, done := reviewPageCursor(cursor, trustpilotCursorPrefix, trustpilotCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: trustpilotCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveTrustpilot(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if creds.BusinessUnitID == "" {
		return SyncRequest{}, fmt.Errorf("trustpilot business_unit_id is required")
	}
	client := reviewHTTPClient(b.HTTPClient, ProviderTrustpilot)
	perPage := reviewPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("perPage", strconv.Itoa(perPage))
	query.Set("page", strconv.Itoa(page))
	headers := map[string]string{"apikey": creds.APIKey}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), trustpilotDefaultAPIBaseURL)

	var out struct {
		Reviews []trustpilotReview `json:"reviews"`
	}
	path := "/v1/private/business-units/" + url.PathEscape(creds.BusinessUnitID) + "/reviews"
	if err := reviewDoJSON(ctx, client, baseURL, path, query, headers, firstString(b.UserAgent, creds.UserAgent, reviewDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	reviewsOut := make([]ReviewInput, 0, len(out.Reviews))
	for _, rv := range out.Reviews {
		if mapped, ok := mapTrustpilotReview(rv); ok {
			reviewsOut = append(reviewsOut, mapped)
		}
	}
	nextCursor := trustpilotCursorComplete
	if len(out.Reviews) >= perPage {
		nextCursor = trustpilotCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Reviews: reviewsOut, Cursor: nextCursor}, nil
}

func mapTrustpilotReview(rv trustpilotReview) (ReviewInput, bool) {
	if rv.Stars < 1 || rv.Stars > 5 {
		return ReviewInput{}, false
	}
	if strings.TrimSpace(rv.Title) == "" && strings.TrimSpace(rv.Text) == "" {
		return ReviewInput{}, false
	}
	out := ReviewInput{
		// Trustpilot business reviews are service-level; the consumer email is
		// not exposed by the API, so these import as emailless reviews (UGC) and
		// the sync skips profile/event linking for them.
		SourceID:      "trustpilot://review/" + strings.TrimSpace(rv.ID),
		ReviewerName:  strings.TrimSpace(rv.Consumer.DisplayName),
		ReviewerEmail: strings.ToLower(strings.TrimSpace(rv.Consumer.Email)),
		Rating:        rv.Stars,
		Title:         strings.TrimSpace(rv.Title),
		Body:          strings.TrimSpace(rv.Text),
		ReviewType:    "store",
		Status:        "approved",
	}
	if t := parseReviewTime(rv.CreatedAt); t != nil {
		out.SubmittedAt = t
	}
	return out, true
}

// ---------------- shared ----------------

func decodeOpaqueCursor(cursor, prefix, complete string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return ""
	}
	if cursor == complete {
		return complete
	}
	return strings.TrimPrefix(cursor, prefix)
}

func reviewHTTPClient(c *http.Client, provider string) *http.Client {
	return reviewEgressClient(c, provider, 30*time.Second)
}
