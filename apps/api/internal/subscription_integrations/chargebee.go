// SPDX-License-Identifier: AGPL-3.0-only
//
// chargebee.go — native Chargebee provider runtime.
//
// Chargebee is a mature recurring-billing platform; subscription lifecycle
// (renewal, dunning, cancellation) powers retention flows. Mirrors the Recharge
// puller: a credential resolver (site API key, HTTP Basic with key as username)
// + a REST puller over the Subscriptions API (offset-token pagination, customer
// email side-loaded on each list row) + canonical SubscriptionInput mapping,
// dispatched via providerPull.
package subscription_integrations

import (
	"context"
	"encoding/base64"
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
	chargebeeDefaultUserAgent = "Moosewave Chargebee Integration"
	chargebeeResponseMaxBytes = 8 << 20
	chargebeeDefaultPageSize  = 100
	chargebeeMaxPageSize      = 100
	chargebeeCursorPrefix     = "chargebee:"
	chargebeeCursorComplete   = "chargebee:complete"
)

type ChargebeeCredentials struct {
	APIKey     string
	Site       string
	APIBaseURL string
	UserAgent  string
}

type ChargebeeCredentialResolver interface {
	ResolveChargebee(ctx context.Context, tenantID string, integration Integration) (ChargebeeCredentials, error)
}

type chargebeeCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	Site       string `json:"site"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p chargebeeCredentialPayload) credentials() (ChargebeeCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return ChargebeeCredentials{}, fmt.Errorf("chargebee api_key is required")
	}
	return ChargebeeCredentials{APIKey: key, Site: strings.TrimSpace(p.Site), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type ChargebeeSecretsCredentialResolver struct {
	Secrets SubscriptionRuntimeSecretResolver
}

func (r ChargebeeSecretsCredentialResolver) ResolveChargebee(ctx context.Context, _ string, integration Integration) (ChargebeeCredentials, error) {
	if r.Secrets == nil {
		return ChargebeeCredentials{}, fmt.Errorf("chargebee credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return ChargebeeCredentials{}, fmt.Errorf("chargebee credentials_ref is required")
	}
	var payload chargebeeCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withChargebeeSite(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ChargebeeCredentials{}, fmt.Errorf("resolve chargebee credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withChargebeeSite(creds, integration), nil
			}
		}
	}
	creds, err := chargebeeCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return ChargebeeCredentials{}, err
	}
	return withChargebeeSite(creds, integration), nil
}

func withChargebeeSite(creds ChargebeeCredentials, integration Integration) ChargebeeCredentials {
	if creds.Site == "" {
		creds.Site = strings.TrimSpace(firstString(
			settingString(integration.Settings, "site_id"),
			settingString(integration.Settings, "site"),
		))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type ChargebeeBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type ChargebeeRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials ChargebeeCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type chargebeeListItem struct {
	Subscription struct {
		ID                string      `json:"id"`
		CustomerID        string      `json:"customer_id"`
		Status            string      `json:"status"`
		PlanID            string      `json:"plan_id"`
		BillingPeriod     json.Number `json:"billing_period"`
		BillingPeriodUnit string      `json:"billing_period_unit"`
		NextBillingAt     json.Number `json:"next_billing_at"`
		CancelledAt       json.Number `json:"cancelled_at"`
		UpdatedAt         json.Number `json:"updated_at"`
	} `json:"subscription"`
	Customer struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	} `json:"customer"`
}

type chargebeeListResponse struct {
	List       []chargebeeListItem `json:"list"`
	NextOffset string              `json:"next_offset"`
}

func (b ChargebeeRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderChargebee {
		return SyncRequest{}, fmt.Errorf("chargebee backfill requires a Chargebee integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("chargebee credential resolver is not configured")
	}
	offset := decodeChargebeeCursor(cursor)
	if offset == chargebeeCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: chargebeeCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveChargebee(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := chargebeeBaseURL(b.APIBaseURL, creds)
	if err != nil {
		return SyncRequest{}, err
	}
	client := subscriptionEgressClient(b.HTTPClient, ProviderChargebee, 20*time.Second)
	query := url.Values{}
	query.Set("limit", strconv.Itoa(chargebeePageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	query.Set("sort_by[asc]", "updated_at")
	if offset != "" {
		query.Set("offset", offset)
	}

	var out chargebeeListResponse
	if err := chargebeeDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v2/subscriptions", query, &out); err != nil {
		return SyncRequest{}, err
	}
	subs := make([]SubscriptionInput, 0, len(out.List))
	for _, item := range out.List {
		if sub, ok := mapChargebeeItem(item); ok {
			subs = append(subs, sub)
		}
	}
	nextCursor := chargebeeCursorComplete
	if strings.TrimSpace(out.NextOffset) != "" {
		nextCursor = chargebeeCursorPrefix + strings.TrimSpace(out.NextOffset)
	}
	return SyncRequest{RunMode: "backfill", Subscriptions: subs, Cursor: nextCursor}, nil
}

func mapChargebeeItem(item chargebeeListItem) (SubscriptionInput, bool) {
	email := strings.ToLower(strings.TrimSpace(item.Customer.Email))
	if email == "" {
		return SubscriptionInput{}, false
	}
	s := item.Subscription
	id := strings.TrimSpace(s.ID)
	freq := strings.TrimSpace(strings.TrimSpace(s.BillingPeriod.String() + " " + s.BillingPeriodUnit))
	out := SubscriptionInput{
		SourceID:       "chargebee://subscription/" + id,
		Email:          email,
		CustomerID:     strings.TrimSpace(firstString(s.CustomerID, item.Customer.ID)),
		SubscriptionID: id,
		Status:         strings.TrimSpace(s.Status),
		ProductID:      strings.TrimSpace(s.PlanID),
		Frequency:      freq,
		Properties:     map[string]any{"chargebee_subscription_id": id},
	}
	if t := chargebeeEpoch(s.NextBillingAt); t != nil {
		out.NextChargeAt = t
	}
	if t := chargebeeEpoch(s.CancelledAt); t != nil {
		out.CancelledAt = t
	}
	if t := chargebeeEpoch(s.UpdatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func chargebeeBaseURL(override string, creds ChargebeeCredentials) (string, error) {
	if v := strings.TrimRight(strings.TrimSpace(override), "/"); v != "" {
		return v, nil
	}
	if v := strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"); v != "" {
		return v, nil
	}
	if site := strings.TrimSpace(creds.Site); site != "" {
		if strings.Contains(site, ".") {
			return "https://" + site, nil
		}
		return "https://" + site + ".chargebee.com", nil
	}
	return "", fmt.Errorf("chargebee site or api_base_url is required")
}

func chargebeeDoJSON(ctx context.Context, client *http.Client, baseURL string, creds ChargebeeCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse chargebee API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.APIKey)+":")))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, chargebeeDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, chargebeeResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("chargebee REST %s failed %d: %s", path, resp.StatusCode, rechargeTruncate(string(body), 500))
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode chargebee response %s: %w", path, err)
	}
	return nil
}

func decodeChargebeeCursor(cursor string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return ""
	}
	if cursor == chargebeeCursorComplete {
		return chargebeeCursorComplete
	}
	return strings.TrimPrefix(cursor, chargebeeCursorPrefix)
}

func chargebeePageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return chargebeeDefaultPageSize
	}
	if n > chargebeeMaxPageSize {
		return chargebeeMaxPageSize
	}
	return n
}

func chargebeeEpoch(value json.Number) *time.Time {
	raw := strings.TrimSpace(value.String())
	if raw == "" || raw == "0" {
		return nil
	}
	secs, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || secs <= 0 {
		return nil
	}
	t := time.Unix(secs, 0).UTC()
	return &t
}
