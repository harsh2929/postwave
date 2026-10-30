// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/mail"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/net/idna"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const (
	agencyJSONMaxBytes = 32 << 10

	MutationOutcomeHeader       = "X-Postwave-Agency-Mutation-Outcome"
	mutationOutcomeNotCommitted = "not-committed"
)

var (
	errDuplicateJSONKey = errors.New("request body contains a duplicate JSON object key")
	workspaceSlugRE     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`)
	rosterSlugRE        = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	dnsLabelRE          = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	ipv4NumberLabelRE   = regexp.MustCompile(`^(?:0x[0-9a-f]+|[0-9]+)$`)
)

// decodeAgencyJSON retains httpbody's media-type, size, unknown-field and
// trailing-value guarantees, and closes encoding/json's duplicate-member and
// invalid-UTF-8 ambiguity. Duplicate members are rejected at every object
// depth rather than silently applying last-key-wins semantics.
func decodeAgencyJSON(rbody []byte) error {
	if !utf8.Valid(rbody) {
		return fmt.Errorf("invalid UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(rbody))
	dec.UseNumber()
	if err := scanJSONValue(dec); err != nil {
		return err
	}
	if _, err := dec.Token(); err == nil {
		return httpbody.ErrMultipleJSONValues
	}
	return nil
}

func scanJSONValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	delim, composite := tok.(json.Delim)
	if !composite {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]struct{}{}
		for dec.More() {
			keyToken, err := dec.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return fmt.Errorf("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("%w: %q", errDuplicateJSONKey, key)
			}
			seen[key] = struct{}{}
			if err := scanJSONValue(dec); err != nil {
				return err
			}
		}
		closing, err := dec.Token()
		if err != nil || closing != json.Delim('}') {
			return fmt.Errorf("invalid JSON object")
		}
	case '[':
		for dec.More() {
			if err := scanJSONValue(dec); err != nil {
				return err
			}
		}
		closing, err := dec.Token()
		if err != nil || closing != json.Delim(']') {
			return fmt.Errorf("invalid JSON array")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter")
	}
	return nil
}

func validWorkspaceSlug(slug string) bool {
	return workspaceSlugRE.MatchString(slug)
}

func validCanonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && len(value) == 36 && parsed.String() == strings.ToLower(value)
}

func validBoundedText(value string, minRunes, maxRunes int) bool {
	if strings.TrimSpace(value) != value || !utf8.ValidString(value) {
		return false
	}
	n := utf8.RuneCountInString(value)
	if n < minRunes || n > maxRunes {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unsafeFormatRune(r) {
			return false
		}
	}
	return true
}

// Reject invisible direction-changing and zero-width characters in fields
// rendered into administrative/public branding surfaces.
func unsafeFormatRune(r rune) bool {
	switch {
	case r == '\u061c' || r == '\u200e' || r == '\u200f':
		return true
	case r == '\u200b' || r == '\u200c' || r == '\u200d' || r == '\ufeff':
		return true
	case r >= '\u202a' && r <= '\u202e':
		return true
	case r >= '\u2060' && r <= '\u206f':
		return true
	default:
		return false
	}
}

func normalizeHexColor(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if len(raw) != 7 || raw[0] != '#' {
		return "", false
	}
	for _, c := range raw[1:] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return "", false
		}
	}
	return strings.ToUpper(raw), true
}

func colorHasWhiteTextContrast(color string) bool {
	if len(color) != 7 || color[0] != '#' {
		return false
	}
	component := func(raw string) float64 {
		n, err := strconv.ParseUint(raw, 16, 8)
		if err != nil {
			return 1
		}
		value := float64(n) / 255
		if value <= 0.04045 {
			return value / 12.92
		}
		return math.Pow((value+0.055)/1.055, 2.4)
	}
	luminance := 0.2126*component(color[1:3]) +
		0.7152*component(color[3:5]) +
		0.0722*component(color[5:7])
	return 1.05/(luminance+0.05) >= 4.5
}

func normalizeSupportEmail(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", true
	}
	if len(raw) > 254 || !validBoundedText(raw, 3, 254) {
		return "", false
	}
	parsed, err := mail.ParseAddress(raw)
	if err != nil || parsed.Name != "" || parsed.Address != raw || strings.Count(raw, "@") != 1 {
		return "", false
	}
	parts := strings.SplitN(raw, "@", 2)
	domain, ok := normalizeDNSName(parts[1])
	if !ok {
		return "", false
	}
	return parts[0] + "@" + domain, true
}

func normalizeCustomDomain(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", true
	}
	domain, ok := normalizeDNSName(raw)
	if !ok || strings.Count(domain, ".") < 1 || net.ParseIP(domain) != nil ||
		looksLikeIPv4Address(domain) {
		return "", false
	}
	for _, suffix := range []string{
		".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa",
		".arpa", ".onion", ".test", ".invalid", ".example",
	} {
		if domain == strings.TrimPrefix(suffix, ".") || strings.HasSuffix(domain, suffix) {
			return "", false
		}
	}
	return domain, true
}

// WHATWG URL parsers accept abbreviated, octal, and hexadecimal IPv4 forms
// that net.ParseIP deliberately does not. A value such as 127.1 or
// 0x7f.0.0.1 is therefore a syntactically valid DNS-looking string to Go but
// becomes loopback when a browser fetches it. Reject every all-numeric
// two-to-four-label hostname conservatively; public DNS names retain at least
// one non-numeric label.
func looksLikeIPv4Address(domain string) bool {
	labels := strings.Split(domain, ".")
	if len(labels) < 2 || len(labels) > 4 {
		return false
	}
	for _, label := range labels {
		if !ipv4NumberLabelRE.MatchString(label) {
			return false
		}
	}
	return true
}

func normalizeDNSName(raw string) (string, bool) {
	if raw == "" || len(raw) > 253 || strings.HasSuffix(raw, ".") || strings.ContainsAny(raw, "/:@%\\*_") {
		return "", false
	}
	ascii, err := idna.Lookup.ToASCII(raw)
	if err != nil {
		return "", false
	}
	ascii = strings.ToLower(ascii)
	if len(ascii) == 0 || len(ascii) > 253 {
		return "", false
	}
	for _, label := range strings.Split(ascii, ".") {
		if !dnsLabelRE.MatchString(label) {
			return "", false
		}
	}
	return ascii, true
}

func normalizeLogoURL(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", true
	}
	if len(raw) > 2048 || !utf8.ValidString(raw) {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || !u.IsAbs() || u.Opaque != "" || u.User != nil ||
		u.Hostname() == "" || u.Fragment != "" || u.RawQuery != "" || u.ForceQuery {
		return "", false
	}
	if u.Port() != "" {
		return "", false
	}
	host, ok := normalizeCustomDomain(u.Hostname())
	if !ok {
		return "", false
	}
	u.Host = host
	if strings.Contains(u.Path, `\`) || hasUnsafeURLPath(u.EscapedPath()) {
		return "", false
	}
	return u.String(), true
}

func hasUnsafeURLPath(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, "%00") || strings.Contains(lower, "%0a") ||
		strings.Contains(lower, "%0d") || strings.Contains(lower, "%5c")
}
