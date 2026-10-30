// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/assets"
)

const (
	PreviewProviderReallyGoodEmails = "really_good_emails"
	PreviewProviderAuraBuild        = "aura_build"
	reallyGoodEmailsPreviewHost     = "pro-really-good-emails.s3.eu-west-1.amazonaws.com"
	auraBuildPreviewHost            = "hoirqrkdgbmvpwutwuwj.supabase.co"
	auraBuildLegacyPreviewHost      = "hoirqrkdgbmvpwutwuwj-all.supabase.co"
	auraPreviewImagesPathPrefix     = "/storage/v1/object/public/preview-images/"
	auraChatThumbnailsPathPrefix    = "/storage/v1/object/public/chat-thumbnails/"
	defaultPreviewFetchTimeout      = 20 * time.Second
	defaultPreviewDialTimeout       = 5 * time.Second
	maxPreviewRedirects             = 3
)

var (
	ErrPreviewSourceRejected    = errors.New("campaign template preview source rejected")
	ErrPreviewSourceUnavailable = errors.New("campaign template preview source unavailable")
	ErrPreviewSourceMissing     = errors.New("campaign template preview source missing")
	ErrPreviewWrongMIME         = errors.New("campaign template preview source has unsupported MIME")
	ErrPreviewOversize          = errors.New("campaign template preview source exceeds byte limit")
	ErrPreviewInvalidImage      = errors.New("campaign template preview source is not a valid image")
)

// PreviewDNSResolver is deliberately small so DNS rebinding behaviour can be
// tested without touching the process-wide resolver.
type PreviewDNSResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// PreviewSourceGuard owns the provider/host allowlist and public-IP boundary.
// Validation is repeated before every redirect and again by DialContext so the
// actual connection cannot silently use an unvetted DNS answer.
type PreviewSourceGuard struct {
	Resolver PreviewDNSResolver
	Dialer   *net.Dialer
}

func NewPreviewSourceGuard(resolver PreviewDNSResolver) *PreviewSourceGuard {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	return &PreviewSourceGuard{
		Resolver: resolver,
		Dialer: &net.Dialer{
			Timeout:   defaultPreviewDialTimeout,
			KeepAlive: 30 * time.Second,
		},
	}
}

func (g *PreviewSourceGuard) Validate(ctx context.Context, provider, rawURL string) (*url.URL, error) {
	parsed, err := validatePreviewSourceStructure(provider, rawURL)
	if err != nil {
		return nil, err
	}
	if _, err := g.resolvePublic(ctx, parsed.Hostname()); err != nil {
		return nil, err
	}
	return parsed, nil
}

// DialContext is suitable for http.Transport.DialContext. It resolves the
// original allowlisted hostname itself, rejects every non-public result, and
// dials a vetted address directly. TLS still receives the URL hostname from
// http.Transport for SNI and certificate verification.
func (g *PreviewSourceGuard) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if g == nil {
		return nil, fmt.Errorf("%w: source guard is not configured", ErrPreviewSourceRejected)
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" || !allowedPreviewHost(host) {
		return nil, fmt.Errorf("%w: dial target is outside the provider allowlist", ErrPreviewSourceRejected)
	}
	addresses, err := g.resolvePublic(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := g.Dialer
	if dialer == nil {
		dialer = &net.Dialer{Timeout: defaultPreviewDialTimeout, KeepAlive: 30 * time.Second}
	}
	var dialErrors []error
	for _, candidate := range addresses {
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.String(), port))
		if dialErr == nil {
			return conn, nil
		}
		dialErrors = append(dialErrors, dialErr)
	}
	return nil, fmt.Errorf("%w: %v", ErrPreviewSourceUnavailable, errors.Join(dialErrors...))
}

func (g *PreviewSourceGuard) resolvePublic(ctx context.Context, host string) ([]netip.Addr, error) {
	if g == nil || g.Resolver == nil {
		return nil, fmt.Errorf("%w: DNS resolver is not configured", ErrPreviewSourceUnavailable)
	}
	if !allowedPreviewHost(host) {
		return nil, fmt.Errorf("%w: hostname is outside the provider allowlist", ErrPreviewSourceRejected)
	}
	resolved, err := g.Resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("%w: DNS lookup failed: %v", ErrPreviewSourceUnavailable, err)
	}
	if len(resolved) == 0 {
		return nil, fmt.Errorf("%w: DNS returned no addresses", ErrPreviewSourceUnavailable)
	}
	if len(resolved) > 16 {
		return nil, fmt.Errorf("%w: DNS returned too many addresses", ErrPreviewSourceRejected)
	}
	addresses := make([]netip.Addr, 0, len(resolved))
	for _, item := range resolved {
		if item.Zone != "" {
			return nil, fmt.Errorf("%w: scoped DNS address", ErrPreviewSourceRejected)
		}
		address, ok := netip.AddrFromSlice(item.IP)
		if !ok {
			return nil, fmt.Errorf("%w: invalid DNS address", ErrPreviewSourceRejected)
		}
		address = address.Unmap()
		if !isPublicPreviewIP(address) {
			return nil, fmt.Errorf("%w: DNS resolved to a non-public address", ErrPreviewSourceRejected)
		}
		addresses = append(addresses, address)
	}
	return addresses, nil
}

func validatePreviewSourceStructure(provider, rawURL string) (*url.URL, error) {
	if provider != PreviewProviderReallyGoodEmails && provider != PreviewProviderAuraBuild {
		return nil, fmt.Errorf("%w: unsupported provider", ErrPreviewSourceRejected)
	}
	if len(rawURL) == 0 || len(rawURL) > 4096 {
		return nil, fmt.Errorf("%w: invalid URL length", ErrPreviewSourceRejected)
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || !parsed.IsAbs() || parsed.Opaque != "" {
		return nil, fmt.Errorf("%w: invalid absolute URL", ErrPreviewSourceRejected)
	}
	if parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" || parsed.Port() != "" {
		return nil, fmt.Errorf("%w: HTTPS URL without credentials, fragment, or explicit port required", ErrPreviewSourceRejected)
	}
	if !previewProviderAllowsHost(provider, parsed.Hostname()) {
		return nil, fmt.Errorf("%w: hostname is outside the provider allowlist", ErrPreviewSourceRejected)
	}
	if !previewProviderAllowsPath(provider, parsed.Path) ||
		path.Clean(parsed.Path) != parsed.Path || strings.Contains(parsed.Path, `\`) ||
		strings.Contains(strings.ToLower(parsed.EscapedPath()), "%5c") {
		return nil, fmt.Errorf("%w: source path is outside the preview prefix", ErrPreviewSourceRejected)
	}
	if provider == PreviewProviderAuraBuild && !validAuraPreviewQuery(parsed) {
		return nil, fmt.Errorf("%w: unsupported Aura preview query", ErrPreviewSourceRejected)
	}
	// Aura still exposes a legacy project-qualified hostname in public catalog
	// rows, but the same public object is served from the current project host.
	// Canonicalize only after validating the exact legacy hostname and bucket;
	// this preserves observed source_url provenance while making the fetch use
	// Aura's working public storage origin.
	if provider == PreviewProviderAuraBuild &&
		strings.EqualFold(parsed.Hostname(), auraBuildLegacyPreviewHost) {
		parsed.Host = auraBuildPreviewHost
	}
	return parsed, nil
}

func allowedPreviewHost(host string) bool {
	return (strings.EqualFold(host, reallyGoodEmailsPreviewHost) ||
		auraBuildAllowsPreviewHost(host)) && !strings.HasSuffix(host, ".")
}

func previewProviderAllowsHost(provider, host string) bool {
	switch provider {
	case PreviewProviderReallyGoodEmails:
		return strings.EqualFold(host, reallyGoodEmailsPreviewHost) &&
			!strings.HasSuffix(host, ".")
	case PreviewProviderAuraBuild:
		return auraBuildAllowsPreviewHost(host) && !strings.HasSuffix(host, ".")
	default:
		return false
	}
}

func auraBuildAllowsPreviewHost(host string) bool {
	return strings.EqualFold(host, auraBuildPreviewHost) ||
		strings.EqualFold(host, auraBuildLegacyPreviewHost)
}

func previewProviderAllowsPath(provider, sourcePath string) bool {
	switch provider {
	case PreviewProviderReallyGoodEmails:
		return strings.HasPrefix(sourcePath, "/emails/") && sourcePath != "/emails/"
	case PreviewProviderAuraBuild:
		return (strings.HasPrefix(sourcePath, auraPreviewImagesPathPrefix) &&
			sourcePath != auraPreviewImagesPathPrefix) ||
			(strings.HasPrefix(sourcePath, auraChatThumbnailsPathPrefix) &&
				sourcePath != auraChatThumbnailsPathPrefix)
	default:
		return false
	}
}

// Aura's public catalog currently appends only a decimal `t` cache-buster to
// some object URLs. Reject every other query shape so a catalog record cannot
// opt the fetcher into a Supabase transformation or download behaviour.
func validAuraPreviewQuery(parsed *url.URL) bool {
	if parsed == nil || parsed.ForceQuery {
		return false
	}
	if parsed.RawQuery == "" {
		return true
	}
	const prefix = "t="
	if !strings.HasPrefix(parsed.RawQuery, prefix) {
		return false
	}
	value := strings.TrimPrefix(parsed.RawQuery, prefix)
	if len(value) == 0 || len(value) > 20 {
		return false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

var previewBlockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:10::/28"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

func isPublicPreviewIP(address netip.Addr) bool {
	if !address.IsValid() {
		return false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() ||
		address.IsLinkLocalUnicast() || address.IsMulticast() || address.IsUnspecified() {
		return false
	}
	for _, blocked := range previewBlockedPrefixes {
		if blocked.Contains(address) {
			return false
		}
	}
	return true
}

// FetchedPreview contains only bytes returned by the canonical asset
// sanitizer; raw upstream response bytes never cross the storage boundary.
type FetchedPreview struct {
	Body          []byte
	MIME          string
	Width         int
	Height        int
	ContentSHA256 string
}

// PreviewFetcher performs a bounded, redirect-aware fetch. Construct it with
// NewPreviewFetcher in production; Client remains injectable for deterministic
// tests while Guard validation still runs for every hop.
type PreviewFetcher struct {
	Guard    *PreviewSourceGuard
	Client   *http.Client
	MaxBytes int64
	Timeout  time.Duration
}

func NewPreviewFetcher(resolver PreviewDNSResolver) *PreviewFetcher {
	guard := NewPreviewSourceGuard(resolver)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = guard.DialContext
	transport.DialTLSContext = nil
	transport.DisableCompression = true
	transport.ForceAttemptHTTP2 = false
	transport.TLSHandshakeTimeout = defaultPreviewDialTimeout
	transport.ResponseHeaderTimeout = 10 * time.Second
	transport.MaxResponseHeaderBytes = 64 * 1024
	transport.ExpectContinueTimeout = time.Second
	transport.MaxIdleConns = 20
	transport.MaxIdleConnsPerHost = 4
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	return &PreviewFetcher{
		Guard:    guard,
		Client:   &http.Client{Transport: transport},
		MaxBytes: assets.MaxBytes,
		Timeout:  defaultPreviewFetchTimeout,
	}
}

func (f *PreviewFetcher) Fetch(ctx context.Context, provider, rawURL string) (*FetchedPreview, error) {
	if f == nil || f.Guard == nil || f.Client == nil {
		return nil, fmt.Errorf("%w: fetcher is not configured", ErrPreviewSourceUnavailable)
	}
	timeout := f.Timeout
	if timeout <= 0 {
		timeout = defaultPreviewFetchTimeout
	}
	fetchCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	parsed, err := f.Guard.Validate(fetchCtx, provider, rawURL)
	if err != nil {
		return nil, err
	}
	maxBytes := f.MaxBytes
	if maxBytes <= 0 || maxBytes > assets.MaxBytes {
		maxBytes = assets.MaxBytes
	}
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, parsed.String(), http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("%w: request construction failed", ErrPreviewSourceRejected)
	}
	req.Header.Set("Accept", "image/png,image/jpeg,image/gif,image/webp")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "PostwavePreviewIngest/1.0")

	client := *f.Client
	client.CheckRedirect = func(redirect *http.Request, via []*http.Request) error {
		if len(via) > maxPreviewRedirects {
			return fmt.Errorf("%w: redirect limit exceeded", ErrPreviewSourceRejected)
		}
		_, validationErr := f.Guard.Validate(redirect.Context(), provider, redirect.URL.String())
		return validationErr
	}
	response, err := client.Do(req)
	if err != nil {
		if errors.Is(err, ErrPreviewSourceRejected) || errors.Is(err, ErrPreviewSourceUnavailable) {
			return nil, err
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("%w: fetch deadline exceeded", ErrPreviewSourceUnavailable)
		}
		return nil, fmt.Errorf("%w: request failed: %v", ErrPreviewSourceUnavailable, err)
	}
	defer func() { _ = response.Body.Close() }()

	switch {
	case response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone:
		return nil, fmt.Errorf("%w: upstream returned %d", ErrPreviewSourceMissing, response.StatusCode)
	case response.StatusCode == http.StatusRequestTimeout ||
		response.StatusCode == http.StatusTooEarly ||
		response.StatusCode == http.StatusTooManyRequests ||
		response.StatusCode >= 500:
		return nil, fmt.Errorf("%w: upstream returned %d", ErrPreviewSourceUnavailable, response.StatusCode)
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return nil, fmt.Errorf("%w: upstream returned %d", ErrPreviewSourceRejected, response.StatusCode)
	}
	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" &&
		!strings.EqualFold(encoding, "identity") {
		return nil, fmt.Errorf("%w: encoded response bodies are not accepted", ErrPreviewWrongMIME)
	}
	declaredMIME, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || !allowedPreviewMIME(declaredMIME) {
		return nil, ErrPreviewWrongMIME
	}
	if response.ContentLength > maxBytes {
		return nil, ErrPreviewOversize
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: response body read failed: %v", ErrPreviewSourceUnavailable, err)
	}
	if int64(len(body)) > maxBytes {
		return nil, ErrPreviewOversize
	}
	sanitized, err := assets.ValidateAndSanitizeUpload(fetchCtx, body)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("%w: image validation deadline exceeded", ErrPreviewSourceUnavailable)
		}
		return nil, ErrPreviewInvalidImage
	}
	if sanitized.MIME != declaredMIME {
		return nil, fmt.Errorf("%w: declared and decoded MIME differ", ErrPreviewWrongMIME)
	}
	digest := sha256.Sum256(sanitized.Body)
	return &FetchedPreview{
		Body:          sanitized.Body,
		MIME:          sanitized.MIME,
		Width:         sanitized.Width,
		Height:        sanitized.Height,
		ContentSHA256: hex.EncodeToString(digest[:]),
	}, nil
}

func allowedPreviewMIME(value string) bool {
	switch value {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}
