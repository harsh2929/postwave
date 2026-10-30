package ingest

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type netIPResolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

var defaultResolver netIPResolver = net.DefaultResolver

var nonPublicIPPrefixes = []netip.Prefix{
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
	netip.MustParsePrefix("255.255.255.255/32"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("::ffff:0:0/96"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

var windowsDrivePath = regexp.MustCompile(`^[A-Za-z]:[\\/]`)

// NormalizeParams trims URL/path fields before they are persisted or used.
func NormalizeParams(sourceType SourceType, params IngestParams) IngestParams {
	params.Extra = normalizeExtra(params.Extra)
	switch sourceType {
	case SourceBlogRSS:
		params.FeedURL = strings.TrimSpace(params.FeedURL)
	case SourceTwitter, SourceLinkedInExport:
		params.ArchivePath = strings.TrimSpace(params.ArchivePath)
		if sourceType == SourceLinkedInExport {
			params.RawText = strings.TrimSpace(params.RawText)
		}
	case SourcePasteIn, SourcePodcastTranscript:
		params.RawText = strings.TrimSpace(params.RawText)
	}
	return params
}

// ValidateParams rejects source parameters that could make the voice service
// fetch private network resources or read arbitrary local files.
func ValidateParams(ctx context.Context, sourceType SourceType, params IngestParams) error {
	return validateParams(ctx, defaultResolver, sourceType, NormalizeParams(sourceType, params))
}

func validateParams(ctx context.Context, resolver netIPResolver, sourceType SourceType, params IngestParams) error {
	params = NormalizeParams(sourceType, params)
	switch sourceType {
	case SourceBlogRSS:
		return validateRSSURL(ctx, resolver, params.FeedURL)
	case SourceTwitter:
		return validateTwitterParams(params)
	case SourceLinkedInExport:
		if params.RawText != "" {
			return nil
		}
		if params.ArchivePath == "" {
			return fmt.Errorf("linkedin: ArchivePath or RawText CSV required")
		}
		return validateArchivePath("linkedin", params.ArchivePath)
	case SourcePasteIn:
		if params.RawText == "" {
			return fmt.Errorf("paste_in: RawText required")
		}
		return nil
	case SourcePodcastTranscript:
		if params.RawText == "" {
			return fmt.Errorf("podcast: RawText transcript required")
		}
		return nil
	default:
		return nil
	}
}

func normalizeExtra(extra map[string]string) map[string]string {
	if len(extra) == 0 {
		return extra
	}
	out := make(map[string]string, len(extra))
	for key, value := range extra {
		out[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return out
}

func validateTwitterParams(params IngestParams) error {
	mode := strings.ToLower(strings.TrimSpace(params.Extra["mode"]))
	hasAPIIdentity := strings.TrimSpace(params.Extra["user_id"]) != "" ||
		strings.Trim(strings.TrimSpace(params.Extra["username"]), "@") != ""

	if mode == "api" || (mode == "" && hasAPIIdentity && params.ArchivePath == "") {
		if !hasAPIIdentity {
			return fmt.Errorf("twitter: api mode requires Extra[\"user_id\"] or Extra[\"username\"]")
		}
		return nil
	}
	if mode != "" && mode != "archive" {
		return fmt.Errorf("twitter: unsupported mode %q (use archive or api)", mode)
	}
	if params.ArchivePath == "" {
		return fmt.Errorf("twitter: ArchivePath required unless api mode provides user_id or username")
	}
	return validateArchivePath("twitter", params.ArchivePath)
}

func validateRSSURL(ctx context.Context, resolver netIPResolver, raw string) error {
	if raw == "" {
		return fmt.Errorf("rss: FeedURL required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("rss: invalid FeedURL: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("rss: FeedURL must use http or https")
	}
	if u.User != nil {
		return fmt.Errorf("rss: FeedURL must not contain user info")
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "" {
		return fmt.Errorf("rss: FeedURL host required")
	}
	if isLocalHostname(host) {
		return fmt.Errorf("rss: FeedURL host is not allowed")
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if !isPublicRoutableIP(addr) {
			return fmt.Errorf("rss: FeedURL host is not public")
		}
		return nil
	}
	if resolver == nil {
		return fmt.Errorf("rss: DNS resolver not configured")
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	addrs, err := resolver.LookupNetIP(lookupCtx, "ip", host)
	if err != nil {
		return fmt.Errorf("rss: resolve FeedURL host: %w", err)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("rss: FeedURL host resolved no addresses")
	}
	for _, addr := range addrs {
		if !isPublicRoutableIP(addr) {
			return fmt.Errorf("rss: FeedURL host resolves to non-public address")
		}
	}
	return nil
}

func isLocalHostname(host string) bool {
	return host == "localhost" ||
		host == "localhost.localdomain" ||
		strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".localdomain")
}

func isPublicRoutableIP(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || !addr.IsGlobalUnicast() {
		return false
	}
	for _, prefix := range nonPublicIPPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func validateArchivePath(sourceName, raw string) error {
	if sourceName == "" {
		sourceName = "archive"
	}
	if raw == "" {
		return nil
	}
	if strings.ContainsRune(raw, 0) {
		return fmt.Errorf("%s: ArchivePath contains NUL byte", sourceName)
	}
	if strings.Contains(raw, "://") {
		return fmt.Errorf("%s: ArchivePath must be a local relative path", sourceName)
	}
	normalized := strings.ReplaceAll(raw, "\\", "/")
	if filepath.IsAbs(raw) || path.IsAbs(normalized) || strings.HasPrefix(normalized, "//") || windowsDrivePath.MatchString(normalized) {
		return fmt.Errorf("%s: ArchivePath must be relative", sourceName)
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == ".." {
			return fmt.Errorf("%s: ArchivePath must not traverse directories", sourceName)
		}
	}
	clean := path.Clean(normalized)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../") {
		return fmt.Errorf("%s: ArchivePath must not traverse directories", sourceName)
	}
	return nil
}
