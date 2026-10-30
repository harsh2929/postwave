// Package observability holds cross-cutting telemetry helpers shared
// across the apps/api gateway and the four sibling Go services. The
// first surface here is Sentry — every service wires InitSentry at
// startup; the SDK is a no-op when the per-service DSN env var is
// unset (dev / local).
//
// PII discipline mirrors apps/desktop/src/lib/telemetry.ts: request
// bodies, authorization-bearing headers, and known token-bearing
// query parameters are scrubbed before any event leaves the process.
package observability

import (
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/getsentry/sentry-go"
	sentryhttp "github.com/getsentry/sentry-go/http"
)

// EnvVarName converts a service identifier (e.g. "api", "voice",
// "deliverability") into the upper-case suffix used by
// SENTRY_DSN_<NAME>. Hyphens / dots are normalized so the helper is
// forgiving of formatting drift between callers.
//
// Exported so tooling can derive the same env-var name a service will
// look up at startup (used by the migration tests in this package).
func EnvVarName(serviceName string) string {
	s := strings.ToUpper(strings.TrimSpace(serviceName))
	s = strings.ReplaceAll(s, "-", "_")
	s = strings.ReplaceAll(s, ".", "_")
	return s
}

// InitSentry wires sentry-go using SENTRY_DSN_<service>. Returns a
// no-op flush function if the DSN is unset (dev / local) — Sentry calls
// become no-ops, no errors raised.
//
// The returned function is intended to be deferred from main():
//
//	defer observability.InitSentry("api", environment)()
//
// On a missing DSN this stays silent at Info level instead of Warn so
// dev logs don't appear noisy. If sentry.Init itself errors (malformed
// DSN, network DNS at startup) we log + return the no-op flush so the
// service still boots — error tracking failing closed shouldn't take
// production down.
func InitSentry(serviceName, environment string) func() {
	dsn := os.Getenv("SENTRY_DSN_" + EnvVarName(serviceName))
	if dsn == "" {
		// No DSN — Sentry SDK is initialized with a no-op transport so
		// calls don't panic but nothing is sent.
		slog.Info("sentry: no DSN; running without error tracking", "service", serviceName)
		return func() {}
	}
	err := sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Environment:      environment,
		Release:          os.Getenv("POSTWAVE_RELEASE"), // tagged on each deploy
		TracesSampleRate: 0.1,                           // 10% of transactions
		AttachStacktrace: true,
		BeforeSend:       RedactSensitiveData, // strip PII before send
	})
	if err != nil {
		slog.Error("sentry: init failed", "err", err.Error())
		return func() {}
	}
	slog.Info("sentry: wired", "service", serviceName, "environment", environment)
	return func() { sentry.Flush(2 * time.Second) }
}

// SentryHTTPMiddleware returns a chi-compatible middleware that
// captures panics + reports HTTP context (method, path, status, query
// — without bodies). Repanic=true preserves the existing chi recovery
// middleware chain; the gateway's chimiddleware.Recoverer still
// produces the 500 response after Sentry has captured the event.
func SentryHTTPMiddleware() func(http.Handler) http.Handler {
	return sentryhttp.New(sentryhttp.Options{
		Repanic:         true,
		WaitForDelivery: false,
	}).Handle
}

// RedactSensitiveData strips PII before send.
//
// What gets scrubbed:
//   - request bodies (event.Request.Data) — may contain subscriber
//     emails, campaign HTML, token bodies, free-form text we never
//     want in Sentry
//   - request cookies (event.Request.Cookies) — session cookies are
//     auth material; treating them like Authorization
//   - Authorization / Cookie / X-Postwave-Token request headers — those
//     are the three header names the gateway uses for auth material
//   - api_key / token / secret query parameters — replaced with [redacted]
//   - recipient-bound preference capabilities and other credential/PII-shaped
//     URL path segments — replaced while preserving the route shape
//
// The redaction matches the JS-side scrub in
// apps/desktop/src/lib/sentry.ts and apps/web/sentry.{client,server,edge}.config.ts
// so a single Sentry project sees a consistent shape regardless of
// which surface raised it.
func RedactSensitiveData(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
	if event == nil {
		return event
	}
	if event.Request != nil {
		event.Request.Data = ""
		event.Request.Cookies = ""
		if event.Request.Headers != nil {
			for _, k := range []string{"Authorization", "Cookie", "X-Postwave-Token"} {
				delete(event.Request.Headers, k)
			}
		}
		if event.Request.URL != "" {
			if u, perr := url.Parse(event.Request.URL); perr == nil {
				q := u.Query()
				touched := false
				publicSupportIngress := IsPublicSupportIntegrationPath(u.Path)
				if safePath := RedactSensitivePath(u.Path); safePath != u.Path {
					u.Path = safePath
					u.RawPath = ""
					touched = true
				}
				if publicSupportIngress && u.RawQuery != "" {
					// The held public provider family accepts no query contract.
					// Minimize every value, including harmless-looking future keys.
					q = url.Values{}
					touched = true
				}
				for k := range q {
					if IsSensitiveSentryQueryKey(k) {
						for i := range q[k] {
							q[k][i] = "[redacted]"
						}
						touched = true
					}
				}
				if touched {
					u.RawQuery = q.Encode()
					event.Request.URL = u.String()
				}
			}
		}
	}
	return event
}

// IsSensitiveSentryQueryKey reports whether a query-parameter key
// should be redacted before the URL is shipped to Sentry. Exported so
// the migration tests in this package (and any future per-service
// scrubber) can share the same allowlist.
func IsSensitiveSentryQueryKey(name string) bool {
	lower := strings.ToLower(name)
	for _, needle := range []string{
		"api_key", "token", "key", "secret", "password", "passwd", "pwd",
		"signature", "sig", "hmac", "authorization", "auth",
		"code", "state", "session", "cursor", "email", "e-mail", "subscriber", "recipient", "address",
	} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}
