// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebroker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"path"
	"sort"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/idna"
)

const maxURLBytes = 4096

// NetResolver adapts net.Resolver to the broker's testable resolver surface.
type NetResolver struct {
	Resolver *net.Resolver
}

func (r NetResolver) LookupIPAddr(ctx context.Context, host string) ([]IPAddr, error) {
	resolver := r.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	resolved, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	result := make([]IPAddr, 0, len(resolved))
	for _, item := range resolved {
		result = append(result, IPAddr{IP: append([]byte(nil), item.IP...), Zone: item.Zone})
	}
	return result, nil
}

// NormalizeSourceURL returns the sole URL representation used for source
// review and hashing. It accepts HTTPS only, removes a default :443 port,
// lowercases and IDNA-normalizes the host, strips no path/query semantics, and
// rejects credentials, fragments, IP literals, ambiguous paths, and controls.
func NormalizeSourceURL(raw string) (string, error) {
	if len(raw) == 0 || len(raw) > maxURLBytes || strings.TrimSpace(raw) != raw || hasControl(raw) {
		return "", fmt.Errorf("%w: invalid URL length or characters", ErrSourceRejected)
	}
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Opaque != "" || parsed.Scheme != "https" {
		return "", fmt.Errorf("%w: an absolute HTTPS URL is required", ErrSourceRejected)
	}
	if parsed.User != nil || parsed.Fragment != "" || parsed.ForceQuery || parsed.Hostname() == "" {
		return "", fmt.Errorf("%w: credentials, fragments, and empty hosts are forbidden", ErrSourceRejected)
	}
	host := parsed.Hostname()
	if strings.HasSuffix(host, ".") || strings.Contains(host, "%") || net.ParseIP(host) != nil {
		return "", fmt.Errorf("%w: IP literals, scoped hosts, and trailing dots are forbidden", ErrSourceRejected)
	}
	asciiHost, err := idna.Lookup.ToASCII(host)
	if err != nil || asciiHost == "" || len(asciiHost) > 253 || strings.Contains(asciiHost, "_") {
		return "", fmt.Errorf("%w: invalid DNS hostname", ErrSourceRejected)
	}
	asciiHost = strings.ToLower(asciiHost)
	port := parsed.Port()
	if port != "" && port != "443" {
		return "", fmt.Errorf("%w: only HTTPS port 443 is allowed", ErrSourceRejected)
	}
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	escaped := strings.ToLower(parsed.EscapedPath())
	if strings.Contains(parsed.Path, `\`) || strings.Contains(escaped, "%5c") ||
		strings.Contains(escaped, "%00") || path.Clean(parsed.Path) != parsed.Path {
		return "", fmt.Errorf("%w: ambiguous source path", ErrSourceRejected)
	}
	parsed.Scheme = "https"
	parsed.Host = asciiHost
	return parsed.String(), nil
}

func SourceURLSHA256(raw string) (string, error) {
	normalized, err := NormalizeSourceURL(raw)
	if err != nil {
		return "", err
	}
	return digest([]byte(normalized)), nil
}

type extractedSource struct {
	nodeID       string
	htmlLocation string
	normalized   string
	digest       string
}

// extractReviewedSources scans only the already-frozen rendered HTML. It does
// not discover or approve destinations: every image must sit under a compiler
// node marker and match the corresponding frozen source review exactly.
func extractReviewedSources(source []byte, reviews []SourceReview, maxHTMLBytes, maxImages int) ([]extractedSource, []Receipt, error) {
	if len(source) == 0 || len(source) > maxHTMLBytes {
		return nil, nil, fmt.Errorf("%w: HTML byte limit", ErrInvalidRequest)
	}
	if len(reviews) > maxImages {
		return nil, nil, fmt.Errorf("%w: source review limit", ErrInvalidRequest)
	}
	reviewed := make(map[string]string, len(reviews))
	for _, review := range reviews {
		nodeID := strings.TrimSpace(review.NodeID)
		if !validNodeID(nodeID) {
			return nil, nil, fmt.Errorf("%w: invalid reviewed node identity", ErrInvalidRequest)
		}
		normalized, err := NormalizeSourceURL(review.URL)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: reviewed node %s: %v", ErrInvalidRequest, nodeID, err)
		}
		if _, duplicate := reviewed[nodeID]; duplicate {
			return nil, nil, fmt.Errorf("%w: duplicate reviewed node identity", ErrInvalidRequest)
		}
		reviewed[nodeID] = normalized
	}

	root, err := html.Parse(bytes.NewReader(source))
	if err != nil {
		return nil, nil, fmt.Errorf("%w: parse frozen HTML", ErrInvalidRequest)
	}
	type work struct {
		node  *html.Node
		owner string
		depth int
	}
	stack := []work{{node: root}}
	found := make(map[string]struct{}, len(reviewed))
	var extracted []extractedSource
	var rejected []Receipt
	elements := 0
	imageOrdinal := 0
	for len(stack) != 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if current.depth > 256 {
			return nil, nil, fmt.Errorf("%w: HTML nesting limit", ErrInvalidRequest)
		}
		owner := current.owner
		if current.node.Type == html.ElementNode {
			elements++
			if elements > 100_000 {
				return nil, nil, fmt.Errorf("%w: HTML element limit", ErrInvalidRequest)
			}
			if value, present, duplicate := uniqueAttribute(current.node, "data-postwave-node"); present && !duplicate {
				owner = strings.TrimSpace(value)
			} else if duplicate {
				owner = ""
			}
			if strings.EqualFold(current.node.Data, "source") ||
				strings.EqualFold(current.node.Data, "style") && styleElementContainsURL(current.node) ||
				attributeContainsURL(current.node, "style") {
				rejected = append(rejected, rejectedReceipt(owner, fmt.Sprintf("/html/elements/%d", elements), "unreviewed_image_source"))
			}
			if strings.EqualFold(current.node.Data, "img") {
				imageOrdinal++
				location := fmt.Sprintf("/html/images/%d", imageOrdinal-1)
				src, present, duplicate := uniqueAttribute(current.node, "src")
				_, srcset, duplicateSrcset := uniqueAttribute(current.node, "srcset")
				if !present || duplicate || srcset || duplicateSrcset || owner == "" {
					rejected = append(rejected, rejectedReceipt(owner, location, "image_source_not_reviewable"))
				} else if imageOrdinal > maxImages {
					rejected = append(rejected, rejectedReceipt(owner, location, "image_count_limit"))
				} else {
					normalized, normalizeErr := NormalizeSourceURL(strings.TrimSpace(src))
					want, approved := reviewed[owner]
					switch {
					case normalizeErr != nil:
						receipt := rejectedReceipt(owner, location, "image_url_rejected")
						rejected = append(rejected, receipt)
					case !approved || normalized != want:
						receipt := rejectedReceipt(owner, location, "image_source_not_frozen")
						receipt.SourceURLSHA256 = digest([]byte(normalized))
						rejected = append(rejected, receipt)
					case hasSeen(found, owner):
						receipt := rejectedReceipt(owner, location, "duplicate_image_node")
						receipt.SourceURLSHA256 = digest([]byte(normalized))
						rejected = append(rejected, receipt)
					default:
						found[owner] = struct{}{}
						extracted = append(extracted, extractedSource{
							nodeID: owner, htmlLocation: location, normalized: normalized,
							digest: digest([]byte(normalized)),
						})
					}
				}
			}
		}
		children := make([]*html.Node, 0)
		for child := current.node.FirstChild; child != nil; child = child.NextSibling {
			children = append(children, child)
		}
		for i := len(children) - 1; i >= 0; i-- {
			stack = append(stack, work{node: children[i], owner: owner, depth: current.depth + 1})
		}
	}
	for nodeID, normalized := range reviewed {
		if _, exists := found[nodeID]; exists {
			continue
		}
		receipt := rejectedReceipt(nodeID, "/html", "reviewed_image_missing")
		receipt.SourceURLSHA256 = digest([]byte(normalized))
		rejected = append(rejected, receipt)
	}
	// A single unreviewed/ambiguous image source invalidates the rendered image
	// source set. Do not fetch a safe-looking subset while silently ignoring a
	// srcset, background image, duplicate node, or unbound image beside it.
	if len(rejected) != 0 {
		extracted = nil
	}
	sort.Slice(extracted, func(i, j int) bool { return extracted[i].nodeID < extracted[j].nodeID })
	sort.Slice(rejected, func(i, j int) bool {
		if rejected[i].NodeID != rejected[j].NodeID {
			return rejected[i].NodeID < rejected[j].NodeID
		}
		if rejected[i].HTMLLocation != rejected[j].HTMLLocation {
			return rejected[i].HTMLLocation < rejected[j].HTMLLocation
		}
		return rejected[i].FailureCode < rejected[j].FailureCode
	})
	return extracted, rejected, nil
}

func uniqueAttribute(node *html.Node, name string) (string, bool, bool) {
	var value string
	present := false
	for _, attribute := range node.Attr {
		if !strings.EqualFold(attribute.Key, name) {
			continue
		}
		if present {
			return "", true, true
		}
		present = true
		value = attribute.Val
	}
	return value, present, false
}

func attributeContainsURL(node *html.Node, name string) bool {
	value, present, duplicate := uniqueAttribute(node, name)
	return duplicate || present && cssContainsExternalSource(value)
}

func styleElementContainsURL(node *html.Node) bool {
	var source strings.Builder
	stack := []*html.Node{node.FirstChild}
	for len(stack) != 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if current == nil {
			continue
		}
		if current.Type == html.TextNode {
			source.WriteString(current.Data)
		}
		stack = append(stack, current.NextSibling, current.FirstChild)
	}
	return cssContainsExternalSource(source.String())
}

func cssContainsExternalSource(value string) bool {
	lower := strings.ToLower(value)
	return strings.Contains(lower, "url(") || strings.Contains(lower, "@import")
}

func rejectedReceipt(nodeID, location, code string) Receipt {
	return Receipt{
		NodeID: nodeID, HTMLLocation: location, Status: StatusFailed,
		FailureCode: code, OCRStatus: OCRUnavailable, OCRFailureCode: code,
		OCRRuntimeVersion: OCRRuntimeVersion,
	}
}

func hasSeen(values map[string]struct{}, key string) bool {
	_, ok := values[key]
	return ok
}

func validNodeID(value string) bool {
	if len(value) < 1 || len(value) > 200 {
		return false
	}
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.' || r == ':' {
			continue
		}
		return false
	}
	return true
}

func hasControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
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

func publicAddress(value []byte, zone string) (netip.Addr, bool) {
	if zone != "" {
		return netip.Addr{}, false
	}
	address, ok := netip.AddrFromSlice(value)
	if !ok {
		return netip.Addr{}, false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() ||
		address.IsLinkLocalUnicast() || address.IsMulticast() || address.IsUnspecified() {
		return netip.Addr{}, false
	}
	for _, blocked := range blockedPrefixes {
		if blocked.Contains(address) {
			return netip.Addr{}, false
		}
	}
	return address, true
}

// drainAndClose bounds connection reuse cleanup without allowing an attacker
// to force the broker to consume an unbounded response body.
func drainAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 4<<10))
	_ = body.Close()
}

func isCancellation(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
