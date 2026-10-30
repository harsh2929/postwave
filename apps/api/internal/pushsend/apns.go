// SPDX-License-Identifier: AGPL-3.0-only

package pushsend

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"
)

// APNsConfig holds the token-based (.p8) authentication credentials APNs's
// HTTP/2 API requires: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
type APNsConfig struct {
	// KeyID is the 10-character key identifier from the Apple Developer
	// portal (Certificates, Identifiers & Profiles > Keys).
	KeyID string
	// TeamID is the 10-character Apple Developer Team ID.
	TeamID string
	// AuthKeyPEM is the PEM-encoded contents of the .p8 signing key
	// downloaded from the Apple Developer portal (PKCS#8, EC private key).
	AuthKeyPEM string
	// BundleID is the app's bundle identifier, sent as the apns-topic
	// header, unless a per-device Device.AppID override is supplied.
	BundleID string
	// Production selects api.push.apple.com; false uses
	// api.sandbox.push.apple.com (development-signed apps).
	Production bool
	// HTTPClient overrides the default HTTP/2 client (tests only).
	HTTPClient *http.Client
}

// APNsProvider is a PushProvider that delivers to platform "ios" devices via
// Apple's HTTP/2 APNs API. Request construction, JWT signing, and the HTTP/2
// transport are real; SendPush returns a clear "APNs push credentials not
// configured" error when APNsConfig is incomplete rather than a silent no-op.
type APNsProvider struct {
	Config APNsConfig

	tokenMu    sync.Mutex
	cachedJWT  string
	cachedAt   time.Time
	nowFunc    func() time.Time // tests only; defaults to time.Now
	httpClient *http.Client
}

// apnsJWTTTL is the maximum APNs provider-token lifetime (60 minutes);
// tokens are refreshed a few minutes early to avoid a request racing expiry.
const apnsJWTTTL = 55 * time.Minute

// NewAPNsProviderFromEnv builds an APNsProvider from APNS_KEY_ID,
// APNS_TEAM_ID, APNS_AUTH_KEY_PEM, APNS_BUNDLE_ID, and APNS_ENV
// ("production" | "sandbox", default sandbox). Any/all may be empty —
// SendPush reports "not configured" rather than the constructor failing.
func NewAPNsProviderFromEnv() *APNsProvider {
	return &APNsProvider{Config: APNsConfig{
		KeyID:      strings.TrimSpace(os.Getenv("APNS_KEY_ID")),
		TeamID:     strings.TrimSpace(os.Getenv("APNS_TEAM_ID")),
		AuthKeyPEM: os.Getenv("APNS_AUTH_KEY_PEM"),
		BundleID:   strings.TrimSpace(os.Getenv("APNS_BUNDLE_ID")),
		Production: strings.EqualFold(strings.TrimSpace(os.Getenv("APNS_ENV")), "production"),
	}}
}

// Configured reports whether enough credentials are present to attempt a
// send. It does not validate the key parses; SendPush surfaces that error.
func (p *APNsProvider) Configured() bool {
	return p != nil &&
		p.Config.KeyID != "" &&
		p.Config.TeamID != "" &&
		strings.TrimSpace(p.Config.AuthKeyPEM) != "" &&
		p.Config.BundleID != ""
}

func (p *APNsProvider) SendPush(ctx context.Context, token, platform, title, body string, data map[string]any) error {
	if platform != "ios" {
		return fmt.Errorf("apns provider does not send to platform %q", platform)
	}
	if strings.TrimSpace(token) == "" {
		return fmt.Errorf("apns: device token is required")
	}
	if !p.Configured() {
		return fmt.Errorf("APNs push credentials not configured")
	}

	jwt, err := p.providerToken()
	if err != nil {
		return fmt.Errorf("apns: sign provider token: %w", err)
	}

	aps := map[string]any{
		"alert": map[string]any{"title": title, "body": body},
		"sound": "default",
	}
	payload := map[string]any{"aps": aps}
	for k, v := range data {
		if k == "aps" {
			continue // aps is reserved; never let caller data clobber it
		}
		payload[k] = v
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("apns: encode payload: %w", err)
	}

	host := "https://api.sandbox.push.apple.com"
	if p.Config.Production {
		host = "https://api.push.apple.com"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, host+"/3/device/"+token, bytes.NewReader(encoded))
	if err != nil {
		return fmt.Errorf("apns: build request: %w", err)
	}
	req.Header.Set("authorization", "bearer "+jwt)
	req.Header.Set("apns-topic", p.Config.BundleID)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	req.Header.Set("content-type", "application/json")

	resp, err := p.client().Do(req)
	if err != nil {
		// net/http transport errors include req.URL, and the APNs device token
		// is a path segment. Never let that credential escape this boundary.
		return errors.New("apns: request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))

	if resp.StatusCode != http.StatusOK {
		var reason struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(respBody, &reason)
		if reason.Reason != "" {
			return fmt.Errorf("apns: send failed: %s: %s", resp.Status, reason.Reason)
		}
		return fmt.Errorf("apns: send failed: %s", resp.Status)
	}
	return nil
}

// client returns an HTTP/2-only client, per Apple's requirement that APNs
// connections use HTTP/2 (plain http.Client with a default transport will
// negotiate HTTP/2 over TLS automatically, but http2.Transport makes the
// requirement explicit and testable).
func (p *APNsProvider) client() *http.Client {
	if p.Config.HTTPClient != nil {
		return p.Config.HTTPClient
	}
	if p.httpClient == nil {
		p.httpClient = &http.Client{
			Timeout:   10 * time.Second,
			Transport: &http2.Transport{},
		}
	}
	return p.httpClient
}

func (p *APNsProvider) now() time.Time {
	if p.nowFunc != nil {
		return p.nowFunc()
	}
	return time.Now()
}

// providerToken returns a cached ES256 JWT provider token, signing a fresh
// one when absent or near expiry (APNs provider tokens are valid up to one
// hour and should be reused across requests rather than minted per-send).
func (p *APNsProvider) providerToken() (string, error) {
	p.tokenMu.Lock()
	defer p.tokenMu.Unlock()

	now := p.now()
	if p.cachedJWT != "" && now.Sub(p.cachedAt) < apnsJWTTTL {
		return p.cachedJWT, nil
	}

	key, err := parseECPrivateKey(p.Config.AuthKeyPEM)
	if err != nil {
		return "", err
	}

	header := map[string]string{"alg": "ES256", "kid": p.Config.KeyID}
	claims := map[string]any{"iss": p.Config.TeamID, "iat": now.Unix()}
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
	r, s, err := ecdsa.Sign(rand.Reader, key, hash[:])
	if err != nil {
		return "", fmt.Errorf("sign: %w", err)
	}
	// JWS ES256 signatures are the fixed-width big-endian concatenation of
	// R and S (32 bytes each for P-256), not the ASN.1 DER encoding
	// ecdsa.Sign's r/s would otherwise be marshaled as.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])

	jwt := signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
	p.cachedJWT = jwt
	p.cachedAt = now
	return jwt, nil
}

func parseECPrivateKey(pemData string) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemData))
	if block == nil {
		return nil, fmt.Errorf("apns auth key is not valid PEM")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if ecKey, ok := key.(*ecdsa.PrivateKey); ok {
			return ecKey, nil
		}
		return nil, fmt.Errorf("apns auth key is not an ECDSA key")
	}
	if ecKey, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return ecKey, nil
	}
	return nil, fmt.Errorf("apns auth key: unrecognized private key format")
}
