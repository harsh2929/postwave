// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_hub

import (
	"context"
	"testing"
)

// DELIVERABILITY#15. The scoring half of this package was already covered by
// hub_test.go; what was untested — because it did not exist — is whether the
// worker TELLS anyone. These are pure-logic tests: notifyDegraded and
// notifyAutoThrottled deliberately touch no pool, so the alert plumbing is
// exercised without a database.

type recordingHealthNotifier struct {
	degraded  []HealthAlert
	throttled []ThrottleAlert
}

func (r *recordingHealthNotifier) NotifyDeliverabilityDegraded(_ context.Context, in HealthAlert) error {
	r.degraded = append(r.degraded, in)
	return nil
}

func (r *recordingHealthNotifier) NotifyDeliverabilityAutoThrottled(_ context.Context, in ThrottleAlert) {
	r.throttled = append(r.throttled, in)
}

// A nil notifier must be a complete no-op. Every existing construction of Deps
// — main.go's own before this shipped, workers.Registered, and every test in
// this repo — leaves the field unset, and a panic here would take down the
// scoring worker for an optional alert.
func TestNotifyHelpersNoOpWithoutANotifier(t *testing.T) {
	t.Parallel()
	w := &Worker{Deps: &Deps{}}
	if err := w.notifyDegraded(context.Background(), HealthAlert{
		TenantID: "tenant-1", IncidentID: "snapshot:1", Score: 40, PreviousScore: 80,
	}); err == nil {
		t.Fatal("missing notifier was reported as delivered")
	}
	w.notifyAutoThrottled(context.Background(), "tenant-1", "override:1", 40, 5000, 2500)
}

// The alert must name the breach an operator should look at first, and it must
// carry the score it crossed FROM — that pair is what makes the notification
// specific rather than "something is wrong".
func TestNotifyDegradedCarriesTheWorstBreachAndTheCrossing(t *testing.T) {
	t.Parallel()
	rec := &recordingHealthNotifier{}
	w := &Worker{Deps: &Deps{HealthNotifier: rec}}
	hub := HubScore{
		Score: 42,
		Grade: "D",
		Breaches: []ThresholdBreach{
			{Code: "engagement_low", Severity: "warn", Title: "Engagement below 15%"},
			{Code: "complaint_rate_high", Severity: "critical", Title: "Complaint rate above 0.1%"},
			{Code: "dns_unverified", Severity: "info", Title: "A sending domain is unverified"},
		},
	}

	err := w.notifyDegraded(context.Background(), HealthAlert{
		TenantID:       "tenant-1",
		IncidentID:     "snapshot:2",
		Score:          hub.Score,
		PreviousScore:  71,
		Grade:          hub.Grade,
		TopBreachCode:  "complaint_rate_high",
		TopBreachTitle: "Complaint rate above 0.1%",
		BreachCount:    len(hub.Breaches),
	})
	if err != nil {
		t.Fatalf("notify degraded: %v", err)
	}

	if len(rec.degraded) != 1 {
		t.Fatalf("expected one degraded alert, got %d", len(rec.degraded))
	}
	got := rec.degraded[0]
	if got.TenantID != "tenant-1" || got.Score != 42 || got.PreviousScore != 71 {
		t.Fatalf("alert = %+v", got)
	}
	if got.Grade != "D" || got.BreachCount != 3 {
		t.Fatalf("alert = %+v", got)
	}
	// Critical outranks warn outranks info, regardless of list order.
	if got.TopBreachCode != "complaint_rate_high" {
		t.Fatalf("top breach = %q, want the critical one", got.TopBreachCode)
	}
	if got.TopBreachTitle != "Complaint rate above 0.1%" {
		t.Fatalf("top breach title = %q", got.TopBreachTitle)
	}
}

// A score can drift under the threshold on engagement decay without any single
// threshold tripping. The alert must still go out, just without naming a breach
// it cannot name — an empty string, never an invented one.
func TestNotifyDegradedWithNoBreachesStillAlerts(t *testing.T) {
	t.Parallel()
	rec := &recordingHealthNotifier{}
	w := &Worker{Deps: &Deps{HealthNotifier: rec}}

	if err := w.notifyDegraded(context.Background(), HealthAlert{
		TenantID: "tenant-1", IncidentID: "snapshot:3", Score: 58,
		PreviousScore: 62, Grade: "C",
	}); err != nil {
		t.Fatalf("notify degraded: %v", err)
	}

	if len(rec.degraded) != 1 {
		t.Fatalf("expected one degraded alert, got %d", len(rec.degraded))
	}
	if got := rec.degraded[0]; got.TopBreachCode != "" || got.TopBreachTitle != "" || got.BreachCount != 0 {
		t.Fatalf("alert invented a breach: %+v", got)
	}
}

// The throttle alert reports an action already taken against the workspace, so
// the caps it names have to be the real ones.
func TestNotifyAutoThrottledCarriesBothCaps(t *testing.T) {
	t.Parallel()
	rec := &recordingHealthNotifier{}
	w := &Worker{Deps: &Deps{HealthNotifier: rec}}

	w.notifyAutoThrottled(context.Background(), "tenant-1", "override:4", 31, 8000, 4000)

	if len(rec.throttled) != 1 {
		t.Fatalf("expected one throttle alert, got %d", len(rec.throttled))
	}
	got := rec.throttled[0]
	if got.PriorSendsPerHour != 8000 || got.ThrottledSendsPerHour != 4000 || got.Score != 31 {
		t.Fatalf("alert = %+v", got)
	}
}

// An empty tenant id is never a valid dispatch target and would fan a
// notification into a tenant-less feed write.
func TestNotifyHelpersRefuseAnEmptyTenant(t *testing.T) {
	t.Parallel()
	rec := &recordingHealthNotifier{}
	w := &Worker{Deps: &Deps{HealthNotifier: rec}}

	if err := w.notifyDegraded(context.Background(), HealthAlert{
		IncidentID: "snapshot:5", Score: 10, PreviousScore: 90,
	}); err == nil {
		t.Fatal("empty tenant was reported as delivered")
	}
	w.notifyAutoThrottled(context.Background(), "", "override:5", 10, 1000, 500)

	if len(rec.degraded) != 0 || len(rec.throttled) != 0 {
		t.Fatalf("dispatched without a tenant: %+v %+v", rec.degraded, rec.throttled)
	}
}

func TestWorstBreachRanksSeverityAndReturnsNilForEmpty(t *testing.T) {
	t.Parallel()
	if got := worstBreach(nil); got != nil {
		t.Fatalf("empty list = %+v, want nil", got)
	}
	// Ties go to the first appended, which scoreHub already orders
	// most-actionable first (bounce, then complaint, then the rest).
	got := worstBreach([]ThresholdBreach{
		{Code: "bounce_rate_high", Severity: "critical"},
		{Code: "complaint_rate_high", Severity: "critical"},
	})
	if got == nil || got.Code != "bounce_rate_high" {
		t.Fatalf("tie-break = %+v", got)
	}
	// An unrecognised severity must not outrank a real one.
	got = worstBreach([]ThresholdBreach{
		{Code: "weird", Severity: "spicy"},
		{Code: "engagement_low", Severity: "warn"},
	})
	if got == nil || got.Code != "engagement_low" {
		t.Fatalf("unknown severity outranked a real one: %+v", got)
	}
}
