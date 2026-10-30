// SPDX-License-Identifier: MIT

// Package mailchimp implements the Mailchimp source adapter.
//
// Auth: OAuth 2.0. After the user accepts at
//
//	https://login.mailchimp.com/oauth2/authorize?response_type=code&client_id=...
//
// Mailchimp redirects to our callback with `code`. We exchange that for a
// token at https://login.mailchimp.com/oauth2/token, then GET
// https://login.mailchimp.com/oauth2/metadata to learn the data center (`dc`)
// the user's account lives in. All subsequent API calls go to
// https://<dc>.api.mailchimp.com/3.0/.
package mailchimp

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/oauth2"

	adapter "github.com/postwave/migrate/adapter"
)

const (
	authorizeURL                      = "https://login.mailchimp.com/oauth2/authorize"
	tokenURL                          = "https://login.mailchimp.com/oauth2/token"
	metadataURL                       = "https://login.mailchimp.com/oauth2/metadata"
	AccountFingerprintExtraKey        = "mailchimp_account_fingerprint"
	mailchimpAccountFingerprintPrefix = "mailchimp-account-v1:"
)

var (
	exchangeTokenURL    = tokenURL
	exchangeMetadataURL = metadataURL
	exchangeRootURL     string
)

// OAuthConfig builds an oauth2.Config from environment variables. Reads
// MAILCHIMP_CLIENT_ID and MAILCHIMP_CLIENT_SECRET. The redirectURI is passed
// in by the caller because it varies per environment.
func OAuthConfig(redirectURI string) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     strings.TrimSpace(os.Getenv("MAILCHIMP_CLIENT_ID")),
		ClientSecret: strings.TrimSpace(os.Getenv("MAILCHIMP_CLIENT_SECRET")),
		Endpoint: oauth2.Endpoint{
			AuthURL:   authorizeURL,
			TokenURL:  tokenURL,
			AuthStyle: oauth2.AuthStyleInParams,
		},
		RedirectURL: redirectURI,
	}
}

// BuildAuthorizeURL returns the URL the UI should redirect the browser to.
func BuildAuthorizeURL(state, redirectURI string) string {
	cfg := OAuthConfig(redirectURI)
	return cfg.AuthCodeURL(state)
}

// ExchangeCode swaps an authorization_code for an access token + the user's
// data-center (dc) value, which we stash in Session.AccountID.
func ExchangeCode(ctx context.Context, code, redirectURI string) (adapter.Session, error) {
	cfg := OAuthConfig(redirectURI)

	// Mailchimp's token endpoint wants application/x-www-form-urlencoded with
	// grant_type=authorization_code. golang.org/x/oauth2 handles this via
	// Exchange but we go manual to surface ErrAuth cleanly.
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", cfg.ClientID)
	form.Set("client_secret", cfg.ClientSecret)
	form.Set("redirect_uri", redirectURI)
	form.Set("code", code)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, exchangeTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return adapter.Session{}, fmt.Errorf("build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("exchange code: %w: %w", adapter.ErrSourceUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := adapter.ReadResponseBodyLimited(resp, maxJSONResponseBodyBytes)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("mailchimp token endpoint: response body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return adapter.Session{}, fmt.Errorf("mailchimp token endpoint %d: %w", resp.StatusCode, adapter.ErrAuth)
	}

	var tok struct {
		AccessToken string `json:"access_token"`
		Scope       string `json:"scope"`
		ExpiresIn   int    `json:"expires_in"` // typically absent / 0 for Mailchimp (long-lived)
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return adapter.Session{}, fmt.Errorf("decode token: %w", err)
	}
	if tok.AccessToken == "" {
		return adapter.Session{}, fmt.Errorf("empty access_token: %w", adapter.ErrAuth)
	}

	// Look up the data center.
	metaReq, err := http.NewRequestWithContext(ctx, http.MethodGet, exchangeMetadataURL, nil)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("build metadata request: %w", err)
	}
	metaReq.Header.Set("Authorization", "OAuth "+tok.AccessToken)
	metaResp, err := client.Do(metaReq)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("fetch metadata: %w: %w", adapter.ErrSourceUnavailable, err)
	}
	defer func() { _ = metaResp.Body.Close() }()
	metaBody, err := adapter.ReadResponseBodyLimited(metaResp, maxJSONResponseBodyBytes)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("mailchimp metadata: response body: %w", err)
	}
	if metaResp.StatusCode < 200 || metaResp.StatusCode >= 300 {
		return adapter.Session{}, fmt.Errorf("mailchimp metadata %d: %w", metaResp.StatusCode, adapter.ErrAuth)
	}
	var meta struct {
		DC          string `json:"dc"`
		APIEndpoint string `json:"api_endpoint"`
		Login       struct {
			Email string `json:"email"`
		} `json:"login"`
	}
	if err := json.Unmarshal(metaBody, &meta); err != nil {
		return adapter.Session{}, fmt.Errorf("decode metadata: %w", err)
	}
	dc, err := mailchimpDataCenter(meta.DC, meta.APIEndpoint)
	if err != nil {
		return adapter.Session{}, err
	}
	rootURL := exchangeRootURL
	if rootURL == "" {
		rootURL = fmt.Sprintf("https://%s.api.mailchimp.com/3.0/", dc)
	}
	fingerprint, err := fetchMailchimpAccountFingerprint(ctx, client, rootURL, adapter.Session{
		AccessToken: tok.AccessToken,
		AccountID:   dc,
		Source:      "mailchimp",
	})
	if err != nil {
		return adapter.Session{}, err
	}

	expires := time.Time{}
	if tok.ExpiresIn > 0 {
		expires = time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	}

	return adapter.Session{
		AccessToken: tok.AccessToken,
		ExpiresAt:   expires,
		AccountID:   dc,
		Source:      "mailchimp",
		Extra: map[string]string{
			AccountFingerprintExtraKey: fingerprint,
		},
	}, nil
}

func fetchMailchimpAccountFingerprint(ctx context.Context, client *http.Client, rootURL string, sess adapter.Session) (string, error) {
	release, err := mailchimpRequestLimiters.acquire(ctx, mailchimpRequestLimiterKey(sess))
	if err != nil {
		return "", err
	}
	defer release()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rootURL, nil)
	if err != nil {
		return "", fmt.Errorf("build Mailchimp account identity request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+sess.AccessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch Mailchimp account identity: %w: %w", adapter.ErrSourceUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := adapter.ReadResponseBodyLimited(resp, maxJSONResponseBodyBytes)
	if err != nil {
		return "", fmt.Errorf("Mailchimp account identity response: %w", err)
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		retry := parseRetryAfter(resp.Header.Get("X-Retry-After"), resp.Header.Get("Retry-After"))
		return "", &adapter.ErrRateLimited{RetryAfter: retry}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return "", fmt.Errorf("Mailchimp account identity status %d: %w", resp.StatusCode, adapter.ErrAuth)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("Mailchimp account identity status %d: %w", resp.StatusCode, adapter.ErrSourceUnavailable)
	}
	var root struct {
		AccountID string `json:"account_id"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return "", fmt.Errorf("decode Mailchimp account identity: %w", err)
	}
	accountID := strings.TrimSpace(root.AccountID)
	if accountID == "" {
		return "", fmt.Errorf("Mailchimp API root did not return account_id: %w", adapter.ErrAuth)
	}
	sum := sha256.Sum256([]byte(mailchimpAccountFingerprintPrefix + accountID))
	fingerprint := fmt.Sprintf("%x", sum[:])
	bindVerifiedMailchimpAccount(sess, fingerprint)
	return fingerprint, nil
}

func mailchimpDataCenter(dc, apiEndpoint string) (string, error) {
	if normalized := normalizeMailchimpDataCenter(dc); normalized != "" {
		return normalized, nil
	}
	if strings.TrimSpace(apiEndpoint) != "" {
		parsed, err := url.Parse(apiEndpoint)
		if err == nil && parsed.Scheme == "https" && parsed.User == nil && parsed.Port() == "" {
			const suffix = ".api.mailchimp.com"
			host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
			if strings.HasSuffix(host, suffix) {
				candidate := strings.TrimSuffix(host, suffix)
				if normalized := normalizeMailchimpDataCenter(candidate); normalized != "" {
					return normalized, nil
				}
			}
		}
	}
	return "", fmt.Errorf("mailchimp metadata did not contain a usable data center: %w", adapter.ErrAuth)
}

func normalizeMailchimpDataCenter(dc string) string {
	dc = strings.ToLower(strings.TrimSpace(dc))
	if dc == "" || len(dc) > 32 {
		return ""
	}
	for _, r := range dc {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			continue
		}
		return ""
	}
	if strings.HasPrefix(dc, "-") || strings.HasSuffix(dc, "-") {
		return ""
	}
	return dc
}
