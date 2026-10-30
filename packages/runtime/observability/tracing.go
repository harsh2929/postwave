// OpenTelemetry distributed tracing wiring for the API gateway and its
// sibling Go services.
//
// This file is intentionally small. Three responsibilities:
//  1. InitTracing — set up the global TracerProvider + W3C
//     tracecontext+baggage propagator from a single env var
//     (OTEL_EXPORTER_OTLP_ENDPOINT). No-op when unset so dev/local
//     runs without an OTLP collector don't error.
//  2. HTTPMiddleware — chi-compatible server middleware that opens
//     a span per request and continues any incoming traceparent
//     header so cross-service flows stitch end-to-end.
//  3. HTTPTransport — wraps an *http.RoundTripper so outbound calls
//     from the gateway to services/voice, services/deliverability,
//     etc. inject traceparent automatically. Used in main.go when
//     building cross-service *http.Client values.
//
// Manual spans are deliberately NOT exposed here. Middleware + the
// otelpgx pool tracer together cover request boundaries and Postgres
// query timings; that's the bulk of what's worth observing. Anything
// more is technical debt unless it captures something auto-
// instrumentation can't see (rare; e.g. AI generation steps that
// don't go through HTTP or pgx).
package observability

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// InitTracing wires OTel tracing for the service. Returns a shutdown
// function that flushes pending spans. No-op when OTEL_EXPORTER_OTLP_ENDPOINT
// is unset — dev / local without a collector just stops sending; no errors.
//
// The shutdown function is intended to be deferred from main():
//
//	shutdown := observability.InitTracing(ctx, "postwave-api", env)
//	defer func() { _ = shutdown(context.Background()) }()
//
// Failure modes are best-effort: if the resource or exporter init
// errors, we log + return a no-op shutdown so the service still
// boots. Trace pipeline failing closed shouldn't take production down
// — same posture as the Sentry init helper in sentry.go.
func InitTracing(ctx context.Context, serviceName, environment string) func(context.Context) error {
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		slog.Info("tracing: no OTLP endpoint; running without tracing", "service", serviceName)
		return func(context.Context) error { return nil }
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
			semconv.DeploymentEnvironment(environment),
			semconv.ServiceVersion(os.Getenv("POSTWAVE_RELEASE")),
		),
	)
	if err != nil {
		slog.Error("tracing: resource init failed", "err", err.Error(), "service", serviceName)
		return func(context.Context) error { return nil }
	}

	endpointOptions, err := traceEndpointOptions(endpoint, environment, os.Getenv("OTEL_EXPORTER_OTLP_INSECURE"))
	if err != nil {
		slog.Error("tracing: invalid exporter configuration", "err", err.Error(), "service", serviceName)
		return func(context.Context) error { return nil }
	}
	endpointOptions = append(endpointOptions, otlptracegrpc.WithTimeout(10*time.Second))
	exporter, err := otlptracegrpc.New(ctx, endpointOptions...)
	if err != nil {
		slog.Error("tracing: exporter init failed", "err", err.Error(), "service", serviceName)
		return func(context.Context) error { return nil }
	}

	sampleRate := ParseSampleRate("OTEL_TRACES_SAMPLER_ARG", 0.1) // 10% default

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(5*time.Second)),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(sampleRate))),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	slog.Info("tracing: wired",
		"service", serviceName,
		"sample_rate", sampleRate,
		"environment", environment,
	)
	return func(ctx context.Context) error {
		shutdownCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return tp.Shutdown(shutdownCtx)
	}
}

// HTTPMiddleware returns a chi-compatible middleware that wraps each
// handler in an otelhttp span. The W3C `traceparent` request header
// is automatically picked up by the global propagator set in
// InitTracing — that's what stitches the trace across the gateway,
// services/voice, services/deliverability, etc.
//
// Span names and http.route use only the matched chi route template. The
// route is read after the handler returns because chi finishes building a
// nested route pattern while dispatching. Attacker-controlled raw paths are
// never used as span names or attributes.
func HTTPMiddleware(serviceName string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		instrumented := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			appRequest := r
			if original, ok := r.Context().Value(originalRequestURLKey{}).(*url.URL); ok && original != nil {
				appRequest = r.Clone(r.Context())
				appURL := *original
				appRequest.URL = &appURL
			}
			defer setHTTPRouteSpan(appRequest)
			next.ServeHTTP(w, appRequest)
		})
		telemetryHandler := otelhttp.NewHandler(
			instrumented,
			serviceName,
			otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
				// otelhttp reapplies its formatter after the handler when chi has
				// populated Request.Pattern. Derive the final name from chi's
				// registered template so that reapplication cannot overwrite the
				// low-cardinality name set by setHTTPRouteSpan below.
				if pattern := matchedHTTPRoutePattern(r); pattern != "" {
					return fmt.Sprintf("%s %s", r.Method, pattern)
				}
				return operation
			}),
		)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r == nil || r.URL == nil || !IsPublicSupportIntegrationPath(r.URL.Path) {
				telemetryHandler.ServeHTTP(w, r)
				return
			}

			// otelhttp records URL attributes before dispatch. Give it a cloned,
			// fully minimized URL, then restore the original only for chi routing.
			// This covers unmatched methods and future descendants as well as the
			// currently mounted Route41 release-hold routes.
			originalURL := *r.URL
			telemetryRequest := r.Clone(context.WithValue(r.Context(), originalRequestURLKey{}, &originalURL))
			telemetryURL := originalURL
			telemetryURL.Path = RedactSensitivePath(originalURL.Path)
			telemetryURL.RawPath = ""
			telemetryURL.RawQuery = ""
			telemetryURL.ForceQuery = false
			telemetryRequest.URL = &telemetryURL
			telemetryHandler.ServeHTTP(w, telemetryRequest)
		})
	}
}

type originalRequestURLKey struct{}

func setHTTPRouteSpan(r *http.Request) {
	pattern := "__unmatched__"
	if matched := matchedHTTPRoutePattern(r); matched != "" {
		pattern = matched
	}
	span := trace.SpanFromContext(r.Context())
	span.SetName(fmt.Sprintf("%s %s", r.Method, pattern))
	span.SetAttributes(semconv.HTTPRoute(pattern))
}

func matchedHTTPRoutePattern(r *http.Request) string {
	if r == nil {
		return ""
	}
	if routeContext := chi.RouteContext(r.Context()); routeContext != nil {
		return routeContext.RoutePattern()
	}
	return ""
}

// HTTPTransport wraps an *http.RoundTripper with otelhttp so outbound
// calls inject `traceparent` headers into requests. Used when the
// gateway constructs cross-service HTTP clients (e.g. to
// services/voice, services/deliverability). The receiving service's
// HTTPMiddleware reads the header and continues the same trace.
//
// nil base falls back to http.DefaultTransport, mirroring net/http.
func HTTPTransport(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return otelhttp.NewTransport(base)
}

func traceEndpointOptions(endpoint, environment, insecureValue string) ([]otlptracegrpc.Option, error) {
	allowInsecure := false
	if insecureValue != "" {
		parsed, err := strconv.ParseBool(insecureValue)
		if err != nil {
			return nil, errors.New("OTEL_EXPORTER_OTLP_INSECURE must be a boolean")
		}
		allowInsecure = parsed
	}
	if allowInsecure && isProtectedEnvironment(environment) {
		return nil, errors.New("OTEL_EXPORTER_OTLP_INSECURE is forbidden in staging and production")
	}

	if !strings.Contains(endpoint, "://") {
		scheme := "https://"
		if allowInsecure {
			scheme = "http://"
		}
		parsed, err := validateTraceEndpointURL(scheme + endpoint)
		if err != nil {
			return nil, err
		}
		return []otlptracegrpc.Option{otlptracegrpc.WithEndpointURL(parsed.String())}, nil
	}

	parsed, err := validateTraceEndpointURL(endpoint)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme == "http" && !allowInsecure {
		return nil, errors.New("HTTP OTLP endpoint requires explicit OTEL_EXPORTER_OTLP_INSECURE=true outside staging/production")
	}
	if parsed.Scheme == "https" && allowInsecure {
		return nil, errors.New("OTEL_EXPORTER_OTLP_INSECURE conflicts with an HTTPS OTLP endpoint")
	}
	return []otlptracegrpc.Option{otlptracegrpc.WithEndpointURL(parsed.String())}, nil
}

func validateTraceEndpointURL(value string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil {
		return nil, errors.New("OTLP endpoint is not a valid URL")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return nil, errors.New("OTLP endpoint scheme must be https or explicitly permitted local http")
	}
	if parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("OTLP endpoint must have a host and no credentials, query, or fragment")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return nil, errors.New("OTLP gRPC endpoint must not include a path")
	}
	if controlCharacters.MatchString(value) {
		return nil, errors.New("OTLP endpoint contains control characters")
	}
	return parsed, nil
}

var controlCharacters = regexp.MustCompile(`[\x00-\x1f\x7f]`)

func isProtectedEnvironment(environment string) bool {
	switch strings.ToLower(strings.TrimSpace(environment)) {
	case "prod", "production", "stage", "staging":
		return true
	default:
		return false
	}
}

// ParseSampleRate reads an env var as a float64 in [0,1]. Falls back
// to def on parse failure or out-of-range values. Used to make
// OTEL_TRACES_SAMPLER_ARG honor the standard OTel env-var convention
// without forcing operators to flip code defaults to override.
//
// Exported so service-specific tuning code can call it directly with a
// different default — InitTracing uses ParseSampleRate("OTEL_TRACES_SAMPLER_ARG", 0.1).
func ParseSampleRate(env string, def float64) float64 {
	v := os.Getenv(env)
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 || f > 1 {
		slog.Warn("tracing: invalid sample rate; using default",
			"env", env, "value", v, "default", def)
		return def
	}
	return f
}
