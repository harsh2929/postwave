// SPDX-License-Identifier: AGPL-3.0-only
//
// seal_subscriptions.go — native Seal Subscriptions provider runtime.
//
// Seal is a popular Shopify subscription app. Merchant API: X-Seal-Token header,
// GET /subscriptions paginated 50/page via the `page` param. Maps to canonical
// SubscriptionInput dispatched via providerPull. Responses are tolerant of both
// the {success,payload:{subscriptions}} envelope and a flat {subscriptions} body.
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
	sealDefaultAPIBaseURL = "https://app.sealsubscriptions.com/shopify/merchant/api"
	sealDefaultUserAgent  = "Moosewave Seal Subscriptions Integration"
	sealResponseMaxBytes  = 8 << 20
	sealDefaultPageSize   = 50
	sealCursorPrefix      = "seal:"
	sealCursorComplete    = "seal:complete"
)

type SealCredentials struct {
	Token      string
	APIBaseURL string
	UserAgent  string
}

type SealCredentialResolver interface {
	ResolveSeal(ctx context.Context, tenantID string, integration Integration) (SealCredentials, error)
}

type sealCredentialPayload struct {
	Token      string `json:"token"`
	APIToken   string `json:"api_token"`
	APIKey     string `json:"api_key"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p sealCredentialPayload) credentials() (SealCredentials, error) {
	token := strings.TrimSpace(firstString(p.Token, p.APIToken, p.APIKey))
	if token == "" {
		return SealCredentials{}, fmt.Errorf("seal subscriptions token is required")
	}
	return SealCredentials{Token: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type SealSecretsCredentialResolver struct {
	Secrets SubscriptionRuntimeSecretResolver
}

func (r SealSecretsCredentialResolver) ResolveSeal(ctx context.Context, _ string, integration Integration) (SealCredentials, error) {
	if r.Secrets == nil {
		return SealCredentials{}, fmt.Errorf("seal credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return SealCredentials{}, fmt.Errorf("seal credentials_ref is required")
	}
	var payload sealCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withSealBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return SealCredentials{}, fmt.Errorf("resolve seal credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withSealBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := sealCredentialPayload{Token: raw}.credentials()
	if err != nil {
		return SealCredentials{}, err
	}
	return withSealBaseURL(creds, integration), nil
}

func withSealBaseURL(creds SealCredentials, integration Integration) SealCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type SealBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type SealRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials SealCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type sealSubscription struct {
	ID              json.Number `json:"id"`
	Email           string      `json:"email"`
	Status          string      `json:"status"`
	NextBillingDate string      `json:"next_billing_date"`
	OrderPlaced     string      `json:"order_placed"`
	ShopifyCustomer json.Number `json:"shopify_customer_id"`
}

type sealResponse struct {
	Subscriptions []sealSubscription `json:"subscriptions"`
	Payload       struct {
		Subscriptions []sealSubscription `json:"subscriptions"`
	} `json:"payload"`
}

func (b SealRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderSealSubscriptions {
		return SyncRequest{}, fmt.Errorf("seal backfill requires a Seal Subscriptions integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("seal credential resolver is not configured")
	}
	page, done := sealPageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: sealCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveSeal(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := subscriptionEgressClient(b.HTTPClient, ProviderSealSubscriptions, 20*time.Second)
	perPage := sealPageSize(strconv.Itoa(b.PageSize))
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), sealDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))

	var out sealResponse
	if err := sealDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/subscriptions", query, &out); err != nil {
		return SyncRequest{}, err
	}
	rows := out.Subscriptions
	if len(rows) == 0 {
		rows = out.Payload.Subscriptions
	}
	subs := make([]SubscriptionInput, 0, len(rows))
	for _, s := range rows {
		if sub, ok := mapSealSubscription(s); ok {
			subs = append(subs, sub)
		}
	}
	nextCursor := sealCursorComplete
	if len(rows) >= perPage {
		nextCursor = sealCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Subscriptions: subs, Cursor: nextCursor}, nil
}

func mapSealSubscription(s sealSubscription) (SubscriptionInput, bool) {
	email := strings.ToLower(strings.TrimSpace(s.Email))
	if email == "" {
		return SubscriptionInput{}, false
	}
	id := strings.TrimSpace(s.ID.String())
	out := SubscriptionInput{
		SourceID:       "seal-subscriptions://subscription/" + id,
		Email:          email,
		CustomerID:     strings.TrimSpace(s.ShopifyCustomer.String()),
		SubscriptionID: id,
		Status:         strings.TrimSpace(s.Status),
		Properties:     map[string]any{"seal_subscription_id": id},
	}
	if t := parseRechargeTime(s.NextBillingDate); t != nil {
		out.NextChargeAt = t
	}
	if t := parseRechargeTime(s.OrderPlaced); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func sealDoJSON(ctx context.Context, client *http.Client, baseURL string, creds SealCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse seal API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Seal-Token", strings.TrimSpace(creds.Token))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, sealDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, sealResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("seal REST %s failed %d: %s", path, resp.StatusCode, rechargeTruncate(string(body), 500))
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode seal response %s: %w", path, err)
	}
	return nil
}

func sealPageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == sealCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, sealCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func sealPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return sealDefaultPageSize
	}
	if n > sealDefaultPageSize {
		return sealDefaultPageSize
	}
	return n
}
