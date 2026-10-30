package sms

import (
	"crypto/rand"
	"encoding/base64"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var httpURLRe = regexp.MustCompile(`https?://[^\s<>"']+`)

func ExtractLinks(body string) []string {
	matches := httpURLRe.FindAllString(body, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(matches))
	for _, match := range matches {
		url := strings.TrimRight(match, ".,);!?:")
		if url == "" || seen[url] {
			continue
		}
		seen[url] = true
		out = append(out, url)
	}
	return out
}

func RewriteLinks(body string, replacements map[string]string) string {
	out := body
	for src, dst := range replacements {
		if src == "" || dst == "" {
			continue
		}
		out = strings.ReplaceAll(out, src, dst)
	}
	return out
}

func NewLinkToken() (string, error) {
	var b [18]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func PublicClickURL(baseURL, token string) string {
	base := normalizePublicBaseURL(baseURL)
	if base == "" || token == "" {
		return ""
	}
	return base + "/api/public/sms/click/" + token
}

func safeTrackedSMSLink(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || containsUnsafeURLControl(raw) {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u == nil || u.Host == "" || u.User != nil {
		return "", false
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", false
	}
	if u.Opaque != "" {
		return "", false
	}
	u.Fragment = ""
	return u.String(), true
}

func normalizePublicBaseURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || containsUnsafeURLControl(raw) {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u == nil || u.Host == "" || u.User != nil {
		return ""
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme == "http" {
		if !isLocalPublicBaseHost(u.Hostname()) {
			return ""
		}
	} else if u.Scheme != "https" {
		return ""
	}
	if u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return ""
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	return strings.TrimRight(u.String(), "/")
}

func isLocalPublicBaseHost(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func containsUnsafeURLControl(raw string) bool {
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c < 0x20 || c == 0x7f {
			return true
		}
		if c == '%' && i+2 < len(raw) {
			if b, ok := parseHexByte(raw[i+1 : i+3]); ok && (b < 0x20 || b == 0x7f) {
				return true
			}
		}
	}
	return false
}

func parseHexByte(raw string) (byte, bool) {
	n, err := strconv.ParseUint(raw, 16, 8)
	if err != nil {
		return 0, false
	}
	return byte(n), true
}

func linkTrackingEnabled(meta map[string]any, override *bool) bool {
	if override != nil {
		return *override
	}
	if meta == nil {
		return false
	}
	switch v := meta["link_tracking"].(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true") || strings.EqualFold(v, "enabled")
	default:
		return false
	}
}
