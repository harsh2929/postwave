// SPDX-License-Identifier: AGPL-3.0-only
//
// bold_subscriptions.go — native Bold Subscriptions provider runtime.
//
// Bold Subscriptions v1/v2. Token-supplied Bearer auth + Bold-API-Version-Date
// header, GET /subscriptions/v1/shops/{shop}/subscriptions?expand=customer with
// page/per_page paging. The customer email is side-loaded inline via
// expand=customer. Maps to canonical SubscriptionInput via providerPull;
// tolerant of both {data:{subscriptions}} and flat {subscriptions} envelopes.
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
	boldDefaultAPIBaseURL = "https://api.boldcommerce.com"
	boldDefaultUserAgent  = "Moosewave Bold Subscriptions Integration"
	boldDefaultAPIVersion = "2024-04-01"
	boldResponseMaxBytes  = 8 << 20
	boldDefaultPageSize   = 100
	boldMaxPageSize       = 250
	boldCursorPrefix      = "bold:"
	boldCursorComplete    = "bold:complete"
)

type BoldCredentials struct {
	AccessToken    string
	ShopIdentifier string
	APIVersion     string
	APIBaseURL     string
	UserAgent      string
}

type BoldCredentialResolver interface {
	ResolveBold(ctx context.Context, tenantID string, integration Integration) (BoldCredentials, error)
}

type boldCredentialPayload struct {
	AccessToken    string `json:"access_token"`
	Token          string `json:"token"`
	APIKey         string `json:"api_key"`
	ShopIdentifier string `json:"shop_identifier"`
	APIVersion     string `json:"api_version_date"`
	APIBaseURL     string `json:"api_base_url"`
	UserAgent      string `json:"user_agent"`
}

func (p boldCredentialPayload) credentials() (BoldCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.Token, p.APIKey))
	if token == "" {
		return BoldCredentials{}, fmt.Errorf("bold subscriptions access_token is required")
	}
	return BoldCredentials{AccessToken: token, ShopIdentifier: strings.TrimSpace(p.ShopIdentifier), APIVersion: strings.TrimSpace(p.APIVersion), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type BoldSecretsCredentialResolver struct {
	Secrets SubscriptionRuntimeSecretResolver
}

func (r BoldSecretsCredentialResolver) ResolveBold(ctx context.Context, _ string, integration Integration) (BoldCredentials, error) {
	if r.Secrets == nil {
		return BoldCredentials{}, fmt.Errorf("bold credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return BoldCredentials{}, fmt.Errorf("bold credentials_ref is required")
	}
	var payload boldCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withBoldDefaults(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return BoldCredentials{}, fmt.Errorf("resolve bold credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withBoldDefaults(creds, integration), nil
			}
		}
	}
	return BoldCredentials{}, fmt.Errorf("bold requires a JSON {access_token, shop_identifier} secret")
}

func withBoldDefaults(creds BoldCredentials, integration Integration) BoldCredentials {
	if creds.ShopIdentifier == "" {
		creds.ShopIdentifier = strings.TrimSpace(firstString(settingString(integration.Settings, "shop_identifier"), settingString(integration.Settings, "shop")))
	}
	if creds.APIVersion == "" {
		creds.APIVersion = strings.TrimSpace(settingString(integration.Settings, "api_version_date"))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type BoldBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type BoldRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials BoldCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type boldSubscription struct {
	ID                string `json:"id"`
	Status            string `json:"status"`
	NextOrderDatetime string `json:"next_order_datetime"`
	Customer          struct {
		Email     string `json:"email"`
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
	} `json:"customer"`
}

type boldResponse struct {
	Subscriptions []boldSubscription `json:"subscriptions"`
	Data          struct {
		Subscriptions []boldSubscription `json:"subscriptions"`
	} `json:"data"`
	Meta struct {
		Pagination struct {
			TotalPages  int `json:"total_pages"`
			CurrentPage int `json:"current_page"`
		} `json:"pagination"`
	} `json:"meta"`
}

func (b BoldRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderBoldSubscriptions {
		return SyncRequest{}, fmt.Errorf("bold backfill requires a Bold Subscriptions integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("bold credential resolver is not configured")
	}
	page, done := boldPageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: boldCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveBold(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if creds.ShopIdentifier == "" {
		return SyncRequest{}, fmt.Errorf("bold shop_identifier is required")
	}
	client := subscriptionEgressClient(b.HTTPClient, ProviderBoldSubscriptions, 20*time.Second)
	perPage := boldPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), boldDefaultAPIBaseURL)
	path := "/subscriptions/v1/shops/" + url.PathEscape(creds.ShopIdentifier) + "/subscriptions"
	query := url.Values{}
	query.Set("expand", "customer")
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(perPage))

	var out boldResponse
	if err := boldDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, query, &out); err != nil {
		return SyncRequest{}, err
	}
	rows := out.Data.Subscriptions
	if len(rows) == 0 {
		rows = out.Subscriptions
	}
	subs := make([]SubscriptionInput, 0, len(rows))
	for _, s := range rows {
		if sub, ok := mapBoldSubscription(s); ok {
			subs = append(subs, sub)
		}
	}
	nextCursor := boldCursorComplete
	if out.Meta.Pagination.TotalPages > page && len(rows) > 0 {
		nextCursor = boldCursorPrefix + strconv.Itoa(page+1)
	} else if out.Meta.Pagination.TotalPages == 0 && len(rows) >= perPage {
		nextCursor = boldCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Subscriptions: subs, Cursor: nextCursor}, nil
}

func mapBoldSubscription(s boldSubscription) (SubscriptionInput, bool) {
	email := strings.ToLower(strings.TrimSpace(s.Customer.Email))
	if email == "" {
		return SubscriptionInput{}, false
	}
	id := strings.TrimSpace(s.ID)
	out := SubscriptionInput{
		SourceID:       "bold-subscriptions://subscription/" + id,
		Email:          email,
		SubscriptionID: id,
		Status:         strings.TrimSpace(s.Status),
		Properties:     map[string]any{"bold_subscription_id": id},
	}
	if t := parseRechargeTime(s.NextOrderDatetime); t != nil {
		out.NextChargeAt = t
	}
	return out, true
}

func boldDoJSON(ctx context.Context, client *http.Client, baseURL string, creds BoldCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse bold API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Bold-API-Version-Date", firstString(creds.APIVersion, boldDefaultAPIVersion))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, boldDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, boldResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("bold REST %s failed %d: %s", path, resp.StatusCode, rechargeTruncate(string(body), 500))
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode bold response %s: %w", path, err)
	}
	return nil
}

func boldPageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == boldCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, boldCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func boldPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return boldDefaultPageSize
	}
	if n > boldMaxPageSize {
		return boldMaxPageSize
	}
	return n
}
