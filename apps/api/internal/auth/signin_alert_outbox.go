// SPDX-License-Identifier: AGPL-3.0-only
//
// Durable delivery for the security-sensitive cross-device sign-in alert.
// The ordinary sign-in heuristic in signin_alert.go remains best-effort, but
// device-grant confirmation is an explicit credential transfer and therefore
// writes its alert intent in the SAME transaction that activates the session.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// DeviceSignInOutboxKind is the shared-worker routing key. It is deliberately
// distinct from SignInEventType: this names a durable transport command while
// SignInEventType names the notification users and clients observe.
const DeviceSignInOutboxKind = "auth.new_device_sign_in.dispatch"

const deviceSignInOutboxVersion = 1

// DeviceSignInOutboxAppender is the narrow part of outbox.Repo confirmation
// needs. Keeping the interface here makes transaction rollback behaviour easy
// to prove without teaching the auth repository about worker internals.
type DeviceSignInOutboxAppender interface {
	Append(context.Context, pgx.Tx, outbox.Append) (string, error)
}

// deviceSignInOutboxPayload contains display/routing metadata only. In
// particular it never carries the device code, cookie, verifier, hashes, raw
// IP, or the approving session id. SessionID is an opaque public revoke target
// (the same id exposed by the active-sessions API and native action payload).
type deviceSignInOutboxPayload struct {
	Version    int            `json:"version"`
	UserID     string         `json:"user_id"`
	SessionID  string         `json:"session_id"`
	AuthMethod string         `json:"auth_method"`
	Device     DeviceIdentity `json:"device"`
}

func (r *Repo) appendDeviceSignInIntent(
	ctx context.Context,
	tx pgx.Tx,
	event NewDeviceSignIn,
) error {
	if r == nil || r.DeviceSignInOutbox == nil {
		return errors.New("device sign-in alert outbox is unavailable")
	}
	payload := deviceSignInOutboxPayload{
		Version:    deviceSignInOutboxVersion,
		UserID:     event.UserID,
		SessionID:  event.SessionID,
		AuthMethod: event.AuthMethod,
		Device:     event.Device,
	}
	if err := validateDeviceSignInOutboxPayload(payload); err != nil {
		return err
	}
	if _, err := r.DeviceSignInOutbox.Append(ctx, tx, outbox.Append{
		TenantID: event.TenantID,
		Kind:     DeviceSignInOutboxKind,
		Payload:  payload,
	}); err != nil {
		return fmt.Errorf("append device sign-in alert intent: %w", err)
	}
	return nil
}

func validateDeviceSignInOutboxPayload(payload deviceSignInOutboxPayload) error {
	if payload.Version != deviceSignInOutboxVersion {
		return fmt.Errorf("device sign-in alert payload version %d is unsupported", payload.Version)
	}
	if strings.TrimSpace(payload.UserID) == "" || strings.TrimSpace(payload.SessionID) == "" {
		return errors.New("device sign-in alert payload requires user_id and session_id")
	}
	if payload.AuthMethod != "device_grant" {
		return fmt.Errorf("device sign-in alert auth_method %q is unsupported", payload.AuthMethod)
	}
	if strings.TrimSpace(payload.Device.Label) == "" || strings.TrimSpace(payload.Device.DeviceType) == "" {
		return errors.New("device sign-in alert payload requires normalized device identity")
	}
	return nil
}

// DeviceSignInOutboxHandler decodes one durable intent and hands it to the
// composition root's synchronous notifyfanout adapter. Returning its error is
// what activates the shared outbox retry/DLQ policy. The adapter treats a
// notification-feed dedupe hit as success, so a worker crash/replay cannot
// create a second logical alert for the same session.
type DeviceSignInOutboxHandler struct {
	Dispatch func(context.Context, NewDeviceSignIn) error
}

func (h *DeviceSignInOutboxHandler) Handle(ctx context.Context, event outbox.Event) error {
	if h == nil || h.Dispatch == nil {
		return errors.New("device sign-in alert dispatcher is unavailable")
	}
	if event.Kind != DeviceSignInOutboxKind || strings.TrimSpace(event.TenantID) == "" {
		return errors.New("invalid device sign-in alert outbox envelope")
	}
	var payload deviceSignInOutboxPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return fmt.Errorf("decode device sign-in alert payload: %w", err)
	}
	if err := validateDeviceSignInOutboxPayload(payload); err != nil {
		return err
	}
	return h.Dispatch(ctx, NewDeviceSignIn{
		TenantID:   event.TenantID,
		UserID:     payload.UserID,
		SessionID:  payload.SessionID,
		AuthMethod: payload.AuthMethod,
		Device:     payload.Device,
	})
}
