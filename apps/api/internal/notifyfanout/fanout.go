// SPDX-License-Identifier: AGPL-3.0-only
//
// Package notifyfanout is the single server-authored notification fanout —
// fix-now items 2+3 of docs/ecosystem/apple-level-integration.md.
//
// Before it, exactly one event (approval.requested) reached any push channel,
// each producer hand-picked its channels, and nothing shared an identity
// across them — so the same logical notification could arrive twice on one
// device and never on another. Dispatch is the one chokepoint:
//
//  1. IDENTITY — a notification_feed row is written first; its id IS the
//     notification_id every channel carries (feed payload, mobile push data,
//     web push payload, SSE event). One logical notification, one id,
//     every device.
//  2. DEDUP — the feed insert is keyed by (tenant, user, dedupe_key); a
//     replayed or concurrently-emitted event finds the existing row and the
//     channel fanout is SUPPRESSED. "Reaches every device, once."
//  3. CHANNELS — mobile push (Expo), web push (VAPID), and the SSE bus
//     (`notification.created`) are fanned best-effort: one channel failing
//     never blocks another, and unconfigured channels no-op.
//  4. PREFERENCES — an optional per-user pref gate (notification_preferences)
//     is honored when the producer names a Pref; producers that already
//     gate upstream (approvals, send-complete) leave it empty.
//
// The package deliberately does NOT render copy: producers pass title/body
// (they hold the context), and the manifest codegen phase of the blueprint
// will centralize copy later. What is centralized here is delivery: identity,
// dedup, channel fanout, and preference gating.

package notifyfanout

import (
	"context"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notification_feed"
	"github.com/postwave/postwave/apps/api/internal/notifications"
	"github.com/postwave/postwave/apps/api/internal/webpush"
	"strings"
)

// Topic is the SSE topic live clients subscribe to for in-app delivery.
const Topic = "notification.created"

// Event is one logical notification to deliver to a set of users.
type Event struct {
	// Type is the canonical manifest event type (approval.requested,
	// campaign.sent, subscriber.bounced, ...). Required.
	Type string
	// Kind is the feed's machine kind for client routing/icons. Defaults to
	// Type when empty.
	Kind string
	// Title/Body are the rendered notification copy.
	Title string
	Body  string
	// MobileBody optionally overrides Body for the native push payload —
	// native payloads must stay content-light (ids, not customer rows).
	// Empty = use Body.
	MobileBody string
	// URL is the in-app route the notification opens (feed deep_link + web
	// push URL).
	URL string
	// EntityID is the opaque id of the entity the notification references,
	// carried in the mobile push data payload.
	EntityID string
	// DedupeKey is the logical identity of this notification per user —
	// e.g. "approval.requested:<approval-id>". Empty disables dedup (the
	// notification inserts unconditionally).
	DedupeKey string
	// Pref names the per-user preference gating this notification, or empty
	// when the producer already gated upstream.
	Pref notifications.Pref
	// Payload is extra feed payload (entity ids, counts). Never customer PII.
	Payload map[string]any
}

// Delivery reports what happened for one recipient.
type Delivery struct {
	UserID         string
	NotificationID string
	// Created is false when dedup suppressed the fanout (an identical
	// logical notification already existed for this user).
	Created bool
	// WebSent/MobileSent are accepted-endpoint counts from the push senders.
	WebSent    int
	MobileSent int
}

// FeedStore is the durable identity + dedup authority (notification_feed).
type FeedStore interface {
	NotifyDeduped(ctx context.Context, tenantID, userID string, n notification_feed.NewNotification, eventType, dedupeKey string) (string, bool, error)
}

// WebSender fans to browser push subscriptions (webpush.Deps).
type WebSender interface {
	SendToUser(ctx context.Context, tenantID, userID string, n webpush.Notification) (int, error)
}

// MobileSender fans to native device installs (mobilepush.Deps).
type MobileSender interface {
	SendToUser(ctx context.Context, tenantID, userID string, n mobilepush.Notification) (int, error)
}

// EventGate is an OPTIONAL capability a channel may implement to declare that
// it cannot carry an event type at all. Native push is a cross-language
// contract (the shared @postwave/notifications manifest, mirrored in Go, from
// which the client derives its Android channel ids), so a server-side producer
// of a brand-new event type must not be silently retried into a per-send
// failure on every dispatch. A sender that does not implement this is treated
// as accepting every event, which keeps existing fakes and channels unchanged.
type EventGate interface {
	SupportsEvent(eventType string) bool
}

// The native sender MUST implement the gate. main.go wires
// `Mobile: mobilePushDeps` directly, so if *mobilepush.Deps ever stops
// satisfying EventGate the fallback below silently turns back into "accepts
// everything" — and every producer of an event outside the device allowlist
// resumes taking a per-recipient error on every dispatch. Assert it here,
// where the fallback lives, rather than discovering it in production logs.
var _ EventGate = (*mobilepush.Deps)(nil)

func channelAccepts(sender any, eventType string) bool {
	gate, ok := sender.(EventGate)
	if !ok {
		return true
	}
	return gate.SupportsEvent(eventType)
}

// PrefGate resolves a user's per-channel notification preferences for a
// category (SETC-037): whether the in-app + webhook channels are on, and the
// webhook destination (notifications.PgDispatcher).
type PrefGate interface {
	Resolve(ctx context.Context, tenantID, userID string, pref notifications.Pref) (notifications.Channels, error)
}

// WebhookPoster delivers a notification to a user's Slack/generic webhook. The
// implementation MUST use an SSRF-safe client. nil on the Fanout no-ops. kind
// ("slack"|"generic") selects the payload shape; eventType is the canonical
// event for structured (generic) receivers.
type WebhookPoster interface {
	Post(ctx context.Context, url, kind, text, eventType string) error
}

// ActionTicketMinter issues a single-use link for an action on a resource.
//
// The out-of-app surfaces — a Slack message, an email — can only offer a link,
// and a link into an authenticated app is a request to log in first: the exact
// friction the notification was removing. A ticket makes the link act.
//
// nil no-ops, like every other collaborator here, and the message simply goes
// out without action links. That is the right default: a notification that
// arrives without buttons is useful, and one that fails to send because ticket
// minting is unconfigured is not.
type ActionTicketMinter interface {
	Mint(ctx context.Context, tenantID, userID, action, resourceKind, resourceID string) (previewURL string, err error)
}

// WebhookRecorder durably records what happened to a webhook post.
//
// A separate interface rather than a Pool on Fanout, because this package has
// no database dependency by design — every collaborator is an interface, which
// is what lets a test fake exactly one channel. It is also why the poster lives
// in `notifywebhook`: that package may import the db layer, this one may not.
//
// nil no-ops, matching every other dependency here. That is a deliberate
// trade: a deployment that forgets to wire it loses the record and still
// delivers, which is the right way round — the alternative is a notification
// channel that stops working because its bookkeeping is unconfigured.
type WebhookRecorder interface {
	Record(ctx context.Context, tenantID, userID, notificationID, eventType, kind string, postErr error) error
}

// BusPublisher is the SSE fabric (events.Bus).
type BusPublisher interface {
	Publish(evt events.Event)
}

// Fanout wires the channels. Any nil dependency no-ops (a deployment without
// web push still feeds + mobile-pushes; a test can fake exactly one channel).
type Fanout struct {
	Feed    FeedStore
	Web     WebSender
	Mobile  MobileSender
	Prefs   PrefGate
	Webhook WebhookPoster
	// WebhookLog records the outcome of each Webhook post. nil no-ops.
	WebhookLog WebhookRecorder
	// Tickets mints action links for the webhook channel. nil no-ops.
	Tickets ActionTicketMinter
	Bus     BusPublisher
	Log     *slog.Logger
}

// Dispatch delivers ev to each user. Best-effort by design: per-user and
// per-channel failures are logged and never abort the batch — a Postmark
// hiccup for one admin must not silence the rest of the team. The feed write
// is the exception: it is the identity authority, so when it fails the
// channels for that user are skipped rather than delivered identity-less.
func (f *Fanout) Dispatch(ctx context.Context, tenantID string, userIDs []string, ev Event) []Delivery {
	if f == nil || ev.Type == "" || tenantID == "" {
		return nil
	}
	log := f.Log
	if log == nil {
		log = slog.Default()
	}
	kind := ev.Kind
	if kind == "" {
		kind = ev.Type
	}
	mobileBody := ev.MobileBody
	if mobileBody == "" {
		mobileBody = ev.Body
	}

	out := make([]Delivery, 0, len(userIDs))
	seen := make(map[string]bool, len(userIDs))
	for _, uid := range userIDs {
		if uid == "" || seen[uid] {
			continue
		}
		seen[uid] = true

		// Resolve the per-channel decision (SETC-037). Empty Pref = no gate:
		// deliver in-app, webhook off — the historical "producer gated upstream"
		// behavior. In-app fails OPEN; the webhook channel fails CLOSED.
		ch := notifications.Channels{InApp: true}
		if ev.Pref != "" && f.Prefs != nil {
			resolved, err := f.Prefs.Resolve(ctx, tenantID, uid, ev.Pref)
			if err != nil {
				// Fail OPEN for in-app, CLOSED for webhook — and enforce it HERE
				// rather than trust the resolver's error-path return value. A
				// resolver that returned a zero Channels{} alongside its error
				// would otherwise silently drop the in-app notification.
				log.Warn("notifyfanout: pref resolve failed; in-app fails open",
					"event", ev.Type, "tenant_id", tenantID, "user_id", uid, "err", err.Error())
				ch = notifications.Channels{InApp: true}
			} else {
				ch = resolved
			}
		}
		webhookURL := ""
		if ch.Webhook && ch.WebhookURL != "" && f.Webhook != nil {
			webhookURL = ch.WebhookURL
		}
		if !ch.InApp && webhookURL == "" {
			// Opted out of every deliverable channel — write nothing.
			continue
		}

		if f.Feed == nil {
			continue
		}
		id, created, err := f.Feed.NotifyDeduped(ctx, tenantID, uid, notification_feed.NewNotification{
			Kind:     kind,
			Title:    ev.Title,
			Body:     ev.Body,
			DeepLink: ev.URL,
			Payload:  ev.Payload,
			// In-app OFF but webhook ON: the row is written ONLY as the dedup +
			// webhook anchor, and hidden from the bell/unread count. When in-app
			// is on, suppressed=false and it is a normal feed notification.
			Suppressed: !ch.InApp,
		}, ev.Type, ev.DedupeKey)
		if err != nil {
			log.Warn("notifyfanout: feed write failed; skipping channels for user",
				"event", ev.Type, "tenant_id", tenantID, "user_id", uid, "err", err.Error())
			continue
		}
		d := Delivery{UserID: uid, NotificationID: id, Created: created}
		if !created {
			// Dedup hit: the logical notification already exists for this
			// user — an earlier dispatch (or a concurrent replica) already
			// fanned the channels. Deliver nothing twice.
			out = append(out, d)
			continue
		}

		// Live push surfaces (web/mobile/SSE) fire only when the in-app channel
		// is on. The feed row above is always written when ANY channel is live —
		// it is the identity/dedup ledger + the bell history.
		if ch.InApp {
			if f.Web != nil {
				sent, err := f.Web.SendToUser(ctx, tenantID, uid, webpush.Notification{
					Title:          ev.Title,
					Body:           ev.Body,
					URL:            ev.URL,
					Tag:            ev.DedupeKey,
					NotificationID: id,
					Event:          ev.Type,
				})
				d.WebSent = sent
				if err != nil {
					log.Warn("notifyfanout: web push failed",
						"event", ev.Type, "tenant_id", tenantID, "user_id", uid, "err", err.Error())
				}
			}
			if f.Mobile != nil && channelAccepts(f.Mobile, ev.Type) {
				sent, err := f.Mobile.SendToUser(ctx, tenantID, uid, mobilepush.Notification{
					EventType:      ev.Type,
					EntityID:       ev.EntityID,
					IdempotencyKey: mobileIdempotencyKey(ev, uid),
					Title:          ev.Title,
					Body:           mobileBody,
					NotificationID: id,
				})
				d.MobileSent = sent
				if err != nil {
					log.Warn("notifyfanout: mobile push failed",
						"event", ev.Type, "tenant_id", tenantID, "user_id", uid, "err", err.Error())
				}
			}
			if f.Bus != nil {
				f.Bus.Publish(events.Event{
					Topic:    Topic,
					TenantID: tenantID,
					At:       time.Now().UTC(),
					Payload: map[string]any{
						"notification_id": id,
						"user_id":         uid,
						"event":           ev.Type,
						"title":           ev.Title,
						"url":             ev.URL,
						"entity_id":       ev.EntityID,
					},
				})
			}
		}
		// Slack/generic webhook channel (SETC-037). Best-effort like the rest;
		// only on Created (dedup already short-circuited a replay above).
		if webhookURL != "" {
			// Action links, when this event has actions and there is somewhere to
			// act. Minted per RECIPIENT: a ticket authorises one named person,
			// and one shared link forwarded around a channel would let anybody
			// who saw it approve as them.
			text := webhookText(ev)
			if links := f.mintActionLinks(ctx, tenantID, uid, ev); links != "" {
				text += "\n" + links
			}
			postErr := f.Webhook.Post(ctx, webhookURL, ch.WebhookKind, text, ev.Type)
			// Recorded, not merely logged. The person configured this
			// destination precisely so they would hear about approvals; when
			// the post fails they hear nothing, and before this no query
			// anywhere could tell them it had even been attempted.
			if f.WebhookLog != nil {
				if err := f.WebhookLog.Record(ctx, tenantID, uid, id, ev.Type, ch.WebhookKind, postErr); err != nil {
					log.Warn("notifyfanout: webhook delivery not recorded",
						"event", ev.Type, "tenant_id", tenantID, "user_id", uid, "err", err.Error())
				}
			}
			if postErr != nil {
				log.Warn("notifyfanout: webhook post failed",
					"event", ev.Type, "tenant_id", tenantID, "user_id", uid, "err", postErr.Error())
			}
		}
		out = append(out, d)
	}
	return out
}

// mobileIdempotencyKey scopes the send-level idempotency to the recipient so
// the mobile sender's own replay protection lines up with the per-user feed
// dedup instead of collapsing distinct recipients of one logical event.
func mobileIdempotencyKey(ev Event, userID string) string {
	if ev.DedupeKey == "" {
		return ""
	}
	return ev.DedupeKey + ":" + userID
}

// mintActionLinks builds the action links for one recipient, or "".
//
// Only ActionAPI actions get a ticket. A navigate action is already a plain
// link and minting one would spend a single-use credential on something that
// needs none — and would make an ordinary "review your devices" link expire.
//
// Every failure degrades to no link rather than no notification. A minting
// outage must not stop somebody being told their approval is waiting; they can
// still open the app.
func (f *Fanout) mintActionLinks(ctx context.Context, tenantID, userID string, ev Event) string {
	if f.Tickets == nil || ev.EntityID == "" {
		return ""
	}
	actions := notifications.ActionsForEvent(ev.Type)
	if len(actions) == 0 {
		return ""
	}
	var lines []string
	for _, a := range actions {
		if a.Kind != notifications.ActionAPI {
			continue
		}
		url, err := f.Tickets.Mint(ctx, tenantID, userID, a.ID, resourceKindFor(ev.Type), ev.EntityID)
		if err != nil || url == "" {
			if f.Log != nil && err != nil {
				f.Log.Warn("notifyfanout: action link not minted",
					"event", ev.Type, "action", a.ID, "err", err.Error())
			}
			continue
		}
		lines = append(lines, a.Label+": "+url)
	}
	return strings.Join(lines, "\n")
}

// resourceKindFor maps an event onto the kind its EntityID refers to.
//
// Explicit rather than derived from the event name: `approval.requested`
// carries an APPROVAL id, and a ticket bound to the wrong kind would either
// refuse to redeem or — worse — redeem against something else with the same id.
func resourceKindFor(eventType string) string {
	switch eventType {
	case "approval.requested", "approval.escalated":
		return "approval"
	case "retention.offer_available":
		return "offer"
	default:
		return "notification"
	}
}
