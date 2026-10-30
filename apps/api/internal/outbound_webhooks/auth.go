// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"golang.org/x/net/http/httpguts"
)

// AuthConfig describes receiver-side authentication applied by the
// delivery worker after Moosewave signing headers are set. Credential fields
// are write-only. Read APIs return only the configured-method booleans and
// custom-header names below; they never return placeholder or secret values.
type AuthConfig struct {
	Type             string            `json:"type,omitempty"`
	BearerToken      string            `json:"bearer_token,omitempty"`
	Headers          map[string]string `json:"headers,omitempty"`
	MTLSCertPEM      string            `json:"mtls_cert_pem,omitempty"`
	MTLSKeyPEM       string            `json:"mtls_key_pem,omitempty"`
	BearerConfigured bool              `json:"bearer_configured,omitempty"`
	HeaderNames      []string          `json:"header_names,omitempty"`
	MTLSConfigured   bool              `json:"mtls_configured,omitempty"`
	SecretRedacted   bool              `json:"secret_redacted,omitempty"`
}

const (
	authConfigStateReady         = "ready"
	authConfigStateLegacyPending = "legacy_pending"
	authConfigStateInvalid       = "invalid"
	storedAuthMetadataType       = "encrypted"

	maxAuthHeaders         = 32
	maxAuthCredentialBytes = 64 << 10
	maxAuthEnvelopeBytes   = 256 << 10
)

var reservedAuthHeaderNames = map[string]struct{}{
	"connection":               {},
	"content-length":           {},
	"content-type":             {},
	"expect":                   {},
	"host":                     {},
	"keep-alive":               {},
	"proxy-authorization":      {},
	"proxy-connection":         {},
	"te":                       {},
	"trailer":                  {},
	"transfer-encoding":        {},
	"upgrade":                  {},
	"user-agent":               {},
	"x-postwave-signature":     {},
	"x-postwave-key-id":        {},
	"x-postwave-event":         {},
	"x-postwave-event-id":      {},
	"x-postwave-delivery":      {},
	"x-postwave-test":          {},
	"postwave-signature":       {},
	"postwave-event":           {},
	"postwave-idempotency-key": {},
}

// encodeAuthConfig serializes the credential-bearing representation that must
// only ever be passed to Store.Cipher.Encrypt. It must never be written to a
// JSON/JSONB metadata column.
func encodeAuthConfig(in *AuthConfig) ([]byte, error) {
	cfg, err := normalizeAuthConfig(in)
	if err != nil {
		return nil, err
	}
	if cfg == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(cfg)
}

// normalizeAuthHeaders canonicalizes and validates the custom header map of
// an AuthConfig: names must be valid, non-reserved header fields, values must
// be non-empty valid field values, and canonicalization must not collapse two
// keys onto one. It returns nil (not an empty map) when no headers were given
// so callers keep distinguishing "none" by length alone.
func normalizeAuthHeaders(in map[string]string) (map[string]string, error) {
	if len(in) > maxAuthHeaders {
		return nil, errors.New("auth_config: too many custom headers")
	}
	var out map[string]string
	for k, v := range in {
		rawName := strings.TrimSpace(k)
		if !httpguts.ValidHeaderFieldName(rawName) {
			return nil, errors.New("auth_config: invalid header name")
		}
		name := http.CanonicalHeaderKey(rawName)
		if _, reserved := reservedAuthHeaderNames[strings.ToLower(name)]; reserved {
			return nil, errors.New("auth_config: reserved header " + name)
		}
		value := strings.TrimSpace(v)
		if value == "" || !httpguts.ValidHeaderFieldValue(value) {
			return nil, errors.New("auth_config: invalid value for header " + name)
		}
		if out == nil {
			out = map[string]string{}
		}
		if _, duplicate := out[name]; duplicate {
			return nil, errors.New("auth_config: duplicate header " + name)
		}
		out[name] = value
	}
	return out, nil
}

func normalizeAuthConfig(in *AuthConfig) (*AuthConfig, error) {
	if in == nil {
		return nil, nil
	}
	if in.SecretRedacted || in.BearerConfigured || in.MTLSConfigured || len(in.HeaderNames) > 0 {
		return nil, errors.New("auth_config: redacted read metadata cannot be used as credentials")
	}
	out := &AuthConfig{
		Type:        strings.ToLower(strings.TrimSpace(in.Type)),
		BearerToken: strings.TrimSpace(in.BearerToken),
		MTLSCertPEM: strings.TrimSpace(in.MTLSCertPEM),
		MTLSKeyPEM:  strings.TrimSpace(in.MTLSKeyPEM),
	}
	headers, headersErr := normalizeAuthHeaders(in.Headers)
	if headersErr != nil {
		return nil, headersErr
	}
	out.Headers = headers
	switch out.Type {
	case "", "none", "bearer", "headers", "custom_headers", "mtls", "combined":
	default:
		return nil, errors.New("auth_config: unsupported type")
	}
	if out.Type == "none" {
		if out.BearerToken != "" || len(out.Headers) > 0 || out.MTLSCertPEM != "" || out.MTLSKeyPEM != "" {
			return nil, errors.New("auth_config: type none cannot include credentials")
		}
		return nil, nil
	}
	hasCredentials := out.BearerToken != "" ||
		len(out.Headers) > 0 ||
		out.MTLSCertPEM != "" ||
		out.MTLSKeyPEM != ""
	if !hasCredentials && out.Type == "" {
		return nil, nil
	}
	if !hasCredentials {
		return nil, errors.New("auth_config: explicit authentication type requires complete credentials; use null or type none to clear")
	}
	if (out.MTLSCertPEM == "") != (out.MTLSKeyPEM == "") {
		return nil, errors.New("auth_config: mtls_cert_pem and mtls_key_pem must be supplied together")
	}
	if out.BearerToken != "" && !httpguts.ValidHeaderFieldValue("Bearer "+out.BearerToken) {
		return nil, errors.New("auth_config: invalid bearer token")
	}
	if out.MTLSCertPEM != "" {
		if _, err := tls.X509KeyPair([]byte(out.MTLSCertPEM), []byte(out.MTLSKeyPEM)); err != nil {
			return nil, errors.New("auth_config: invalid mTLS certificate or private key")
		}
	}
	if out.BearerToken != "" {
		if _, hasAuthorization := out.Headers["Authorization"]; hasAuthorization {
			return nil, errors.New("auth_config: bearer_token conflicts with Authorization header")
		}
	}
	if out.Type == "" {
		methods := 0
		if out.BearerToken != "" {
			out.Type = "bearer"
			methods++
		}
		if len(out.Headers) > 0 {
			out.Type = "headers"
			methods++
		}
		if out.MTLSCertPEM != "" {
			out.Type = "mtls"
			methods++
		}
		if methods > 1 {
			out.Type = "combined"
		}
	}
	switch out.Type {
	case "bearer":
		if out.BearerToken == "" || len(out.Headers) > 0 || out.MTLSCertPEM != "" {
			return nil, errors.New("auth_config: bearer type requires only bearer_token")
		}
	case "headers", "custom_headers":
		if len(out.Headers) == 0 || out.BearerToken != "" || out.MTLSCertPEM != "" {
			return nil, errors.New("auth_config: headers type requires only custom headers")
		}
	case "mtls":
		if out.MTLSCertPEM == "" || out.BearerToken != "" || len(out.Headers) > 0 {
			return nil, errors.New("auth_config: mtls type requires only a certificate and private key")
		}
	case "combined":
		// Any one or more valid methods may be used. Keeping "combined" valid
		// for a single method preserves the existing API contract.
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	if len(encoded) > maxAuthCredentialBytes {
		return nil, errors.New("auth_config: credentials exceed size limit")
	}
	return out, nil
}

func decodeAuthConfig(raw []byte, redact bool) (*AuthConfig, error) {
	if len(raw) == 0 || string(raw) == "{}" || string(raw) == "null" {
		return nil, nil
	}
	var cfg AuthConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, err
	}
	norm, err := normalizeAuthConfig(&cfg)
	if err != nil {
		return nil, err
	}
	if redact {
		return redactAuthConfig(norm), nil
	}
	return norm, nil
}

func redactAuthConfig(in *AuthConfig) *AuthConfig {
	if in == nil {
		return nil
	}
	names := make([]string, 0, len(in.Headers))
	for name := range in.Headers {
		names = append(names, http.CanonicalHeaderKey(name))
	}
	sort.Strings(names)
	hasBearer := in.BearerToken != "" || in.BearerConfigured
	hasMTLS := in.MTLSCertPEM != "" || in.MTLSKeyPEM != "" || in.MTLSConfigured
	hasSecrets := hasBearer || hasMTLS || len(names) > 0 || len(in.HeaderNames) > 0
	if len(names) == 0 && len(in.HeaderNames) > 0 {
		names = append(names, in.HeaderNames...)
		sort.Strings(names)
	}
	return &AuthConfig{
		Type:             in.Type,
		BearerConfigured: hasBearer,
		HeaderNames:      names,
		MTLSConfigured:   hasMTLS,
		SecretRedacted:   hasSecrets,
	}
}

// encodeAuthMetadata returns the only representation permitted in the public
// auth_config JSONB column.
func encodeAuthMetadata(in *AuthConfig) ([]byte, error) {
	if in == nil {
		return []byte("{}"), nil
	}
	public := redactAuthConfig(in)
	return json.Marshal(struct {
		Type             string   `json:"type"`
		ConfiguredType   string   `json:"configured_type,omitempty"`
		BearerConfigured bool     `json:"bearer_configured,omitempty"`
		HeaderNames      []string `json:"header_names,omitempty"`
		MTLSConfigured   bool     `json:"mtls_configured,omitempty"`
		SecretRedacted   bool     `json:"secret_redacted,omitempty"`
	}{
		Type:             storedAuthMetadataType,
		ConfiguredType:   public.Type,
		BearerConfigured: public.BearerConfigured,
		HeaderNames:      public.HeaderNames,
		MTLSConfigured:   public.MTLSConfigured,
		SecretRedacted:   public.SecretRedacted,
	})
}

// decodePublicAuthMetadata projects either current safe metadata or a legacy
// plaintext row into a value-free response. It intentionally never returns an
// error: malformed legacy data must remain operable enough for an administrator
// to replace it, without making List/Get leak or fail wholesale.
func decodePublicAuthMetadata(raw []byte) *AuthConfig {
	if len(raw) == 0 || string(raw) == "{}" || string(raw) == "null" {
		return nil
	}
	var stored struct {
		AuthConfig
		ConfiguredType string `json:"configured_type,omitempty"`
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		return &AuthConfig{SecretRedacted: true}
	}
	public := redactAuthConfig(&stored.AuthConfig)
	if public.Type == storedAuthMetadataType {
		public.Type = stored.ConfiguredType
	}
	return public
}

func authMetadataClaimsCredentials(raw []byte) bool {
	if len(raw) == 0 || string(raw) == "{}" || string(raw) == "null" {
		return false
	}
	var cfg AuthConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return true
	}
	return cfg.BearerConfigured || cfg.MTLSConfigured || cfg.SecretRedacted ||
		len(cfg.HeaderNames) > 0 || cfg.BearerToken != "" || len(cfg.Headers) > 0 ||
		cfg.MTLSCertPEM != "" || cfg.MTLSKeyPEM != ""
}

func authMetadataContainsCredentialValues(raw []byte) bool {
	if len(raw) == 0 || string(raw) == "{}" || string(raw) == "null" {
		return false
	}
	var cfg AuthConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return true
	}
	return cfg.BearerToken != "" || len(cfg.Headers) > 0 ||
		cfg.MTLSCertPEM != "" || cfg.MTLSKeyPEM != ""
}

func authMetadataIsEncrypted(raw []byte) bool {
	var metadata struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return false
	}
	return metadata.Type == storedAuthMetadataType
}

func applyAuthConfig(req *http.Request, cfg *AuthConfig) {
	if req == nil || cfg == nil {
		return
	}
	if cfg.BearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.BearerToken)
	}
	for name, value := range cfg.Headers {
		if name == "" {
			continue
		}
		if _, reserved := reservedAuthHeaderNames[strings.ToLower(name)]; reserved {
			continue
		}
		req.Header.Set(name, value)
	}
}

// clientCertificateTransport is implemented by transport stacks that can
// rebuild themselves around a cloned *http.Transport. This matters in
// production, where the SSRF-safe base transport is wrapped by OpenTelemetry:
// a direct type assertion to *http.Transport would otherwise make every mTLS
// delivery fail before it reached the receiver.
type clientCertificateTransport interface {
	http.RoundTripper
	withClientCertificate(tls.Certificate) (http.RoundTripper, error)
}

type composableClientTransport struct {
	base    *http.Transport
	wrap    func(http.RoundTripper) http.RoundTripper
	current http.RoundTripper
}

// NewClientCertificateCapableTransport keeps an instrumented transport
// cloneable for per-destination mTLS while preserving the original wrapper
// (for example OpenTelemetry) and the SSRF-safe dialer beneath it.
func NewClientCertificateCapableTransport(
	base *http.Transport,
	wrap func(http.RoundTripper) http.RoundTripper,
) http.RoundTripper {
	if base == nil {
		if defaultTransport, ok := http.DefaultTransport.(*http.Transport); ok {
			base = defaultTransport.Clone()
		} else {
			base = &http.Transport{}
		}
	}
	transport := http.RoundTripper(base)
	if wrap != nil {
		transport = wrap(base)
	}
	return &composableClientTransport{
		base:    base,
		wrap:    wrap,
		current: transport,
	}
}

func (t *composableClientTransport) RoundTrip(
	req *http.Request,
) (*http.Response, error) {
	if t == nil || t.current == nil {
		return nil, errors.New("auth_config: receiver transport is unavailable")
	}
	return t.current.RoundTrip(req)
}

func (t *composableClientTransport) withClientCertificate(
	cert tls.Certificate,
) (http.RoundTripper, error) {
	if t == nil || t.base == nil {
		return nil, errors.New("auth_config: receiver transport is unavailable")
	}
	clone := t.base.Clone()
	if clone.TLSClientConfig == nil {
		clone.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	} else {
		clone.TLSClientConfig = clone.TLSClientConfig.Clone()
		if clone.TLSClientConfig.MinVersion < tls.VersionTLS12 {
			clone.TLSClientConfig.MinVersion = tls.VersionTLS12
		}
	}
	clone.TLSClientConfig.Certificates = append(
		clone.TLSClientConfig.Certificates,
		cert,
	)
	return NewClientCertificateCapableTransport(clone, t.wrap), nil
}

func clientWithAuth(base *http.Client, cfg *AuthConfig) (*http.Client, error) {
	if cfg == nil || cfg.MTLSCertPEM == "" {
		return base, nil
	}
	cert, err := tls.X509KeyPair([]byte(cfg.MTLSCertPEM), []byte(cfg.MTLSKeyPEM))
	if err != nil {
		return nil, err
	}
	if base == nil {
		base = NewSecureHTTPClient(nil)
	}
	var transport http.RoundTripper
	switch rt := base.Transport.(type) {
	case clientCertificateTransport:
		transport, err = rt.withClientCertificate(cert)
	case *http.Transport:
		clone := rt.Clone()
		if clone.TLSClientConfig == nil {
			clone.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		} else {
			clone.TLSClientConfig = clone.TLSClientConfig.Clone()
			if clone.TLSClientConfig.MinVersion < tls.VersionTLS12 {
				clone.TLSClientConfig.MinVersion = tls.VersionTLS12
			}
		}
		clone.TLSClientConfig.Certificates = append(clone.TLSClientConfig.Certificates, cert)
		transport = clone
	default:
		return nil, errors.New("auth_config: mTLS requires a client-certificate-capable transport")
	}
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Timeout:       firstDuration(base.Timeout, 10*time.Second),
		Transport:     transport,
		CheckRedirect: base.CheckRedirect,
		Jar:           base.Jar,
	}, nil
}

func firstDuration(v, fallback time.Duration) time.Duration {
	if v > 0 {
		return v
	}
	return fallback
}

func signingKeyFingerprint(algorithm string, material []byte) string {
	sum := sha256.Sum256(append([]byte(algorithm+":"), material...))
	return hex.EncodeToString(sum[:8])
}
