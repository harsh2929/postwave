// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notification_feed"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
)

type signInAlertFeed struct {
	id      string
	created bool
	err     error
}

func (f *signInAlertFeed) NotifyDeduped(
	context.Context,
	string,
	string,
	notification_feed.NewNotification,
	string,
	string,
) (string, bool, error) {
	return f.id, f.created, f.err
}

type signInAlertMobile struct {
	notices []mobilepush.Notification
	err     error
}

func (m *signInAlertMobile) SendToUser(
	_ context.Context,
	_, _ string,
	notice mobilepush.Notification,
) (int, error) {
	m.notices = append(m.notices, notice)
	return 0, m.err
}

func TestDispatchNewDeviceSignInAlertResumesNativeAfterFeedDedupe(t *testing.T) {
	t.Parallel()
	feed := &signInAlertFeed{id: "notification-1", created: false}
	mobile := &signInAlertMobile{}
	event := auth.NewDeviceSignIn{
		TenantID: "tenant", UserID: "user", SessionID: "session",
		AuthMethod: "device_grant",
		Device: auth.DeviceIdentity{
			Label: "Edge on Windows", DeviceType: auth.DeviceTypeDesktop,
		},
	}
	fanout := &notifyfanout.Fanout{Feed: feed}

	// Two worker attempts model a crash after feed persistence. The
	// specialized path re-enters native delivery on both attempts with one
	// stable per-session/per-user idempotency key; the production mobile sender
	// collapses those against mobile_push_deliveries.
	for range 2 {
		if err := dispatchNewDeviceSignInAlert(context.Background(), fanout, mobile, event); err != nil {
			t.Fatalf("dispatch: %v", err)
		}
	}
	if len(mobile.notices) != 2 {
		t.Fatalf("native resume calls = %d, want 2 attempts", len(mobile.notices))
	}
	for _, notice := range mobile.notices {
		if notice.IdempotencyKey != auth.SignInEventType+":session:user" ||
			notice.NotificationID != "notification-1" || notice.EntityID != "session" {
			t.Fatalf("native resume notice = %+v", notice)
		}
	}
}

func TestDispatchNewDeviceSignInAlertRetriesDurabilityFailures(t *testing.T) {
	t.Parallel()
	event := auth.NewDeviceSignIn{
		TenantID: "tenant", UserID: "user", SessionID: "session",
		AuthMethod: "device_grant",
		Device:     auth.DeviceIdentity{Label: "Windows PC", DeviceType: auth.DeviceTypeDesktop},
	}

	feedErr := errors.New("feed unavailable")
	mobile := &signInAlertMobile{}
	if err := dispatchNewDeviceSignInAlert(context.Background(), &notifyfanout.Fanout{
		Feed: &signInAlertFeed{err: feedErr},
	}, mobile, event); err == nil {
		t.Fatal("feed failure was treated as delivered")
	}
	if len(mobile.notices) != 0 {
		t.Fatal("native delivery ran without a durable notification identity")
	}

	mobile = &signInAlertMobile{}
	if err := dispatchNewDeviceSignInAlert(context.Background(), &notifyfanout.Fanout{
		Feed: &signInAlertFeed{created: true},
	}, mobile, event); err == nil {
		t.Fatal("empty durable notification id was treated as delivered")
	}
	if len(mobile.notices) != 0 {
		t.Fatal("native delivery ran with an empty notification identity")
	}

	mobileErr := errors.New("device lookup unavailable")
	mobile = &signInAlertMobile{err: mobileErr}
	if err := dispatchNewDeviceSignInAlert(context.Background(), &notifyfanout.Fanout{
		Feed: &signInAlertFeed{id: "notification-1", created: false},
	}, mobile, event); !errors.Is(err, mobileErr) {
		t.Fatalf("native pre-claim failure = %v, want retryable source error", err)
	}
}
