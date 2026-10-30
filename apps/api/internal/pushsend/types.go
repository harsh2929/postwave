// SPDX-License-Identifier: AGPL-3.0-only
//
// Package pushsend is the G-14 customer push send-path: pushsuppressions
// (migration 0253's package) noted "there is no push send path in apps/api
// today" — everything here is that path.
//
// Four parts:
//   - push_devices (migration 1745): a tenant-scoped registry of a
//     subscriber's push-capable endpoints (ios/APNs token, android/FCM
//     token), registered by POST /api/v1/push/devices.
//   - push_suppression_authorities (migration 1996): independent active
//     authority facts. Device resolution maps ios to apns and android to fcm,
//     hashes the exact raw token bytes, and fails the complete recipient closed
//     if authority evaluation is unavailable or ambiguous.
//   - PushSender: a live ChannelSender matching the exact shape of
//     internal/omnichannel's ChannelSender (see channel_senders.go's
//     EmailSender) so the composition root can chain it into the same
//     omnichannel dispatch pipeline that already drives email/SMS.
//   - APNsProvider / FCMProvider: real HTTP request construction against
//     Apple's and Google's push endpoints, inert (return a clear
//     "not configured" error) until credentials are supplied via env.
//
// The composition root chains PushSender behind the omnichannel runtime hold.
// Provider credentials and release qualification remain separate deployment
// concerns; suppression authority is nevertheless mandatory in the resolver
// so a future enablement cannot bypass the gate.
package pushsend

import "context"

// Device is one push-capable endpoint for a subscriber, as resolved from
// push_devices at send time.
type Device struct {
	Token    string
	Platform string // "ios" | "android" — mirrors push_devices_platform_check
	AppID    string // APNs bundle id / FCM project id override; "" = provider default
}

// PushProvider dispatches one push notification to one device token. APNs
// and FCM adapters implement this; both are real request-construction code
// that returns a clear "<provider> not configured" error when credentials
// are absent rather than silently no-op'ing. SendPush runs while the tenant's
// shared eligibility lease is held. An adapter may collect terminal feedback
// in memory or enqueue it, but it must not synchronously wait for a device or
// suppression-authority database mutation; persist that feedback only after
// SendPush returns and the lease has been released.
type PushProvider interface {
	SendPush(ctx context.Context, token, platform, title, body string, data map[string]any) error
}
