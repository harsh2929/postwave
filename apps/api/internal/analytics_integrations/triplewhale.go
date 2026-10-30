// SPDX-License-Identifier: AGPL-3.0-only
//
// triplewhale.go — native Triple Whale outbound puller.
//
// Triple Whale is the dominant DTC attribution/BI hub for Shopify brands.
// Reads customers_table through the documented Data-Out SQL API, authenticated
// with x-api-key and an explicit shopId. Stable ordering and bounded LIMIT/OFFSET
// pages feed canonical profiles with spend/order traits. Customers are lifetime
// records, so the API period does not filter their creation dates.
package analytics_integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	tripleWhaleDefaultAPIBaseURL = "https://api.triplewhale.com"
	tripleWhaleDefaultEndpoint   = "/api/v2/orcabase/api/sql"
	tripleWhaleCursorPrefix      = "triplewhale:"
	tripleWhaleCursorComplete    = "triplewhale:complete"
	tripleWhaleDefaultLookback   = 365
)

type TripleWhaleCredentials struct {
	APIKey     string
	ShopID     string
	APIBaseURL string
	UserAgent  string
}

type TripleWhaleCredentialResolver interface {
	ResolveTripleWhale(ctx context.Context, tenantID string, integration Integration) (TripleWhaleCredentials, error)
}

type tripleWhaleCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	ShopID     string `json:"shop_id"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p tripleWhaleCredentialPayload) credentials() (TripleWhaleCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return TripleWhaleCredentials{}, fmt.Errorf("triple whale api_key is required")
	}
	return TripleWhaleCredentials{APIKey: key, ShopID: strings.TrimSpace(p.ShopID), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type TripleWhaleSecretsCredentialResolver struct {
	Secrets AnalyticsPullerSecretResolver
}

func (r TripleWhaleSecretsCredentialResolver) ResolveTripleWhale(ctx context.Context, _ string, integration Integration) (TripleWhaleCredentials, error) {
	if r.Secrets == nil {
		return TripleWhaleCredentials{}, fmt.Errorf("triple whale credential resolver is not configured")
	}
	ref := analyticsCredentialRef(integration)
	if ref == "" {
		return TripleWhaleCredentials{}, fmt.Errorf("triple whale credentials_ref is required")
	}
	var payload tripleWhaleCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withTripleWhaleBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return TripleWhaleCredentials{}, fmt.Errorf("resolve triple whale credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withTripleWhaleBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := tripleWhaleCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return TripleWhaleCredentials{}, err
	}
	return withTripleWhaleBaseURL(creds, integration), nil
}

func withTripleWhaleBaseURL(creds TripleWhaleCredentials, integration Integration) TripleWhaleCredentials {
	if creds.ShopID == "" {
		creds.ShopID = strings.TrimSpace(firstString(settingString(integration.Settings, "shop_id"), settingString(integration.Settings, "shop_domain")))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type TripleWhaleRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials TripleWhaleCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
	Now         func() time.Time
}

type tripleWhaleCustomer struct {
	Email       string      `json:"email"`
	FirstName   string      `json:"firstName"`
	LastName    string      `json:"lastName"`
	TotalSpent  json.Number `json:"totalSpent"`
	OrdersCount json.Number `json:"ordersCount"`
}

type tripleWhaleResponse struct {
	Customers   []tripleWhaleCustomer `json:"customers"`
	HasNextPage bool                  `json:"hasNextPage"`
}

func (b TripleWhaleRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderTripleWhale {
		return SyncRequest{}, fmt.Errorf("triple whale backfill requires a Triple Whale integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("triple whale credential resolver is not configured")
	}
	page, done := tripleWhalePageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: tripleWhaleCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveTripleWhale(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := analyticsEgressClient(b.HTTPClient, ProviderTripleWhale, 30*time.Second)
	start, end := b.window(integration)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), tripleWhaleDefaultAPIBaseURL)
	endpoint := firstString(settingString(integration.Settings, "endpoint"), tripleWhaleDefaultEndpoint)
	pageSize := analyticsPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	payload := map[string]any{
		"startDate": start,
		"endDate":   end,
		"page":      page,
		"limit":     pageSize,
	}
	sqlAPI := endpoint == tripleWhaleDefaultEndpoint
	if sqlAPI {
		if creds.ShopID == "" {
			return SyncRequest{}, fmt.Errorf("triple whale shop_id is required in the credential secret or shop_id settings")
		}
		configuredShopID := strings.TrimSpace(firstString(settingString(integration.Settings, "shop_id"), settingString(integration.Settings, "shop_domain")))
		if configuredShopID != "" && configuredShopID != creds.ShopID {
			return SyncRequest{}, fmt.Errorf("triple whale shop_id settings do not match the credential secret")
		}
		if page-1 > int(^uint(0)>>1)/pageSize {
			return SyncRequest{}, fmt.Errorf("triple whale page cursor exceeds the supported range")
		}
		payload = map[string]any{
			"shopId": creds.ShopID,
			"query":  fmt.Sprintf("SELECT email_address AS email, first_name AS firstName, last_name AS lastName, amount_spent AS totalSpent, orders AS ordersCount FROM customers_table ORDER BY email_address, customer_id, platform LIMIT %d OFFSET %d", pageSize, (page-1)*pageSize),
			"period": map[string]string{"startDate": start, "endDate": end},
		}
	}
	reqBody, _ := json.Marshal(payload)
	headers := map[string]string{"x-api-key": strings.TrimSpace(creds.APIKey)}

	var out tripleWhaleResponse
	var target any = &out
	if sqlAPI {
		target = &out.Customers
	}
	if err := analyticsDoJSON(ctx, client, http.MethodPost, strings.TrimRight(baseURL, "/")+endpoint, headers, bytes.NewReader(reqBody), firstString(b.UserAgent, creds.UserAgent, analyticsDefaultUserAgent), target); err != nil {
		return SyncRequest{}, err
	}
	if sqlAPI {
		out.HasNextPage = len(out.Customers) == pageSize
	}
	profiles := make([]ProfileInput, 0, len(out.Customers))
	for _, c := range out.Customers {
		if mapped, ok := mapTripleWhaleCustomer(c); ok {
			profiles = append(profiles, mapped)
		}
	}
	nextCursor := tripleWhaleCursorComplete
	if out.HasNextPage && len(out.Customers) > 0 {
		nextCursor = tripleWhaleCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Profiles: profiles, Cursor: nextCursor}, nil
}

func (b TripleWhaleRESTBackfiller) window(integration Integration) (string, string) {
	start := strings.TrimSpace(settingString(integration.Settings, "start_date"))
	end := strings.TrimSpace(settingString(integration.Settings, "end_date"))
	if start != "" && end != "" {
		return start, end
	}
	now := time.Now
	if b.Now != nil {
		now = b.Now
	}
	to := now().UTC()
	lookback := tripleWhaleDefaultLookback
	if n, _ := strconv.Atoi(strings.TrimSpace(settingString(integration.Settings, "lookback_days"))); n > 0 {
		lookback = n
	}
	from := to.AddDate(0, 0, -lookback)
	if start == "" {
		start = from.Format("2006-01-02")
	}
	if end == "" {
		end = to.Format("2006-01-02")
	}
	return start, end
}

func mapTripleWhaleCustomer(c tripleWhaleCustomer) (ProfileInput, bool) {
	email := strings.ToLower(strings.TrimSpace(c.Email))
	if email == "" {
		return ProfileInput{}, false
	}
	return ProfileInput{
		SourceID:  "triplewhale://customer/" + email,
		Email:     email,
		FirstName: strings.TrimSpace(c.FirstName),
		LastName:  strings.TrimSpace(c.LastName),
		Traits: map[string]any{
			"triplewhale_total_spent":  strings.TrimSpace(c.TotalSpent.String()),
			"triplewhale_orders_count": strings.TrimSpace(c.OrdersCount.String()),
		},
	}, true
}

func tripleWhalePageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == tripleWhaleCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, tripleWhaleCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}
