// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type recordingPlaygroundDataStore struct {
	webhook      *Webhook
	prepareCalls int
}

func (s *recordingPlaygroundDataStore) PreparePlaygroundFire(
	_ context.Context,
	_, _ string,
	expected int64,
	_ time.Time,
) (*PreparedPlaygroundTarget, error) {
	s.prepareCalls++
	if s.webhook == nil {
		return nil, ErrNotFound
	}
	if s.webhook.ConfigVersion != expected {
		return nil, errPlaygroundWebhookChanged
	}
	return &PreparedPlaygroundTarget{
		WebhookID:     s.webhook.ID,
		ConfigVersion: s.webhook.ConfigVersion,
	}, nil
}

type recordingPlaygroundLedger struct{}

func (*recordingPlaygroundLedger) RecoverPlaygroundFire(context.Context, string, string, string) (*playgroundFireRecord, error) {
	return nil, ErrNotFound
}
func (*recordingPlaygroundLedger) ReservePlaygroundFire(context.Context, playgroundFireReservationInput) (*playgroundFireReservation, error) {
	panic("reservation must not run in config-version validation tests")
}
func (*recordingPlaygroundLedger) CompletePlaygroundFire(context.Context, string, string, string, int, bool, playgroundFireResponse) error {
	panic("completion must not run in revision validation tests")
}
func (*recordingPlaygroundLedger) GetPlaygroundFireRecord(context.Context, string, string) (*playgroundFireRecord, error) {
	panic("lookup must not run in revision validation tests")
}

type noOpIdempotencyStore struct{}

func (*noOpIdempotencyStore) Get(context.Context, string, string) (*idempotency.Record, error) {
	return nil, idempotency.ErrNotFound
}
func (*noOpIdempotencyStore) Claim(context.Context, *idempotency.Record) (bool, error) {
	return true, nil
}
func (*noOpIdempotencyStore) Complete(context.Context, *idempotency.Record) error { return nil }
func (*noOpIdempotencyStore) DeletePending(context.Context, string, string) error { return nil }

func playgroundFireRequest(body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant-a"})
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	ctx = context.WithValue(ctx, chi.RouteCtxKey, routeCtx)
	req := httptest.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"/api/v1/outbound-webhooks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/playground/fire",
		strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(idempotency.HeaderName, "route45-revision-test")
	return req
}

func servePlaygroundFireForTest(deps *Deps, rec *httptest.ResponseRecorder, req *http.Request) {
	wrapped := idempotency.ProcessWithHandlerOwnedReplayAndBodyLimit(
		&noOpIdempotencyStore{},
		func(r *http.Request) (string, bool) {
			tenant, ok := middleware.TenantFromContext(r.Context())
			if !ok || tenant == nil {
				return "", false
			}
			return tenant.ID, true
		},
		HandlerOwnedPlaygroundFireReplay,
		PlaygroundReplayBodyLimit,
		func(*http.Request) (string, bool) { return "webhook-playground-fire:test-user", true },
	)(http.HandlerFunc(deps.PlaygroundFire))
	wrapped.ServeHTTP(rec, req)
}

func TestPlaygroundEventCatalogKeepsExactWireShapeAndAdminMount(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	(&Deps{}).PlaygroundEvents(rec, httptest.NewRequest(http.MethodGet, "/api/v1/outbound-webhooks/playground/events", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var wire map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	if len(wire) != 1 {
		t.Fatalf("catalog keys = %#v, want exact events envelope", wire)
	}
	rawEvents, ok := wire["events"].([]any)
	if !ok {
		t.Fatalf("events = %#v, want array", wire["events"])
	}
	if len(rawEvents) != len(AllowedEvents) {
		t.Fatalf("events length = %d, want %d", len(rawEvents), len(AllowedEvents))
	}
	for index, rawEvent := range rawEvents {
		event, ok := rawEvent.(map[string]any)
		if !ok || len(event) != 2 {
			t.Fatalf("events[%d] = %#v, want exact two-field object", index, rawEvent)
		}
		if event["event_type"] != AllowedEvents[index] {
			t.Errorf("events[%d].event_type = %#v, want %q", index, event["event_type"], AllowedEvents[index])
		}
		if _, ok := event["sample_payload"].(map[string]any); !ok {
			t.Errorf("events[%d].sample_payload = %#v, want object", index, event["sample_payload"])
		}
	}

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	mainSource, err := os.ReadFile(filepath.Join(filepath.Dir(source), "..", "..", "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(mainSource)
	mount := strings.Index(text, "outboundWebhooksDeps.MountPlaygroundRoutes(r)")
	if mount < 0 {
		t.Fatal("main.go does not mount playground routes")
	}
	playgroundSource, err := os.ReadFile(filepath.Join(filepath.Dir(source), "playground.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(playgroundSource), "requireAdmin := apikeys.RequireExactTenantAdmin") ||
		!strings.Contains(string(playgroundSource), "r.With(ProtectPlaygroundResponses, requireAdmin)") {
		t.Fatal("playground mount does not defensively own its exact-admin and private-response gates")
	}
	if strings.Contains(string(playgroundSource), "requireAdmin := apikeys.RequireScope(apikeys.ScopeAdmin)") {
		t.Fatal("playground mount regressed to delegable custom-role admin grants")
	}
}

func TestPlaygroundFireRejectsMissingInvalidOrStaleWebhookConfigVersionBeforePreparation(t *testing.T) {
	t.Parallel()

	const currentConfigVersion int64 = 7
	tests := []struct {
		name          string
		configVersion any
		wantStatus    int
		wantCode      string
	}{
		{
			name:          "missing",
			configVersion: nil,
			wantStatus:    http.StatusBadRequest,
			wantCode:      "expected_webhook_config_version_required",
		},
		{
			name:          "zero",
			configVersion: int64(0),
			wantStatus:    http.StatusBadRequest,
			wantCode:      "invalid_expected_webhook_config_version",
		},
		{
			name:          "negative",
			configVersion: int64(-1),
			wantStatus:    http.StatusBadRequest,
			wantCode:      "invalid_expected_webhook_config_version",
		},
		{
			name:          "outside JSON safe integer range",
			configVersion: MaxWebhookConfigVersion + 1,
			wantStatus:    http.StatusBadRequest,
			wantCode:      "invalid_expected_webhook_config_version",
		},
		{
			name:          "stale",
			configVersion: currentConfigVersion - 1,
			wantStatus:    http.StatusConflict,
			wantCode:      "webhook_changed",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &recordingPlaygroundDataStore{
				webhook: &Webhook{
					ID:            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					ConfigVersion: currentConfigVersion,
				},
			}
			input := map[string]any{
				"fire_id":    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				"event_type": "campaign.sent",
			}
			if tt.configVersion != nil {
				input["expected_webhook_config_version"] = tt.configVersion
			}
			body, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			rec := httptest.NewRecorder()
			servePlaygroundFireForTest(
				&Deps{playgroundStore: store, playgroundLedger: &recordingPlaygroundLedger{}},
				rec,
				playgroundFireRequest(string(body)),
			)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"`+tt.wantCode+`"`) {
				t.Fatalf("body = %s, want code %q", rec.Body.String(), tt.wantCode)
			}
			wantPrepareCalls := 0
			if tt.name == "stale" {
				wantPrepareCalls = 1
			}
			if store.prepareCalls != wantPrepareCalls {
				t.Fatalf("prepare calls = %d, want %d", store.prepareCalls, wantPrepareCalls)
			}
		})
	}
}

func TestExpectedPlaygroundConfigVersionMustBePositiveAndExactlyRepresentable(t *testing.T) {
	t.Parallel()

	if _, err := validateExpectedPlaygroundConfigVersion(nil); !errors.Is(err, errExpectedWebhookConfigVersionRequired) {
		t.Fatalf("nil version error = %v", err)
	}
	zero := int64(0)
	if _, err := validateExpectedPlaygroundConfigVersion(&zero); !errors.Is(err, errExpectedWebhookConfigVersionInvalid) {
		t.Fatalf("zero version error = %v", err)
	}
	tooLarge := MaxWebhookConfigVersion + 1
	if _, err := validateExpectedPlaygroundConfigVersion(&tooLarge); !errors.Is(err, errExpectedWebhookConfigVersionInvalid) {
		t.Fatalf("unsafe version error = %v", err)
	}
	valid := int64(1)
	if got, err := validateExpectedPlaygroundConfigVersion(&valid); err != nil || got != valid {
		t.Fatalf("valid version = %d, err=%v", got, err)
	}
	max := MaxWebhookConfigVersion
	if got, err := validateExpectedPlaygroundConfigVersion(&max); err != nil || got != max {
		t.Fatalf("maximum version = %d, err=%v", got, err)
	}
}

func TestPlaygroundFireMapsStrictJSONContractErrorsBeforePreparation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		body     string
		wantCode string
	}{
		{
			name:     "explicit null payload",
			body:     `{"fire_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","event_type":"campaign.sent","expected_webhook_config_version":7,"payload":null}`,
			wantCode: "payload_null",
		},
		{
			name:     "recursive duplicate member",
			body:     `{"fire_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","event_type":"campaign.sent","expected_webhook_config_version":7,"payload":{"nested":{"same":1,"same":2}}}`,
			wantCode: "duplicate_json_member",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &recordingPlaygroundDataStore{webhook: &Webhook{
				ID:            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				ConfigVersion: 7,
			}}
			recorder := httptest.NewRecorder()
			servePlaygroundFireForTest(
				&Deps{playgroundStore: store, playgroundLedger: &recordingPlaygroundLedger{}},
				recorder,
				playgroundFireRequest(test.body),
			)
			if recorder.Code != http.StatusBadRequest ||
				!strings.Contains(recorder.Body.String(), `"`+test.wantCode+`"`) {
				t.Fatalf("status/body = %d %s, want 400/%s", recorder.Code, recorder.Body.String(), test.wantCode)
			}
			if store.prepareCalls != 0 {
				t.Fatalf("prepared mutable target after strict JSON refusal: %d", store.prepareCalls)
			}
		})
	}
}

func TestFilteredPlaygroundResponseKeepsExactInspectableWireShape(t *testing.T) {
	t.Parallel()

	response := playgroundFireResponse{
		FireID:       "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		EventID:      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		DeliveryID:   "playground-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		URL:          "https://receiver.example.test/…",
		Method:       http.MethodPost,
		Headers:      map[string]string{},
		BodyJSON:     json.RawMessage(`{"event":{"type":"campaign.sent"}}`),
		RequestedAt:  time.Date(2026, 7, 23, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
		StatusCode:   http.StatusNoContent,
		ResponseBody: "",
		LatencyMs:    0,
		Filtered:     true,
		Outcome:      "filtered",
		Ambiguous:    false,
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	expectedKeys := []string{
		"fire_id",
		"event_id",
		"delivery_id",
		"url",
		"method",
		"headers",
		"body",
		"signature",
		"requested_at",
		"status_code",
		"response_body",
		"latency_ms",
		"filtered",
		"outcome",
		"ambiguous",
		"response_body_truncated",
	}
	if len(wire) != len(expectedKeys) {
		t.Fatalf("filtered response keys = %#v, want exact contract %v", wire, expectedKeys)
	}
	for _, key := range expectedKeys {
		if _, ok := wire[key]; !ok {
			t.Errorf("filtered response missing %q: %#v", key, wire)
		}
	}
	headers, ok := wire["headers"].(map[string]any)
	if !ok || len(headers) != 0 {
		t.Fatalf("filtered headers = %#v, want empty JSON object", wire["headers"])
	}
	if wire["signature"] != "" ||
		wire["response_body"] != "" ||
		wire["status_code"] != float64(http.StatusNoContent) ||
		wire["filtered"] != true {
		t.Fatalf("filtered response values = %#v", wire)
	}

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	handlerSource, err := os.ReadFile(filepath.Join(filepath.Dir(source), "playground.go"))
	if err != nil {
		t.Fatal(err)
	}
	filteredBranch := string(handlerSource)
	for _, contract := range []string{
		"if prepared.Filtered {",
		"Headers:           map[string]string{}",
		"Filtered:          true",
	} {
		if !strings.Contains(filteredBranch, contract) {
			t.Errorf("filtered playground handler missing contract %q", contract)
		}
	}
}
