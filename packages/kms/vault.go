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

// VaultProvider wraps DEKs against a HashiCorp Vault Transit secrets
// engine. Vault Transit exposes an "encrypt as a service" API that wraps
// arbitrary plaintext under a named key without exposing the underlying
// keying material — a near-perfect fit for our Provider abstraction.
//
// Why REST instead of the Vault SDK: hashicorp/vault/api drags a large
// dep tree (mlock, retry, lifetime managers) that we don't need for a
// simple wrap/unwrap. The REST surface is stable and small.
//
// Auth: every request sends `X-Vault-Token: <token>`. The token can be
// provided directly via the Token field, or pulled from a TokenSource
// (when set) — the latter integrates cleanly with Vault Agent or
// AppRole login flows that mint short-lived tokens.
//
// Namespaces: Vault Enterprise supports namespaces via the
// X-Vault-Namespace header; set Namespace to use them.
type VaultProvider struct {
	// Address is the Vault server URL ("https://vault.acme.com:8200").
	// Required.
	Address string

	// MountPath is the path the Transit engine is mounted at; default
	// "transit". The Transit engine can be mounted multiple times to
	// segregate keys (e.g. transit-prod, transit-staging).
	MountPath string

	// Namespace optionally sets X-Vault-Namespace (Vault Enterprise).
	Namespace string

	// Token is the static Vault token. When TokenSource is also set,
	// TokenSource wins.
	Token string

	// TokenSource lets the caller mint short-lived tokens on demand
	// (Vault Agent, AppRole, AWS auth, etc.). When set, Token is
	// ignored.
	TokenSource TokenSource

	HTTPClient *http.Client
	Timeout    time.Duration
}

// NewVaultProvider constructs a VaultProvider with sensible defaults.
func NewVaultProvider(address, token string) *VaultProvider {
	return &VaultProvider{
		Address:    strings.TrimRight(address, "/"),
		MountPath:  "transit",
		Token:      token,
		HTTPClient: &http.Client{Timeout: 10 * time.Second},
		Timeout:    DefaultTimeout,
	}
}

// Name returns "vault".
func (p *VaultProvider) Name() string { return "vault" }

// WrapDEK calls Vault Transit /v1/{mount}/encrypt/{keyRef}.
//
// keyRef is the transit key name (e.g. "tenant-abc-kek-1").
func (p *VaultProvider) WrapDEK(ctx context.Context, keyRef string, plainDEK []byte) ([]byte, error) {
	if err := p.validate(keyRef); err != nil {
		return nil, err
	}
	if len(plainDEK) != DEKSize {
		return nil, fmt.Errorf("%w: vault: expected %d-byte DEK, got %d", ErrInvalidKeyRef, DEKSize, len(plainDEK))
	}
	body := map[string]string{"plaintext": base64.StdEncoding.EncodeToString(plainDEK)}
	var resp struct {
		Data struct {
			Ciphertext string `json:"ciphertext"`
		} `json:"data"`
	}
	if err := p.doJSON(ctx, "POST", p.path("encrypt", keyRef), body, &resp); err != nil {
		return nil, fmt.Errorf("vault transit encrypt: %w", err)
	}
	if resp.Data.Ciphertext == "" {
		return nil, fmt.Errorf("vault transit encrypt: empty ciphertext")
	}
	// Vault returns "vault:v{N}:<base64>" — we store the full string so
	// future rotations of the underlying key version remain decryptable.
	return []byte(resp.Data.Ciphertext), nil
}

// UnwrapDEK calls Vault Transit /v1/{mount}/decrypt/{keyRef}.
func (p *VaultProvider) UnwrapDEK(ctx context.Context, keyRef string, wrapped []byte) ([]byte, error) {
	if err := p.validate(keyRef); err != nil {
		return nil, err
	}
	body := map[string]string{"ciphertext": string(wrapped)}
	var resp struct {
		Data struct {
			Plaintext string `json:"plaintext"`
		} `json:"data"`
	}
	if err := p.doJSON(ctx, "POST", p.path("decrypt", keyRef), body, &resp); err != nil {
		return nil, fmt.Errorf("vault transit decrypt: %w", err)
	}
	dek, err := base64.StdEncoding.DecodeString(resp.Data.Plaintext)
	if err != nil {
		return nil, fmt.Errorf("vault transit decrypt: invalid base64: %w", err)
	}
	if len(dek) != DEKSize {
		return nil, fmt.Errorf("vault returned %d-byte DEK, expected %d", len(dek), DEKSize)
	}
	return dek, nil
}

// HealthCheck encrypts + decrypts a probe value.
func (p *VaultProvider) HealthCheck(ctx context.Context, keyRef string) error {
	probe := make([]byte, DEKSize)
	probe[0] = 0xb5
	wrapped, err := p.WrapDEK(ctx, keyRef, probe)
	if err != nil {
		return err
	}
	back, err := p.UnwrapDEK(ctx, keyRef, wrapped)
	if err != nil {
		return err
	}
	if !bytes.Equal(probe, back) {
		return fmt.Errorf("vault transit health-check: round-trip mismatch")
	}
	zero(probe)
	zero(back)
	return nil
}

// --- internals ---

// vaultKeyRefRE enforces a flat Transit-key-name grammar so a tenant
// can't smuggle slashes, dots, or other path-significant characters
// that would route the request to a different Transit operation or
// (with `..` path traversal) escape the configured mount.
//
// Vault Transit key names accept letters, digits, dashes, and
// underscores; we add a length cap (128) for sanity.
var vaultKeyRefRE = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

func (p *VaultProvider) validate(keyRef string) error {
	if p == nil || p.HTTPClient == nil || p.Address == "" {
		return ErrProviderUnconfigured
	}
	if p.Token == "" && p.TokenSource == nil {
		return ErrProviderUnconfigured
	}
	if !vaultKeyRefRE.MatchString(keyRef) {
		return fmt.Errorf("%w: vault: keyRef must be flat alphanumeric (no /, ., or special characters)", ErrInvalidKeyRef)
	}
	return nil
}

func (p *VaultProvider) path(action, keyRef string) string {
	mount := p.MountPath
	if mount == "" {
		mount = "transit"
	}
	return fmt.Sprintf("/v1/%s/%s/%s", strings.Trim(mount, "/"), action, keyRef)
}

func (p *VaultProvider) doJSON(ctx context.Context, method, path string, body any, into any) error {
	ctx, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, p.Address+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	tok := p.Token
	if p.TokenSource != nil {
		t, err := p.TokenSource.Token(ctx)
		if err != nil {
			return fmt.Errorf("vault token source: %w", err)
		}
		tok = t
	}
	req.Header.Set("X-Vault-Token", tok)
	if p.Namespace != "" {
		req.Header.Set("X-Vault-Namespace", p.Namespace)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := p.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusForbidden {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return fmt.Errorf("%w: %s", ErrPermissionDenied, strings.TrimSpace(string(raw)))
	}
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return fmt.Errorf("vault status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if into == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(into)
}

func (p *VaultProvider) timeout() time.Duration {
	if p.Timeout <= 0 {
		return DefaultTimeout
	}
	return p.Timeout
}
