// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func TestDeviceSignInOutboxHandlerDispatchesSecretFreeEvent(t *testing.T) {
	t.Parallel()
	payload := deviceSignInOutboxPayload{
		Version:    deviceSignInOutboxVersion,
		UserID:     "02ec11b5-f684-4914-9480-d92a6450a95c",
		SessionID:  "MDEyMzQ1Njc4OWFiY2RlZg",
		AuthMethod: "device_grant",
		Device: DeviceIdentity{
			Label: "Edge on Windows", DeviceType: DeviceTypeDesktop,
			OS: "Windows", Client: "Edge",
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	for _, forbidden := range []string{
		"device_code", "verifier", "cookie", "consent_token", "approved_session_id", `"ip"`,
	} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("payload contains forbidden secret field %q: %s", forbidden, raw)
		}
	}

	var got NewDeviceSignIn
	handler := &DeviceSignInOutboxHandler{
		Dispatch: func(_ context.Context, event NewDeviceSignIn) error {
			got = event
			return nil
		},
	}
	err = handler.Handle(context.Background(), outbox.Event{
		TenantID: "2df6721e-4a3b-4b88-8be6-9e01d078268a",
		Kind:     DeviceSignInOutboxKind,
		Payload:  raw,
	})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if got.TenantID != "2df6721e-4a3b-4b88-8be6-9e01d078268a" ||
		got.UserID != payload.UserID || got.SessionID != payload.SessionID ||
		got.Device != payload.Device || got.IP != "" {
		t.Fatalf("dispatched event = %+v", got)
	}
}

func TestDeviceSignInOutboxHandlerRetriesDispatcherFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("notification feed unavailable")
	handler := &DeviceSignInOutboxHandler{
		Dispatch: func(context.Context, NewDeviceSignIn) error { return want },
	}
	raw, err := json.Marshal(deviceSignInOutboxPayload{
		Version: deviceSignInOutboxVersion, UserID: "user", SessionID: "session",
		AuthMethod: "device_grant",
		Device:     DeviceIdentity{Label: "Windows PC", DeviceType: DeviceTypeDesktop},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	err = handler.Handle(context.Background(), outbox.Event{
		TenantID: "tenant", Kind: DeviceSignInOutboxKind, Payload: raw,
	})
	if !errors.Is(err, want) {
		t.Fatalf("Handle error = %v, want dispatcher error", err)
	}
}

func TestDeviceSignInOutboxHandlerRejectsMalformedIntent(t *testing.T) {
	t.Parallel()
	called := false
	handler := &DeviceSignInOutboxHandler{
		Dispatch: func(context.Context, NewDeviceSignIn) error {
			called = true
			return nil
		},
	}
	for _, event := range []outbox.Event{
		{TenantID: "tenant", Kind: "wrong", Payload: json.RawMessage(`{}`)},
		{TenantID: "tenant", Kind: DeviceSignInOutboxKind, Payload: json.RawMessage(`{`)},
		{TenantID: "tenant", Kind: DeviceSignInOutboxKind, Payload: json.RawMessage(`{"version":1}`)},
		{TenantID: "tenant", Kind: DeviceSignInOutboxKind, Payload: json.RawMessage(`{"version":1,"user_id":"u","session_id":"s","auth_method":"password","device":{"device_label":"PC","device_type":"desktop"}}`)},
	} {
		if err := handler.Handle(context.Background(), event); err == nil {
			t.Fatalf("malformed event was accepted: %+v", event)
		}
	}
	if called {
		t.Fatal("dispatcher called for malformed intent")
	}
}
