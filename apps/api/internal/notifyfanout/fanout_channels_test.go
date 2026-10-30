// SPDX-License-Identifier: AGPL-3.0-only
package notifyfanout

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

type fakeChannelGate struct{ ch notifications.Channels }

func (f *fakeChannelGate) Resolve(_ context.Context, _, _ string, _ notifications.Pref) (notifications.Channels, error) {
	return f.ch, nil
}

type fakeWebhook struct {
	posts []struct{ url, kind, text, eventType string }
}

func (f *fakeWebhook) Post(_ context.Context, url, kind, text, eventType string) error {
	f.posts = append(f.posts, struct{ url, kind, text, eventType string }{url, kind, text, eventType})
	return nil
}

func newChannelFanout(ch notifications.Channels) (*Fanout, *fakeFeed, *fakeWeb, *fakeWebhook) {
	feed := &fakeFeed{}
	web := &fakeWeb{}
	wh := &fakeWebhook{}
	return &Fanout{
		Feed:    feed,
		Web:     web,
		Prefs:   &fakeChannelGate{ch: ch},
		Webhook: wh,
	}, feed, web, wh
}

const chanEvent = "subscriber.bounced"

func chanEv() Event {
	return Event{Type: chanEvent, Title: "Bounce", Body: "high bounce rate", URL: "/app/x", Pref: notifications.PrefBounceAlert}
}

func TestDispatch_InAppAndWebhook(t *testing.T) {
	f, feed, web, wh := newChannelFanout(notifications.Channels{InApp: true, Webhook: true, WebhookURL: "https://hooks.example/x"})
	f.Dispatch(context.Background(), "t1", []string{"u1"}, chanEv())
	if len(feed.calls) != 1 {
		t.Fatalf("feed writes = %d, want 1", len(feed.calls))
	}
	if feed.lastN.Suppressed {
		t.Fatalf("in-app ON: the feed row must be VISIBLE (suppressed=false)")
	}
	if len(web.sent) != 1 {
		t.Fatalf("web push = %d, want 1 (in-app on)", len(web.sent))
	}
	if len(wh.posts) != 1 || wh.posts[0].url != "https://hooks.example/x" {
		t.Fatalf("webhook posts = %+v, want 1 to the URL", wh.posts)
	}
}

func TestDispatch_WebhookOnlyInAppOff(t *testing.T) {
	// In-app off, webhook on: the feed row (dedup/identity + bell history) is
	// still written, live push is SUPPRESSED, and the webhook still fires.
	f, feed, web, wh := newChannelFanout(notifications.Channels{InApp: false, Webhook: true, WebhookURL: "https://hooks.example/x"})
	f.Dispatch(context.Background(), "t1", []string{"u1"}, chanEv())
	if len(feed.calls) != 1 {
		t.Fatalf("feed writes = %d, want 1 (webhook needs the dedup anchor)", len(feed.calls))
	}
	if !feed.lastN.Suppressed {
		t.Fatalf("in-app OFF: the feed row must be SUPPRESSED (hidden from the bell), only a dedup/webhook anchor")
	}
	if len(web.sent) != 0 {
		t.Fatalf("web push = %d, want 0 (in-app off)", len(web.sent))
	}
	if len(wh.posts) != 1 {
		t.Fatalf("webhook posts = %d, want 1", len(wh.posts))
	}
}

func TestDispatch_AllChannelsOffWritesNothing(t *testing.T) {
	// In-app off + webhook off → nothing at all (no feed row, no push, no webhook).
	f, feed, web, wh := newChannelFanout(notifications.Channels{InApp: false, Webhook: false})
	f.Dispatch(context.Background(), "t1", []string{"u1"}, chanEv())
	if len(feed.calls) != 0 || len(web.sent) != 0 || len(wh.posts) != 0 {
		t.Fatalf("opted-out-of-all wrote something: feed=%d web=%d wh=%d", len(feed.calls), len(web.sent), len(wh.posts))
	}
}

func TestDispatch_WebhookOnButNoURLNoOps(t *testing.T) {
	// webhook_on but no URL configured → webhook channel is dormant; in-app still delivers.
	f, feed, _, wh := newChannelFanout(notifications.Channels{InApp: true, Webhook: true, WebhookURL: ""})
	f.Dispatch(context.Background(), "t1", []string{"u1"}, chanEv())
	if len(feed.calls) != 1 {
		t.Fatalf("feed writes = %d, want 1", len(feed.calls))
	}
	if len(wh.posts) != 0 {
		t.Fatalf("webhook posts = %d, want 0 (no URL)", len(wh.posts))
	}
}

func TestDispatch_WebhookUsesRedactedBodyNeverPII(t *testing.T) {
	// The webhook egresses to a host outside our trust boundary, so it must use
	// the content-light MobileBody, NOT ev.Body (which the bounce/complaint
	// producers fill with a raw subscriber email).
	f, _, _, wh := newChannelFanout(notifications.Channels{InApp: true, Webhook: true, WebhookURL: "https://hooks.example/x"})
	f.Dispatch(context.Background(), "t1", []string{"u1"}, Event{
		Type:       "subscriber.bounced",
		Title:      "Subscriber hard-bounced",
		Body:       "jane.doe@example.com hard-bounced and was suppressed.",
		MobileBody: "A subscriber address hard-bounced.",
		URL:        "/app/subscribers",
		Pref:       notifications.PrefBounceAlert,
	})
	if len(wh.posts) != 1 {
		t.Fatalf("webhook posts = %d, want 1", len(wh.posts))
	}
	text := wh.posts[0].text
	if strings.Contains(text, "jane.doe@example.com") {
		t.Fatalf("webhook payload leaked customer PII: %q", text)
	}
	if !strings.Contains(text, "A subscriber address hard-bounced.") {
		t.Fatalf("webhook payload must use the redacted MobileBody, got %q", text)
	}
}

func TestDispatch_WebhookKindFlowsToPoster(t *testing.T) {
	// The per-user webhook kind resolved from prefs must reach the poster so the
	// payload shape (slack vs generic) is honored.
	f, _, _, wh := newChannelFanout(notifications.Channels{InApp: false, Webhook: true, WebhookURL: "https://hooks.example/x", WebhookKind: "generic"})
	f.Dispatch(context.Background(), "t1", []string{"u1"}, chanEv())
	if len(wh.posts) != 1 {
		t.Fatalf("webhook posts = %d, want 1", len(wh.posts))
	}
	if wh.posts[0].kind != "generic" {
		t.Fatalf("webhook kind = %q, want generic", wh.posts[0].kind)
	}
	if wh.posts[0].eventType != chanEvent {
		t.Fatalf("webhook eventType = %q, want %q", wh.posts[0].eventType, chanEvent)
	}
}

func TestDispatch_WebhookNotSentOnDedupHit(t *testing.T) {
	// A dedup hit (Created=false) short-circuits BEFORE any channel — including
	// the webhook — so a replayed event never double-posts.
	f, feed, web, wh := newChannelFanout(notifications.Channels{InApp: true, Webhook: true, WebhookURL: "https://hooks.example/x"})
	feed.created = map[string]bool{"u1": false}
	f.Dispatch(context.Background(), "t1", []string{"u1"}, chanEv())
	if len(web.sent) != 0 || len(wh.posts) != 0 {
		t.Fatalf("dedup hit still fanned channels: web=%d wh=%d", len(web.sent), len(wh.posts))
	}
}

// The recorder must be CALLED, not merely wired.
//
// Every other channel in this package got a durable delivery record before this
// one; the webhook channel logged its failures and stored nothing. A recorder
// that exists on the struct and is never invoked leaves that exactly as it was,
// and the only symptom is the absence of rows nobody is looking for yet.
type fakeWebhookRecorder struct {
	calls []struct {
		tenantID, userID, notificationID, eventType, kind string
		failed                                            bool
	}
	err error
}

func (f *fakeWebhookRecorder) Record(_ context.Context, tenantID, userID, notificationID, eventType, kind string, postErr error) error {
	f.calls = append(f.calls, struct {
		tenantID, userID, notificationID, eventType, kind string
		failed                                            bool
	}{tenantID, userID, notificationID, eventType, kind, postErr != nil})
	return f.err
}

type failingWebhook struct{ err error }

func (f *failingWebhook) Post(_ context.Context, _, _, _, _ string) error { return f.err }

func TestDispatchRecordsTheWebhookOutcome(t *testing.T) {
	for _, tc := range []struct {
		name       string
		postErr    error
		wantFailed bool
	}{
		{name: "a successful post is recorded", postErr: nil, wantFailed: false},
		{name: "a failed post is recorded", postErr: errors.New("slack 500"), wantFailed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _, _, _ := newChannelFanout(notifications.Channels{InApp: true, Webhook: true, WebhookURL: "https://hooks.example.test/x", WebhookKind: "slack"})
			f.Webhook = &failingWebhook{err: tc.postErr}
			rec := &fakeWebhookRecorder{}
			f.WebhookLog = rec

			out := f.Dispatch(context.Background(), "tenant-1", []string{"user-1"}, chanEv())
			if len(out) != 1 {
				t.Fatalf("dispatch produced %d deliveries, want 1", len(out))
			}
			if len(rec.calls) != 1 {
				t.Fatalf("recorder called %d times, want 1 — the webhook outcome is "+
					"still a log line and nothing else", len(rec.calls))
			}
			got := rec.calls[0]
			if got.failed != tc.wantFailed {
				t.Errorf("recorded failed=%v, want %v", got.failed, tc.wantFailed)
			}
			if got.tenantID != "tenant-1" || got.userID != "user-1" {
				t.Errorf("recorded for the wrong identity: %+v", got)
			}
			if got.notificationID == "" {
				t.Error("recorded with no notification id, so the row cannot be " +
					"joined back to the notification it was for")
			}
			if got.eventType != chanEvent {
				t.Errorf("event type = %q, want %q", got.eventType, chanEvent)
			}
		})
	}
}

// A recorder that errors must not break delivery. The notification has already
// been posted by then, and turning a bookkeeping failure into a delivery
// failure would be strictly worse than the missing record.
func TestARecorderFailureDoesNotBreakDispatch(t *testing.T) {
	f, _, _, wh := newChannelFanout(notifications.Channels{InApp: true, Webhook: true, WebhookURL: "https://hooks.example.test/x", WebhookKind: "slack"})
	f.WebhookLog = &fakeWebhookRecorder{err: errors.New("db down")}

	out := f.Dispatch(context.Background(), "tenant-1", []string{"user-1"}, chanEv())
	if len(out) != 1 {
		t.Fatalf("dispatch produced %d deliveries, want 1", len(out))
	}
	if len(wh.posts) != 1 {
		t.Fatalf("the webhook was posted %d times, want 1 — a recorder outage "+
			"must not stop the notification", len(wh.posts))
	}
}

// nil no-ops, matching every other dependency here: a deployment that has not
// wired the recorder still delivers.
func TestANilRecorderStillDelivers(t *testing.T) {
	f, _, _, wh := newChannelFanout(notifications.Channels{InApp: true, Webhook: true, WebhookURL: "https://hooks.example.test/x", WebhookKind: "slack"})
	f.WebhookLog = nil
	if out := f.Dispatch(context.Background(), "tenant-1", []string{"user-1"}, chanEv()); len(out) != 1 {
		t.Fatalf("dispatch produced %d deliveries, want 1", len(out))
	}
	if len(wh.posts) != 1 {
		t.Fatalf("posts = %d, want 1", len(wh.posts))
	}
}

// The out-of-app surface must be able to ACT, not just be told.
//
// This is the loop the ticket work exists to close: catalog → actions → ticket
// → link in a Slack message → preview → redeem. Without it the ticket mechanism
// is complete and unused, which is the failure this ledger keeps recording.
type fakeMinter struct {
	calls []struct{ tenantID, userID, action, kind, id string }
	err   error
}

func (f *fakeMinter) Mint(_ context.Context, tenantID, userID, action, kind, id string) (string, error) {
	f.calls = append(f.calls, struct{ tenantID, userID, action, kind, id string }{tenantID, userID, action, kind, id})
	if f.err != nil {
		return "", f.err
	}
	return "https://app.example.test/api/v1/actions/preview?ticket=" + action, nil
}

func approvalEv() Event {
	return Event{
		Type: "approval.requested", Title: "Approval needed",
		Body: "Spring Sale", URL: "/app/approvals", EntityID: "appr-1",
		Pref: notifications.PrefBounceAlert,
	}
}

func TestTheWebhookMessageCarriesActionLinks(t *testing.T) {
	f, _, _, wh := newChannelFanout(notifications.Channels{
		InApp: true, Webhook: true, WebhookURL: "https://hooks.example.test/x", WebhookKind: "slack",
	})
	m := &fakeMinter{}
	f.Tickets = m

	f.Dispatch(context.Background(), "tenant-1", []string{"user-1"}, approvalEv())

	if len(wh.posts) != 1 {
		t.Fatalf("posts = %d, want 1", len(wh.posts))
	}
	text := wh.posts[0].text
	if !strings.Contains(text, "Approve") || !strings.Contains(text, "Reject") {
		t.Fatalf("the message carries no action links:\n%s", text)
	}
	// Minted per RECIPIENT: one shared link forwarded around a channel would let
	// anybody who saw it approve as that person.
	if len(m.calls) != 2 {
		t.Fatalf("minted %d tickets, want one per API action", len(m.calls))
	}
	for _, c := range m.calls {
		if c.userID != "user-1" || c.tenantID != "tenant-1" {
			t.Errorf("ticket minted for the wrong identity: %+v", c)
		}
		if c.kind != "approval" || c.id != "appr-1" {
			t.Errorf("ticket bound to %s/%s, want approval/appr-1 — a wrong kind "+
				"redeems against the wrong thing or not at all", c.kind, c.id)
		}
	}
}

// A navigate action needs no ticket: it is already a plain link, and minting one
// would spend a single-use credential on something that needs none — and make an
// ordinary "review your devices" link expire.
func TestANavigateOnlyEventMintsNoTickets(t *testing.T) {
	f, _, _, _ := newChannelFanout(notifications.Channels{
		InApp: true, Webhook: true, WebhookURL: "https://hooks.example.test/x", WebhookKind: "slack",
	})
	m := &fakeMinter{}
	f.Tickets = m
	ev := approvalEv()
	ev.Type = "auth.new_device_sign_in"

	f.Dispatch(context.Background(), "tenant-1", []string{"user-1"}, ev)
	if len(m.calls) != 0 {
		t.Fatalf("minted %d tickets for a navigate-only event", len(m.calls))
	}
}

// A minting outage must cost the buttons, never the notification.
func TestAMintingFailureStillSendsTheMessage(t *testing.T) {
	f, _, _, wh := newChannelFanout(notifications.Channels{
		InApp: true, Webhook: true, WebhookURL: "https://hooks.example.test/x", WebhookKind: "slack",
	})
	f.Tickets = &fakeMinter{err: errors.New("db down")}

	f.Dispatch(context.Background(), "tenant-1", []string{"user-1"}, approvalEv())
	if len(wh.posts) != 1 {
		t.Fatalf("posts = %d; a minting outage stopped somebody being told their "+
			"approval is waiting", len(wh.posts))
	}
	if strings.Contains(wh.posts[0].text, "preview?t=") {
		t.Error("a link was included despite minting failing")
	}
}

// nil no-ops, like every other collaborator here.
func TestANilMinterStillSendsTheMessage(t *testing.T) {
	f, _, _, wh := newChannelFanout(notifications.Channels{
		InApp: true, Webhook: true, WebhookURL: "https://hooks.example.test/x", WebhookKind: "slack",
	})
	f.Tickets = nil
	f.Dispatch(context.Background(), "tenant-1", []string{"user-1"}, approvalEv())
	if len(wh.posts) != 1 {
		t.Fatalf("posts = %d, want 1", len(wh.posts))
	}
}
