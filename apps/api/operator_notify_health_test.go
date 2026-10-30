// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/deliverability_hub"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

// DELIVERABILITY#15 + AUTOMATION#41.
//
// Two producers that had computed the right thing for a long time and told
// nobody: the hub worker (which scores the account, fires a WEBHOOK on a
// downward crossing, and halves max_sends_per_hour) and the voice stuck scanner
// (which detects participants who have stopped moving). These tests pin the
// properties that make the new channel SAFE rather than merely present.
//
// They exercise the REAL event builders — `deliverabilityDegradedEvent`,
// `deliverabilityAutoThrottledEvent`, `participantsStuckEvent` — rather than a
// copy of the payload maintained beside the assertions, then push those values
// through a real notifyfanout.Fanout with faked channels so the dedupe and
// identity behaviour under test is the production one.

const healthAlertTenant = "22222222-2222-4222-8222-222222222222"

func healthHarness() (*notifyfanout.Fanout, *capturingFeed, *capturingMobile, *capturingWeb) {
	feed := &capturingFeed{}
	mobile := &capturingMobile{}
	web := &capturingWeb{}
	return &notifyfanout.Fanout{Feed: feed, Mobile: mobile, Web: web}, feed, mobile, web
}

// The adapter must satisfy both producer-side interfaces; main.go assigns it to
// each by field, so a signature drift would only show up as "the alert quietly
// stopped being wired".
var (
	_ deliverability_hub.HealthNotifier = (*operatorNotifyAdapter)(nil)
	_ webhooks.CrossServiceNotifier     = (*operatorNotifyAdapter)(nil)
)

// THE CROSS-LANGUAGE CONTRACT. A push event has to exist in mobilepush's device
// allowlist or notifyfanout skips the native channel entirely (EventGate), and
// the shared @postwave/notifications manifest test asserts that allowlist
// matches the manifest event-for-event — which is in turn what mobile derives
// its Android channel ids from. Miss any link and Android drops the delivery
// against a channel the handset never created, silently.
func TestNewHealthEventsAreCarriableOnTheNativePushChannel(t *testing.T) {
	t.Parallel()
	for _, event := range []string{
		"deliverability.degraded",
		"deliverability.auto_throttled",
		"sequence.participants.stuck",
	} {
		if !mobilepush.SupportsEvent(event) {
			t.Errorf("mobilepush does not accept %q — the native channel will be skipped", event)
		}
	}
}

// AUTOMATION#41's root cause, pinned. services/voice announces stuck
// participants by writing a `webhook.fanout` outbox row, and FanoutHandler DLQs
// any row whose event type fails IsValidEvent. The scanner therefore dead-ended
// every alert in the DLQ: no webhook, no integration, no notification, and no
// error a person would ever see.
//
// The literal is deliberate — services/voice is a separate Go module, so this
// package cannot import stuckworker.EventType to compare against it.
func TestStuckScannerEventIsInTheWebhookCatalog(t *testing.T) {
	t.Parallel()
	if !webhooks.IsValidEvent("sequence.participants.stuck") {
		t.Fatal("sequence.participants.stuck is missing from webhooks.AllEvents; " +
			"the voice stuck scanner's fanout rows will DLQ")
	}
	if string(webhooks.EventSequenceParticipantsStuck) != "sequence.participants.stuck" {
		t.Fatalf("constant drifted from the wire value: %q",
			webhooks.EventSequenceParticipantsStuck)
	}
}

func TestDegradedEventNamesTheWorstBreachAndKeepsTheWireContentLight(t *testing.T) {
	t.Parallel()
	fanout, feed, mobile, web := healthHarness()

	ev := deliverabilityDegradedEvent(deliverability_hub.HealthAlert{
		TenantID:       healthAlertTenant,
		IncidentID:     "snapshot:100",
		Score:          42,
		PreviousScore:  71,
		Grade:          "D",
		TopBreachCode:  "complaint_rate_high",
		TopBreachTitle: "Complaint rate above 0.1%",
		BreachCount:    3,
	})
	fanout.Dispatch(context.Background(), healthAlertTenant, []string{"admin-1"}, ev)

	if len(feed.writes) != 1 {
		t.Fatalf("expected one feed write, got %d", len(feed.writes))
	}
	if got := feed.writes[0].eventType; got != "deliverability.degraded" {
		t.Fatalf("event type = %q", got)
	}
	// The in-app body may be specific — it is read on a screen behind auth.
	if !strings.Contains(ev.Body, "42") || !strings.Contains(ev.Body, "Complaint rate above 0.1%") {
		t.Fatalf("in-app body lost the specifics: %q", ev.Body)
	}
	// The native payload must not. A lock screen is a shoulder-surfable
	// surface, and the score is a business metric.
	for _, n := range mobile.sent {
		if strings.Contains(n.Body, "42") || strings.Contains(n.Body, "0.1%") {
			t.Fatalf("native payload carried a measured rate: %q", n.Body)
		}
	}
	// The destination is an in-app route, never an absolute URL.
	if feed.writes[0].deepLink != "/app/deliverability" {
		t.Fatalf("deep link = %q", feed.writes[0].deepLink)
	}
	for _, n := range web.sent {
		if strings.Contains(n.URL, "http") {
			t.Fatalf("web push URL is not the in-app destination: %q", n.URL)
		}
	}
}

// The dedupe identity has to collapse a REPLAY of the same crossing while
// letting a genuinely new incident through. A permanent key would mean an
// operator is told about a degradation exactly once, ever.
func TestDegradedDedupeCollapsesAReplayButRearmsAfterRecovery(t *testing.T) {
	t.Parallel()
	fanout, feed, mobile, _ := healthHarness()
	crossing := deliverability_hub.HealthAlert{
		TenantID: healthAlertTenant, IncidentID: "snapshot:101",
		Score: 42, PreviousScore: 71, Grade: "D",
	}

	// Same crossing dispatched twice — a retried tick, or a second replica.
	fanout.Dispatch(context.Background(), healthAlertTenant, []string{"admin-1"},
		deliverabilityDegradedEvent(crossing))
	fanout.Dispatch(context.Background(), healthAlertTenant, []string{"admin-1"},
		deliverabilityDegradedEvent(crossing))
	if len(mobile.sent) != 1 {
		t.Fatalf("a replayed crossing pushed %d times, want 1", len(mobile.sent))
	}

	// Recovered, then later repeated the exact same 71 -> 42 crossing. The
	// immutable target snapshot, not the numbers, makes it a new incident.
	fanout.Dispatch(context.Background(), healthAlertTenant, []string{"admin-1"},
		deliverabilityDegradedEvent(deliverability_hub.HealthAlert{
			TenantID: healthAlertTenant, IncidentID: "snapshot:102",
			Score: 42, PreviousScore: 71, Grade: "D",
		}))
	if len(mobile.sent) != 2 {
		t.Fatalf("a new incident after recovery pushed %d times total, want 2", len(mobile.sent))
	}
	if feed.writes[0].dedupeKey == feed.writes[2].dedupeKey {
		t.Fatalf("distinct incidents share a dedupe key: %q", feed.writes[0].dedupeKey)
	}
}

// "Sending was throttled" without a number leaves an operator unable to judge
// whether tonight's send still fits — but the PRIOR cap must only be reported
// when one was genuinely in force, because the worker substitutes an invented
// default (5000) when the workspace had none.
func TestAutoThrottledEventReportsTheNewCapAndNeverAFabricatedPrior(t *testing.T) {
	t.Parallel()
	withPrior := deliverabilityAutoThrottledEvent(deliverability_hub.ThrottleAlert{
		TenantID: healthAlertTenant, IncidentID: "override:501", Score: 31,
		PriorSendsPerHour: 8000, ThrottledSendsPerHour: 4000,
	})
	if !strings.Contains(withPrior.Body, "4000") {
		t.Fatalf("body does not name the new cap: %q", withPrior.Body)
	}
	if got := withPrior.Payload["prior_sends_per_hour"]; got != 8000 {
		t.Fatalf("prior cap = %v, want 8000", got)
	}

	noPrior := deliverabilityAutoThrottledEvent(deliverability_hub.ThrottleAlert{
		TenantID: healthAlertTenant, IncidentID: "override:502", Score: 31,
		PriorSendsPerHour: 0, ThrottledSendsPerHour: 2500,
	})
	if _, present := noPrior.Payload["prior_sends_per_hour"]; present {
		t.Fatalf("reported a prior cap the workspace never had: %v", noPrior.Payload)
	}
	if noPrior.URL != "/app/deliverability" || noPrior.EntityID != "" {
		t.Fatalf("destination = %q entity = %q", noPrior.URL, noPrior.EntityID)
	}
}

func TestAutoThrottleDedupeUsesTheImmutableOverrideIncident(t *testing.T) {
	t.Parallel()
	first := deliverabilityAutoThrottledEvent(deliverability_hub.ThrottleAlert{
		TenantID: healthAlertTenant, IncidentID: "override:601",
		Score: 31, ThrottledSendsPerHour: 2500,
	})
	replay := deliverabilityAutoThrottledEvent(deliverability_hub.ThrottleAlert{
		TenantID: healthAlertTenant, IncidentID: "override:601",
		Score: 31, ThrottledSendsPerHour: 2500,
	})
	later := deliverabilityAutoThrottledEvent(deliverability_hub.ThrottleAlert{
		TenantID: healthAlertTenant, IncidentID: "override:602",
		Score: 31, ThrottledSendsPerHour: 2500,
	})
	if first.DedupeKey != replay.DedupeKey {
		t.Fatalf("same override got different keys: %q vs %q", first.DedupeKey, replay.DedupeKey)
	}
	if first.DedupeKey == later.DedupeKey {
		t.Fatalf("distinct overrides with identical values share %q", first.DedupeKey)
	}
}

// The grade is concatenated straight into notification copy. scoreHub only ever
// produces A..F, but a malformed push is a bad way to discover otherwise.
func TestDegradedEventBoundsTheGradeLetter(t *testing.T) {
	t.Parallel()
	ev := deliverabilityDegradedEvent(deliverability_hub.HealthAlert{
		TenantID: healthAlertTenant, Score: 10, Grade: "not-a-grade",
	})
	if strings.Contains(ev.Body, "not-a-grade") {
		t.Fatalf("unbounded grade reached the copy: %q", ev.Body)
	}
	if !strings.Contains(ev.Body, "(grade ?)") {
		t.Fatalf("body = %q", ev.Body)
	}
}

// THE DISCLOSURE TEST for AUTOMATION#41. The scanner embeds up to 20 stuck
// participants — subscriber identities and their idle times — in the alert body,
// because a webhook receiver is the tenant's OWN system. A notification is not:
// it lands on lock screens and in a feed that syncs to every device the team
// owns. Nothing from `items` may survive into the dispatched event.
func TestStuckEventNeverCarriesTheParticipantRows(t *testing.T) {
	t.Parallel()
	raw := []byte(`{
	  "sequence_id": "seq_abc123",
	  "sequence_name": "Winback Q3",
	  "threshold_days": 7,
	  "stuck_count": 4,
	  "items": [
	    {"subscriber_id": "sub_1", "email": "ceo@acquisition-target.example", "idle_days": 19}
	  ]
	}`)
	var body stuckAlertBody
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	fanout, feed, mobile, web := healthHarness()
	ev, ok := participantsStuckEvent(body, time.Date(2026, 8, 2, 9, 0, 0, 0, time.UTC))
	if !ok {
		t.Fatal("a well-formed alert was dropped")
	}
	fanout.Dispatch(context.Background(), healthAlertTenant, []string{"admin-1"}, ev)

	const leaked = "ceo@acquisition-target.example"
	for _, blob := range []string{ev.Body, ev.MobileBody, ev.Title, ev.URL, ev.DedupeKey} {
		if strings.Contains(blob, leaked) || strings.Contains(blob, "sub_1") {
			t.Fatalf("participant row leaked into %q", blob)
		}
	}
	if _, present := ev.Payload["items"]; present {
		t.Fatalf("payload carried the participant rows: %v", ev.Payload)
	}
	for _, n := range mobile.sent {
		if strings.Contains(n.Body, leaked) || strings.Contains(n.Body, "Winback Q3") {
			t.Fatalf("native payload carried tenant content: %q", n.Body)
		}
	}
	for _, n := range web.sent {
		if strings.Contains(n.URL, "http") {
			t.Fatalf("web push URL is not the in-app destination: %q", n.URL)
		}
	}
	// The in-app feed body MAY name the sequence — it is read behind auth, and
	// without the name the notification cannot say which journey stalled.
	if !strings.Contains(feed.writes[0].payload["sequence_id"].(string), "seq_abc123") {
		t.Fatalf("feed payload lost the sequence id: %v", feed.writes[0].payload)
	}
	if !strings.Contains(ev.Body, "Winback Q3") || !strings.Contains(ev.Body, "4 people") {
		t.Fatalf("in-app body = %q", ev.Body)
	}
	if !strings.Contains(ev.Body, "more than 7 days") {
		t.Fatalf("in-app body lost the threshold: %q", ev.Body)
	}
}

// `/app/sequences/<id>` is concatenated into the feed deep link and the web push
// URL. An id carrying a slash, a scheme or traversal would mint a link pointing
// somewhere the alert is not about — the same guard route-map applies on the
// client end of that link.
func TestStuckEventRefusesAnUnsafeSequenceID(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 2, 9, 0, 0, 0, time.UTC)
	for _, id := range []string{
		"", "../../app/settings", "seq/../../x", "https://evil.example",
		"seq id", "seq%2f..", strings.Repeat("s", 129),
	} {
		if _, ok := participantsStuckEvent(stuckAlertBody{
			SequenceID: id, StuckCount: 3,
		}, now); ok {
			t.Errorf("built an event for unsafe sequence id %q", id)
		}
	}
	if _, ok := participantsStuckEvent(stuckAlertBody{
		SequenceID: "seq_abc-123", StuckCount: 3,
	}, now); !ok {
		t.Error("rejected a well-formed sequence id")
	}
}

// The scanner is stateless and re-alerts on every sweep — and it sweeps once
// immediately on start, so a crash-looping voice service emits a fanout row per
// restart. The day bucket collapses that (and outbox at-least-once retries)
// without muting a condition that is still true tomorrow.
func TestStuckDedupeIsOneAlertPerSequencePerDay(t *testing.T) {
	t.Parallel()
	body := stuckAlertBody{SequenceID: "seq_abc123", StuckCount: 4, ThresholdDays: 7}
	morning, _ := participantsStuckEvent(body, time.Date(2026, 8, 2, 6, 0, 0, 0, time.UTC))
	evening, _ := participantsStuckEvent(body, time.Date(2026, 8, 2, 23, 30, 0, 0, time.UTC))
	tomorrow, _ := participantsStuckEvent(body, time.Date(2026, 8, 3, 6, 0, 0, 0, time.UTC))

	if morning.DedupeKey != evening.DedupeKey {
		t.Fatalf("same-day sweeps got different keys: %q vs %q",
			morning.DedupeKey, evening.DedupeKey)
	}
	if morning.DedupeKey == tomorrow.DedupeKey {
		t.Fatalf("the next day reused yesterday's key: %q", morning.DedupeKey)
	}

	// And a different sequence is never collapsed into the same incident.
	other, _ := participantsStuckEvent(stuckAlertBody{
		SequenceID: "seq_other", StuckCount: 4,
	}, time.Date(2026, 8, 2, 6, 0, 0, 0, time.UTC))
	if other.DedupeKey == morning.DedupeKey {
		t.Fatalf("two sequences share a dedupe key: %q", other.DedupeKey)
	}
}

// ABSENCE IS NOT ZERO: a payload asserting nobody is stuck must produce no
// notification rather than a "0 people stopped progressing" push.
func TestStuckEventStaysSilentWhenNobodyIsStuck(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 2, 9, 0, 0, 0, time.UTC)
	if _, ok := participantsStuckEvent(stuckAlertBody{
		SequenceID: "seq_abc123", StuckCount: 0,
	}, now); ok {
		t.Fatal("built an alert for zero stuck participants")
	}
}

// One person is not "1 people". The copy is the first thing an operator reads.
func TestStuckCopyPluralisesAndDropsAnAbsentLabel(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 2, 9, 0, 0, 0, time.UTC)
	one, _ := participantsStuckEvent(stuckAlertBody{
		SequenceID: "seq_1", StuckCount: 1, ThresholdDays: 1,
	}, now)
	if !strings.Contains(one.Body, "1 person") || strings.Contains(one.Body, "1 people") {
		t.Fatalf("body = %q", one.Body)
	}
	if !strings.Contains(one.Body, "more than 1 day") || strings.Contains(one.Body, "1 days") {
		t.Fatalf("body = %q", one.Body)
	}
	// No sequence name: the clause is dropped entirely rather than rendering
	// an empty pair of quotes.
	if strings.Contains(one.Body, "“") {
		t.Fatalf("rendered an empty label: %q", one.Body)
	}
}

// A tenant's sequence label is arbitrary text. Truncation must not split a
// codepoint, and it must not let an unbounded string into a push payload.
func TestStuckLabelIsBoundedInRunesNotBytes(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("日", 200)
	got := boundedLabel(long, maxStuckSequenceNameChars)
	if strings.ContainsRune(got, '�') {
		t.Fatalf("truncation split a codepoint: %q", got)
	}
	if n := len([]rune(got)); n != maxStuckSequenceNameChars+1 { // +1 for the ellipsis
		t.Fatalf("bounded label is %d runes, want %d", n, maxStuckSequenceNameChars+1)
	}
	if boundedLabel("   ", 10) != "" {
		t.Fatal("whitespace-only label should render as absent")
	}
}

// The cross-service hook is a BOUNDED set. A sibling service that starts
// emitting some other event must not acquire a first-party notification by
// accident — the default arm is silence.
func TestCrossServiceNotifierIgnoresUnnamedEvents(t *testing.T) {
	t.Parallel()
	fanout, feed, _, _ := healthHarness()
	adapter := &operatorNotifyAdapter{Fanout: fanout}

	adapter.NotifyCrossServiceEvent(context.Background(), healthAlertTenant,
		"migration.completed", json.RawMessage(`{"sequence_id":"seq_1","stuck_count":9}`))

	if len(feed.writes) != 0 {
		t.Fatalf("an unnamed cross-service event was notified: %+v", feed.writes)
	}
}

// A malformed payload from a sibling service must not panic the outbox worker
// that calls this — the fanout row has already committed by then.
func TestCrossServiceNotifierSurvivesAMalformedPayload(t *testing.T) {
	t.Parallel()
	fanout, feed, _, _ := healthHarness()
	adapter := &operatorNotifyAdapter{Fanout: fanout}

	adapter.NotifyCrossServiceEvent(context.Background(), healthAlertTenant,
		"sequence.participants.stuck", json.RawMessage(`{"stuck_count": "four"`))

	if len(feed.writes) != 0 {
		t.Fatalf("notified from a malformed payload: %+v", feed.writes)
	}
}
