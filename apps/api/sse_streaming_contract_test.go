// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apidocs"
	"github.com/postwave/postwave/apps/api/internal/apikeycalls"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/budgets"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/conversions"
	"github.com/postwave/postwave/apps/api/internal/cost"
	"github.com/postwave/postwave/apps/api/internal/deliverability_hub"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/privacy"
	"github.com/postwave/postwave/apps/api/internal/pushsuppressions"
	"github.com/postwave/postwave/apps/api/internal/sendingsettings"
	"github.com/postwave/postwave/apps/api/internal/sms"
	"github.com/postwave/postwave/apps/api/internal/sse"
	"github.com/postwave/postwave/apps/api/internal/stepup"
)

// streamTestWriteTimeout stands in for apiWriteTimeout. It is short so the
// tests can outlive it; the property under test is the same at 90 seconds.
const streamTestWriteTimeout = time.Second

const streamTestTenantID = "7a0c3f5e-4b1d-4c8e-9f2a-1d6b8e3c5a70"

// composedMiddleware is one r.Use call of authenticated group 1 in main.go:
// the literal it starts with, and a construction of the same middleware whose
// response-writer behaviour matches production (dependencies that only matter
// for mutations, API keys or send routes are left empty).
type composedMiddleware struct {
	marker string
	build  func() func(http.Handler) http.Handler
}

// authenticatedGroupOuterGuards are the r.Use calls main.go makes in
// authenticated group 1 before authenticatedRoutes.apply(r), in order.
func authenticatedGroupOuterGuards() []composedMiddleware {
	return []composedMiddleware{
		{"r.Use(apidocs.ProtectResponses)", func() func(http.Handler) http.Handler { return apidocs.ProtectResponses }},
		{"r.Use(apikeys.ProtectCredentialResponses)", func() func(http.Handler) http.Handler { return apikeys.ProtectCredentialResponses }},
		{"r.Use(apikeycalls.ProtectMCPResponses)", func() func(http.Handler) http.Handler { return apikeycalls.ProtectMCPResponses }},
		{"r.Use(privacy.ProtectIncidentResponses)", func() func(http.Handler) http.Handler { return privacy.ProtectIncidentResponses }},
		{"r.Use(sms.ProtectRoute42Responses)", func() func(http.Handler) http.Handler { return sms.ProtectRoute42Responses }},
		{"r.Use(pushsuppressions.ProtectRoute43Responses)", func() func(http.Handler) http.Handler { return pushsuppressions.ProtectRoute43Responses }},
		{"r.Use(outbound_webhooks.ProtectPlaygroundResponses)", func() func(http.Handler) http.Handler { return outbound_webhooks.ProtectPlaygroundResponses }},
		{"r.Use(consent.ProtectSensitiveResponses)", func() func(http.Handler) http.Handler { return consent.ProtectSensitiveResponses }},
	}
}

// authenticatedGroupTail are the r.Use calls main.go makes in authenticated
// group 1 after authenticatedRoutes.apply(r), in order.
func authenticatedGroupTail() []composedMiddleware {
	passThrough := func(next http.Handler) http.Handler { return next }
	return []composedMiddleware{
		{"r.Use(outbound_webhooks.PlaygroundRateGovernor(", func() func(http.Handler) http.Handler {
			return outbound_webhooks.PlaygroundRateGovernor(passThrough, passThrough)
		}},
		{"r.Use(stepup.Middleware(", func() func(http.Handler) http.Handler {
			return stepup.Middleware(func(context.Context, string) (bool, error) { return false, nil })
		}},
		{"r.Use(idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(", func() func(http.Handler) http.Handler {
			return idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(nil, nil, nil, nil, nil)
		}},
		{"r.Use(middleware.AuditMiddleware(pool))", func() func(http.Handler) http.Handler { return middleware.AuditMiddleware(nil) }},
		{"r.Use(middleware.CostHeaderMiddleware(", func() func(http.Handler) http.Handler {
			return middleware.CostHeaderMiddleware(cost.WithRunningTotal, cost.RunningTotalCents, nil)
		}},
		{"r.Use(budgets.Middleware(budgetRepo))", func() func(http.Handler) http.Handler { return budgets.Middleware(noSendBudgets{}) }},
		{"r.Use(httpcache.Conditional())", httpcache.Conditional},
		{"r.Use(httpcache.WithPolicy(httpcache.AuthRead()))", func() func(http.Handler) http.Handler {
			return httpcache.WithPolicy(httpcache.AuthRead())
		}},
	}
}

type discardCallSink struct{}

func (discardCallSink) Insert(context.Context, *apikeycalls.Call) error { return nil }

type noSendBudgets struct{}

func (noSendBudgets) LoadBudget(context.Context, string) (*budgets.Budget, error) { return nil, nil }
func (noSendBudgets) LoadUsage(context.Context, string, time.Time) (*budgets.Usage, error) {
	return nil, nil
}
func (noSendBudgets) IncrementUsage(context.Context, *budgets.Budget, budgets.Resource, int, time.Time) error {
	return nil
}

// withStreamTestTenant stands in for the tenant resolution inside
// authenticatedRoutes.apply; none of the stack's authentication middleware
// wraps the response writer, so only its result is needed here.
func withStreamTestTenant(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenant := &middleware.Tenant{ID: streamTestTenantID}
		next.ServeHTTP(w, r.WithContext(middleware.WithTenant(r.Context(), tenant)))
	})
}

func startStreamingServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.Config.WriteTimeout = streamTestWriteTimeout
	server.Start()
	t.Cleanup(server.Close)
	return server
}

// sseFrames reads SSE frames off a live response body on a goroutine, so a
// test can wait for one with a deadline instead of blocking forever.
type sseFrames struct {
	frames chan string
	done   chan error
}

func readSSEFrames(body io.Reader) *sseFrames {
	out := &sseFrames{frames: make(chan string, 64), done: make(chan error, 1)}
	go func() {
		reader := bufio.NewReader(body)
		var frame strings.Builder
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				out.done <- err
				return
			}
			if line == "\n" {
				out.frames <- frame.String()
				frame.Reset()
				continue
			}
			frame.WriteString(line)
		}
	}()
	return out
}

// next waits for the next frame satisfying match.
func (s *sseFrames) next(t *testing.T, within time.Duration, what string, match func(string) bool) string {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case frame := <-s.frames:
			if match(frame) {
				return frame
			}
		case err := <-s.done:
			t.Fatalf("stream ended before %s: %v", what, err)
		case <-deadline:
			t.Fatalf("no %s within %s", what, within)
		}
	}
}

// openStream issues a GET and returns once the response headers arrive, which
// only happens when a flush reaches the wire.
func openStream(t *testing.T, url string, within time.Duration) *http.Response {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept", "text/event-stream")
	type result struct {
		response *http.Response
		err      error
	}
	arrived := make(chan result, 1)
	go func() {
		response, doErr := http.DefaultClient.Do(request)
		arrived <- result{response, doErr}
	}()
	select {
	case got := <-arrived:
		if got.err != nil {
			t.Fatalf("GET %s: %v", url, got.err)
		}
		t.Cleanup(func() { _ = got.response.Body.Close() })
		return got.response
	case <-time.After(within):
		cancel()
		t.Fatalf("GET %s: no response headers within %s — the first flush never reached the client", url, within)
		return nil
	}
}

// The browser's realtime channel is GET /api/v1/events. This composes the
// root chain exactly as run() does (useRootMiddleware) and authenticated
// group 1 as main.go does, mounts the real events handler, and serves it with
// a finite WriteTimeout like production. Before the fix the ready event was
// "flushed" into a wrapper that dropped it: no headers reached the client
// until the write deadline killed the connection, and the load balancer in
// front answered with its own 502.
func TestServerSentEventsStreamThroughTheGatewayMiddleware(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	recorder := apikeycalls.NewRecorder(discardCallSink{}, logger)
	t.Cleanup(recorder.Close)
	bus := events.NewBus()
	stream := &events.HandlerDeps{
		Bus:               bus,
		HeartbeatInterval: 200 * time.Millisecond,
		MaxDuration:       30 * time.Second,
		Logger:            logger,
	}

	router := chi.NewRouter()
	useRootMiddleware(router, logger, config.Config{}, nil)
	mountAuthenticatedRoutesBehindAgentHold(router, func(r chi.Router) {
		for _, guard := range authenticatedGroupOuterGuards() {
			r.Use(guard.build())
		}
		r.Use(withStreamTestTenant)
		r.Use(apikeycalls.QuotaMiddleware(nil))
		r.Use(apikeycalls.RecorderMiddleware(recorder))
		for _, tail := range authenticatedGroupTail() {
			r.Use(tail.build())
		}
		r.Get("/api/v1/events", stream.Handle)
	})
	server := startStreamingServer(t, router)

	started := time.Now()
	response := openStream(t, server.URL+"/api/v1/events?topics=subscriber.added", 2*time.Second)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}
	if got := response.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q: an event stream must never be compressed", got)
	}
	if response.Header.Get("X-Postwave-Cost-Cents") == "" {
		t.Fatal("X-Postwave-Cost-Cents missing: the cost writer was not on the stream's path")
	}
	frames := readSSEFrames(response.Body)
	frames.next(t, time.Second, "ready event", func(frame string) bool {
		return strings.HasPrefix(frame, "event: ready\n")
	})

	// A domain event published on the bus reaches the client while the
	// stream is open.
	bus.Publish(events.Event{
		Topic:    "subscriber.added",
		TenantID: streamTestTenantID,
		At:       time.Now().UTC(),
		Payload:  map[string]any{"subscriber_id": "sub_1"},
	})
	frames.next(t, 2*time.Second, "published subscriber.added event", func(frame string) bool {
		return strings.HasPrefix(frame, "event: subscriber.added\n")
	})

	// The stream outlives the server's WriteTimeout: a heartbeat written
	// after it would have closed the connection had the deadline not moved.
	frames.next(t, 3*time.Second, "heartbeat after the write timeout", func(frame string) bool {
		return frame == ":keepalive\n" && time.Since(started) > streamTestWriteTimeout+500*time.Millisecond
	})
}

// A wrapper added to authenticated group 1 must also be added to the
// composition above, or the streaming contract stops covering production.
func TestStreamingContractComposesMainsAuthenticatedGroup(t *testing.T) {
	t.Parallel()
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	start := strings.Index(text, "mountAuthenticatedRoutesBehindAgentHold(r, func(r chi.Router) {")
	end := strings.Index(text, "(&flowsteps.Deps{")
	if start < 0 || end < start {
		t.Fatal("authenticated group 1 markers not found in main.go")
	}
	var outer, tail []string
	seenApply := false
	for _, line := range strings.Split(text[start:end], "\n") {
		switch {
		case strings.TrimSpace(line) == "authenticatedRoutes.apply(r)":
			seenApply = true
		case strings.HasPrefix(line, "\t\tr.Use("):
			if seenApply {
				tail = append(tail, strings.TrimSpace(line))
			} else {
				outer = append(outer, strings.TrimSpace(line))
			}
		}
	}
	if !seenApply {
		t.Fatal("authenticatedRoutes.apply(r) not found in authenticated group 1")
	}
	assertComposition(t, "before authenticatedRoutes.apply", outer, authenticatedGroupOuterGuards())
	assertComposition(t, "after authenticatedRoutes.apply", tail, authenticatedGroupTail())
}

func assertComposition(t *testing.T, where string, got []string, want []composedMiddleware) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: main.go has %d r.Use calls %q, the streaming contract composes %d", where, len(got), got, len(want))
	}
	for index, line := range got {
		if !strings.HasPrefix(line, want[index].marker) {
			t.Fatalf("%s: r.Use #%d is %q, the streaming contract composes %q", where, index+1, line, want[index].marker)
		}
	}
}

// Every ResponseWriter wrapper in the gateway must pass a flush and the write
// deadline through to net/http. Each case serves a stream through one wrapper,
// on a path where it actually wraps, over a real connection with a finite
// WriteTimeout: the client must receive the first event while the handler is
// still running, and a second one written after the timeout.
//
// The route-scoped privacy wrappers must also restamp their cache boundary
// when a flush commits the headers. The handler below deliberately weakens
// Cache-Control and then lets its first flush commit the headers, with no
// WriteHeader call for the wrapper to intercept; a flush that reached net/http
// through Unwrap alone would publish that weaker policy.
func TestEveryResponseWrapperStreamsThroughToTheClient(t *testing.T) {
	t.Parallel()
	withAPIKey := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(middleware.WithAPIKeyID(r.Context(), "key_stream_test")))
		})
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	recorder := apikeycalls.NewRecorder(discardCallSink{}, logger)
	t.Cleanup(recorder.Close)

	type wrapperCase struct {
		name         string
		method       string
		path         string
		wrap         func(http.Handler) http.Handler
		cacheControl string // the boundary a flush must restamp; "" when the wrapper sets none
	}
	cases := []wrapperCase{
		{name: "request metrics recorder", path: "/api/v1/events", wrap: observability.HTTPRequestMetrics},
		{name: "tier-1 surface recorder", path: "/api/v1/events", wrap: func(next http.Handler) http.Handler {
			return observability.Tier1Middleware("stream_test", next)
		}},
		{name: "client-closed request writer", path: "/api/v1/events", wrap: middleware.ClientClosedRequests},
		{name: "cost header writer", path: "/api/v1/events", wrap: middleware.CostHeaderMiddleware(cost.WithRunningTotal, cost.RunningTotalCents, nil)},
		{name: "conditional GET buffer", path: "/api/v1/events", wrap: httpcache.Conditional()},
		{name: "API-key call recorder", path: "/api/v1/events", wrap: apikeycalls.RecorderMiddleware(recorder)},
		{name: "audit status writer", method: http.MethodPost, path: "/api/v1/ai-agent/chat", wrap: middleware.AuditMiddleware(nil)},
		{name: "send budget recorder", method: http.MethodPost, path: "/api/v1/campaigns/cmp_1/send", wrap: func(next http.Handler) http.Handler {
			return withAPIKey(budgets.Middleware(noSendBudgets{})(next))
		}},
		{name: "MCP boundary", path: "/api/v1/mcp/executions/stream", wrap: apikeycalls.ProtectMCPResponses, cacheControl: "private, no-store"},
		{name: "stream-token boundary", path: "/api/v1/streams/token", wrap: apikeys.ProtectCredentialResponses, cacheControl: "private, no-store"},
		{name: "OpenAPI boundary", path: "/api/v1/openapi.json", wrap: apidocs.ProtectResponses, cacheControl: "private, no-store"},
		{name: "ingest-secret boundary", path: "/api/v1/conversions/ingest-secrets", wrap: conversions.ProtectIngestSecretResponses, cacheControl: "private, no-store"},
		{name: "webhook playground boundary", path: "/api/v1/outbound-webhooks/playground/events", wrap: outbound_webhooks.ProtectPlaygroundResponses, cacheControl: "private, no-store"},
		{name: "consent boundary", path: "/api/v1/consent/receipts", wrap: consent.ProtectSensitiveResponses, cacheControl: "private, no-store"},
		{name: "deliverability boundary", path: "/api/v1/deliverability/hub", wrap: deliverability_hub.ProtectResponses, cacheControl: "private, no-store, max-age=0"},
		{name: "frequency-cap boundary", path: "/api/v1/sending/frequency-caps", wrap: frequency.ProtectResponses, cacheControl: "private, no-store"},
		{name: "intelligent-retry boundary", path: "/api/v1/intelligent-retry/events", wrap: intelligent_retry.ProtectResponses, cacheControl: "private, no-store"},
		{name: "privacy-incident boundary", path: "/api/v1/privacy/incidents", wrap: privacy.ProtectIncidentResponses, cacheControl: "private, no-store"},
		{name: "push-suppression boundary", path: "/api/v1/push/suppressions", wrap: pushsuppressions.ProtectRoute43Responses, cacheControl: "private, no-store, max-age=0"},
		{name: "sending-settings boundary", path: "/api/v1/settings/sending", wrap: sendingsettings.ProtectResponses, cacheControl: "private, no-store"},
		{name: "SMS registry boundary", path: "/api/v1/sms/suppressions", wrap: sms.ProtectRoute42Responses, cacheControl: "private, no-store"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			clientHasFirstEvent := make(chan struct{})
			handlerErrors := make(chan string, 4)
			handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				stream, ok := sse.Open(w)
				if !ok {
					handlerErrors <- "sse.Open refused the wrapped writer"
					http.Error(w, "cannot stream", http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				// A shared writer weakening the cache policy mid-flight, then
				// the first flush committing the (implicit 200) headers
				// without a WriteHeader call for the wrapper to intercept.
				w.Header().Set("Cache-Control", "public, max-age=300")
				if err := stream.Flush(); err != nil {
					handlerErrors <- "flush committing the headers: " + err.Error()
					return
				}
				if err := stream.Sendf("event: first\ndata: {}\n\n"); err != nil {
					handlerErrors <- "first event: " + err.Error()
					return
				}
				select {
				case <-clientHasFirstEvent:
				case <-time.After(3 * time.Second):
					handlerErrors <- "the client never received the first event while the handler ran"
					return
				}
				time.Sleep(streamTestWriteTimeout + 200*time.Millisecond)
				if err := stream.Sendf("event: second\ndata: {}\n\n"); err != nil {
					handlerErrors <- "event after the write timeout: " + err.Error()
				}
			})
			server := startStreamingServer(t, tc.wrap(handler))

			method := tc.method
			if method == "" {
				method = http.MethodGet
			}
			request, err := http.NewRequest(method, server.URL+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatalf("%s %s: %v", method, tc.path, err)
			}
			defer func() { _ = response.Body.Close() }()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", response.StatusCode)
			}
			if tc.cacheControl != "" {
				if got := response.Header.Get("Cache-Control"); got != tc.cacheControl {
					t.Fatalf("Cache-Control = %q, want the wrapper's %q restamped at flush", got, tc.cacheControl)
				}
			}
			frames := readSSEFrames(response.Body)
			frames.next(t, 2*time.Second, "first event", func(frame string) bool {
				return strings.HasPrefix(frame, "event: first\n")
			})
			close(clientHasFirstEvent)
			frames.next(t, 4*time.Second, "event written after the write timeout", func(frame string) bool {
				return strings.HasPrefix(frame, "event: second\n")
			})
			select {
			case message := <-handlerErrors:
				t.Fatal(message)
			default:
			}
		})
	}
}
