package ops

import (
	"testing"
	"time"
)

// THE load-bearing test of the entire console.
//
// A reporter that dies must turn its check RED, not freeze it at the last
// value it wrote. Every disaster in the 2026-07 audit had the same shape: a
// green light fed by a source that had stopped working (StaticSampler{},
// TreatMissingData: notBreaching, the unreachable Stripe DLQ mailer).
func TestEffective_DeadReporterGoesRed(t *testing.T) {
	c := Check{ID: "x", Kind: KindEvaluated, Interval: time.Hour}
	now := time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC)

	// It last said OK three hours ago. The staleness budget is 2 * 1h.
	r := Result{Status: StatusOK, LastReportedAt: now.Add(-3 * time.Hour)}

	got := r.Effective(now, c)
	if got != StatusStale {
		t.Fatalf("a dead reporter must go stale, got %q", got)
	}
	if !got.IsRed() {
		t.Fatal("stale must render red: a silent machine is a broken machine")
	}
}

// A check that has NEVER reported has no row, so its zero Result has a zero
// LastReportedAt. It must be RED.
//
// This one test catches the entire "constructed but never started" bug class
// the audit found: dns_health, date_trigger, best_send_hour, activitypub,
// soft_bounce_recovery, aeo. A worker that was never wired up never beats,
// and therefore goes red on its own with nobody having to anticipate it.
func TestEffective_NeverReported_IsStale(t *testing.T) {
	c := Check{ID: "worker.dns-health", Kind: KindHeartbeat, Interval: 10 * time.Minute}

	var r Result // zero value

	if got := r.Effective(time.Now(), c); got != StatusStale {
		t.Fatalf("a check that never reported must be stale, got %q", got)
	}
}

func TestEffective_FreshReporterKeepsItsStatus(t *testing.T) {
	c := Check{ID: "x", Kind: KindEvaluated, Interval: time.Hour}
	now := time.Now()
	r := Result{Status: StatusOK, LastReportedAt: now.Add(-30 * time.Minute)}

	if got := r.Effective(now, c); got != StatusOK {
		t.Fatalf("a fresh reporter keeps its status, got %q", got)
	}
}

// A late human is not a broken machine.
//
// A manual chore past its cadence is DUE — it sorts into NEEDS YOU, and it is
// NOT red. Rendering "replace the banned seed mailbox" as RED-broken the
// moment it goes a day overdue is the road to a permanently-red board, and a
// permanently-red board is wallpaper.
func TestEffective_ManualOverdue_IsDueNotRed(t *testing.T) {
	c := Check{ID: "seedlist.rotate", Kind: KindManual, Cadence: 7 * 24 * time.Hour}
	now := time.Now()
	r := Result{Status: StatusOK, LastReportedAt: now.Add(-8 * 24 * time.Hour)}

	got := r.Effective(now, c)
	if got != StatusDue {
		t.Fatalf("an overdue chore is DUE, got %q", got)
	}
	if got.IsRed() {
		t.Fatal("DUE must not render red: a late human is not a broken machine")
	}
}

func TestEffective_ManualWithinCadence_IsOK(t *testing.T) {
	c := Check{ID: "seedlist.rotate", Kind: KindManual, Cadence: 7 * 24 * time.Hour}
	now := time.Now()
	r := Result{Status: StatusOK, LastReportedAt: now.Add(-2 * 24 * time.Hour)}

	if got := r.Effective(now, c); got != StatusOK {
		t.Fatalf("a chore inside its cadence is OK, got %q", got)
	}
}
