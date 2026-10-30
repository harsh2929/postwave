// SPDX-License-Identifier: AGPL-3.0-only
//
// friendbuy.go — native Friendbuy referral/advocacy puller.
//
// Friendbuy is a high-demand DTC referral platform. Its Merchant API uses a
// token exchange: POST /v1/authorization with {key, secret} returns a bearer
// token, then customers/advocates are pulled with an opaque cursor. Maps to
// canonical MemberInput (referral code preserved) dispatched via providerPull.
package loyalty_integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	friendbuyDefaultAPIBaseURL = "https://mapi.fbot.me"
	friendbuyResponseMaxBytes  = 8 << 20
	friendbuyCursorPrefix      = "friendbuy:"
	friendbuyCursorComplete    = "friendbuy:complete"
)

type FriendbuyCredentials struct {
	Key        string
	Secret     string
	APIBaseURL string
	UserAgent  string
}

type FriendbuyCredentialResolver interface {
	ResolveFriendbuy(ctx context.Context, tenantID string, integration Integration) (FriendbuyCredentials, error)
}

type friendbuyCredentialPayload struct {
	Key        string `json:"key"`
	APIKey     string `json:"api_key"`
	Secret     string `json:"secret"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p friendbuyCredentialPayload) credentials() (FriendbuyCredentials, error) {
	key := strings.TrimSpace(firstString(p.Key, p.APIKey))
	secret := strings.TrimSpace(p.Secret)
	if key == "" || secret == "" {
		return FriendbuyCredentials{}, fmt.Errorf("friendbuy key and secret are required")
	}
	return FriendbuyCredentials{Key: key, Secret: secret, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type FriendbuySecretsCredentialResolver struct {
	Secrets LoyaltyRuntimeSecretResolver
}

func (r FriendbuySecretsCredentialResolver) ResolveFriendbuy(ctx context.Context, _ string, integration Integration) (FriendbuyCredentials, error) {
	if r.Secrets == nil {
		return FriendbuyCredentials{}, fmt.Errorf("friendbuy credential resolver is not configured")
	}
	ref := loyaltyCredentialRef(integration)
	if ref == "" {
		return FriendbuyCredentials{}, fmt.Errorf("friendbuy credentials_ref is required")
	}
	var payload friendbuyCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withFriendbuyBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FriendbuyCredentials{}, fmt.Errorf("resolve friendbuy credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withFriendbuyBaseURL(creds, integration), nil
			}
		}
	}
	return FriendbuyCredentials{}, fmt.Errorf("friendbuy requires a JSON {key, secret} secret")
}

func withFriendbuyBaseURL(creds FriendbuyCredentials, integration Integration) FriendbuyCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type FriendbuyRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FriendbuyCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type friendbuyCustomer struct {
	ID           string `json:"id"`
	Email        string `json:"email"`
	FirstName    string `json:"firstName"`
	LastName     string `json:"lastName"`
	Name         string `json:"name"`
	ReferralCode string `json:"referralCode"`
}

func (b FriendbuyRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFriendbuy {
		return SyncRequest{}, fmt.Errorf("friendbuy backfill requires a Friendbuy integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("friendbuy credential resolver is not configured")
	}
	state := friendbuyDecodeCursor(cursor)
	if state == friendbuyCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: friendbuyCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveFriendbuy(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := loyaltyHTTPClient(b.HTTPClient, ProviderFriendbuy)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), friendbuyDefaultAPIBaseURL)
	token, err := friendbuyExchangeToken(ctx, client, baseURL, creds, firstString(b.UserAgent, creds.UserAgent, loyaltyDefaultUserAgent))
	if err != nil {
		return SyncRequest{}, err
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(loyaltyPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	if state != "" {
		query.Set("cursor", state)
	}
	headers := map[string]string{"Authorization": "Bearer " + token}

	var out struct {
		Results []friendbuyCustomer `json:"results"`
		Next    string              `json:"next"`
	}
	if err := loyaltyDoJSON(ctx, client, baseURL, "/v1/customers", query, headers, firstString(b.UserAgent, creds.UserAgent, loyaltyDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	members := make([]MemberInput, 0, len(out.Results))
	for _, c := range out.Results {
		if mapped, ok := mapFriendbuyCustomer(c); ok {
			members = append(members, mapped)
		}
	}
	nextCursor := friendbuyCursorComplete
	if strings.TrimSpace(out.Next) != "" {
		nextCursor = friendbuyCursorPrefix + strings.TrimSpace(out.Next)
	}
	return SyncRequest{RunMode: "backfill", Members: members, Cursor: nextCursor}, nil
}

func friendbuyExchangeToken(ctx context.Context, client *http.Client, baseURL string, creds FriendbuyCredentials, userAgent string) (string, error) {
	payload, _ := json.Marshal(map[string]string{"key": creds.Key, "secret": creds.Secret})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/authorization", bytes.NewReader(payload))
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
	body, _ := io.ReadAll(io.LimitReader(resp.Body, friendbuyResponseMaxBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("friendbuy token exchange failed %d: %s", resp.StatusCode, loyaltyTruncate(string(body), 300))
	}
	var raw struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return "", fmt.Errorf("decode friendbuy token: %w", err)
	}
	if strings.TrimSpace(raw.Token) == "" {
		return "", fmt.Errorf("friendbuy token response missing token")
	}
	return strings.TrimSpace(raw.Token), nil
}

func mapFriendbuyCustomer(c friendbuyCustomer) (MemberInput, bool) {
	email := strings.ToLower(strings.TrimSpace(c.Email))
	if email == "" {
		return MemberInput{}, false
	}
	return MemberInput{
		SourceID:     "friendbuy://customer/" + firstString(strings.TrimSpace(c.ID), email),
		Email:        email,
		FirstName:    strings.TrimSpace(c.FirstName),
		LastName:     strings.TrimSpace(c.LastName),
		FullName:     strings.TrimSpace(firstString(c.Name, strings.TrimSpace(c.FirstName+" "+c.LastName))),
		ReferralCode: strings.TrimSpace(c.ReferralCode),
	}, true
}

func friendbuyDecodeCursor(cursor string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return ""
	}
	if cursor == friendbuyCursorComplete {
		return friendbuyCursorComplete
	}
	return strings.TrimPrefix(cursor, friendbuyCursorPrefix)
}
