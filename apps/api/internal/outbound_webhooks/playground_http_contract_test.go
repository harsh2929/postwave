// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func playgroundDecodeRequest(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/outbound-webhooks/id/playground/fire", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestDecodePlaygroundFireInputPreservesNumbersAndDistinguishesPayloadPresence(t *testing.T) {
	t.Parallel()

	omitted, err := decodePlaygroundFireInput(playgroundDecodeRequest(`{
		"fire_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		"event_type":"campaign.sent",
		"expected_webhook_config_version":17
	}`))
	if err != nil {
		t.Fatalf("decode omitted payload: %v", err)
	}
	if omitted.PayloadProvided || omitted.Payload != nil {
		t.Fatalf("omitted payload = %#v provided=%v, want catalog fallback marker", omitted.Payload, omitted.PayloadProvided)
	}
	if omitted.ExpectedWebhookConfigVersion == nil || *omitted.ExpectedWebhookConfigVersion != 17 {
		t.Fatalf("config version = %#v, want 17", omitted.ExpectedWebhookConfigVersion)
	}

	withNumbers, err := decodePlaygroundFireInput(playgroundDecodeRequest(`{
		"fire_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		"event_type":"campaign.sent",
		"expected_webhook_config_version":17,
		"payload":{"large":9007199254740993,"decimal":0.10000000000000000001,"exponent":1e+30,"huge":1e400}
	}`))
	if err != nil {
		t.Fatalf("decode numeric payload: %v", err)
	}
	if !withNumbers.PayloadProvided {
		t.Fatal("provided payload was marked omitted")
	}
	for name, want := range map[string]string{
		"large":    "9007199254740993",
		"decimal":  "0.10000000000000000001",
		"exponent": "1e+30",
		"huge":     "1e400",
	} {
		number, ok := withNumbers.Payload[name].(json.Number)
		if !ok || number.String() != want {
			t.Errorf("payload[%s] = %#v, want json.Number(%q)", name, withNumbers.Payload[name], want)
		}
	}
	if err := validatePlaygroundPayload(withNumbers.Payload); err != nil {
		t.Fatalf("high-precision JSON numbers rejected by payload validation: %v", err)
	}
}

func TestDecodePlaygroundFireInputRejectsNullAndRecursiveDuplicateMembers(t *testing.T) {
	t.Parallel()

	base := `"fire_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","event_type":"campaign.sent","expected_webhook_config_version":1`
	tests := []struct {
		name string
		body string
		want error
	}{
		{name: "explicit null", body: `{` + base + `,"payload":null}`, want: errPlaygroundExplicitNullPayload},
		{name: "duplicate root", body: `{` + base + `,"event_type":"audit.created"}`, want: errPlaygroundDuplicateJSONMember},
		{name: "duplicate nested object", body: `{` + base + `,"payload":{"outer":{"same":1,"same":2}}}`, want: errPlaygroundDuplicateJSONMember},
		{name: "duplicate object in array", body: `{` + base + `,"payload":{"items":[{"same":1,"same":2}]}}`, want: errPlaygroundDuplicateJSONMember},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := decodePlaygroundFireInput(playgroundDecodeRequest(test.body))
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

type countingReadCloser struct {
	reader io.Reader
	reads  int
}

func (r *countingReadCloser) Read(buffer []byte) (int, error) {
	r.reads++
	return r.reader.Read(buffer)
}

func (*countingReadCloser) Close() error { return nil }

type incompleteReceiverBody struct {
	sent bool
}

func (body *incompleteReceiverBody) Read(buffer []byte) (int, error) {
	if body.sent {
		return 0, io.ErrUnexpectedEOF
	}
	body.sent = true
	return copy(buffer, []byte(`{"partial":`)), nil
}

func (*incompleteReceiverBody) Close() error { return nil }

func TestReceiverPostNormalizesOutOfDomainHTTPStatus(t *testing.T) {
	t.Parallel()

	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 600,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"receiver":"answered"}`)),
			Request:    request,
		}, nil
	})}
	deps := &Deps{HTTPClient: client}
	status, body, truncated, err := deps.post(
		context.Background(),
		"https://receiver.example.test/hook",
		"signature",
		"key-id",
		"campaign.sent",
		"event-id",
		"delivery-id",
		[]byte(`{"event":{}}`),
		nil,
	)
	if status != 0 || truncated || err == nil || !strings.Contains(err.Error(), "unsupported HTTP status 600") {
		t.Fatalf("playground post = status %d truncated=%v err=%v, want conservative status-zero outcome", status, truncated, err)
	}
	if body != `{"receiver":"answered"}` {
		t.Fatalf("bounded response body = %q", body)
	}

	worker := &Worker{HTTPClient: client}
	workerStatus, workerBody, workerErr := worker.post(
		context.Background(),
		"https://receiver.example.test/hook",
		"signature",
		"key-id",
		"campaign.sent",
		"event-id",
		"delivery-id",
		[]byte(`{"event":{}}`),
		nil,
	)
	if workerStatus != 0 || workerErr == nil || !strings.Contains(workerErr.Error(), "unsupported HTTP status 600") || workerBody != body {
		t.Fatalf("worker post = status %d body=%q err=%v, want matching status-zero outcome", workerStatus, workerBody, workerErr)
	}

	incompleteClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    600,
			Header:        make(http.Header),
			Body:          &incompleteReceiverBody{},
			ContentLength: 100,
			Request:       request,
		}, nil
	})}
	status, incompleteBody, incompleteTruncated, err := (&Deps{HTTPClient: incompleteClient}).post(
		context.Background(),
		"https://receiver.example.test/hook",
		"signature",
		"key-id",
		"campaign.sent",
		"event-id",
		"delivery-id",
		[]byte(`{"event":{}}`),
		nil,
	)
	if status != 0 || incompleteBody != "" || !incompleteTruncated || err == nil || !strings.Contains(err.Error(), "unsupported HTTP status 600") {
		t.Fatalf(
			"incomplete out-of-domain response = status %d body=%q truncated=%v err=%v, want withheld status-zero normalization",
			status,
			incompleteBody,
			incompleteTruncated,
			err,
		)
	}
	workerStatus, workerIncompleteBody, workerErr := (&Worker{HTTPClient: incompleteClient}).post(
		context.Background(),
		"https://receiver.example.test/hook",
		"signature",
		"key-id",
		"campaign.sent",
		"event-id",
		"delivery-id",
		[]byte(`{"event":{}}`),
		nil,
	)
	if workerStatus != 0 || workerIncompleteBody != "" || workerErr == nil || !strings.Contains(workerErr.Error(), "unsupported HTTP status 600") {
		t.Fatalf(
			"worker incomplete out-of-domain response = status %d body=%q err=%v, want withheld status-zero normalization",
			workerStatus,
			workerIncompleteBody,
			workerErr,
		)
	}

	const boundarySecret = "boundary-secret-value"
	boundaryBody := strings.Repeat("x", MaxResponseBodyBytes-5) + boundarySecret
	boundaryClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusNoContent,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(boundaryBody)),
			Request:    request,
		}, nil
	})}
	boundaryStatus, boundaryPreview, boundaryErr := (&Worker{HTTPClient: boundaryClient}).post(
		context.Background(),
		"https://receiver.example.test/hook",
		"signature",
		"key-id",
		"campaign.sent",
		"event-id",
		"delivery-id",
		[]byte(`{"event":{}}`),
		&AuthConfig{Type: "bearer", BearerToken: boundarySecret},
	)
	if boundaryStatus != http.StatusNoContent || boundaryPreview != "" || boundaryErr != nil {
		t.Fatalf("oversized worker response = status %d body=%q err=%v, want authoritative 204 with withheld preview", boundaryStatus, boundaryPreview, boundaryErr)
	}
}

func TestPlaygroundRateGovernorRunsBeforeBodyReadAndMarksStandaloneFallback(t *testing.T) {
	t.Parallel()

	for _, apiKey := range []bool{false, true} {
		name := "session"
		if apiKey {
			name = "api_key"
		}
		t.Run(name, func(t *testing.T) {
			body := &countingReadCloser{reader: strings.NewReader(`{"ok":true}`)}
			var order []string
			gate := func(name string) func(http.Handler) http.Handler {
				return func(next http.Handler) http.Handler {
					return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if body.reads != 0 {
							t.Fatalf("%s limiter ran after body read", name)
						}
						order = append(order, name)
						next.ServeHTTP(w, r)
					})
				}
			}
			tenantGate := gate("tenant")
			keyGate := gate("key")
			final := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !playgroundRateAdmitted(r.Context()) {
					t.Fatal("rate admission marker missing")
				}
				_, _ = io.ReadAll(r.Body)
				w.WriteHeader(http.StatusNoContent)
			})
			standaloneFallback := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				servePlaygroundRateAdmission(w, r, tenantGate, keyGate, final)
			})
			handler := PlaygroundRateGovernor(tenantGate, keyGate)(standaloneFallback)

			ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant-a"})
			request := httptest.NewRequestWithContext(
				ctx,
				http.MethodPost,
				"/api/v1/outbound-webhooks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/playground/fire",
				nil,
			)
			request.Body = body
			if apiKey {
				ctx = middleware.WithAPIKeyAuth(request.Context())
				ctx = middleware.WithAPIKeyID(ctx, "key-route45")
				request = request.WithContext(ctx)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want 204; body=%s", recorder.Code, recorder.Body.String())
			}
			want := []string{"tenant"}
			if apiKey {
				want = []string{"key", "tenant"}
			}
			if strings.Join(order, ",") != strings.Join(want, ",") {
				t.Fatalf("limiter order = %v, want %v (and no duplicate fallback charge)", order, want)
			}
		})
	}
}

func TestRootPlaygroundProtectionCoversBodyRefusalsAndMainOrdering(t *testing.T) {
	t.Parallel()

	protected := ProtectPlaygroundResponses(
		httpbody.LimitRequests(8, nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})),
	)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/outbound-webhooks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/playground/fire",
		strings.NewReader("123456789"),
	)
	request.ContentLength = 9
	recorder := httptest.NewRecorder()
	protected.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d, want 413", recorder.Code)
	}
	if recorder.Header().Get("Cache-Control") != "private, no-store" || recorder.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("oversized private headers = %#v", recorder.Header())
	}

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source path")
	}
	mainSource, err := os.ReadFile(filepath.Join(filepath.Dir(source), "..", "..", "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(mainSource)
	rootProtect := strings.Index(text, "r.Use(outbound_webhooks.ProtectPlaygroundResponses)")
	bodyLimit := strings.Index(text, "r.Use(httpbody.LimitRequests(")
	csrf := strings.Index(text, "r.Use(middleware.AllowedOriginsCSRF(")
	clientVersion := strings.Index(text, "r.Use(middleware.ClientVersion(")
	if rootProtect < 0 || bodyLimit < 0 || csrf < 0 || clientVersion < 0 ||
		rootProtect > bodyLimit || rootProtect > csrf || rootProtect > clientVersion {
		t.Fatalf(
			"root playground protection must precede body/CSRF/client-version: protect=%d body=%d csrf=%d version=%d",
			rootProtect, bodyLimit, csrf, clientVersion,
		)
	}
	for _, handler := range []string{"r.NotFound", "r.MethodNotAllowed"} {
		start := strings.Index(text, handler+"(")
		if start < 0 {
			t.Fatalf("main.go missing %s", handler)
		}
		end := strings.Index(text[start:], ".ServeHTTP)")
		if end < 0 || !strings.Contains(text[start:start+end], "outbound_webhooks.ProtectPlaygroundResponses") {
			t.Fatalf("%s is not wrapped by playground private policy", handler)
		}
	}
	auth := strings.Index(text, "authenticatedRoutes.apply(r)")
	rate := strings.Index(text, "r.Use(outbound_webhooks.PlaygroundRateGovernor(")
	stepUp := strings.Index(text, "r.Use(stepup.Middleware(")
	idempotency := strings.Index(text, "r.Use(idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(")
	if auth < 0 || rate < auth || stepUp < rate || idempotency < stepUp {
		t.Fatalf("authenticated order must be auth -> playground rate -> step-up -> idempotency: auth=%d rate=%d stepup=%d idem=%d", auth, rate, stepUp, idempotency)
	}
}

func TestBoundPlaygroundFireResponseCapsEveryInspectableCollection(t *testing.T) {
	t.Parallel()

	headers := make(map[string]string, playgroundMaxInspectableHeaders+10)
	for index := 0; index < playgroundMaxInspectableHeaders+10; index++ {
		headers[strings.Repeat("h", playgroundMaxInspectableHeaderNameBytes+1)+string(rune(index))] = strings.Repeat("é", playgroundMaxInspectableTextBytes)
	}
	response := boundPlaygroundFireResponse(playgroundFireResponse{
		URL:          strings.Repeat("u", playgroundMaxInspectableURLBytes+1),
		Headers:      headers,
		BodyJSON:     json.RawMessage(bytes.Repeat([]byte{'x'}, playgroundMaxPreparedBodyBytes+1)),
		Signature:    strings.Repeat("s", playgroundMaxInspectableTextBytes+1),
		ResponseBody: strings.Repeat("r", playgroundMaxInspectableTextBytes+1),
		Error:        strings.Repeat("e", playgroundMaxInspectableTextBytes+1),
	})
	if len(response.URL) > playgroundMaxInspectableURLBytes ||
		len(response.Signature) > playgroundMaxInspectableTextBytes ||
		len(response.ResponseBody) > playgroundMaxInspectableTextBytes ||
		len(response.Error) > playgroundMaxInspectableTextBytes {
		t.Fatalf("inspectable strings remain unbounded: %#v", response)
	}
	if !response.ResponseBodyTruncated {
		t.Fatal("bounded response body did not set response_body_truncated")
	}
	if response.ResponseBody != "" {
		t.Fatalf("truncated receiver body leaked a partial preview: %q", response.ResponseBody)
	}
	if len(response.Headers) > playgroundMaxInspectableHeaders {
		t.Fatalf("headers = %d, want <= %d", len(response.Headers), playgroundMaxInspectableHeaders)
	}
	if len(response.BodyJSON) > playgroundMaxPreparedBodyBytes || !json.Valid(response.BodyJSON) {
		t.Fatalf("bounded body is invalid or oversized: %d bytes", len(response.BodyJSON))
	}
}
