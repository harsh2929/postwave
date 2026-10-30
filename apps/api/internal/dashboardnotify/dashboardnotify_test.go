// SPDX-License-Identifier: AGPL-3.0-only
package dashboardnotify

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
)

// recordingFanout captures dispatches instead of delivering them. The sweep is
// fleet-wide, so tests filter by tenant rather than assuming the fixture is the
// only workspace in the database.
type recordingFanout struct {
	tenants []string
	events  []notifyfanout.Event
	users   [][]string
}

func (f *recordingFanout) Dispatch(_ context.Context, tenantID string, userIDs []string, ev notifyfanout.Event) []notifyfanout.Delivery {
	f.tenants = append(f.tenants, tenantID)
	f.events = append(f.events, ev)
	f.users = append(f.users, userIDs)
	return nil
}

// forTenant returns the (event, recipients) pairs dispatched for one tenant.
func (f *recordingFanout) forTenant(tenantID string) ([]notifyfanout.Event, [][]string) {
	var events []notifyfanout.Event
	var users [][]string
	for index, id := range f.tenants {
		if id == tenantID {
			events = append(events, f.events[index])
			users = append(users, f.users[index])
		}
	}
	return events, users
}

func TestHighestCrossedMilestone(t *testing.T) {
	cases := map[int]int{
		0:         0,
		99:        0,
		100:       100,
		499:       100,
		500:       500,
		1_234:     1_000,
		999_999:   500_000,
		1_000_000: 1_000_000,
		9_999_999: 1_000_000,
	}
	for count, want := range cases {
		if got := HighestCrossedMilestone(count); got != want {
			t.Errorf("HighestCrossedMilestone(%d) = %d, want %d", count, got, want)
		}
	}
}

// Thresholds must be strictly ascending — HighestCrossedMilestone takes the
// last match, and an out-of-order list would silently pick the wrong one.
func TestMilestoneThresholdsAreAscending(t *testing.T) {
	for i := 1; i < len(MilestoneThresholds); i++ {
		if MilestoneThresholds[i] <= MilestoneThresholds[i-1] {
			t.Fatalf("thresholds are not ascending at index %d: %v", i, MilestoneThresholds)
		}
	}
}

func TestFormatThousands(t *testing.T) {
	for value, want := range map[int]string{
		100: "100", 1_000: "1,000", 25_000: "25,000",
		250_000: "250,000", 1_000_000: "1,000,000",
	} {
		if got := formatThousands(value); got != want {
			t.Errorf("formatThousands(%d) = %q, want %q", value, got, want)
		}
	}
}

// The dedupe key IS the idempotency mechanism (there is no state table), so
// its shape is load-bearing: per metric per DAY for anomalies, per threshold
// forever for milestones.
func TestAnomalyDedupeKeyIsPerMetricPerDay(t *testing.T) {
	day := time.Date(2026, 7, 26, 13, 0, 0, 0, time.UTC)
	sameDayLater := time.Date(2026, 7, 26, 23, 59, 0, 0, time.UTC)
	nextDay := time.Date(2026, 7, 27, 0, 1, 0, 0, time.UTC)

	key := func(metric string, bucket time.Time) string {
		return EventAnomaly + ":" + metric + ":" + bucket.UTC().Format("2006-01-02")
	}
	if key("bounces", day) != key("bounces", sameDayLater) {
		t.Fatal("two detections on the same day produced different dedupe keys")
	}
	if key("bounces", day) == key("bounces", nextDay) {
		t.Fatal("a new day must be a new notification")
	}
	if key("bounces", day) == key("complaints", day) {
		t.Fatal("different metrics must not share a dedupe key")
	}
}

func TestAnomalyCopyCarriesTheNumbersAndNoCustomerData(t *testing.T) {
	title, body := anomalyCopy(anomalyRow{
		metric:    "bounces",
		dayBucket: time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC),
		value:     412,
		mean:      37.4,
		zScore:    6.1,
	})
	if title != "Unusual bounces activity" {
		t.Fatalf("title = %q", title)
	}
	want := "bounces hit 412 on Jul 26 (typical is about 37)."
	if body != want {
		t.Fatalf("body = %q, want %q", body, want)
	}
}

func TestTickRefusesWhenUnconfigured(t *testing.T) {
	if err := (&Emitter{}).Tick(context.Background()); err == nil {
		t.Fatal("an emitter with no pool or fanout reported success")
	}
	if err := (&Emitter{Fanout: &recordingFanout{}}).Tick(context.Background()); err == nil {
		t.Fatal("an emitter with no pool reported success")
	}
}

// Run must return immediately rather than spinning a ticker forever when the
// deployment has not wired the emitter.
func TestRunReturnsImmediatelyWhenUnconfigured(t *testing.T) {
	done := make(chan struct{})
	go func() {
		(&Emitter{}).Run(context.Background())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run blocked with no pool or fanout configured")
	}
}
