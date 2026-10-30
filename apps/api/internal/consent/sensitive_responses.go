// SPDX-License-Identifier: AGPL-3.0-only

package consent

import (
	"net/http"
	"strings"
)

// prepareSensitiveResponse applies the cache boundary shared by the consent
// evidence, tracking-consent, anonymous decision, and recipient-bound hosted
// preference surfaces. These payloads contain direct identifiers and browser
// evidence; refusals are sensitive too because status/body differences can
// reveal whether a credential or subject exists.
func prepareSensitiveResponse(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Del("ETag")
	for _, dimension := range []string{
		"Authorization",
		"Cookie",
		"X-Postwave-Site-Key",
		"Sec-GPC",
		"Idempotency-Key",
	} {
		addVaryDimension(w.Header(), dimension)
	}
}

func addVaryDimension(header http.Header, dimension string) {
	for _, line := range header.Values("Vary") {
		for _, existing := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(existing), dimension) {
				return
			}
		}
	}
	header.Add("Vary", dimension)
}

// ProtectSensitiveResponses stamps sensitive consent routes before any inner
// authentication, authorization, decoder, or handler can return. The response
// writer reasserts the policy at commit time because shared error writers and
// the authenticated read cache install generic policies after middleware has
// started.
func ProtectSensitiveResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isSensitiveConsentRoute(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &sensitiveConsentResponseWriter{ResponseWriter: w}
		prepareSensitiveResponse(protected)
		next.ServeHTTP(protected, r)
	})
}

type sensitiveConsentResponseWriter struct {
	http.ResponseWriter
}

func (w *sensitiveConsentResponseWriter) WriteHeader(status int) {
	prepareSensitiveResponse(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func (w *sensitiveConsentResponseWriter) Write(body []byte) (int, error) {
	prepareSensitiveResponse(w.ResponseWriter)
	return w.ResponseWriter.Write(body)
}

// FlushError is what http.ResponseController calls to flush. A flush commits
// the headers, so the private boundary is stamped first: a flush that reached
// net/http through Unwrap alone would skip it. The underlying writer's answer
// is returned as-is, so this claims no streaming capability it lacks.
func (w *sensitiveConsentResponseWriter) FlushError() error {
	prepareSensitiveResponse(w.ResponseWriter)
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *sensitiveConsentResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func isSensitiveConsentRoute(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	switch {
	case isSensitiveSMSRoute(path):
		return true
	case isHostedPreferenceCapabilityPath(path):
		return true
	case path == "/api/public/consent":
		return true
	case path == "/api/v1/consent/receipts" ||
		strings.HasPrefix(path, "/api/v1/consent/receipts/"):
		return true
	case path == "/api/v1/consent/events" ||
		strings.HasPrefix(path, "/api/v1/consent/events/"):
		return true
	case strings.HasPrefix(path, "/api/v1/consent/subscribers/") &&
		strings.HasSuffix(path, "/tracking"):
		return true
	case strings.HasPrefix(path, "/api/v1/subscribers/") &&
		strings.HasSuffix(path, "/tracking-consent"):
		return true
	case isSubscriberConsentReceiptExportPath(path):
		return true
	default:
		return false
	}
}

// isSensitiveSMSRoute covers the raw inbox/evidence and bulk-send surfaces.
// It intentionally lives in this pre-auth guard: route-local middleware runs
// too late to protect an early missing/bad credential or tenant refusal.
func isSensitiveSMSRoute(path string) bool {
	// Every tenant-facing SMS route can expose or infer recipient, sender,
	// consent, suppression, message, or dispatch state. Protect the family at
	// the outer boundary so auth/decoder/rate-limit refusals cannot bypass the
	// cache policy. Provider callbacks live under /api/public/sms and are not
	// matched here.
	return path == "/api/v1/sms" || strings.HasPrefix(path, "/api/v1/sms/")
}

func isHostedPreferenceCapabilityPath(path string) bool {
	const prefix = "/api/public/preferences/"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	if len(parts) == 1 {
		return parts[0] != ""
	}
	return len(parts) == 2 && parts[0] != "" &&
		(parts[1] == "one-click" || parts[1] == "frequency")
}

func isSubscriberConsentReceiptExportPath(path string) bool {
	const prefix = "/api/v1/subscribers/"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	if len(parts) != 2 || parts[0] == "" {
		return false
	}
	return parts[1] == "consent-receipt.json" || parts[1] == "consent-receipt.zip"
}
