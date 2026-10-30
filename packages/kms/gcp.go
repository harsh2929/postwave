// SPDX-License-Identifier: MIT

package kms

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// GCPProvider wraps DEKs against a Google Cloud KMS CryptoKey via the
// Cloud KMS REST API (cloudkms.googleapis.com/v1/{name}:encrypt|decrypt).
//
// Why REST instead of the cloud.google.com/go/kms SDK: the SDK pulls a
// large transitive set of grpc + protobuf + cloud-libs deps that we'd
// otherwise avoid. The REST API is stable, documented (see Cloud KMS
// REST docs), and small enough to maintain inline.
//
// Auth: GCPProvider expects an OAuth2 access token (typically obtained
// via golang.org/x/oauth2/google.DefaultTokenSource or a service account
// JSON). The TokenSource interface keeps the actual auth strategy out of
// this package so apps/api can wire either source.
type GCPProvider struct {
	HTTPClient  *http.Client
	TokenSource TokenSource
	Timeout     time.Duration

	// BaseURL is overridable for tests; defaults to the public Cloud KMS
	// endpoint.
	BaseURL string
}

// TokenSource is the narrow interface for fetching an OAuth2 bearer
// token. The apps/api wiring satisfies this with
// google.DefaultTokenSource (oauth2/google).
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

// NewGCPProvider constructs a GCPProvider with sensible defaults.
func NewGCPProvider(ts TokenSource) *GCPProvider {
	return &GCPProvider{
		HTTPClient:  &http.Client{Timeout: 10 * time.Second},
		TokenSource: ts,
		Timeout:     DefaultTimeout,
		BaseURL:     "https://cloudkms.googleapis.com/v1",
	}
}

// Name returns "gcp".
func (p *GCPProvider) Name() string { return "gcp" }

// WrapDEK calls the GCP KMS REST API encrypt endpoint.
//
// keyRef must be the full resource name:
// projects/{p}/locations/{l}/keyRings/{r}/cryptoKeys/{k}
func (p *GCPProvider) WrapDEK(ctx context.Context, keyRef string, plainDEK []byte) ([]byte, error) {
	if err := p.validate(keyRef); err != nil {
		return nil, err
	}
	if len(plainDEK) != DEKSize {
		return nil, fmt.Errorf("%w: gcp: expected %d-byte DEK, got %d", ErrInvalidKeyRef, DEKSize, len(plainDEK))
	}
	body := map[string]string{
		"plaintext": base64.StdEncoding.EncodeToString(plainDEK),
	}
	var resp struct {
		Ciphertext string `json:"ciphertext"`
	}
	if err := p.doJSON(ctx, "POST", keyRef+":encrypt", body, &resp); err != nil {
		return nil, fmt.Errorf("gcp kms encrypt: %w", err)
	}
	wrapped, err := base64.StdEncoding.DecodeString(resp.Ciphertext)
	if err != nil {
		return nil, fmt.Errorf("gcp kms encrypt: invalid base64: %w", err)
	}
	return wrapped, nil
}

// UnwrapDEK calls the GCP KMS REST API decrypt endpoint.
func (p *GCPProvider) UnwrapDEK(ctx context.Context, keyRef string, wrapped []byte) ([]byte, error) {
	if err := p.validate(keyRef); err != nil {
		return nil, err
	}
	body := map[string]string{
		"ciphertext": base64.StdEncoding.EncodeToString(wrapped),
	}
	var resp struct {
		Plaintext string `json:"plaintext"`
	}
	if err := p.doJSON(ctx, "POST", keyRef+":decrypt", body, &resp); err != nil {
		return nil, fmt.Errorf("gcp kms decrypt: %w", err)
	}
	dek, err := base64.StdEncoding.DecodeString(resp.Plaintext)
	if err != nil {
		return nil, fmt.Errorf("gcp kms decrypt: invalid base64: %w", err)
	}
	if len(dek) != DEKSize {
		return nil, fmt.Errorf("gcp kms returned %d-byte DEK, expected %d", len(dek), DEKSize)
	}
	return dek, nil
}

// HealthCheck encrypts + decrypts a small probe to validate the keyRef.
func (p *GCPProvider) HealthCheck(ctx context.Context, keyRef string) error {
	probe := make([]byte, DEKSize)
	probe[0] = 0xa5 // distinguishable byte so any silent-corruption surfaces
	wrapped, err := p.WrapDEK(ctx, keyRef, probe)
	if err != nil {
		return err
	}
	back, err := p.UnwrapDEK(ctx, keyRef, wrapped)
	if err != nil {
		return err
	}
	if !bytes.Equal(probe, back) {
		return fmt.Errorf("gcp kms health-check: round-trip mismatch")
	}
	zero(probe)
	zero(back)
	return nil
}

// --- internals ---

// gcpKeyRefRE enforces the strict Cloud KMS resource-name grammar so
// a tenant-supplied keyRef cannot pivot the encrypt/decrypt call to a
// different GCP API endpoint (Secret Manager, etc.) via path traversal
// or URL-significant characters (`?`, `#`, `%`, whitespace).
//
// Format: projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>
// (optionally followed by /cryptoKeyVersions/<v> for version-pinning).
// Component charset matches Cloud KMS itself: letters, digits, dashes,
// and underscores.
var gcpKeyRefRE = regexp.MustCompile(
	`^projects/[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}` +
		`/locations/[a-zA-Z0-9_-]+` +
		`/keyRings/[a-zA-Z0-9_-]+` +
		`/cryptoKeys/[a-zA-Z0-9_-]+` +
		`(/cryptoKeyVersions/[0-9]+)?$`,
)

func (p *GCPProvider) validate(keyRef string) error {
	if p == nil || p.HTTPClient == nil || p.TokenSource == nil {
		return ErrProviderUnconfigured
	}
	if !gcpKeyRefRE.MatchString(keyRef) {
		return fmt.Errorf("%w: gcp: keyRef must match projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>", ErrInvalidKeyRef)
	}
	return nil
}

// doJSON executes a POST to {BaseURL}/{path} with body marshalled as JSON
// and the result decoded into `into`.
func (p *GCPProvider) doJSON(ctx context.Context, method, path string, body any, into any) error {
	ctx, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()

	buf, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal body: %w", err)
	}
	url := strings.TrimRight(p.BaseURL, "/") + "/" + strings.TrimLeft(path, "/")
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	tok, err := p.TokenSource.Token(ctx)
	if err != nil {
		return fmt.Errorf("token: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := p.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return fmt.Errorf("%w: %s", ErrPermissionDenied, strings.TrimSpace(string(raw)))
	}
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if into == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(into)
}

func (p *GCPProvider) timeout() time.Duration {
	if p.Timeout <= 0 {
		return DefaultTimeout
	}
	return p.Timeout
}

// StaticToken is a TokenSource backed by a fixed bearer token. Useful in
// dev / tests; production wires google.DefaultTokenSource.
type StaticToken string

// Token returns the static value.
func (s StaticToken) Token(_ context.Context) (string, error) { return string(s), nil }
