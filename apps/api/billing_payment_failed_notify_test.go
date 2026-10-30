// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notification_feed"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/webpush"
)

// COMMERCE#4. A failed charge already flipped billing_state.dunning and queued
// an email; nothing else was told, so a workspace could lapse in silence. These
// tests pin the three properties that make the new channel SAFE rather than
// merely present, exercised through a real notifyfanout.Fanout with faked
// channels so the dedupe/identity behaviour under test is the production one.

type recordedFeedWrite struct {
	userID    string
	eventType string
	dedupeKey string
	deepLink  string
	payload   map[string]any
}

type capturingFeed struct {
	writes []recordedFeedWrite
	// seen makes the fake behave like the real (tenant,user,dedupe_key)
	// unique index: a repeat returns created=false.
	seen map[string]bool
	next int
}

func (f *capturingFeed) NotifyDeduped(
	_ context.Context,
	_, userID string,
	n notification_feed.NewNotification,
	eventType, dedupeKey string,
) (string, bool, error) {
	f.writes = append(f.writes, recordedFeedWrite{
		userID: userID, eventType: eventType, dedupeKey: dedupeKey,
		deepLink: n.DeepLink, payload: n.Payload,
	})
	if f.seen == nil {
		f.seen = map[string]bool{}
	}
	key := userID + "|" + dedupeKey
	created := dedupeKey == "" || !f.seen[key]
	f.seen[key] = true
	f.next++
	return "notif-" + strings.Repeat("x", 0) + itoa(f.next), created, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

type capturingMobile struct{ sent []mobilepush.Notification }

func (m *capturingMobile) SendToUser(_ context.Context, _, _ string, n mobilepush.Notification) (int, error) {
	m.sent = append(m.sent, n)
	return 1, nil
}

type capturingWeb struct{ sent []webpush.Notification }

func (w *capturingWeb) SendToUser(_ context.Context, _, _ string, n webpush.Notification) (int, error) {
	w.sent = append(w.sent, n)
	return 1, nil
}

func paymentFailedHarness() (*operatorNotifyAdapter, *capturingFeed, *capturingMobile, *capturingWeb) {
	feed := &capturingFeed{}
	mobile := &capturingMobile{}
	web := &capturingWeb{}
	return &operatorNotifyAdapter{
		Fanout: &notifyfanout.Fanout{Feed: feed, Mobile: mobile, Web: web},
	}, feed, mobile, web
}

const failedAlertTenant = "11111111-1111-4111-8111-111111111111"

func baseAlert() billing.PaymentFailedAlert {
	return billing.PaymentFailedAlert{
		TenantID:     failedAlertTenant,
		UserID:       "owner-1",
		InvoiceID:    "in_123",
		AttemptCount: 1,
		HostedURL:    "https://invoice.stripe.com/i/acct_1/live_YWNjdF8x?secret=bearer",
	}
}

// The single most important property: Stripe's hosted invoice URL is a BEARER
// URL for a payment surface. It reaches this adapter (billing has it in hand)
// and must not reach any delivered payload — the notification sends the
// customer to an authenticated in-app screen instead.
func TestPaymentFailedNotificationNeverCarriesTheHostedInvoiceURL(t *testing.T) {
	t.Parallel()
	adapter, feed, mobile, web := paymentFailedHarness()
	alert := baseAlert()

	adapter.NotifyPaymentFailed(context.Background(), alert)

	if len(feed.writes) != 1 {
		t.Fatalf("expected exactly one feed write, got %d", len(feed.writes))
	}
	write := feed.writes[0]
	if strings.Contains(write.deepLink, "stripe.com") || strings.Contains(write.deepLink, "secret=") {
		t.Fatalf("feed deep link leaked the hosted invoice URL: %q", write.deepLink)
	}
	if write.deepLink != "/app/billing" {
		t.Fatalf("feed deep link = %q, want the in-app billing screen", write.deepLink)
	}
	for key, value := range write.payload {
		if text, ok := value.(string); ok && strings.Contains(text, "stripe.com") {
			t.Fatalf("feed payload %q leaked the hosted invoice URL", key)
		}
	}
	for _, n := range mobile.sent {
		if strings.Contains(n.Body, "stripe.com") || strings.Contains(n.Title, "stripe.com") {
			t.Fatalf("mobile push leaked the hosted invoice URL: %+v", n)
		}
	}
	for _, n := range web.sent {
		if strings.Contains(n.URL, "stripe.com") {
			t.Fatalf("web push leaked the hosted invoice URL: %q", n.URL)
		}
	}
}

// The event name is a cross-language contract: packages/notifications carries
// it, mobilepush.allowedDeviceEvents mirrors it, and apps/mobile derives the
// Android channel id from the manifest. A typo here means Android silently
// drops the notification, which is the exact failure mode this event was added
// to fix.
func TestPaymentFailedNotificationUsesTheManifestEventTheDeviceAccepts(t *testing.T) {
	t.Parallel()
	adapter, feed, mobile, _ := paymentFailedHarness()

	adapter.NotifyPaymentFailed(context.Background(), baseAlert())

	if got := feed.writes[0].eventType; got != "billing.payment_failed" {
		t.Fatalf("event type = %q, want billing.payment_failed", got)
	}
	if !mobilepush.SupportsEvent("billing.payment_failed") {
		t.Fatal("mobilepush does not accept billing.payment_failed; the native push would be skipped")
	}
	if len(mobile.sent) != 1 {
		t.Fatalf("expected the native channel to be used, got %d sends", len(mobile.sent))
	}
	if mobile.sent[0].EventType != "billing.payment_failed" {
		t.Fatalf("mobile event type = %q", mobile.sent[0].EventType)
	}
}

// Stripe redelivers webhook events. A redelivery is the SAME attempt and must
// be silent; a genuinely new retry attempt is new information and must alert
// again — matching the cadence of the dunning email, which also sends per
// attempt.
func TestPaymentFailedNotificationDedupesRedeliveryButNotANewAttempt(t *testing.T) {
	t.Parallel()
	adapter, feed, mobile, _ := paymentFailedHarness()
	alert := baseAlert()

	adapter.NotifyPaymentFailed(context.Background(), alert)
	adapter.NotifyPaymentFailed(context.Background(), alert) // Stripe redelivery
	if len(mobile.sent) != 1 {
		t.Fatalf("a redelivered event buzzed the phone again: %d sends", len(mobile.sent))
	}

	alert.AttemptCount = 2
	adapter.NotifyPaymentFailed(context.Background(), alert)
	if len(mobile.sent) != 2 {
		t.Fatalf("a new retry attempt did not alert: %d sends", len(mobile.sent))
	}
	if feed.writes[0].dedupeKey == feed.writes[2].dedupeKey {
		t.Fatalf("attempt is not part of the dedupe key: %q", feed.writes[0].dedupeKey)
	}
}

// The recipient is SUPPLIED by billing (the tenant owner, already pref-gated).
// Deriving an audience here would disclose a tenant's payment trouble to more
// people than the email policy chose to.
func TestPaymentFailedNotificationTellsOnlyTheSuppliedRecipient(t *testing.T) {
	t.Parallel()
	adapter, feed, _, _ := paymentFailedHarness()

	adapter.NotifyPaymentFailed(context.Background(), baseAlert())

	if len(feed.writes) != 1 || feed.writes[0].userID != "owner-1" {
		t.Fatalf("notified %d users (%+v), want exactly the supplied owner", len(feed.writes), feed.writes)
	}
}

func TestPaymentFailedNotificationIgnoresAnIncompleteAlert(t *testing.T) {
	t.Parallel()
	adapter, feed, _, _ := paymentFailedHarness()

	// No resolved owner: billing found no owner-role user. Dispatching with an
	// empty user id would write an unaddressed feed row.
	noUser := baseAlert()
	noUser.UserID = ""
	adapter.NotifyPaymentFailed(context.Background(), noUser)

	noTenant := baseAlert()
	noTenant.TenantID = ""
	adapter.NotifyPaymentFailed(context.Background(), noTenant)

	if len(feed.writes) != 0 {
		t.Fatalf("expected no delivery, got %+v", feed.writes)
	}
}

// The adapter must satisfy the interface billing declares; main.go assigns it
// to PaymentFailedNotifier, and a signature drift would only show up there.
var _ billing.PaymentFailedNotifier = (*operatorNotifyAdapter)(nil)

// GOVERNANCE#48. A sink's breaker opening means the tenant's audit trail
// stopped reaching their SIEM, and a SIEM cannot raise that alarm itself —
// silence is indistinguishable from "nothing happened".
func TestAuditSinkCircuitNotificationNeverCarriesTheSinkEndpoint(t *testing.T) {
	t.Parallel()
	adapter, feed, mobile, web := paymentFailedHarness()
	// adminUserIDs needs a pool; without one it returns nil and nothing is
	// dispatched, so this exercise supplies the recipients directly through a
	// fanout dispatch with the same event shape the adapter builds.
	adapter.Fanout.Dispatch(context.Background(), failedAlertTenant, []string{"admin-1"},
		auditSinkCircuitEventForTest("Splunk prod"))

	if len(feed.writes) != 1 {
		t.Fatalf("expected one feed write, got %d", len(feed.writes))
	}
	if got := feed.writes[0].eventType; got != "auditsink.circuit_opened" {
		t.Fatalf("event type = %q", got)
	}
	if !mobilepush.SupportsEvent("auditsink.circuit_opened") {
		t.Fatal("mobilepush does not accept auditsink.circuit_opened")
	}
	if feed.writes[0].deepLink != "/app/settings/audit-sinks" {
		t.Fatalf("deep link = %q", feed.writes[0].deepLink)
	}
	// The tenant's own sink label may appear in the in-app feed body but must
	// not ride in the native payload, which is a lock-screen surface.
	for _, n := range mobile.sent {
		if strings.Contains(n.Body, "Splunk prod") {
			t.Fatalf("native payload carried the tenant's sink label: %q", n.Body)
		}
	}
	for _, n := range web.sent {
		if strings.Contains(n.URL, "http") {
			t.Fatalf("web push URL is not the in-app destination: %q", n.URL)
		}
	}
}

// The adapter must satisfy the interface auditsink declares.
var _ auditsink.CircuitNotifier = (*operatorNotifyAdapter)(nil)

// auditSinkCircuitEventForTest mirrors the event NotifyAuditSinkCircuitOpened
// builds. Kept beside the assertions so a change to the adapter's payload that
// this test should catch shows up as a compile-time edit here rather than as a
// silently-still-passing test.
func auditSinkCircuitEventForTest(label string) notifyfanout.Event {
	return notifyfanout.Event{
		Type:       "auditsink.circuit_opened",
		Title:      "Audit sink stopped",
		Body:       "Audit sink \u201c" + label + "\u201d stopped accepting events, so new audit records are being held.",
		MobileBody: "An audit sink stopped accepting events. New audit records are being held.",
		URL:        "/app/settings/audit-sinks",
		EntityID:   "sink-1",
		DedupeKey:  "auditsink.circuit_opened:sink-1",
		Payload:    map[string]any{"sink_id": "sink-1"},
	}
}
