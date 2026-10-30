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
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

type recordingOutboundReplayStore struct {
	keys        []string
	deliveryIDs []string
	result      ReplayDeliveryResult
	err         error
}

func (s *recordingOutboundReplayStore) ReplayDelivery(
	_ context.Context,
	_, deliveryID, idempotencyKey string,
) (ReplayDeliveryResult, error) {
	s.keys = append(s.keys, idempotencyKey)
	s.deliveryIDs = append(s.deliveryIDs, deliveryID)
	return s.result, s.err
}

func outboundReplayHandlerRequest(headerValues ...string) *http.Request {
	ctx := middleware.WithTenant(
		context.Background(),
		&middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"},
	)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")
	ctx = context.WithValue(ctx, chi.RouteCtxKey, routeCtx)
	request := httptest.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"/api/v1/outbound-webhooks/deliveries/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/replay",
		nil,
	)
	if headerValues != nil {
		request.Header[idempotency.HeaderName] = headerValues
	}
	return request
}

func TestOutboundReplayHandlerRequiresOneBoundedIdempotencyKey(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		values []string
		code   string
	}{
		{name: "missing", code: "idempotency_key_required"},
		{name: "blank", values: []string{"   "}, code: "idempotency_key_required"},
		{
			name:   "multiple",
			values: []string{"operator-click-1", "operator-click-2"},
			code:   "invalid_idempotency_key",
		},
		{
			name:   "oversized",
			values: []string{strings.Repeat("k", idempotency.MaxKeyLength+1)},
			code:   "invalid_idempotency_key",
		},
		{
			name:   "control",
			values: []string{"operator\nclick"},
			code:   "invalid_idempotency_key",
		},
		{
			name:   "invalid UTF-8",
			values: []string{string([]byte{0xff})},
			code:   "invalid_idempotency_key",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			store := &recordingOutboundReplayStore{}
			deps := &Deps{replayStore: store}
			recorder := httptest.NewRecorder()

			deps.ReplayDelivery(
				recorder,
				outboundReplayHandlerRequest(test.values...),
			)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf(
					"status = %d, want 400; body=%s",
					recorder.Code,
					recorder.Body.String(),
				)
			}
			if len(store.keys) != 0 {
				t.Fatalf("invalid request reached store with keys %#v", store.keys)
			}
			if !strings.Contains(recorder.Body.String(), `"`+test.code+`"`) {
				t.Fatalf("body = %s, want code %q", recorder.Body.String(), test.code)
			}
		})
	}
}

func TestOutboundReplayHandlerReturnsExactFrozenContract(t *testing.T) {
	t.Parallel()

	replayedAt := time.Date(2026, 7, 23, 9, 8, 7, 123000000, time.UTC)
	store := &recordingOutboundReplayStore{
		result: ReplayDeliveryResult{
			DeliveryID:   "33333333-3333-4333-8333-333333333333",
			ReplayedFrom: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			Status:       "pending",
			ReplayedAt:   replayedAt,
		},
	}
	deps := &Deps{replayStore: store}

	invoke := func() string {
		t.Helper()
		recorder := httptest.NewRecorder()
		deps.ReplayDelivery(
			recorder,
			outboundReplayHandlerRequest("  stable-operator-click  "),
		)
		if recorder.Code != http.StatusAccepted {
			t.Fatalf(
				"status = %d, want 202; body=%s",
				recorder.Code,
				recorder.Body.String(),
			)
		}
		return recorder.Body.String()
	}
	firstBody := invoke()
	secondBody := invoke()
	if firstBody != secondBody {
		t.Fatalf("same logical replay changed response:\nfirst %s\nsecond %s", firstBody, secondBody)
	}
	if len(store.keys) != 2 ||
		store.keys[0] != "stable-operator-click" ||
		store.keys[1] != "stable-operator-click" {
		t.Fatalf("normalized forwarded keys = %#v", store.keys)
	}
	if len(store.deliveryIDs) != 2 ||
		store.deliveryIDs[0] != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" ||
		store.deliveryIDs[1] != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
		t.Fatalf("canonical forwarded delivery ids = %#v", store.deliveryIDs)
	}

	var body map[string]any
	if err := json.Unmarshal([]byte(firstBody), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body) != 4 {
		t.Fatalf("response keys = %#v, want exact four-field contract", body)
	}
	for _, key := range []string{"delivery_id", "replayed_from", "status", "replayed_at"} {
		if _, ok := body[key]; !ok {
			t.Errorf("response missing %q: %#v", key, body)
		}
	}
	replayedAtText, ok := body["replayed_at"].(string)
	if !ok {
		t.Fatalf("replayed_at = %#v, want RFC3339 string", body["replayed_at"])
	}
	parsed, err := time.Parse(time.RFC3339Nano, replayedAtText)
	if err != nil || !parsed.Equal(replayedAt) {
		t.Fatalf("replayed_at = %q (%v), want %s", replayedAtText, err, replayedAt)
	}
}

func TestOutboundReplayHandlerMapsSemanticKeyReuseToConflict(t *testing.T) {
	t.Parallel()

	store := &recordingOutboundReplayStore{err: ErrReplayConflict}
	recorder := httptest.NewRecorder()
	(&Deps{replayStore: store}).ReplayDelivery(
		recorder,
		outboundReplayHandlerRequest("reused-key"),
	)

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"idempotency_key_conflict"`) {
		t.Fatalf("body = %s, want conflict code", recorder.Body.String())
	}
}

func TestOutboundReplayHandlerPreservesLifecycleFailureContract(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "missing or tombstoned", err: ErrNotFound, status: http.StatusNotFound, code: "not_found"},
		{
			name:   "source in flight",
			err:    ErrDeliveryInProgress,
			status: http.StatusConflict,
			code:   "delivery_in_progress",
		},
		{
			name:   "inactive parent",
			err:    ErrWebhookInactive,
			status: http.StatusConflict,
			code:   "webhook_inactive",
		},
		{
			name:   "auth pending",
			err:    ErrAuthConfigPending,
			status: http.StatusConflict,
			code:   "receiver_auth_unavailable",
		},
		{
			name:   "auth invalid",
			err:    ErrAuthConfigInvalid,
			status: http.StatusConflict,
			code:   "receiver_auth_unavailable",
		},
		{
			name:   "destination pending",
			err:    ErrDestinationPending,
			status: http.StatusConflict,
			code:   "destination_unavailable",
		},
		{
			name:   "destination invalid",
			err:    ErrDestinationInvalid,
			status: http.StatusConflict,
			code:   "destination_unavailable",
		},
		{
			name:   "delivery policy invalid",
			err:    ErrDeliveryPolicyInvalid,
			status: http.StatusConflict,
			code:   "delivery_configuration_invalid",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			store := &recordingOutboundReplayStore{err: test.err}
			recorder := httptest.NewRecorder()
			(&Deps{replayStore: store}).ReplayDelivery(
				recorder,
				outboundReplayHandlerRequest("lifecycle-check"),
			)
			if recorder.Code != test.status {
				t.Fatalf(
					"status = %d, want %d; body=%s",
					recorder.Code,
					test.status,
					recorder.Body.String(),
				)
			}
			if !strings.Contains(recorder.Body.String(), `"`+test.code+`"`) {
				t.Fatalf("body = %s, want code %q", recorder.Body.String(), test.code)
			}
		})
	}
}

func TestReplayDeliveryRejectsInvalidKeyBeforeDatabase(t *testing.T) {
	t.Parallel()

	store := &Store{}
	tests := []struct {
		name string
		key  string
		want error
	}{
		{name: "empty", want: ErrReplayIdempotencyRequired},
		{name: "blank", key: "  ", want: ErrReplayIdempotencyRequired},
		{
			name: "oversized",
			key:  strings.Repeat("k", idempotency.MaxKeyLength+1),
			want: ErrReplayIdempotencyInvalid,
		},
		{name: "control", key: "bad\tkey", want: ErrReplayIdempotencyInvalid},
		{name: "invalid UTF-8", key: string([]byte{0xff}), want: ErrReplayIdempotencyInvalid},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, err := store.ReplayDelivery(
				context.Background(),
				"tenant",
				"delivery",
				test.key,
			); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
	if _, err := store.ReplayDelivery(
		context.Background(),
		"tenant",
		"not-a-delivery-uuid",
		"valid-key",
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("malformed delivery id error = %v, want ErrNotFound", err)
	}
}

func TestOutboundReplayIdempotencyMigrationAndStoreContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	root := filepath.Dir(source)
	migrationPath := filepath.Clean(filepath.Join(
		root,
		"../../../../infra/migrations/1802_outbound_webhook_replay_idempotency.sql",
	))
	rawMigration, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatal(err)
	}
	migration := string(rawMigration)
	file := migrationrunner.MigrationFile{
		Version: "1802_outbound_webhook_replay_idempotency",
		Path:    migrationPath,
		SQL:     migration,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1802 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS replay_idempotency_hash bytea",
		"ADD COLUMN IF NOT EXISTS replayed_at timestamptz",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS",
		"ON outbound_webhook_deliveries (tenant_id, replay_idempotency_hash)",
		"WHERE replay_idempotency_hash IS NOT NULL",
		"octet_length(replay_idempotency_hash) = 32",
		"AND parent_delivery_id IS NOT NULL",
		"AND replayed_at IS NOT NULL",
		"VALIDATE CONSTRAINT outbound_webhook_deliveries_replay_receipt_check",
	} {
		if !strings.Contains(migration, contract) {
			t.Errorf("migration 1802 missing contract %q", contract)
		}
	}

	storeRaw, err := os.ReadFile(filepath.Join(root, "store.go"))
	if err != nil {
		t.Fatal(err)
	}
	storeSource := string(storeRaw)
	for _, contract := range []string{
		"normalizeOutboundReplayIdempotencyKey(idempotencyKey)",
		"loadOutboundReplayByKeyTx(",
		"replay_idempotency_hash, replayed_at",
		"ON CONFLICT (tenant_id, replay_idempotency_hash)",
		"return ReplayDeliveryResult{}, ErrReplayConflict",
	} {
		if !strings.Contains(storeSource, contract) {
			t.Errorf("outbound replay store missing contract %q", contract)
		}
	}
}
