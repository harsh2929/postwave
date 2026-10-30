// SPDX-License-Identifier: AGPL-3.0-only
//
// push.go — an optional browser/web-push channel for approval requests. The
// PostmarkNotifier already emails each gated recipient; when a PushNotifier is
// wired (main.go bridges it to internal/webpush) the same gated recipients also
// get an instant browser notification, so an approver sees the request even
// with their inbox closed.
//
// The interface + payload type are kept local so the approvals package does not
// import internal/webpush directly — main.go owns the adapter, matching the
// AdminLister / Dispatcher wiring pattern in this package.
package approvals

import "context"

// PushNotification is a single browser/web-push message. Its fields mirror the
// subset of webpush.Notification the service worker's direct-render branch
// reads (title/body/url/tag); the icon is supplied by the service worker.
type PushNotification struct {
	Title string
	Body  string
	URL   string
	Tag   string
}

// PushNotifier delivers a browser web push to one user's registered browsers.
// Implementations are best-effort and MUST be a no-op (0, nil) when web push is
// unconfigured, so the notifier can fan out unconditionally. The int return is
// the number of the user's browser endpoints the push reached.
type PushNotifier interface {
	SendToUser(ctx context.Context, tenantID, userID string, n PushNotification) (int, error)
}
