// SPDX-License-Identifier: AGPL-3.0-only

package pushsend

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// FCMConfig holds an FCM v1 (HTTP v1, not the deprecated legacy API)
// Google-service-account credential, used to mint short-lived OAuth2 access
// tokens for the Firebase Cloud Messaging send endpoint:
// https://firebase.google.com/docs/cloud-messaging/migrate-v1
type FCMConfig struct {
	// ProjectID is the Firebase project id (fcm.googleapis.com/v1/projects/{ProjectID}/messages:send).
	ProjectID string
	// ClientEmail is the service account's client_email field.
	ClientEmail string
	// PrivateKeyPEM is the service account's private_key field (PKCS#8 RSA).
	PrivateKeyPEM string
	// TokenURL overrides the OAuth2 token endpoint (tests only).
	TokenURL string
	// HTTPClient overrides the default HTTP client (tests only).
	HTTPClient *http.Client
}

const fcmDefaultTokenURL = "https://oauth2.googleapis.com/token"
const fcmScope = "https://www.googleapis.com/auth/firebase.messaging"

// FCMProvider is a PushProvider that delivers to platform "android" devices
// via FCM's v1 HTTP API. Request construction, the service-account JWT
// assertion, and the OAuth2 token exchange are real; SendPush returns a
// clear "FCM push credentials not configured" error when FCMConfig is
// incomplete rather than a silent no-op.
type FCMProvider struct {
	Config FCMConfig

	tokenMu     sync.Mutex
	cachedToken string
	cachedAt    time.Time
	cachedTTL   time.Duration
	nowFunc     func() time.Time // tests only; defaults to time.Now
	httpClient  *http.Client
}

// NewFCMProviderFromEnv builds an FCMProvider from FCM_PROJECT_ID,
// FCM_CLIENT_EMAIL, and FCM_PRIVATE_KEY_PEM (the three fields needed out of
// a downloaded Firebase service-account JSON key). Any/all may be empty —
// SendPush reports "not configured" rather than the constructor failing.
func NewFCMProviderFromEnv() *FCMProvider {
	return &FCMProvider{Config: FCMConfig{
		ProjectID:     strings.TrimSpace(os.Getenv("FCM_PROJECT_ID")),
		ClientEmail:   strings.TrimSpace(os.Getenv("FCM_CLIENT_EMAIL")),
		PrivateKeyPEM: os.Getenv("FCM_PRIVATE_KEY_PEM"),
	}}
}

// Configured reports whether enough credentials are present to attempt a
// send. It does not validate the key parses; SendPush surfaces that error.
func (p *FCMProvider) Configured() bool {
	return p != nil &&
		p.Config.ProjectID != "" &&
		p.Config.ClientEmail != "" &&
		strings.TrimSpace(p.Config.PrivateKeyPEM) != ""
}

func (p *FCMProvider) SendPush(ctx context.Context, token, platform, title, body string, data map[string]any) error {
	if platform != "android" {
		return fmt.Errorf("fcm provider does not send to platform %q", platform)
	}
	if strings.TrimSpace(token) == "" {
		return fmt.Errorf("fcm: device token is required")
	}
	if !p.Configured() {
		return fmt.Errorf("FCM push credentials not configured")
	}

	accessToken, err := p.accessToken(ctx)
	if err != nil {
		return fmt.Errorf("fcm: obtain access token: %w", err)
	}

	stringData := make(map[string]string, len(data))
	for k, v := range data {
		stringData[k] = fmt.Sprint(v)
	}
	message := map[string]any{
		"message": map[string]any{
			"token": token,
			"notification": map[string]any{
				"title": title,
				"body":  body,
			},
			"data": stringData,
		},
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("fcm: encode payload: %w", err)
	}

	endpoint := "https://fcm.googleapis.com/v1/projects/" + url.PathEscape(p.Config.ProjectID) + "/messages:send"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return fmt.Errorf("fcm: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client().Do(req)
	if err != nil {
		// Transport errors are not durable-safe: a custom transport can echo
		// request bodies containing the raw device token.
		return errors.New("fcm: request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))

	if resp.StatusCode != http.StatusOK {
		var errBody struct {
			Error struct {
				Status  string `json:"status"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(respBody, &errBody)
		if errBody.Error.Status != "" {
			return fmt.Errorf("fcm: send failed: %s: %s", resp.Status, errBody.Error.Status)
		}
		return fmt.Errorf("fcm: send failed: %s", resp.Status)
	}
	return nil
}

func (p *FCMProvider) client() *http.Client {
	if p.Config.HTTPClient != nil {
		return p.Config.HTTPClient
	}
	if p.httpClient == nil {
		p.httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return p.httpClient
}

func (p *FCMProvider) now() time.Time {
	if p.nowFunc != nil {
		return p.nowFunc()
	}
	return time.Now()
}

// accessToken returns a cached OAuth2 bearer token for the FCM scope,
// exchanging a fresh signed JWT assertion for one when absent or expired.
// This implements the "OAuth2 for Server to Server Applications" service
// account flow (RFC 7523) without an external Google API client library.
func (p *FCMProvider) accessToken(ctx context.Context) (string, error) {
	p.tokenMu.Lock()
	defer p.tokenMu.Unlock()

	now := p.now()
	if p.cachedToken != "" && now.Before(p.cachedAt.Add(p.cachedTTL)) {
		return p.cachedToken, nil
	}

	key, err := parseRSAPrivateKey(p.Config.PrivateKeyPEM)
	if err != nil {
		return "", err
	}

	iat := now
	exp := now.Add(55 * time.Minute)
	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	claims := map[string]any{
		"iss":   p.Config.ClientEmail,
		"scope": fcmScope,
		"aud":   defaultedFCM(p.Config.TokenURL, fcmDefaultTokenURL),
		"iat":   iat.Unix(),
		"exp":   exp.Unix(),
	}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." +
		base64.RawURLEncoding.EncodeToString(claimsJSON)

	hash := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
	if err != nil {
		return "", fmt.Errorf("sign assertion: %w", err)
	}
	assertion := signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)

	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
	form.Set("assertion", assertion)

	tokenURL := defaultedFCM(p.Config.TokenURL, fcmDefaultTokenURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := p.client().Do(req)
	if err != nil {
		return "", fmt.Errorf("token exchange request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token exchange failed: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var tokenResp struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return "", fmt.Errorf("decode token response: %w", err)
	}
	if tokenResp.AccessToken == "" {
		return "", fmt.Errorf("token exchange returned no access_token")
	}

	p.cachedToken = tokenResp.AccessToken
	p.cachedAt = now
	ttl := time.Duration(tokenResp.ExpiresIn) * time.Second
	if ttl <= 0 {
		ttl = 55 * time.Minute
	}
	p.cachedTTL = ttl
	return tokenResp.AccessToken, nil
}

func parseRSAPrivateKey(pemData string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemData))
	if block == nil {
		return nil, fmt.Errorf("fcm private key is not valid PEM")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if rsaKey, ok := key.(*rsa.PrivateKey); ok {
			return rsaKey, nil
		}
		return nil, fmt.Errorf("fcm private key is not an RSA key")
	}
	if rsaKey, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return rsaKey, nil
	}
	return nil, fmt.Errorf("fcm private key: unrecognized private key format")
}

func defaultedFCM(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}
