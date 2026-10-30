package archive

// Publish-input validation: length caps + URL-shape + SSRF guards for the
// admin publish surface (`AdminPublish`/`PublishCampaign`).
//
// Pre-fix `AdminPublish` only enforced a 256 KiB body cap (via the
// httpbody envelope) and a slug shape/reserved check (via
// `validateSlug`). The SEO knobs — `excerpt`, `meta_description`,
// `og_image`, `hero_image`, `author_name` — were silently accepted at
// any length, with any payload, including unvalidated URLs. The og_image
// in particular was an SSRF surface: the public archive page renders it
// into a `<meta property="og:image">` tag, which is fetched by
// Facebook/Twitter/Slack link-unfurl bots — but operators have also
// historically routed it through internal image proxies which would
// dereference an arbitrary URL server-side, e.g. `http://169.254.169.254`
// (AWS IMDS) or `http://localhost:6379` (a Redis instance on the same
// host).
//
// This file applies the same length/format conventions beehiiv/Substack/
// Buttondown enforce on their publish forms:
//
//   - Excerpt:           ≤ 280 chars (Twitter-card descender length).
//   - MetaDescription:   ≤ 160 chars (SEO best-practice; Google truncates
//                        at ~155 in SERPs, 160 leaves a 5-char headroom).
//   - AuthorName:        ≤ 100 chars (matches the `archive_author_name`
//                        column's effective practical bound + what
//                        Substack lets you type in the same field).
//   - OGImage,HeroImage: must `url.Parse` cleanly with scheme in
//                        {http, https}, and the hostname (after DNS-free
//                        IP literal parsing) must NOT be an RFC1918
//                        private address, loopback, link-local, or
//                        otherwise non-globally-routable. This is the
//                        SSRF guard.
//
// All errors are stable, exported `errPublish*` variables so the handler
// can map them to per-field `invalid_<field>` codes the desktop renders
// inline. Length values are exported constants so the desktop input
// counter can mirror the server-side cap without a magic number drift.

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

// Per-field length caps. Exported so the desktop input chips can read
// the same number the server enforces and the test suite can pin the
// boundary in one place.
const (
	// PublishExcerptMaxLen — Twitter card / OpenGraph description cap.
	// Substack and beehiiv both clamp around this length.
	PublishExcerptMaxLen = 280
	// PublishMetaDescriptionMaxLen — SEO meta-description cap. Google
	// truncates at ~155 in SERPs; 160 leaves a small headroom and
	// matches what Buttondown / Ghost enforce.
	PublishMetaDescriptionMaxLen = 160
	// PublishAuthorNameMaxLen — author name display cap. Matches what
	// Substack allows in the same field.
	PublishAuthorNameMaxLen = 100
	// PublishCanonicalURLMaxLen — `archive_canonical_url` is rendered
	// into a public `<link rel="canonical">` tag and (per IETF + de-
	// facto browser caps) a URL has no formal limit but 2 KiB is the
	// effective practical bound. Mirrors the CHECK constraint in
	// migration 0297.
	PublishCanonicalURLMaxLen = 2048
)

// Stable, per-field validation errors. The handler maps each to a
// `invalid_<field>` JSON error code so the desktop slideover can render
// the failure inline next to the offending input.
var (
	errPublishExcerptTooLong         = errors.New("archive: excerpt must be 280 characters or fewer")
	errPublishMetaDescriptionTooLong = errors.New("archive: meta description must be 160 characters or fewer")
	errPublishAuthorNameTooLong      = errors.New("archive: author name must be 100 characters or fewer")
	errPublishOGImageInvalid         = errors.New("archive: og_image must be an absolute http(s) URL to a public host")
	errPublishHeroImageInvalid       = errors.New("archive: hero_image must be an absolute http(s) URL to a public host")
	// errPublishCanonicalURLTooLong  — `archive_canonical_url` is capped
	// at 2048 chars by the DB CHECK constraint (migration 0297). We
	// reject anything longer here so the client sees a stable inline
	// error instead of a Postgres constraint-violation 500.
	errPublishCanonicalURLTooLong = errors.New("archive: canonical URL must be 2048 characters or fewer")
	// errPublishCanonicalURLInvalid — shape failure. Must be an
	// absolute http(s) URL. Unlike og_image / hero_image, we do NOT
	// reject private/loopback IPs here: a canonical URL is a HINT to
	// search engines, not a server-side fetch surface — the only
	// dereferencer is the recipient's browser (or Googlebot), which
	// will refuse to resolve a private IP from a public referrer
	// anyway. Operators legitimately want to point at staging or
	// localhost during testing.
	errPublishCanonicalURLInvalid = errors.New("archive: canonical_url must be an absolute http(s) URL")
)

// validatePublishInput runs every non-slug field check. Slug shape is
// owned by `validateSlug` (called separately in `PublishCampaign`) so
// the two error classes stay independently testable.
//
// Returns the first error encountered. We could collect-and-return all
// of them, but the desktop renders the inline error per-field on its
// own (it knows which input caused which code from the error code), so
// surfacing the first violation keeps the wire envelope compatible with
// `validateSlug`'s contract.
//
// Nil SEO pointers are treated as "leave column alone" — same semantics
// as `PublishCampaign` itself. Empty strings clear the column and are
// trivially valid (length 0 ≤ cap; image clears bypass URL parsing).
func validatePublishInput(in PublishInput) error {
	// Length checks: excerpt is always a string (not pointer) — empty
	// means "no excerpt set", non-empty is bounded.
	if len(in.Excerpt) > PublishExcerptMaxLen {
		return errPublishExcerptTooLong
	}
	if in.MetaDescription != nil && len(*in.MetaDescription) > PublishMetaDescriptionMaxLen {
		return errPublishMetaDescriptionTooLong
	}
	if in.AuthorName != nil && len(*in.AuthorName) > PublishAuthorNameMaxLen {
		return errPublishAuthorNameTooLong
	}
	// URL + SSRF checks. Nil pointer = leave alone; empty string =
	// clear column (both bypass parsing). Non-empty must parse.
	if in.OGImage != nil {
		if v := strings.TrimSpace(*in.OGImage); v != "" {
			if err := validatePublicImageURL(v); err != nil {
				return errPublishOGImageInvalid
			}
		}
	}
	if in.HeroImage != nil {
		if v := strings.TrimSpace(*in.HeroImage); v != "" {
			if err := validatePublicImageURL(v); err != nil {
				return errPublishHeroImageInvalid
			}
		}
	}
	// CanonicalURL: length-cap + scheme/abs check. Empty clears (no
	// shape check). See gap feature `archive-canonical-url`.
	if in.CanonicalURL != nil {
		if v := strings.TrimSpace(*in.CanonicalURL); v != "" {
			if len(v) > PublishCanonicalURLMaxLen {
				return errPublishCanonicalURLTooLong
			}
			if err := validateCanonicalURL(v); err != nil {
				return errPublishCanonicalURLInvalid
			}
		}
	}
	return nil
}

// validateCanonicalURL returns nil iff `raw` parses cleanly as an
// absolute http(s) URL with a non-empty host. The function is
// intentionally permissive about the host: a canonical URL is rendered
// into a `<link rel="canonical">` tag the client browser (or a search
// engine crawler) resolves, never the Moosewave API — so the SSRF
// guard that applies to og_image / hero_image does NOT apply here.
//
// Mirrors the database CHECK constraint `archive_canonical_url ~
// '^https?://[^ ]+$'` from migration 0297. We do a richer parse here
// (url.Parse + scheme check) so the error surfaced to the operator is
// `invalid_canonical_url` instead of a Postgres constraint-violation
// 500 leaking the regex.
func validateCanonicalURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("archive: malformed canonical URL")
	}
	if !u.IsAbs() {
		return errors.New("archive: canonical URL must be absolute")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return errors.New("archive: canonical URL scheme must be http or https")
	}
	if u.Host == "" {
		return errors.New("archive: canonical URL missing host")
	}
	// Reject embedded spaces — the DB regex also rejects them, but
	// catch them here for a friendlier message.
	if strings.ContainsAny(raw, " \t\n\r") {
		return errors.New("archive: canonical URL must not contain whitespace")
	}
	return nil
}

// firstImageRe captures the src of the first <img> tag in an HTML body.
// Deliberately permissive about attribute order/quoting — it only needs
// to find a plausible candidate; validatePublicImageURL is the gate.
var firstImageRe = regexp.MustCompile(`(?is)<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']`)

// firstImageURL (G21) returns the src of the first <img> in body that is
// a valid public absolute http(s) image URL, or "" if none qualifies.
// Used to auto-derive an og:image when the operator didn't set one, so
// shared campaign archive links get a social preview for free.
func firstImageURL(body string) string {
	for _, m := range firstImageRe.FindAllStringSubmatch(body, -1) {
		candidate := strings.TrimSpace(m[1])
		if candidate == "" {
			continue
		}
		if err := validatePublicImageURL(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// IsPublicImageURL reports whether raw is suitable for a public archive image
// reference. It intentionally shares the publish-time validation contract so
// downstream renderers can reject malformed legacy rows without duplicating
// the SSRF/private-network rules. Whitespace surrounding a stored URL is
// ignored, matching PublishCampaign's normalization boundary.
func IsPublicImageURL(raw string) bool {
	raw = strings.TrimSpace(raw)
	return raw != "" && validatePublicImageURL(raw) == nil
}

// validatePublicImageURL returns nil iff `raw` is an absolute http(s)
// URL whose host is either a globally-routable IP literal or a syntactically
// valid, fully-qualified DNS name. Private/loopback/link-local IP literals and
// the special IMDS `169.254.169.254` host are rejected. Credentials, invalid
// ports, and decoded URL controls are also rejected: accepted values cross a
// public rendering boundary in archive HTML, RSS, and JSON Feed.
//
// We intentionally do not resolve DNS here (request-time DNS resolution would
// be a separate latency budget
// and TOCTOU race against later fetches). Operators who proxy
// og_image through their own image transformer should configure that
// transformer's egress firewall to drop private-network responses;
// that's defence in depth on top of this literal check.
//
// Scheme is restricted to http and https — data:, file:, ftp: and the
// like have no legitimate use in a published OG image URL and are
// common SSRF/XSS pivots.
func validatePublicImageURL(raw string) error {
	if len(raw) > PublishCanonicalURLMaxLen || containsASCIIControl(raw) {
		return errors.New("archive: URL is too long or contains control characters")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("archive: malformed URL")
	}
	// Absolute, scheme-bearing URLs only — relative paths or
	// protocol-relative URLs are useless in an OG image meta tag.
	if !u.IsAbs() {
		return errors.New("archive: URL must be absolute")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return errors.New("archive: URL scheme must be http or https")
	}
	if u.Opaque != "" {
		return errors.New("archive: opaque URLs are not allowed")
	}
	if u.User != nil {
		return errors.New("archive: URL credentials are not allowed")
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("archive: URL missing host")
	}
	if err := validatePublicURLPort(u.Host); err != nil {
		return err
	}
	if containsASCIIControl(u.Path) || containsASCIIControl(u.Fragment) {
		return errors.New("archive: URL contains an escaped control character")
	}
	decodedQuery, err := url.QueryUnescape(u.RawQuery)
	if err != nil || containsASCIIControl(decodedQuery) {
		return errors.New("archive: URL contains a malformed query or escaped control character")
	}
	// IP-literal hosts: parse and reject any non-global address. DNS
	// names are checked syntactically without resolving them (see the
	// DNS/TOCTOU note above).
	if ip := net.ParseIP(host); ip != nil {
		if !isPubliclyRoutable(ip) {
			return errors.New("archive: URL host is a non-public IP")
		}
	} else if !validPublicImageDNSHost(host) {
		return errors.New("archive: URL host is not a valid public DNS name")
	}
	return nil
}

// validatePublicURLPort parses the authority itself instead of relying on
// url.URL.Port alone: Port returns an empty string for both "no port" and an
// invalid/empty port. IPv6 literals must remain bracketed and DNS hosts may
// carry one optional decimal port in the IANA range.
func validatePublicURLPort(authority string) error {
	port := ""
	switch {
	case strings.HasPrefix(authority, "["):
		closeBracket := strings.LastIndexByte(authority, ']')
		if closeBracket < 0 {
			return errors.New("archive: URL has a malformed IPv6 host")
		}
		suffix := authority[closeBracket+1:]
		if suffix == "" {
			return nil
		}
		if !strings.HasPrefix(suffix, ":") || len(suffix) == 1 {
			return errors.New("archive: URL has an invalid port")
		}
		port = suffix[1:]
	default:
		colon := strings.LastIndexByte(authority, ':')
		if colon < 0 {
			return nil
		}
		if strings.IndexByte(authority, ':') != colon || colon == len(authority)-1 {
			return errors.New("archive: URL has an invalid port")
		}
		port = authority[colon+1:]
	}

	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return errors.New("archive: URL has an invalid port")
	}
	return nil
}

func validPublicImageDNSHost(host string) bool {
	// A trailing root dot is valid DNS notation. Strip it for label checks but
	// retain the user's URL verbatim at the render boundary.
	host = strings.TrimSuffix(host, ".")
	ascii, err := idna.Lookup.ToASCII(host)
	if err != nil || ascii == "" || len(ascii) > 253 || !strings.Contains(ascii, ".") {
		return false
	}
	if strings.Trim(ascii, "0123456789.") == "" {
		// Reject legacy/ambiguous numeric host spellings such as 127.1 and
		// 0177.0.0.1 that some clients interpret as IP literals.
		return false
	}
	for _, label := range strings.Split(strings.ToLower(ascii), ".") {
		if len(label) == 0 || len(label) > 63 || !isASCIILetterOrDigit(label[0]) ||
			!isASCIILetterOrDigit(label[len(label)-1]) {
			return false
		}
		for i := 1; i < len(label)-1; i++ {
			if !isASCIILetterOrDigit(label[i]) && label[i] != '-' {
				return false
			}
		}
	}
	return true
}

func isASCIILetterOrDigit(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9'
}

func containsASCIIControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// isPubliclyRoutable returns true iff `ip` is a globally-routable
// internet address. Rejects:
//
//   - Loopback           (127.0.0.0/8, ::1)
//   - Link-local         (169.254.0.0/16, fe80::/10) — covers AWS IMDS
//   - Private RFC1918    (10/8, 172.16/12, 192.168/16) and IPv6 ULA
//   - Multicast          (224.0.0.0/4, ff00::/8)
//   - Unspecified        (0.0.0.0, ::)
//
// The set mirrors what Go 1.21+'s `(net.IP).IsPrivate` /
// `IsLoopback` / `IsLinkLocalUnicast` / `IsMulticast` /
// `IsUnspecified` report, plus an explicit check for the IPv4
// link-local AWS IMDS address so an operator's homegrown literal
// can't slip past via an unusual zero-padded form.
func isPubliclyRoutable(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() ||
		ip.IsInterfaceLocalMulticast() {
		return false
	}
	return true
}
