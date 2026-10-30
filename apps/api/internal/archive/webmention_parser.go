// SPDX-License-Identifier: AGPL-3.0-only
//
// webmention_parser.go — the real WebmentionParser that the worker
// (webmention_worker.go) drives. Replaces the noop scaffold: it fetches
// the claimed `source` page over an SSRF-guarded client, verifies the
// `target` is actually linked from it (the Webmention spec REQUIRES this,
// otherwise any site could spam an inbox), and extracts the page title +
// h-card author microformats so the operator's promote slideover has
// something to show.
//
// Error contract with the worker loop (see drainBatch):
//
//   - A PERMANENT failure (4xx, non-HTML body, unparseable HTML) returns a
//     plain error → the worker marks the inbox row 'rejected'.
//   - The "target not linked" case is NOT an error: we return a result with
//     LinkVerified=false and the worker rejects it (same outcome, but the
//     distinction keeps the parser's error channel for genuine faults).
//   - A TRANSIENT failure (dial error, timeout, 5xx, 429) is wrapped as the
//     worker's errParserDeferred sentinel so the row is LEFT PENDING and
//     re-claimed on the next tick — matching the spec's retry guidance and
//     requiring zero changes to the committed worker loop.

package archive

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// defaultMaxSourceBytes caps how much of a source page we read into the
// HTML parser. 2 MiB is generous for a blog post yet bounds memory against
// a hostile or runaway source. The fetch is also wall-clock bounded by the
// client timeout.
const defaultMaxSourceBytes = 2 << 20

// httpWebmentionParser is the production WebmentionParser. The client is a
// struct field (not a package global) so tests can inject an httptest
// client that legitimately dials 127.0.0.1 — the SSRF-guarded production
// client refuses non-public addresses and so cannot reach a test server.
type httpWebmentionParser struct {
	client   *http.Client
	maxBytes int64
}

// newHTTPWebmentionParser builds the production parser with the
// SSRF-guarded client.
func newHTTPWebmentionParser() *httpWebmentionParser {
	return &httpWebmentionParser{
		client:   newSafeFetchClient(),
		maxBytes: defaultMaxSourceBytes,
	}
}

// Parse implements WebmentionParser. See the file header for the error
// contract with the worker loop.
func (p *httpWebmentionParser) Parse(ctx context.Context, source, target string) (WebmentionParseResult, error) {
	// Validate the source URL shape. The REAL SSRF protection is the
	// connect-time dialer in newSafeFetchClient (it refuses private IPs and
	// is immune to DNS rebinding, which a hostname pre-check cannot be), so
	// we do not duplicate an IP-literal pre-check here — that would also
	// make the client non-injectable for tests.
	su, err := url.Parse(source)
	if err != nil || !su.IsAbs() {
		return WebmentionParseResult{}, fmt.Errorf("webmention: malformed source URL")
	}
	if scheme := strings.ToLower(su.Scheme); scheme != "http" && scheme != "https" {
		return WebmentionParseResult{}, fmt.Errorf("webmention: source scheme must be http(s), got %q", su.Scheme)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return WebmentionParseResult{}, fmt.Errorf("webmention: build request: %w", err)
	}
	req.Header.Set("User-Agent", "PostwaveWebmention/1.0 (+https://moosewave.com/webmention)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := p.client.Do(req)
	if err != nil {
		// Network-level failures are transient: leave the row pending and
		// retry on the next tick rather than rejecting a momentarily-down
		// source forever.
		return WebmentionParseResult{}, transientf("fetch source: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	switch {
	case resp.StatusCode == http.StatusOK:
		// proceed
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return WebmentionParseResult{}, transientf("source returned %d", resp.StatusCode)
	default:
		return WebmentionParseResult{}, fmt.Errorf("webmention: source returned %d", resp.StatusCode)
	}

	if ct := resp.Header.Get("Content-Type"); ct != "" && !strings.Contains(strings.ToLower(ct), "html") {
		return WebmentionParseResult{}, fmt.Errorf("webmention: source is not HTML (%s)", ct)
	}

	root, err := html.Parse(io.LimitReader(resp.Body, p.maxBytes))
	if err != nil {
		return WebmentionParseResult{}, fmt.Errorf("webmention: parse source HTML: %w", err)
	}

	// Resolve relative links against the FINAL response URL (after any
	// redirects) so a relative href in the body resolves correctly.
	base := su
	if resp.Request != nil && resp.Request.URL != nil {
		base = resp.Request.URL
	}
	return extractWebmention(root, base, target), nil
}

// transientf wraps errParserDeferred so the worker leaves the row pending
// (errors.Is(err, errParserDeferred) drives the "retry next tick" branch).
func transientf(format string, args ...any) error {
	return fmt.Errorf("webmention: %s: %w", fmt.Sprintf(format, args...), errParserDeferred)
}

// newSafeFetchClient builds an SSRF-guarded HTTP client for fetching
// arbitrary public source pages. Unlike the webpush push client there is no
// host allowlist (Webmention sources are any public site), but the
// connect-time dialer still refuses private/loopback/link-local/CGNAT
// addresses and dials the validated IP directly so a public hostname that
// DNS-rebinds to an internal IP cannot smuggle through.
func newSafeFetchClient() *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				if isPubliclyRoutable(ip.IP) && !isCGNAT(ip.IP) {
					return dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
				}
			}
			return nil, fmt.Errorf("webmention: refusing to dial non-public host %q", host)
		},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		MaxIdleConns:          10,
	}
	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: transport,
		// Allow a few redirects (http→https, shortlinks). Each hop re-dials
		// through the guarded DialContext, so a redirect to an internal
		// address is still refused at connect time.
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return fmt.Errorf("webmention: stopped after 3 redirects")
			}
			return nil
		},
	}
}

// isCGNAT reports whether ip is in the carrier-grade NAT range 100.64.0.0/10
// (RFC 6598). isPubliclyRoutable does not cover this range, so we check it
// explicitly to harden the dialer.
func isCGNAT(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
}

// extractWebmention walks the parsed source document once, collecting:
//   - LinkVerified: whether any <a>/<link> href resolves to the target,
//   - Title: the first <title> text,
//   - AuthorName/AuthorURL: from the first h-card microformat, if any.
func extractWebmention(root *html.Node, base *url.URL, target string) WebmentionParseResult {
	res := WebmentionParseResult{}
	normTarget := normalizeURLForMatch(target)

	var hcardFound bool
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "title":
				if res.Title == "" {
					res.Title = truncateRunes(textContent(n), 500)
				}
			case "a", "link":
				if !res.LinkVerified {
					if resolved := resolveHref(n, base); resolved != "" &&
						normalizeURLForMatch(resolved) == normTarget {
						res.LinkVerified = true
					}
				}
			}
			if !hcardFound && hasClass(n, "h-card") {
				hcardFound = true
				name, aURL := extractHCard(n, base)
				res.AuthorName = truncateRunes(name, 500)
				res.AuthorURL = truncateRunes(aURL, 2048)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return res
}

// extractHCard pulls a best-effort author name + URL out of an h-card
// subtree using microformats2 p-name / u-url, falling back to mf2 implied
// properties (the h-card's own text / href) when the explicit properties
// are absent. This is a pragmatic subset of the mf2 spec — enough for the
// operator to recognize who mentioned them — not a full parser.
func extractHCard(hcard *html.Node, base *url.URL) (name, authorURL string) {
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if name == "" && hasClass(n, "p-name") {
				name = textContent(n)
			}
			if authorURL == "" && hasClass(n, "u-url") {
				authorURL = resolveHref(n, base)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(hcard)

	// Implied properties (mf2): a bare h-card with no explicit p-name/u-url.
	if name == "" {
		name = textContent(hcard)
	}
	if authorURL == "" && (hcard.Data == "a" || hcard.Data == "link") {
		authorURL = resolveHref(hcard, base)
	}
	return name, authorURL
}

// resolveHref returns the node's href resolved against base (absolute).
func resolveHref(n *html.Node, base *url.URL) string {
	href := getAttr(n, "href")
	if href == "" {
		return ""
	}
	ref, err := url.Parse(strings.TrimSpace(href))
	if err != nil {
		return ""
	}
	if base == nil {
		return ref.String()
	}
	return base.ResolveReference(ref).String()
}

// normalizeURLForMatch canonicalizes a URL for equality comparison: lowercase
// scheme + host, strip the default port and URL fragment, and drop a single
// trailing slash. Path/query case is preserved (they can be significant).
func normalizeURLForMatch(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return strings.TrimRight(strings.TrimSpace(raw), "/")
	}
	u.Fragment = ""
	u.Scheme = strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Host)
	if u.Scheme == "http" {
		host = strings.TrimSuffix(host, ":80")
	}
	if u.Scheme == "https" {
		host = strings.TrimSuffix(host, ":443")
	}
	u.Host = host
	s := u.String()
	if strings.HasSuffix(s, "/") {
		s = strings.TrimRight(s, "/")
	}
	return s
}

// getAttr returns the first value of attribute key on n, or "".
func getAttr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// hasClass reports whether n's class attribute contains the exact token.
func hasClass(n *html.Node, class string) bool {
	for _, a := range n.Attr {
		if a.Key == "class" {
			for _, f := range strings.Fields(a.Val) {
				if f == class {
					return true
				}
			}
		}
	}
	return false
}

// textContent returns the concatenated, whitespace-collapsed text of n's
// descendants.
func textContent(n *html.Node) string {
	var sb strings.Builder
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.TextNode {
			sb.WriteString(x.Data)
			sb.WriteString(" ")
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return strings.Join(strings.Fields(sb.String()), " ")
}

// truncateRunes caps s to max runes without splitting a multi-byte
// character (the worker's SQL LEFT(...) does the final column-bound trim;
// this is a sanity bound to keep oversized strings out of memory/DB).
func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
