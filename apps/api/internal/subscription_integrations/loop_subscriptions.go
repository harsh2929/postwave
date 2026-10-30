// SPDX-License-Identifier: AGPL-3.0-only
//
// loop_subscriptions.go — native Loop Subscriptions provider runtime.
//
// Loop is a Shopify-native subscription platform (direct Recharge/Skio rival).
// Mirrors the Recharge/Skio puller: a credential resolver (static API key sent
// as the X-Loop-Token header) + a REST puller over the Subscriptions API
// (page-number pagination + hasMore) + canonical SubscriptionInput mapping,
// dispatched via providerPull.
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
	loopDefaultAPIBaseURL = "https://api.loopsubscriptions.com"
	loopDefaultUserAgent  = "Moosewave Loop Integration"
	loopResponseMaxBytes  = 8 << 20
	loopDefaultPageSize   = 100
	loopMaxPageSize       = 250
	loopCursorPrefix      = "loop:"
	loopCursorComplete    = "loop:complete"
)

type LoopCredentials struct {
	APIKey     string
	APIBaseURL string
	UserAgent  string
}

type LoopCredentialResolver interface {
	ResolveLoop(ctx context.Context, tenantID string, integration Integration) (LoopCredentials, error)
}

type loopCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p loopCredentialPayload) credentials() (LoopCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return LoopCredentials{}, fmt.Errorf("loop api_key is required")
	}
	return LoopCredentials{APIKey: key, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type LoopSubscriptionsSecretsCredentialResolver struct {
	Secrets SubscriptionRuntimeSecretResolver
}

func (r LoopSubscriptionsSecretsCredentialResolver) ResolveLoop(ctx context.Context, _ string, integration Integration) (LoopCredentials, error) {
	if r.Secrets == nil {
		return LoopCredentials{}, fmt.Errorf("loop credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return LoopCredentials{}, fmt.Errorf("loop credentials_ref is required")
	}
	var payload loopCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withLoopBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return LoopCredentials{}, fmt.Errorf("resolve loop credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withLoopBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := loopCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return LoopCredentials{}, err
	}
	return withLoopBaseURL(creds, integration), nil
}

func withLoopBaseURL(creds LoopCredentials, integration Integration) LoopCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type LoopSubscriptionsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type LoopSubscriptionsRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials LoopCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type loopSubscription struct {
	// Loop returns numeric ids; productId may be a Shopify GID string — decode
	// both tolerantly so a single odd row never fails the whole page.
	ID            json.RawMessage `json:"id"`
	Email         string          `json:"email"`
	CustomerEmail string          `json:"customerEmail"`
	Customer      struct {
		Email string `json:"email"`
	} `json:"customer"`
	Status               string          `json:"status"`
	SKU                  string          `json:"sku"`
	ProductID            json.RawMessage `json:"productId"`
	ProductTitle         string          `json:"productTitle"`
	NextBillingDate      string          `json:"nextBillingDate"`
	NextBillingDateEpoch int64           `json:"nextBillingDateEpoch"`
	CancelledAt          string          `json:"cancelledAt"`
	UpdatedAt            string          `json:"updatedAt"`
}

// loopSubscriptionsResponse tolerates both Loop's current envelope
// ({data:[...], pageInfo:{hasNextPage}}) and the legacy ({subscriptions, hasMore}).
type loopSubscriptionsResponse struct {
	Data          []loopSubscription `json:"data"`
	Subscriptions []loopSubscription `json:"subscriptions"`
	PageInfo      struct {
		HasNextPage bool `json:"hasNextPage"`
	} `json:"pageInfo"`
	HasMore bool `json:"hasMore"`
}

func (r loopSubscriptionsResponse) rows() []loopSubscription {
	if len(r.Data) > 0 {
		return r.Data
	}
	return r.Subscriptions
}

func (r loopSubscriptionsResponse) hasMore() bool {
	return r.PageInfo.HasNextPage || r.HasMore
}

func (b LoopSubscriptionsRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderLoopSubscriptions {
		return SyncRequest{}, fmt.Errorf("loop backfill requires a Loop Subscriptions integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("loop credential resolver is not configured")
	}
	page, done := loopPageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: loopCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveLoop(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := subscriptionEgressClient(b.HTTPClient, ProviderLoopSubscriptions, 20*time.Second)
	perPage := loopPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), loopDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("pageNo", strconv.Itoa(page))
	query.Set("pageSize", strconv.Itoa(perPage))

	var out loopSubscriptionsResponse
	if err := loopDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/admin/2023-10/subscription", query, &out); err != nil {
		return SyncRequest{}, err
	}
	rows := out.rows()
	subs := make([]SubscriptionInput, 0, len(rows))
	for _, s := range rows {
		if sub, ok := mapLoopSubscription(s); ok {
			subs = append(subs, sub)
		}
	}
	nextCursor := loopCursorComplete
	if out.hasMore() && len(rows) > 0 {
		nextCursor = loopCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Subscriptions: subs, Cursor: nextCursor}, nil
}

func mapLoopSubscription(s loopSubscription) (SubscriptionInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(s.Email, s.CustomerEmail, s.Customer.Email)))
	if email == "" {
		return SubscriptionInput{}, false
	}
	id := loopJSONString(s.ID)
	out := SubscriptionInput{
		SourceID:       "loop-subscriptions://subscription/" + id,
		Email:          email,
		SubscriptionID: id,
		Status:         strings.TrimSpace(s.Status),
		ProductID:      strings.TrimSpace(firstString(loopJSONString(s.ProductID), s.ProductTitle)),
		SKU:            strings.TrimSpace(s.SKU),
		Properties:     map[string]any{"loop_subscription_id": id, "loop_product_title": s.ProductTitle},
	}
	if t := parseRechargeTime(s.NextBillingDate); t != nil {
		out.NextChargeAt = t
	} else if t := loopEpochTime(s.NextBillingDateEpoch); t != nil {
		out.NextChargeAt = t
	}
	if t := parseRechargeTime(s.CancelledAt); t != nil {
		out.CancelledAt = t
	}
	if t := parseRechargeTime(s.UpdatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func loopDoJSON(ctx context.Context, client *http.Client, baseURL string, creds LoopCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse loop API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Loop-Token", strings.TrimSpace(creds.APIKey))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, loopDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, loopResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("loop REST %s failed %d: %s", path, resp.StatusCode, rechargeTruncate(string(body), 500))
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode loop response %s: %w", path, err)
	}
	return nil
}

// loopJSONString reads a JSON id that may be a number (2241) or a string
// (Shopify GID) without failing the surrounding decode.
func loopJSONString(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return ""
	}
	if len(s) >= 2 && s[0] == '"' {
		var out string
		if err := json.Unmarshal(raw, &out); err == nil {
			return strings.TrimSpace(out)
		}
	}
	return s
}

// loopEpochTime converts a Loop epoch (seconds, or milliseconds when oversized)
// into a UTC time.
func loopEpochTime(epoch int64) *time.Time {
	if epoch <= 0 {
		return nil
	}
	if epoch > 1e12 {
		epoch /= 1000
	}
	t := time.Unix(epoch, 0).UTC()
	return &t
}

func loopPageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == loopCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, loopCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func loopPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return loopDefaultPageSize
	}
	if n > loopMaxPageSize {
		return loopMaxPageSize
	}
	return n
}
