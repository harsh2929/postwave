// SPDX-License-Identifier: MIT

package activecampaign

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
)

// AccountFingerprintExtraKey is the opaque, stable ActiveCampaign account
// identity stored in a migration session. It is deliberately derived from the
// account-specific API host rather than a user id: ActiveCampaign API tokens
// are user-specific, so rotating to another migration user in the same account
// must not look like an account switch.
const (
	AccountFingerprintExtraKey       = "activecampaign_account_fingerprint"
	activeCampaignAllowedAPIHostsEnv = "ACTIVECAMPAIGN_ALLOWED_API_HOSTS"
)

var errActiveCampaignRedirect = errors.New("activecampaign: redirects are not allowed")

// allowInsecureActiveCampaignTestLoopback is false in production builds. The
// package's tests enable it from a _test.go file so the large adapter fixture
// suite can continue to use httptest servers without weakening runtime URL
// validation.
var allowInsecureActiveCampaignTestLoopback bool

// validateAPIURLForRequest enforces the credential-bearing request boundary.
// ActiveCampaign documents an account-specific HTTPS base URL. Built-in
// provider domains and operator-approved exact hosts prevent a supplied URL
// from turning Api-Token into a general-purpose SSRF/credential-exfiltration
// primitive.
func validateAPIURLForRequest(raw string) error {
	return validateActiveCampaignAPIURL(raw, allowInsecureActiveCampaignTestLoopback)
}

func validateActiveCampaignAPIURL(raw string, allowTestLoopback bool) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("invalid ActiveCampaign account API URL")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("unsafe ActiveCampaign account API URL")
	}
	host := canonicalAccountHost(u)
	if host == "" {
		return fmt.Errorf("invalid ActiveCampaign account API URL host")
	}
	if allowTestLoopback && u.Scheme == "http" && isCanonicalLoopbackHost(host) {
		return nil
	}
	if u.Scheme != "https" {
		return fmt.Errorf("ActiveCampaign account API URL must use https")
	}
	if port := u.Port(); port != "" && port != "443" {
		return fmt.Errorf("ActiveCampaign account API URL must use the standard HTTPS port")
	}
	if net.ParseIP(host) != nil || isNumericIPAddressLikeHost(host) || isCanonicalLoopbackHost(host) || isLocalhostSubdomain(host) {
		return fmt.Errorf("ActiveCampaign account API URL host is not recognized; paste the API URL from Settings > Developer")
	}
	allowed, err := isAllowedActiveCampaignAPIHost(host)
	if err != nil {
		return err
	}
	if !allowed {
		return fmt.Errorf("ActiveCampaign account API URL host is not recognized; paste the API URL from Settings > Developer")
	}
	if path := strings.TrimRight(u.EscapedPath(), "/"); path != "/api/3" {
		return fmt.Errorf("ActiveCampaign account API URL must resolve to /api/3")
	}
	return nil
}

func isAllowedActiveCampaignAPIHost(host string) (bool, error) {
	host = canonicalHostname(host)
	if isActiveCampaignAccountHost(host) {
		return true, nil
	}
	hosts, err := configuredActiveCampaignAPIHosts()
	if err != nil {
		return false, err
	}
	_, ok := hosts[host]
	return ok, nil
}

func configuredActiveCampaignAPIHosts() (map[string]struct{}, error) {
	hosts := make(map[string]struct{})
	raw := strings.TrimSpace(os.Getenv(activeCampaignAllowedAPIHostsEnv))
	if raw == "" {
		return hosts, nil
	}
	for _, entry := range strings.Split(raw, ",") {
		host := canonicalHostname(entry)
		if !validConfiguredActiveCampaignAPIHost(host) {
			return nil, fmt.Errorf("%s must contain only comma-separated exact DNS hostnames", activeCampaignAllowedAPIHostsEnv)
		}
		hosts[host] = struct{}{}
	}
	return hosts, nil
}

func validConfiguredActiveCampaignAPIHost(host string) bool {
	if host == "" || len(host) > 253 || !strings.Contains(host, ".") ||
		net.ParseIP(host) != nil || isNumericIPAddressLikeHost(host) ||
		isCanonicalLoopbackHost(host) || isLocalhostSubdomain(host) {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if !validDNSLabel(label) {
			return false
		}
	}
	return true
}

func isActiveCampaignAccountHost(host string) bool {
	_, ok := activeCampaignAccountName(host)
	return ok
}

func activeCampaignAccountName(host string) (string, bool) {
	host = canonicalHostname(host)
	for _, suffix := range []string{".api-us1.com", ".activehosted.com"} {
		if !strings.HasSuffix(host, suffix) || len(host) <= len(suffix) {
			continue
		}
		account := strings.TrimSuffix(host, suffix)
		if strings.Contains(account, ".") || !validDNSLabel(account) {
			return "", false
		}
		return account, true
	}
	return "", false
}

func validDNSLabel(value string) bool {
	if value == "" || len(value) > 63 || value[0] == '-' || value[len(value)-1] == '-' {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}

func isCanonicalLoopbackHost(host string) bool {
	host = canonicalHostname(host)
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isLocalhostSubdomain(host string) bool {
	return strings.HasSuffix(canonicalHostname(host), ".localhost")
}

func isNumericIPAddressLikeHost(host string) bool {
	host = canonicalHostname(host)
	if host == "" {
		return false
	}
	for _, r := range host {
		if (r < '0' || r > '9') && r != '.' {
			return false
		}
	}
	return true
}

func canonicalHostname(host string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
}

func canonicalAccountHost(u *url.URL) string {
	if u == nil {
		return ""
	}
	return canonicalHostname(u.Hostname())
}

func accountHostFromAPIURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return canonicalAccountHost(u)
}

func accountFingerprintFromAPIURL(raw string) (string, error) {
	if err := validateAPIURLForRequest(raw); err != nil {
		return "", err
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("ActiveCampaign account identity is missing")
	}
	host := canonicalAccountHost(u)
	identity := ""
	if account, ok := activeCampaignAccountName(host); ok {
		// Preserve the original account-label material so persisted fingerprints
		// remain stable and supported provider aliases continue to match.
		identity = "activecampaign-account-v1:" + account
	} else if allowInsecureActiveCampaignTestLoopback && isCanonicalLoopbackHost(host) {
		identity = "activecampaign-account-v1:httptest:" + strings.ToLower(u.Host)
	} else if allowed, allowErr := isAllowedActiveCampaignAPIHost(host); allowErr != nil {
		return "", allowErr
	} else if allowed {
		// A configured hostname is an exact operator-approved account identity.
		// Do not collapse it to a label because custom provider domains have no
		// documented alias relationship.
		identity = "activecampaign-account-host-v1:" + host
	}
	if identity == "" {
		return "", fmt.Errorf("ActiveCampaign account identity is missing")
	}
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:]), nil
}

// AccountFingerprintForAPIURL returns the opaque identity for a validated
// ActiveCampaign account API URL. Callers persist the result, never the raw
// account host, in durable migration control state.
func AccountFingerprintForAPIURL(raw string) (string, error) {
	return accountFingerprintFromAPIURL(raw)
}

// AccountFingerprintForCredentialAPIURL returns the opaque identity for an
// ActiveCampaign API URL as accepted by Authenticate. Credential inputs may be
// a bare Developer-tab host, an account root, or an API v3 resource URL;
// normalization reduces each form to the strict /api/3 request boundary before
// deriving the fingerprint. Callers must use AccountFingerprintForAPIURL when
// validating an already-normalized request base.
func AccountFingerprintForCredentialAPIURL(raw string) (string, error) {
	normalized, err := normalizeAPIURL(raw)
	if err != nil {
		return "", err
	}
	return accountFingerprintFromAPIURL(normalized)
}

// AccountFingerprint returns the opaque account identity established during
// Authenticate. Empty means the session predates account binding or was not
// produced by the ActiveCampaign adapter and must fail closed for cutover.
func AccountFingerprint(sess adapter.Session) string {
	if len(sess.Extra) == 0 {
		return ""
	}
	return strings.TrimSpace(sess.Extra[AccountFingerprintExtraKey])
}

func (a *Adapter) establishAuthenticatedAccount(ctx context.Context, sess *adapter.Session) error {
	if sess == nil {
		return fmt.Errorf("activecampaign: authenticated session is missing: %w", adapter.ErrAuth)
	}
	var identity struct {
		User json.RawMessage `json:"user"`
	}
	if err := a.do(ctx, *sess, http.MethodGet, "/users/me", nil, &identity); err != nil {
		return err
	}
	user := bytes.TrimSpace(identity.User)
	if len(user) < 2 || user[0] != '{' || user[len(user)-1] != '}' || bytes.Equal(user, []byte("{}")) {
		return fmt.Errorf("activecampaign: /users/me response is missing the authenticated user: %w", adapter.ErrAuth)
	}
	fingerprint, err := accountFingerprintFromAPIURL(sess.Extra["api_url"])
	if err != nil {
		return fmt.Errorf("activecampaign: establish account identity: %w", err)
	}
	sess.Extra[AccountFingerprintExtraKey] = fingerprint
	return nil
}

func activeCampaignHTTPClient(base *http.Client) *http.Client {
	if base == nil {
		base = http.DefaultClient
	}
	client := *base
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errActiveCampaignRedirect
	}
	return &client
}
