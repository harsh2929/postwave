// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
)

// dispatchNewDeviceSignInAlert is synchronous so the transactional outbox
// worker can retry a failed notification-feed write. Live push channels remain
// best-effort inside notifyfanout; the feed row is the durable alert identity
// and its dedupe key makes an outbox replay idempotent by target session.
func dispatchNewDeviceSignInAlert(
	ctx context.Context,
	fanout *notifyfanout.Fanout,
	mobile mobileSignInAlertSender,
	event auth.NewDeviceSignIn,
) error {
	if fanout == nil {
		return errors.New("new-device notification fanout is unavailable")
	}
	where := event.Device.Label
	if event.IP != "" {
		where += " (" + event.IP + ")"
	}
	deliveries := fanout.Dispatch(ctx, event.TenantID, []string{event.UserID}, notifyfanout.Event{
		Type:       auth.SignInEventType,
		Kind:       "security",
		Title:      "New sign-in to your Moosewave account",
		Body:       "A new sign-in from " + where + " using " + event.AuthMethod + ". If this wasn't you, revoke the session now.",
		MobileBody: "New sign-in from " + event.Device.Label + ". Not you?",
		URL:        "/app/settings/security",
		EntityID:   event.SessionID,
		DedupeKey:  auth.SignInEventType + ":" + event.SessionID,
		Payload: map[string]any{
			"session_id":  event.SessionID,
			"device_type": event.Device.DeviceType,
			"auth_method": event.AuthMethod,
		},
	})
	if len(deliveries) != 1 || deliveries[0].UserID != event.UserID ||
		strings.TrimSpace(deliveries[0].NotificationID) == "" {
		return fmt.Errorf("new-device notification feed did not persist recipient %s", event.UserID)
	}
	// notifyfanout suppresses every channel on a feed-dedup hit. That is the
	// right default for ordinary best-effort events, but an outbox worker may
	// have crashed after the feed insert and before native delivery. Re-enter
	// the native sender even on a dedup hit: mobile_push_deliveries has its own
	// per-device idempotency ledger, so an accepted/queued delivery is a no-op,
	// while a missing delivery is safely resumed. Once claimed, its retry
	// worker owns transient Expo failures independently of this outbox row.
	if mobile != nil {
		_, err := mobile.SendToUser(ctx, event.TenantID, event.UserID, mobilepush.Notification{
			EventType:      auth.SignInEventType,
			EntityID:       event.SessionID,
			IdempotencyKey: auth.SignInEventType + ":" + event.SessionID + ":" + event.UserID,
			Title:          "New sign-in to your Moosewave account",
			Body:           "New sign-in from " + event.Device.Label + ". Not you?",
			NotificationID: deliveries[0].NotificationID,
		})
		if err != nil && !errors.Is(err, mobilepush.ErrPushDeliveryDisabled) {
			return fmt.Errorf("resume new-device native delivery: %w", err)
		}
	}
	return nil
}

type mobileSignInAlertSender interface {
	SendToUser(context.Context, string, string, mobilepush.Notification) (int, error)
}
