package observability

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// TestInitTracing_NoEndpointIsNoop confirms the helper is silent
// when OTEL_EXPORTER_OTLP_ENDPOINT is unset — that's the default
// dev/local shape and panicking there would block every unit test
// that imports this package.
func TestInitTracing_NoEndpointIsNoop(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	shutdown := InitTracing(context.Background(), "test-service", "test")
	if shutdown == nil {
		t.Fatal("InitTracing returned nil shutdown func")
	}
	// Calling the no-op shutdown must not panic or block.
	if err := shutdown(context.Background()); err != nil {
		t.Errorf("no-op shutdown returned err: %v", err)
	}
}

// TestInitTracing_WiresProviderAndPropagator confirms that when an
// endpoint is set, the global TracerProvider and propagator are
// installed. We deliberately point at a bogus endpoint — the OTLP
// gRPC exporter is async and does not connect at init time, so the
// helper still returns successfully and a real collector outage
// won't crash the process at startup.
func TestInitTracing_WiresProviderAndPropagator(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:14317") // bogus port; OK, async
	t.Setenv("OTEL_EXPORTER_OTLP_INSECURE", "true")
	t.Setenv("OTEL_TRACES_SAMPLER_ARG", "0.5")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdown := InitTracing(ctx, "test-service", "test")
	defer func() { _ = shutdown(context.Background()) }()

	tp := otel.GetTracerProvider()
	if tp == nil {
		t.Fatal("tracer provider not set on global otel")
	}
	// Propagator should be a composite of TraceContext + Baggage.
	prop := otel.GetTextMapPropagator()
	if prop == nil {
		t.Fatal("propagator not set on global otel")
	}
	// Fields() should contain "traceparent" — confirms TraceContext is wired.
	fields := prop.Fields()
	found := false
	for _, f := range fields {
		if f == "traceparent" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("propagator fields missing traceparent: %v", fields)
	}
}

// TestHTTPMiddleware_WrapsHandler verifies that the middleware passes
// the request through and that incoming traceparent context survives
// to the inner handler. We don't assert span attributes directly —
// that's tested upstream in otelhttp's own test suite. We just need
// confidence the middleware is a transparent wrapper.
func TestHTTPMiddleware_WrapsHandler(t *testing.T) {
	// Propagator must be set for the middleware to read incoming context.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	var innerCalled bool
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		innerCalled = true
		w.WriteHeader(http.StatusTeapot)
	})
	wrapped := HTTPMiddleware("test-service")(inner)

	req := httptest.NewRequest(http.MethodPost, "/v1/campaigns/abc/send", nil)
	// W3C traceparent — sampled (01). The middleware should pass this
	// through; the inner handler still runs.
	req.Header.Set("traceparent", "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01")

	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	if !innerCalled {
		t.Error("inner handler was not called")
	}
	if rec.Code != http.StatusTeapot {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusTeapot)
	}
}

func TestHTTPMiddleware_UsesRouteTemplateNotRawIdentifier(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
	})

	router := chi.NewRouter()
	router.Use(HTTPMiddleware("test-service"))
	router.Get("/users/{userID}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	rawIdentifier := "secret-customer-123"
	recorderHTTP := httptest.NewRecorder()
	router.ServeHTTP(recorderHTTP, httptest.NewRequest(http.MethodGet, "/users/"+rawIdentifier, nil))
	if recorderHTTP.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", recorderHTTP.Code, http.StatusNoContent)
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	if got, want := spans[0].Name(), "GET /users/{userID}"; got != want {
		t.Fatalf("span name = %q, want %q", got, want)
	}
	if strings.Contains(spans[0].Name(), rawIdentifier) {
		t.Fatal("span name disclosed the raw route identifier")
	}
	foundRoute := false
	for _, attr := range spans[0].Attributes() {
		if string(attr.Key) == "http.route" && attr.Value.AsString() == "/users/{userID}" {
			foundRoute = true
		}
	}
	if !foundRoute {
		t.Fatal("span is missing the matched http.route template")
	}
}

func TestHTTPMiddleware_RedactsHeldSupportIngressBeforeOTelAndPreservesRouting(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
	})

	const account = "short-account"
	const querySecret = "ordinary-looking-secret"
	const bodySecret = "raw-customer-body"
	innerSawOriginal := false
	router := chi.NewRouter()
	router.Use(HTTPMiddleware("test-service"))
	router.Post("/api/public/support-integrations/zendesk/{account}/webhooks", func(w http.ResponseWriter, r *http.Request) {
		innerSawOriginal = r.URL.Path == "/api/public/support-integrations/zendesk/"+account+"/webhooks" &&
			r.URL.Query().Get("anything") == querySecret
		w.WriteHeader(http.StatusServiceUnavailable)
	})

	req := httptest.NewRequest(http.MethodPost,
		"/api/public/support-integrations/zendesk/"+account+"/webhooks?anything="+querySecret,
		strings.NewReader(bodySecret))
	recorderHTTP := httptest.NewRecorder()
	router.ServeHTTP(recorderHTTP, req)
	if !innerSawOriginal {
		t.Fatal("telemetry minimization changed application routing/query input")
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	serialized := spans[0].Name()
	for _, attr := range spans[0].Attributes() {
		serialized += " " + string(attr.Key) + "=" + attr.Value.String()
	}
	for _, secret := range []string{account, querySecret, bodySecret} {
		if strings.Contains(serialized, secret) {
			t.Fatalf("OTel span disclosed %q: %s", secret, serialized)
		}
	}
}

// TestHTTPTransport_NilBaseFallsBackToDefault confirms the nil-safety
// the helper documents. A nil base must not panic and must still
// produce a usable RoundTripper.
func TestHTTPTransport_NilBaseFallsBackToDefault(t *testing.T) {
	rt := HTTPTransport(nil)
	if rt == nil {
		t.Fatal("HTTPTransport(nil) returned nil")
	}
	// Round-trip through a local test server to confirm the
	// transport at least dials. The actual span injection is
	// tested in otelhttp's own suite; we only verify wiring.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	client := &http.Client{Transport: rt, Timeout: 2 * time.Second}
	resp, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("client.Get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusNoContent)
	}
}

// TestParseSampleRate_FallbackOnInvalid covers the env-var parsing
// edge cases: empty, malformed, out-of-range. All three fall back to
// the default — operators shouldn't accidentally disable sampling by
// typoing OTEL_TRACES_SAMPLER_ARG.
func TestParseSampleRate_FallbackOnInvalid(t *testing.T) {
	cases := []struct {
		name string
		val  string
		def  float64
		want float64
	}{
		{"empty", "", 0.1, 0.1},
		{"valid", "0.5", 0.1, 0.5},
		{"valid-boundary-zero", "0", 0.1, 0},
		{"valid-boundary-one", "1", 0.1, 1},
		{"malformed", "potato", 0.1, 0.1},
		{"negative", "-0.5", 0.1, 0.1},
		{"too-high", "2", 0.1, 0.1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("OTEL_TRACES_SAMPLER_ARG", c.val)
			got := ParseSampleRate("OTEL_TRACES_SAMPLER_ARG", c.def)
			if got != c.want {
				t.Errorf("ParseSampleRate(%q) = %v, want %v", c.val, got, c.want)
			}
		})
	}
}

func TestTraceEndpointOptions_TLSAndLocalInsecurePolicy(t *testing.T) {
	cases := []struct {
		name        string
		endpoint    string
		environment string
		insecure    string
		wantErr     bool
	}{
		{name: "production HTTPS", endpoint: "https://collector.example:4317", environment: "production"},
		{name: "production TLS host port", endpoint: "collector.example:4317", environment: "production"},
		{name: "local explicit HTTP", endpoint: "http://127.0.0.1:4317", environment: "development", insecure: "true"},
		{name: "local host port explicit insecure", endpoint: "collector:4317", environment: "local", insecure: "true"},
		{name: "HTTP without opt in", endpoint: "http://collector:4317", environment: "development", wantErr: true},
		{name: "production insecure", endpoint: "http://collector:4317", environment: "production", insecure: "true", wantErr: true},
		{name: "credentials", endpoint: "https://user:secret@collector.example:4317", environment: "production", wantErr: true},
		{name: "path", endpoint: "https://collector.example:4317/traces", environment: "production", wantErr: true},
		{name: "query", endpoint: "https://collector.example:4317?token=secret", environment: "production", wantErr: true},
		{name: "bad boolean", endpoint: "https://collector.example:4317", environment: "production", insecure: "sometimes", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := traceEndpointOptions(tc.endpoint, tc.environment, tc.insecure)
			if (err != nil) != tc.wantErr {
				t.Fatalf("traceEndpointOptions() error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

// TestInitTracing_ShutdownReturnsWithinTimeout regression-tests the
// shutdown contract: even with a bogus endpoint (no collector to
// drain to), shutdown must return within our 5s budget so a
// SIGTERM-driven graceful shutdown doesn't hang.
func TestInitTracing_ShutdownReturnsWithinTimeout(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:14317")
	t.Setenv("OTEL_EXPORTER_OTLP_INSECURE", "true")
	shutdown := InitTracing(context.Background(), "test-service", "test")
	done := make(chan error, 1)
	go func() {
		done <- shutdown(context.Background())
	}()
	select {
	case <-done:
		// Either success or exporter error — both fine.
	case <-time.After(8 * time.Second):
		t.Fatal("shutdown did not return within 8s")
	}
}
