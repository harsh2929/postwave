// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_hub

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	maxProjectedWebhookURLInput = 4096
	maxProjectedErrorInput      = 4096
)

// projectWebhookOrigin deliberately exposes only the destination origin.
// Webhook userinfo, paths, queries, and fragments can all contain credentials
// or unguessable capabilities and therefore never belong in an operator JSON
// response. Invalid or control-bearing input fails closed to an absent value.
func projectWebhookOrigin(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxProjectedWebhookURLInput || containsControl(raw) {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.Host == "" {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && scheme != "http" {
		return ""
	}
	return (&url.URL{Scheme: scheme, Host: u.Host}).String()
}

// projectWebhookFailure converts provider/network detail into a bounded fixed
// vocabulary. Raw errors routinely contain URLs, reflected response bodies,
// auth headers, and controls, so even apparently harmless substrings are never
// copied into a response.
func projectWebhookFailure(raw string, statusCode int) string {
	if statusCode >= 100 && statusCode <= 599 {
		return "Receiver returned HTTP " + strconv.Itoa(statusCode)
	}
	if len(raw) > maxProjectedErrorInput {
		return "Delivery failed"
	}
	lower := strings.ToLower(raw)
	switch {
	case strings.Contains(lower, "timeout"), strings.Contains(lower, "timed out"), strings.Contains(lower, "deadline exceeded"):
		return "Connection timed out"
	case strings.Contains(lower, "no such host"), strings.Contains(lower, "dns"):
		return "DNS lookup failed"
	case strings.Contains(lower, "tls"), strings.Contains(lower, "x509"), strings.Contains(lower, "certificate"):
		return "TLS validation failed"
	case strings.Contains(lower, "connection refused"):
		return "Connection refused"
	case strings.Contains(lower, "connection reset"), strings.Contains(lower, "broken pipe"), strings.Contains(lower, "unexpected eof"):
		return "Connection interrupted"
	case strings.Contains(lower, "rate limit"):
		return "Receiver rate limited"
	case strings.Contains(lower, "cancelled"), strings.Contains(lower, "canceled"):
		return "Delivery cancelled"
	default:
		return "Delivery failed"
	}
}

func projectVerificationFailure(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	if len(raw) > maxProjectedErrorInput {
		return "Verification failed"
	}
	lower := strings.ToLower(raw)
	switch {
	case strings.Contains(lower, "timeout"), strings.Contains(lower, "timed out"), strings.Contains(lower, "deadline exceeded"):
		return "Verification timed out"
	case strings.Contains(lower, "dns"), strings.Contains(lower, "no such host"):
		return "DNS verification failed"
	default:
		return "Verification failed"
	}
}

func containsControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func setSensitiveEvidenceNoStoreHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}
