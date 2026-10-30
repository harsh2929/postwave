// SPDX-License-Identifier: AGPL-3.0-only
//
// appstle.go — native Appstle Subscriptions provider runtime.
//
// Appstle is a major Shopify subscription app. External API: X-API-Key header,
// base /api/external/v2. The backend is Spring, so the contracts list paginates
// Pageable-style ({content,last,totalPages,number}, 0-indexed page); we tolerate
// a top-level array too. Maps Shopify-style contract fields -> canonical
// SubscriptionInput via providerPull. (Endpoint path is overridable via the
// `endpoint` setting; live certification confirms it per store.)
package subscription_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	appstleDefaultAPIBaseURL = "https://subscription-admin.appstle.com"
	appstleDefaultEndpoint   = "/api/external/v2/subscription-contracts"
	appstleDefaultUserAgent  = "Moosewave Appstle Integration"
	appstleResponseMaxBytes  = 8 << 20
	appstleDefaultPageSize   = 50
	appstleMaxPageSize       = 200
	appstleCursorPrefix      = "appstle:"
	appstleCursorComplete    = "appstle:complete"
)

type AppstleCredentials struct {
	APIKey     string
	APIBaseURL string
	UserAgent  string
}

type AppstleCredentialResolver interface {
	ResolveAppstle(ctx context.Context, tenantID string, integration Integration) (AppstleCredentials, error)
}

type appstleCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p appstleCredentialPayload) credentials() (AppstleCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return AppstleCredentials{}, fmt.Errorf("appstle api_key is required")
	}
	return AppstleCredentials{APIKey: key, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type AppstleSecretsCredentialResolver struct {
	Secrets SubscriptionRuntimeSecretResolver
}

func (r AppstleSecretsCredentialResolver) ResolveAppstle(ctx context.Context, _ string, integration Integration) (AppstleCredentials, error) {
	if r.Secrets == nil {
		return AppstleCredentials{}, fmt.Errorf("appstle credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return AppstleCredentials{}, fmt.Errorf("appstle credentials_ref is required")
	}
	var payload appstleCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withAppstleBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return AppstleCredentials{}, fmt.Errorf("resolve appstle credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withAppstleBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := appstleCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return AppstleCredentials{}, err
	}
	return withAppstleBaseURL(creds, integration), nil
}

func withAppstleBaseURL(creds AppstleCredentials, integration Integration) AppstleCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type AppstleBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type AppstleRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials AppstleCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type appstleContract struct {
	ID              json.Number `json:"id"`
	Status          string      `json:"status"`
	CustomerEmail   string      `json:"customerEmail"`
	Email           string      `json:"email"`
	NextBillingDate string      `json:"nextBillingDate"`
	Customer        struct {
		Email string `json:"email"`
	} `json:"customer"`
}

func (b AppstleRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderAppstle {
		return SyncRequest{}, fmt.Errorf("appstle backfill requires an Appstle integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("appstle credential resolver is not configured")
	}
	page, done := appstlePageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: appstleCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveAppstle(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := subscriptionEgressClient(b.HTTPClient, ProviderAppstle, 20*time.Second)
	size := appstlePageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), appstleDefaultAPIBaseURL)
	endpoint := firstString(settingString(integration.Settings, "endpoint"), appstleDefaultEndpoint)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page)) // Spring Pageable is 0-indexed
	query.Set("size", strconv.Itoa(size))

	raw, err := appstleGet(ctx, client, baseURL, creds, b.UserAgent, endpoint, query)
	if err != nil {
		return SyncRequest{}, err
	}
	contracts, last, hasLast := decodeAppstleContracts(raw)
	subs := make([]SubscriptionInput, 0, len(contracts))
	for _, c := range contracts {
		if sub, ok := mapAppstleContract(c); ok {
			subs = append(subs, sub)
		}
	}
	nextCursor := appstleCursorComplete
	more := len(contracts) >= size
	if hasLast {
		more = !last && len(contracts) > 0
	}
	if more {
		nextCursor = appstleCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Subscriptions: subs, Cursor: nextCursor}, nil
}

// decodeAppstleContracts tolerates both the Spring {content,last} envelope and a
// bare top-level array.
func decodeAppstleContracts(raw []byte) (contracts []appstleContract, last bool, hasLast bool) {
	raw = []byte(strings.TrimSpace(string(raw)))
	if len(raw) == 0 {
		return nil, false, false
	}
	if raw[0] == '[' {
		_ = json.Unmarshal(raw, &contracts)
		return contracts, false, false
	}
	var wrapped struct {
		Content []appstleContract `json:"content"`
		Last    bool              `json:"last"`
	}
	if err := json.Unmarshal(raw, &wrapped); err == nil {
		return wrapped.Content, wrapped.Last, true
	}
	return nil, false, false
}

func mapAppstleContract(c appstleContract) (SubscriptionInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(c.CustomerEmail, c.Email, c.Customer.Email)))
	if email == "" {
		return SubscriptionInput{}, false
	}
	id := strings.TrimSpace(c.ID.String())
	out := SubscriptionInput{
		SourceID:       "appstle://subscription/" + id,
		Email:          email,
		SubscriptionID: id,
		Status:         strings.TrimSpace(c.Status),
		Properties:     map[string]any{"appstle_subscription_id": id},
	}
	if t := parseRechargeTime(c.NextBillingDate); t != nil {
		out.NextChargeAt = t
	}
	return out, true
}

func appstleGet(ctx context.Context, client *http.Client, baseURL string, creds AppstleCredentials, userAgent, path string, query url.Values) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("parse appstle API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-Key", strings.TrimSpace(creds.APIKey))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, appstleDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, appstleResponseMaxBytes))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("appstle REST %s failed %d: %s", path, resp.StatusCode, rechargeTruncate(string(body), 500))
	}
	return body, nil
}

func appstlePageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == appstleCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, appstleCursorPrefix))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, false
}

func appstlePageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return appstleDefaultPageSize
	}
	if n > appstleMaxPageSize {
		return appstleMaxPageSize
	}
	return n
}
