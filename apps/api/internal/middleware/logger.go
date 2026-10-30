// Package middleware contains chi-compatible HTTP middleware for the API
// gateway.
package middleware

import (
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	chimiddleware "github.com/go-chi/chi/v5/middleware"
	runtimeobservability "github.com/postwave/postwave/packages/runtime/observability"
)

// sensitiveQueryKeys are query-string parameter names whose VALUES are
// redacted before logging. Names are matched case-insensitively and by
// substring so e.g. "x_api_key" and "ACCESS-TOKEN" both match. Adding a
// new credential-bearing param? Append the substring here.
var sensitiveQueryKeys = []string{
	"token", "ticket", "key", "secret", "password", "passwd", "pwd",
	"signature", "sig", "hmac", "authorization", "auth",
	"code", "state", "session", "cursor",
	"email", "e-mail", "subscriber", "recipient", "address",
}

func redactRequestQuery(path, raw string) string {
	// Action preview query strings contain the credential itself. Drop the
	// entire query on that route so even legacy one-letter keys, duplicate
	// parameters, and malformed escaping cannot put the bearer into logs.
	if strings.TrimSuffix(path, "/") == "/api/v1/actions/preview" {
		return ""
	}
	return redactQuery(raw)
}

// redactQuery returns a logging-safe rendering of raw, replacing the value of
// any param whose name matches a sensitiveQueryKeys entry with "[REDACTED]".
// Malformed query strings fall through unchanged so logs still capture the
// (already-suspicious) shape.
func redactQuery(raw string) string {
	if raw == "" {
		return ""
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return "[unparseable]"
	}
	for k := range values {
		if isSensitiveQueryKey(k) {
			for i := range values[k] {
				values[k][i] = "[REDACTED]"
			}
		}
	}
	// Encode round-trips, normalizing the key order — that's fine for logs.
	return values.Encode()
}

func isSensitiveQueryKey(name string) bool {
	lower := strings.ToLower(name)
	if lower == "q" || lower == "tag" || lower == "phone" {
		return true
	}
	for _, needle := range sensitiveQueryKeys {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

// SlogLogger returns a chi middleware that logs every request as a single
// structured slog record once the response has been written. Sensitive query
// values are redacted before they hit the log.
func SlogLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := chimiddleware.NewWrapResponseWriter(w, r.ProtoMajor)

			defer func() {
				query := redactRequestQuery(r.URL.Path, r.URL.RawQuery)
				if runtimeobservability.IsPublicSupportIntegrationPath(r.URL.Path) {
					query = ""
				}
				logger.LogAttrs(r.Context(), slog.LevelInfo, "http.request",
					slog.String("method", r.Method),
					slog.String("path", runtimeobservability.RedactSensitivePath(r.URL.Path)),
					slog.String("query", query),
					slog.Int("status", ww.Status()),
					slog.Int("bytes", ww.BytesWritten()),
					slog.Duration("duration", time.Since(start)),
					slog.String("request_id", chimiddleware.GetReqID(r.Context())),
					slog.String("remote_addr", r.RemoteAddr),
					slog.String("user_agent", r.UserAgent()),
				)
			}()

			next.ServeHTTP(ww, r)
		})
	}
}
