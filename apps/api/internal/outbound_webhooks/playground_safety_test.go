// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type safetyPlaygroundStore struct {
	target *PreparedPlaygroundTarget
	calls  int
}

func (s *safetyPlaygroundStore) PreparePlaygroundFire(
	_ context.Context, _, _ string, expectedConfigVersion int64, _ time.Time,
) (*PreparedPlaygroundTarget, error) {
	s.calls++
	if s.target == nil {
		return nil, ErrNotFound
	}
	if expectedConfigVersion != s.target.ConfigVersion {
		return nil, errPlaygroundWebhookChanged
	}
	return s.target, nil
}

type safetyPlaygroundLedger struct {
	mu             sync.Mutex
	recovered      *playgroundFireRecord
	recoverErr     error
	reserveErr     error
	reserved       bool
	completed      bool
	completedState string
	completedBody  playgroundFireResponse
	reservation    playgroundFireReservationInput
}

func (l *safetyPlaygroundLedger) RecoverPlaygroundFire(
	context.Context, string, string, string,
) (*playgroundFireRecord, error) {
	if l.recoverErr != nil {
		return nil, l.recoverErr
	}
	if l.recovered == nil {
		return nil, ErrNotFound
	}
	return l.recovered, nil
}

func (l *safetyPlaygroundLedger) ReservePlaygroundFire(
	_ context.Context,
	input playgroundFireReservationInput,
) (*playgroundFireReservation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.reservation = input
	if l.reserveErr != nil {
		return nil, l.reserveErr
	}
	l.reserved = true
	return &playgroundFireReservation{
		Created: true,
		Record: playgroundFireRecord{
			FireID: input.FireID, WebhookID: input.WebhookID, EventType: input.EventType,
			ConfigVersion: input.ConfigVersion,
			State:         "pending", DeliveryID: "playground-" + input.FireID,
		},
	}, nil
}

func (l *safetyPlaygroundLedger) CompletePlaygroundFire(
	_ context.Context,
	_, _ string,
	outcome string,
	_ int,
	_ bool,
	response playgroundFireResponse,
) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.completed = true
	l.completedState = outcome
	l.completedBody = response
	return nil
}

func (*safetyPlaygroundLedger) GetPlaygroundFireRecord(
	context.Context, string, string,
) (*playgroundFireRecord, error) {
	return nil, ErrNotFound
}

func TestProtectPlaygroundResponsesCoversSuccessErrorsAndValidators(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/outbound-webhooks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/playground/fire",
		nil,
	)
	request.Header.Set("If-None-Match", `"private-receipt"`)
	request.Header.Set("If-Modified-Since", time.Now().UTC().Format(http.TimeFormat))
	recorder := httptest.NewRecorder()
	ProtectPlaygroundResponses(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
			t.Fatal("conditional cache validators reached the protected handler")
		}
		w.Header().Set("ETag", `"must-be-stripped"`)
		w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
		http.Error(w, "private failure", http.StatusBadGateway)
	})).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
	for name, want := range map[string]string{
		"Cache-Control":          "private, no-store",
		"Pragma":                 "no-cache",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := recorder.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if recorder.Header().Get("ETag") != "" || recorder.Header().Get("Last-Modified") != "" {
		t.Fatalf("protected validators leaked: %#v", recorder.Header())
	}
	vary := strings.ToLower(strings.Join(recorder.Header().Values("Vary"), ","))
	if !strings.Contains(vary, "authorization") || !strings.Contains(vary, "cookie") {
		t.Fatalf("Vary = %q, want authorization and cookie", vary)
	}
}

func TestPlaygroundConcurrencyLimitIsTenantScopedAndNonBlocking(t *testing.T) {
	t.Parallel()
	limit := NewPlaygroundConcurrencyLimit(1)
	entered := make(chan struct{})
	release := make(chan struct{})
	handler := limit.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenant, _ := middleware.TenantFromContext(r.Context())
		if tenant.ID == "tenant-a" {
			select {
			case <-entered:
			default:
				close(entered)
				<-release
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	requestFor := func(tenantID string) *http.Request {
		ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: tenantID})
		return httptest.NewRequestWithContext(ctx, http.MethodPost, "/", nil)
	}
	first := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.ServeHTTP(first, requestFor("tenant-a"))
	}()
	<-entered

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, requestFor("tenant-a"))
	if second.Code != http.StatusTooManyRequests || second.Header().Get("Retry-After") != "5" {
		t.Fatalf("same-tenant contention = %d headers=%#v", second.Code, second.Header())
	}
	if !strings.Contains(second.Body.String(), `"reason":"quota"`) ||
		!strings.Contains(second.Body.String(), `"code":"playground_concurrency_limited"`) {
		t.Fatalf("same-tenant denial is not entitlement-shaped: %s", second.Body.String())
	}
	other := httptest.NewRecorder()
	handler.ServeHTTP(other, requestFor("tenant-b"))
	if other.Code != http.StatusNoContent {
		t.Fatalf("independent tenant status = %d, want 204", other.Code)
	}
	close(release)
	<-done
}

func TestPlaygroundGovernorAppliesTenantBudgetToSessionsAndAPIKeys(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		apiKey   bool
		wantPath []string
	}{
		{name: "session", wantPath: []string{"tenant", "concurrency"}},
		{name: "api key", apiKey: true, wantPath: []string{"key", "tenant", "concurrency"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var path []string
			gate := func(name string) func(http.Handler) http.Handler {
				return func(next http.Handler) http.Handler {
					return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						path = append(path, name)
						next.ServeHTTP(w, r)
					})
				}
			}
			deps := &Deps{
				PlaygroundTenantRateLimit:  gate("tenant"),
				PlaygroundAPIKeyRateLimit:  gate("key"),
				PlaygroundConcurrencyLimit: gate("concurrency"),
			}
			req := httptest.NewRequest(http.MethodPost, "/", nil)
			if tt.apiKey {
				ctx := middleware.WithAPIKeyAuth(req.Context())
				ctx = middleware.WithAPIKeyID(ctx, "key-route45")
				req = req.WithContext(ctx)
			}
			recorder := httptest.NewRecorder()
			deps.governedPlaygroundFire(recorder, req)
			if strings.Join(path, ",") != strings.Join(tt.wantPath, ",") {
				t.Fatalf("gate path = %v, want %v", path, tt.wantPath)
			}
		})
	}
}

func TestPlaygroundPayloadLimitsRejectBytesComplexityAndControlKeys(t *testing.T) {
	t.Parallel()
	if err := validatePlaygroundPayload(map[string]any{
		"value": strings.Repeat("é", playgroundMaxPayloadBytes),
	}); err != errPlaygroundPayloadTooLarge {
		t.Fatalf("UTF-8 byte amplification error = %v, want too large", err)
	}
	deep := map[string]any{}
	cursor := deep
	for index := 0; index < playgroundMaxPayloadDepth; index++ {
		next := map[string]any{}
		cursor["child"] = next
		cursor = next
	}
	if err := validatePlaygroundPayload(deep); err != errPlaygroundPayloadTooComplex {
		t.Fatalf("deep payload error = %v, want too complex", err)
	}
	if err := validatePlaygroundPayload(map[string]any{"bad\nkey": true}); err != errPlaygroundPayloadTooComplex {
		t.Fatalf("control-key error = %v, want too complex", err)
	}
	for _, eventType := range AllowedEvents {
		sample := SamplePayloadFor(eventType)
		if note, _ := sample["note"].(string); strings.HasPrefix(note, "no sample payload registered") {
			t.Errorf("%s still uses a placeholder sample", eventType)
		}
		if err := validatePlaygroundPayload(sample); err != nil {
			t.Errorf("%s sample rejected: %v", eventType, err)
		}
	}
}

func TestPlaygroundUUIDsAreCanonicalRFC4122VersionsOneThroughEight(t *testing.T) {
	t.Parallel()
	tests := []struct {
		value string
		want  bool
	}{
		{value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", want: true},
		{value: "018f0c7a-5d3b-7c2f-8b11-1c2d3e4f5a6b", want: true},
		{value: "aaaaaaaa-aaaa-8aaa-baaa-aaaaaaaaaaaa", want: true},
		{value: "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa", want: false},
		{value: "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa", want: false},
		{value: "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa", want: false},
		{value: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", want: false},
		{value: " aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", want: false},
	}
	for _, tt := range tests {
		if got := validCanonicalUUID(tt.value); got != tt.want {
			t.Errorf("validCanonicalUUID(%q) = %v, want %v", tt.value, got, tt.want)
		}
	}
}

func TestPlaygroundReceiptCiphertextIsDigestTenantAndRowBound(t *testing.T) {
	t.Parallel()
	const (
		tenantID    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		fireID      = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
		webhookID   = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
		requestHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		keyHash     = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	)
	store := &Store{Cipher: xorAuthCipher{}}
	response := playgroundFireResponse{
		FireID:                fireID,
		EventID:               playgroundEventID(fireID),
		DeliveryID:            "playground-" + fireID,
		Outcome:               "receiver_responded",
		StatusCode:            http.StatusAccepted,
		ResponseBodyTruncated: false,
	}
	record := &playgroundFireRecord{
		FireID:                fireID,
		WebhookID:             webhookID,
		EventType:             "campaign.sent",
		ConfigVersion:         7,
		DeliveryID:            "playground-" + fireID,
		State:                 "completed",
		Outcome:               "receiver_responded",
		ReceiverStatusCode:    http.StatusAccepted,
		RequestHash:           requestHash,
		IdempotencyKeyHash:    keyHash,
		ResponseBodyTruncated: false,
	}
	envelope, digest, _, err := store.encryptPlaygroundFireResponse(
		context.Background(), playgroundReceiptBinding{
			Phase:              playgroundReceiptPhaseTerminal,
			TenantID:           tenantID,
			FireID:             fireID,
			WebhookID:          webhookID,
			EventType:          record.EventType,
			RequestHash:        requestHash,
			IdempotencyKeyHash: keyHash,
			ConfigVersion:      record.ConfigVersion,
			Response:           response,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := store.decryptPlaygroundFireResponse(
		context.Background(), tenantID, record, digest, envelope,
	)
	if err != nil || decoded.FireID != fireID {
		t.Fatalf("decode = %#v, err=%v", decoded, err)
	}
	if _, err := store.decryptPlaygroundFireResponse(
		context.Background(), "another-tenant", record, digest, envelope,
	); err == nil {
		t.Fatal("tenant-swapped receipt was accepted")
	}
	if _, err := store.decryptPlaygroundFireResponse(
		context.Background(), tenantID, record, strings.Repeat("0", 64), envelope,
	); err == nil {
		t.Fatal("digest-swapped receipt was accepted")
	}
	tamperedRow := *record
	tamperedRow.ReceiverStatusCode = http.StatusOK
	if _, err := store.decryptPlaygroundFireResponse(
		context.Background(), tenantID, &tamperedRow, digest, envelope,
	); err == nil {
		t.Fatal("row-swapped receipt was accepted")
	}

}

func TestPlaygroundFireReservesBeforeReceiverAndCompletesUniqueReceipt(t *testing.T) {
	t.Parallel()
	ledger := &safetyPlaygroundLedger{}
	store := &safetyPlaygroundStore{target: &PreparedPlaygroundTarget{
		WebhookID:     "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		ConfigVersion: 7,
		DisplayURL:    "https://receiver.example.test/hook",
		Destination:   "https://receiver.example.test/hook",
		Keys: &SigningKeys{
			Algorithm: AlgorithmHMACSHA256,
			Primary:   []byte("route45-secret"),
		},
		Config: &DeliveryConfig{},
	}}
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		ledger.mu.Lock()
		reserved := ledger.reserved
		ledger.mu.Unlock()
		if !reserved {
			t.Fatal("receiver transport ran before durable reservation")
		}
		if req.Header.Get(DeliveryHeader) != "playground-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" {
			t.Fatalf("delivery id = %q", req.Header.Get(DeliveryHeader))
		}
		delivered, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(delivered, []byte(`9007199254740993`)) {
			t.Fatalf("large JSON number lost wire fidelity: %s", delivered)
		}
		return &http.Response{
			StatusCode: http.StatusAccepted,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("accepted")),
			Request:    req,
		}, nil
	})}
	deps := &Deps{playgroundStore: store, playgroundLedger: ledger, HTTPClient: client}
	body := `{"fire_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","event_type":"campaign.sent","expected_webhook_config_version":7,"payload":{"campaign_id":"cmp-1","large":9007199254740993}}`
	recorder := httptest.NewRecorder()
	servePlaygroundFireForTest(deps, recorder, playgroundFireRequest(body))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if !ledger.completed || ledger.completedState != "receiver_responded" {
		t.Fatalf("completion = %v/%q", ledger.completed, ledger.completedState)
	}
	if ledger.completedBody.FireID != "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" ||
		ledger.completedBody.DeliveryID != "playground-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" ||
		ledger.completedBody.StatusCode != http.StatusAccepted {
		t.Fatalf("receipt = %#v", ledger.completedBody)
	}
	if ledger.reservation.ConfigVersion != 7 ||
		ledger.reservation.AuditMeta.TenantID != "tenant-a" ||
		ledger.reservation.Skeleton.Outcome != "" ||
		ledger.reservation.Skeleton.StatusCode != 0 ||
		ledger.reservation.Skeleton.Error != "" ||
		ledger.reservation.Skeleton.ResponseBody != "" ||
		ledger.reservation.Skeleton.Filtered ||
		ledger.reservation.Skeleton.Ambiguous ||
		ledger.reservation.Skeleton.ResponseBodyTruncated {
		t.Fatalf("reservation did not freeze a neutral safe skeleton: %#v", ledger.reservation)
	}
}

func TestPlaygroundFireDoesNotDispatchWhenReservationDetectsConfigRace(t *testing.T) {
	t.Parallel()
	ledger := &safetyPlaygroundLedger{reserveErr: errPlaygroundWebhookChanged}
	store := &safetyPlaygroundStore{target: &PreparedPlaygroundTarget{
		WebhookID:     "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		ConfigVersion: 7,
		DisplayURL:    "https://receiver.example.test/hook",
		Destination:   "https://receiver.example.test/hook",
		Keys: &SigningKeys{
			Algorithm: AlgorithmHMACSHA256,
			Primary:   []byte("route45-secret"),
		},
		Config: &DeliveryConfig{},
	}}
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("receiver transport ran after reservation rejected a config race")
		return nil, nil
	})}
	deps := &Deps{playgroundStore: store, playgroundLedger: ledger, HTTPClient: client}
	recorder := httptest.NewRecorder()
	servePlaygroundFireForTest(
		deps,
		recorder,
		playgroundFireRequest(`{"fire_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","event_type":"campaign.sent","expected_webhook_config_version":7}`),
	)
	if recorder.Code != http.StatusConflict ||
		!strings.Contains(recorder.Body.String(), `"webhook_changed"`) {
		t.Fatalf("status/body = %d %s, want 409 webhook_changed", recorder.Code, recorder.Body.String())
	}
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if ledger.reserved || ledger.completed {
		t.Fatalf("rejected reservation state reserved=%v completed=%v", ledger.reserved, ledger.completed)
	}
}

func TestPlaygroundRecoveryPrecedesMutableTargetAndPendingNeverRefires(t *testing.T) {
	t.Parallel()
	response := playgroundFireResponse{
		FireID:       "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		EventID:      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		DeliveryID:   "playground-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		URL:          "https://receiver.example.test/hook",
		Method:       http.MethodPost,
		Headers:      map[string]string{"Content-Type": "application/json"},
		BodyJSON:     json.RawMessage(`{"event":{"type":"campaign.sent"}}`),
		Signature:    "t=1,v1=frozen",
		RequestedAt:  "2026-07-23T12:34:56Z",
		StatusCode:   http.StatusAccepted,
		ResponseBody: "accepted",
		Outcome:      "receiver_responded",
	}
	tests := []struct {
		name       string
		record     *playgroundFireRecord
		recoverErr error
		wantStatus int
		wantReplay bool
	}{
		{
			name: "completed",
			record: &playgroundFireRecord{
				FireID: response.FireID, State: "completed", Outcome: response.Outcome,
				Response: &response,
			},
			wantStatus: http.StatusOK,
			wantReplay: true,
		},
		{
			name: "pending",
			record: &playgroundFireRecord{
				FireID: response.FireID, State: "pending",
			},
			wantStatus: http.StatusConflict,
		},
		{
			name: "receipt expired",
			record: &playgroundFireRecord{
				FireID: response.FireID, State: "receipt_expired",
			},
			wantStatus: http.StatusGone,
		},
		{
			name:       "same key changed malformed body",
			recoverErr: errPlaygroundIdempotencyConflict,
			wantStatus: http.StatusUnprocessableEntity,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &safetyPlaygroundStore{}
			ledger := &safetyPlaygroundLedger{recovered: test.record, recoverErr: test.recoverErr}
			recorder := httptest.NewRecorder()
			body := `{"historical_or_changed_body":true}`
			request := playgroundFireRequest(body)
			chi.RouteContext(request.Context()).URLParams.Values[0] = "not-a-current-webhook-uuid"
			servePlaygroundFireForTest(
				&Deps{playgroundStore: store, playgroundLedger: ledger},
				recorder,
				request,
			)
			if recorder.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, test.wantStatus, recorder.Body.String())
			}
			if store.calls != 0 {
				t.Fatalf("mutable target prepared during recovery: %d calls", store.calls)
			}
			if got := recorder.Header().Get(idempotency.ReplayedHeaderName); (got == "true") != test.wantReplay {
				t.Fatalf("replay header = %q, want replay=%v", got, test.wantReplay)
			}
			if test.name == "pending" && recorder.Header().Get("Retry-After") != "5" {
				t.Fatalf("pending Retry-After = %q", recorder.Header().Get("Retry-After"))
			}
			if test.name == "receipt expired" {
				if recorder.Header().Get("Retry-After") != "" {
					t.Fatalf("expired receipt advertised retry: %q", recorder.Header().Get("Retry-After"))
				}
				if !strings.Contains(recorder.Body.String(), `"playground_fire_receipt_expired"`) {
					t.Fatalf("expired body = %s", recorder.Body.String())
				}
			}
		})
	}
}

func TestPlaygroundPostWithholdsOversizedReceiverPreview(t *testing.T) {
	t.Parallel()
	deps := &Deps{HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(
				`{"token":"` + strings.Repeat("s", MaxResponseBodyBytes) + `"}`,
			)),
			Request: req,
		}, nil
	})}}
	status, preview, truncated, err := deps.post(
		context.Background(), "https://receiver.example.test", "signature", "primary=key",
		"campaign.sent", "event-id", "delivery-id", []byte(`{}`), nil,
	)
	if err != nil || status != http.StatusOK || !truncated || preview != "" {
		t.Fatalf("post = status %d preview %q truncated %v err %v", status, preview, truncated, err)
	}
}

func TestPlaygroundLedgerMigrationIsEncryptedTenantScopedAndTransitionGuarded(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source path")
	}
	migration, err := os.ReadFile(filepath.Join(
		filepath.Dir(source), "..", "..", "..", "..", "infra", "migrations",
		"2007_webhook_playground_fire_receipts.sql",
	))
	if err != nil {
		t.Fatal(err)
	}
	text := string(migration)
	for _, contract := range []string{
		"UNIQUE (tenant_id,idempotency_key_sha256)",
		"receipt_envelope           bytea",
		"'receipt_expired'",
		"ENABLE ROW LEVEL SECURITY",
		"FORCE ROW LEVEL SECURITY",
		"guard_outbound_webhook_playground_fire_insert",
		"guard_outbound_webhook_playground_fire_update",
		"GRANT SELECT,INSERT,UPDATE ON outbound_webhook_playground_fires TO postwave_app",
		"Deliberately omit DELETE",
	} {
		if !strings.Contains(text, contract) {
			t.Errorf("migration missing %q", contract)
		}
	}
	if strings.Contains(text, "response_body json") || strings.Contains(text, "response_envelope json") {
		t.Fatal("migration retains a plaintext JSON inspection response")
	}
}
