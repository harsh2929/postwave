// SPDX-License-Identifier: AGPL-3.0-only

package notifyfanout

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notification_feed"
	"github.com/postwave/postwave/apps/api/internal/notifications"
	"github.com/postwave/postwave/apps/api/internal/webpush"
)

type fakeFeed struct {
	created map[string]bool // userID -> created result
	err     map[string]error
	calls   []string // userIDs in order
	lastN   notification_feed.NewNotification
	lastEv  string
	lastKey string
}

func (f *fakeFeed) NotifyDeduped(_ context.Context, _, userID string, n notification_feed.NewNotification, eventType, dedupeKey string) (string, bool, error) {
	f.calls = append(f.calls, userID)
	f.lastN, f.lastEv, f.lastKey = n, eventType, dedupeKey
	if err := f.err[userID]; err != nil {
		return "", false, err
	}
	created, ok := f.created[userID]
	if !ok {
		created = true
	}
	return "nid-" + userID, created, nil
}

type fakeWeb struct {
	sent []webpush.Notification
	err  error
}

func (f *fakeWeb) SendToUser(_ context.Context, _, _ string, n webpush.Notification) (int, error) {
	f.sent = append(f.sent, n)
	if f.err != nil {
		return 0, f.err
	}
	return 1, nil
}

type fakeMobile struct{ sent []mobilepush.Notification }

func (f *fakeMobile) SendToUser(_ context.Context, _, _ string, n mobilepush.Notification) (int, error) {
	f.sent = append(f.sent, n)
	return 2, nil
}

type fakeGate struct {
	allow map[string]bool
	err   error
}

// Resolve maps the fake's per-user allow flag onto the in-app channel (the
// channel the old single Gate governed). On error, in-app fails OPEN — matching
// the production PgDispatcher.Resolve contract.
func (f *fakeGate) Resolve(_ context.Context, _, userID string, _ notifications.Pref) (notifications.Channels, error) {
	if f.err != nil {
		return notifications.Channels{InApp: true}, f.err
	}
	allowed, ok := f.allow[userID]
	if !ok {
		return notifications.Channels{InApp: true}, nil
	}
	return notifications.Channels{InApp: allowed}, nil
}

type fakeBus struct{ events []events.Event }

func (f *fakeBus) Publish(evt events.Event) { f.events = append(f.events, evt) }

func base() (*Fanout, *fakeFeed, *fakeWeb, *fakeMobile, *fakeBus) {
	feed := &fakeFeed{created: map[string]bool{}, err: map[string]error{}}
	web := &fakeWeb{}
	mob := &fakeMobile{}
	bus := &fakeBus{}
	return &Fanout{Feed: feed, Web: web, Mobile: mob, Bus: bus}, feed, web, mob, bus
}

func TestDispatch_SharedIdentityAcrossEveryChannel(t *testing.T) {
	f, _, web, mob, bus := base()
	got := f.Dispatch(context.Background(), "t1", []string{"u1"}, Event{
		Type: "approval.requested", Title: "Approval needed", Body: "b",
		URL: "/app/approvals", EntityID: "ap-1", DedupeKey: "approval.requested:ap-1",
	})
	if len(got) != 1 || !got[0].Created {
		t.Fatalf("want 1 created delivery, got %+v", got)
	}
	id := got[0].NotificationID
	if id != "nid-u1" {
		t.Fatalf("unexpected id %q", id)
	}
	if len(web.sent) != 1 || web.sent[0].NotificationID != id || web.sent[0].Event != "approval.requested" {
		t.Fatalf("web payload missing shared identity: %+v", web.sent)
	}
	if len(mob.sent) != 1 || mob.sent[0].NotificationID != id {
		t.Fatalf("mobile payload missing shared identity: %+v", mob.sent)
	}
	if len(bus.events) != 1 || bus.events[0].Topic != Topic ||
		bus.events[0].Payload["notification_id"] != id || bus.events[0].TenantID != "t1" {
		t.Fatalf("bus event missing shared identity: %+v", bus.events)
	}
	if got[0].WebSent != 1 || got[0].MobileSent != 2 {
		t.Fatalf("sent counts not propagated: %+v", got[0])
	}
}

func TestDispatch_DedupSuppressesEveryChannel(t *testing.T) {
	f, feed, web, mob, bus := base()
	feed.created["u1"] = false // duplicate: row already existed
	got := f.Dispatch(context.Background(), "t1", []string{"u1"}, Event{
		Type: "campaign.sent", Title: "t", DedupeKey: "campaign.sent:c1",
	})
	if len(got) != 1 || got[0].Created {
		t.Fatalf("want suppressed delivery, got %+v", got)
	}
	if got[0].NotificationID != "nid-u1" {
		t.Fatalf("duplicate must still surface the existing identity, got %+v", got[0])
	}
	if len(web.sent)+len(mob.sent)+len(bus.events) != 0 {
		t.Fatalf("dedup hit must suppress all channels: web=%d mobile=%d bus=%d",
			len(web.sent), len(mob.sent), len(bus.events))
	}
}

func TestDispatch_PrefGateSkipsBeforeAnyWrite(t *testing.T) {
	f, feed, web, _, _ := base()
	f.Prefs = &fakeGate{allow: map[string]bool{"u-off": false, "u-on": true}}
	got := f.Dispatch(context.Background(), "t1", []string{"u-off", "u-on"}, Event{
		Type: "campaign.sent", Title: "t", Pref: notifications.PrefSendComplete,
	})
	if len(got) != 1 || got[0].UserID != "u-on" {
		t.Fatalf("gated-off user must be skipped, got %+v", got)
	}
	if len(feed.calls) != 1 || feed.calls[0] != "u-on" {
		t.Fatalf("gated-off user must not reach the feed: %v", feed.calls)
	}
	if len(web.sent) != 1 {
		t.Fatalf("gated-on user must still deliver")
	}
}

func TestDispatch_PrefGateErrorFailsOpen(t *testing.T) {
	f, _, web, _, _ := base()
	f.Prefs = &fakeGate{err: errors.New("pref table down")}
	got := f.Dispatch(context.Background(), "t1", []string{"u1"}, Event{
		Type: "approval.requested", Title: "t", Pref: notifications.PrefApprovalRequest,
	})
	if len(got) != 1 || len(web.sent) != 1 {
		t.Fatalf("gate error must fail open (deliver): got=%+v web=%d", got, len(web.sent))
	}
}

func TestDispatch_ChannelFailureNeverAbortsOthers(t *testing.T) {
	f, _, web, mob, bus := base()
	web.err = errors.New("push service 500")
	got := f.Dispatch(context.Background(), "t1", []string{"u1"}, Event{Type: "e", Title: "t"})
	if len(got) != 1 {
		t.Fatalf("delivery must survive a channel failure")
	}
	if len(mob.sent) != 1 || len(bus.events) != 1 {
		t.Fatalf("mobile/bus must still deliver after web failure: mobile=%d bus=%d", len(mob.sent), len(bus.events))
	}
}

func TestDispatch_FeedErrorSkipsChannelsForThatUserOnly(t *testing.T) {
	f, feed, web, _, _ := base()
	feed.err["u-bad"] = errors.New("insert failed")
	got := f.Dispatch(context.Background(), "t1", []string{"u-bad", "u-ok"}, Event{Type: "e", Title: "t"})
	if len(got) != 1 || got[0].UserID != "u-ok" {
		t.Fatalf("only the healthy user delivers: %+v", got)
	}
	if len(web.sent) != 1 {
		t.Fatalf("identity-less push must never happen; healthy user still delivers")
	}
}

func TestDispatch_MobileBodyOverrideAndScopedIdempotency(t *testing.T) {
	f, _, web, mob, _ := base()
	f.Dispatch(context.Background(), "t1", []string{"u1"}, Event{
		Type: "approval.requested", Title: "t", Body: "full detail",
		MobileBody: "A pending request is waiting.", DedupeKey: "approval.requested:ap-1",
	})
	if web.sent[0].Body != "full detail" {
		t.Fatalf("web keeps the full body")
	}
	if mob.sent[0].Body != "A pending request is waiting." {
		t.Fatalf("mobile must use the content-light body")
	}
	if mob.sent[0].IdempotencyKey != "approval.requested:ap-1:u1" {
		t.Fatalf("mobile idempotency must be recipient-scoped, got %q", mob.sent[0].IdempotencyKey)
	}
}

func TestDispatch_DuplicateAndEmptyUsersSkipped(t *testing.T) {
	f, feed, _, _, _ := base()
	got := f.Dispatch(context.Background(), "t1", []string{"", "u1", "u1"}, Event{Type: "e", Title: "t"})
	if len(got) != 1 || len(feed.calls) != 1 {
		t.Fatalf("empty/duplicate user ids must collapse: got=%d feed=%d", len(got), len(feed.calls))
	}
}

func TestDispatch_KindDefaultsToEventType(t *testing.T) {
	f, feed, _, _, _ := base()
	f.Dispatch(context.Background(), "t1", []string{"u1"}, Event{Type: "subscriber.bounced", Title: "t"})
	if feed.lastN.Kind != "subscriber.bounced" || feed.lastEv != "subscriber.bounced" {
		t.Fatalf("kind must default to the event type: %+v ev=%s", feed.lastN, feed.lastEv)
	}
}
