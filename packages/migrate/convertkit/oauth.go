// SPDX-License-Identifier: MIT

// Package convertkit implements the ConvertKit / Kit source adapter.
//
// Auth: ConvertKit (rebranded "Kit") moved to OAuth 2.0 in 2024 for new apps.
// Authorize at https://api.kit.com/v4/oauth/authorize, exchange at
// https://api.kit.com/v4/oauth/token.
package convertkit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/oauth2"

	adapter "github.com/postwave/migrate/adapter"
)

const (
	authorizeURL = "https://api.kit.com/v4/oauth/authorize"
	tokenURL     = "https://api.kit.com/v4/oauth/token"
)

// OAuthConfig pulls CONVERTKIT_CLIENT_ID / CONVERTKIT_CLIENT_SECRET from env.
func OAuthConfig(redirectURI string) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     strings.TrimSpace(os.Getenv("CONVERTKIT_CLIENT_ID")),
		ClientSecret: strings.TrimSpace(os.Getenv("CONVERTKIT_CLIENT_SECRET")),
		Endpoint: oauth2.Endpoint{
			AuthURL:   authorizeURL,
			TokenURL:  tokenURL,
			AuthStyle: oauth2.AuthStyleInParams,
		},
		RedirectURL: redirectURI,
	}
}

// BuildAuthorizeURL returns the URL the UI should redirect to.
func BuildAuthorizeURL(state, redirectURI string) string {
	return OAuthConfig(redirectURI).AuthCodeURL(state, oauth2.AccessTypeOffline)
}

// ExchangeCode swaps an authorization_code for an access/refresh token pair.
func ExchangeCode(ctx context.Context, code, redirectURI string) (adapter.Session, error) {
	cfg := OAuthConfig(redirectURI)

	return exchangeToken(ctx, &http.Client{Timeout: 30 * time.Second}, tokenURL, map[string]string{
		"grant_type": "authorization_code", "client_id": cfg.ClientID, "client_secret": cfg.ClientSecret, "redirect_uri": redirectURI, "code": code,
	})
}

// RefreshSession rotates a single-use v4 refresh token. The caller must hold a
// durable session lock and persist both returned tokens before resuming work.
func (a *Adapter) RefreshSession(ctx context.Context, sess adapter.Session) (adapter.Session, error) {
	if sess.RefreshToken == "" || sess.AccountID == "" || sess.Extra["api_version"] != "4" {
		return adapter.Session{}, fmt.Errorf("kit: reconnect source to refresh session: %w", adapter.ErrAuth)
	}
	cfg := OAuthConfig("")
	endpoint := tokenURL
	if a.BaseURL != "" && a.BaseURL != apiBase {
		endpoint = strings.TrimRight(a.BaseURL, "/") + "/oauth/token"
	}
	refreshed, err := exchangeToken(ctx, a.http, endpoint, map[string]string{"grant_type": "refresh_token", "client_id": cfg.ClientID, "client_secret": cfg.ClientSecret, "refresh_token": sess.RefreshToken})
	if err != nil {
		return adapter.Session{}, err
	}
	refreshed.AccountID = sess.AccountID
	refreshed.Extra = cloneMap(sess.Extra)
	id, err := a.accountID(ctx, refreshed)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("kit: refreshed account could not be verified; reconnect source: %w", err)
	}
	if id != sess.AccountID {
		return adapter.Session{}, fmt.Errorf("kit: refreshed account mismatch: %w", adapter.ErrAuth)
	}
	return refreshed, nil
}

func exchangeToken(ctx context.Context, client *http.Client, endpoint string, fields map[string]string) (adapter.Session, error) {
	if fields["client_id"] == "" || fields["client_secret"] == "" {
		return adapter.Session{}, fmt.Errorf("kit: OAuth app is not configured: %w", adapter.ErrAuth)
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return adapter.Session{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return adapter.Session{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// Token requests contain app secrets and single-use grants. Never replay
	// their bodies at a redirect destination, including a same-host redirect.
	boundClient := *client
	boundClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := boundClient.Do(req)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("kit: token request failed: %w", adapter.ErrSourceUnavailable)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return adapter.Session{}, fmt.Errorf("kit: token endpoint %d; reconnect source: %w", resp.StatusCode, adapter.ErrAuth)
	}
	if resp.StatusCode != http.StatusOK {
		return adapter.Session{}, fmt.Errorf("kit: unexpected token response status %d: %w", resp.StatusCode, adapter.ErrSourceUnavailable)
	}
	body, err := adapter.ReadResponseBodyLimited(resp, maxJSONResponseBodyBytes)
	if err != nil {
		return adapter.Session{}, err
	}

	var tok struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		TokenType    string `json:"token_type"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return adapter.Session{}, fmt.Errorf("decode token: %w", err)
	}
	if tok.AccessToken == "" || tok.RefreshToken == "" || tok.ExpiresIn <= 0 || !strings.EqualFold(tok.TokenType, "bearer") {
		return adapter.Session{}, fmt.Errorf("incomplete OAuth token response: %w", adapter.ErrAuth)
	}
	expires := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	return adapter.Session{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		ExpiresAt:    expires,
		Source:       "convertkit",
	}, nil
}
