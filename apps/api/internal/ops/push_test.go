// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/postwave/apps/api/internal/ops/internal/pushstatetest"
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type fakeSend struct {
	kind    PushKind
	checkID string
}

// fakeChannel records (kind, checkID) per delivered message and can be
// toggled into failure to exercise the retry-next-tick path.
type fakeChannel struct {
	name     string
	fail     bool
	attempts int
	sent     []fakeSend
}

func (f *fakeChannel) Name() string { return f.name }

func (f *fakeChannel) Send(_ context.Context, m PushMessage) error {
	f.attempts++
	if f.fail {
		return errors.New(f.name + " is down")
	}
	f.sent = append(f.sent, fakeSend{kind: m.Kind, checkID: m.CheckID})
	return nil
}

// clock is the injectable Now: tests advance it explicitly.
type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

// pushTestPool gives each push test an empty ops_check_results,
// ops_check_history and ops_push_state, and holds the cross-package
// ops_push_state lock (pushstatetest.Lock) until the test ends.
//
// The push tests assert on the '__push_loop__' heartbeat, a deployment
// singleton that the canary tests in internal/ops/checks write too, and
// TestPush_TickSkipsWhenLockHeld asserts that the whole table stays empty.
// Neither assertion can be scoped to rows one test owns, so the canary tests
// are kept out for the whole test instead.
//
// Nothing else writes ops_push_state while the lock is held. Rows found at
// the start were therefore left by a holder that died before its cleanup
// ran, and rows found at the end are exactly the ones this test wrote. Both
// are deleted, so no push test leaves a heartbeat stamped by its fake clock
// behind for the next holder.
func pushTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := testPool(t)

	var reg *string
	if err := pool.QueryRow(context.Background(),
		`SELECT to_regclass('ops_push_state')::text`).Scan(&reg); err != nil {
		t.Fatalf("checking for ops_push_state: %v", err)
	}
	if reg == nil {
		t.Fatalf("ops push tables missing: apply infra/migrations/1701_ops_push_state.sql")
	}

	pushstatetest.Lock(t, pool)
	if _, err := pool.Exec(context.Background(), `DELETE FROM ops_push_state`); err != nil {
		t.Fatalf("clearing ops_push_state left by an earlier holder: %v", err)
	}
	// Registered after Lock, so it runs before the lock is released.
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM ops_push_state`); err != nil {
			t.Errorf("removing this test's ops_push_state rows: %v", err)
		}
	})
	truncate(t, pool, "ops_check_results", "ops_check_history")
	return pool
}

func newTestPusher(pool *pgxpool.Pool, clk *clock, checks []Check, chans ...Channel) *Pusher {
	return &Pusher{
		Store:    NewStore(pool),
		State:    NewPushStateStore(pool),
		Channels: chans,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:      clk.now,
		checks:   checks,
	}
}

// pushCheck builds a well-formed evaluated check without touching the global
// registry (tests inject checks straight into the Pusher).
func pushCheck(id string, sev Severity, damping int) Check {
	return Check{
		ID:          id,
		Group:       "Sending",
		Title:       id,
		Why:         "test consequence",
		Kind:        KindEvaluated,
		Severity:    sev,
		Interval:    time.Minute,
		Damping:     damping,
		Remediation: "test remediation",
	}
}

// seedResult writes an OBSERVED result the way the reconciler would.
func seedResult(t *testing.T, pool *pgxpool.Pool, checkID string, st Status, at time.Time) {
	t.Helper()
	store := NewStore(pool)
	prevs, err := store.LoadAll(context.Background())
	if err != nil {
		t.Fatalf("seedResult: LoadAll: %v", err)
	}
	if err := store.Upsert(context.Background(), checkID, prevs[checkID], st, "test detail", at); err != nil {
		t.Fatalf("seedResult: Upsert: %v", err)
	}
}

func snooze(t *testing.T, pool *pgxpool.Pool, checkID string, until time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE ops_check_results SET acked_until = $2 WHERE check_id = $1`,
		checkID, until); err != nil {
		t.Fatalf("snooze: %v", err)
	}
}

func loadState(t *testing.T, p *Pusher, checkID string) (PushState, bool) {
	t.Helper()
	states, err := p.State.LoadAll(context.Background())
	if err != nil {
		t.Fatalf("PushStateStore.LoadAll: %v", err)
	}
	st, ok := states[checkID]
	return st, ok
}

// ---------------------------------------------------------------------------
// The damping state machine
// ---------------------------------------------------------------------------

// A single red observation followed by recovery is a blip, not an incident.
func TestPush_BlipDoesNotAlert(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	ch := &fakeChannel{name: "slack"}
	c := pushCheck("t.push.blip", SevCritical, 0)
	p := newTestPusher(pool, clk, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusRed, clk.t)
	p.Tick(ctx)
	seedResult(t, pool, c.ID, StatusOK, clk.t)
	p.Tick(ctx)
	p.Tick(ctx)

	if len(ch.sent) != 0 {
		t.Fatalf("a one-tick blip must not alert, got %v", ch.sent)
	}

	// The tick heartbeats the reserved row — and LoadAll must never surface
	// it to the state machine.
	var hb time.Time
	if err := pool.QueryRow(ctx,
		`SELECT updated_at FROM ops_push_state WHERE check_id = '__push_loop__'`).Scan(&hb); err != nil {
		t.Fatalf("tick must upsert the __push_loop__ heartbeat row: %v", err)
	}
	if !hb.Equal(clk.t) {
		t.Fatalf("heartbeat updated_at = %v, want %v", hb, clk.t)
	}
	if _, leaked := loadState(t, p, "__push_loop__"); leaked {
		t.Fatal("PushStateStore.LoadAll must skip the reserved __push_loop__ row")
	}
}

func TestPush_TwoConsecutiveRedsAlertOnce(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	ch := &fakeChannel{name: "slack"}
	c := pushCheck("t.push.tworeds", SevCritical, 0)
	p := newTestPusher(pool, clk, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusRed, clk.t)
	p.Tick(ctx)
	if len(ch.sent) != 0 {
		t.Fatalf("first red tick must not alert yet (damping=2), got %v", ch.sent)
	}
	p.Tick(ctx)
	if len(ch.sent) != 1 || ch.sent[0].kind != PushAlert || ch.sent[0].checkID != c.ID {
		t.Fatalf("second red tick must alert exactly once, got %v", ch.sent)
	}
	p.Tick(ctx)
	if len(ch.sent) != 1 {
		t.Fatalf("third red tick must not re-alert, got %v", ch.sent)
	}
}

// The dead-reporter push test — the whole reason the engine derives Effective
// itself: the row still says 'ok', but the reporter has been silent for
// 5×Interval, so the effective status is stale, which is red.
func TestPush_DeadReporterAlerts(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	ch := &fakeChannel{name: "slack"}
	c := pushCheck("t.push.deadreporter", SevHigh, 0)
	p := newTestPusher(pool, clk, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusOK, clk.t.Add(-5*c.Interval))
	p.Tick(ctx)
	if len(ch.sent) != 0 {
		t.Fatalf("stale must damp like any other red, got %v", ch.sent)
	}
	p.Tick(ctx)
	if len(ch.sent) != 1 || ch.sent[0].kind != PushAlert || ch.sent[0].checkID != c.ID {
		t.Fatalf("a dead reporter must alert after damping, got %v", ch.sent)
	}
}

func TestPush_CriticalRepushesEvery24h(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	ch := &fakeChannel{name: "slack"}
	c := pushCheck("t.push.repush", SevCritical, 0)
	p := newTestPusher(pool, clk, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusRed, clk.t)
	p.Tick(ctx)
	p.Tick(ctx) // damped alert fires here
	if len(ch.sent) != 1 || ch.sent[0].kind != PushAlert {
		t.Fatalf("expected exactly the initial alert, got %v", ch.sent)
	}

	clk.advance(24 * time.Hour) // still red (the stale derivation keeps it red)
	p.Tick(ctx)
	if len(ch.sent) != 2 || ch.sent[1].kind != PushRepush || ch.sent[1].checkID != c.ID {
		t.Fatalf("expected one repush at +24h, got %v", ch.sent)
	}

	clk.advance(24 * time.Hour)
	p.Tick(ctx)
	if len(ch.sent) != 3 || ch.sent[2].kind != PushRepush {
		t.Fatalf("expected a second repush at +48h, got %v", ch.sent)
	}
}

// Resolved only closes loops we opened: a routine check that silently went
// red and back never alerted, so it must not "resolve" either. A critical
// check that alerted gets exactly one resolved on recovery.
func TestPush_ResolvedOnlyAfterAlert(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	ch := &fakeChannel{name: "slack"}
	routine := pushCheck("t.push.routine-recover", SevRoutine, 0)
	critical := pushCheck("t.push.critical-recover", SevCritical, 0)
	p := newTestPusher(pool, clk, []Check{routine, critical}, ch)

	seedResult(t, pool, routine.ID, StatusRed, clk.t)
	seedResult(t, pool, critical.ID, StatusRed, clk.t)
	p.Tick(ctx)
	p.Tick(ctx)
	if len(ch.sent) != 1 || ch.sent[0] != (fakeSend{PushAlert, critical.ID}) {
		t.Fatalf("only the critical check may alert, got %v", ch.sent)
	}

	seedResult(t, pool, routine.ID, StatusOK, clk.t)
	seedResult(t, pool, critical.ID, StatusOK, clk.t)
	p.Tick(ctx)
	p.Tick(ctx)
	if len(ch.sent) != 2 || ch.sent[1] != (fakeSend{PushResolved, critical.ID}) {
		t.Fatalf("exactly one resolved, for the check that alerted, got %v", ch.sent)
	}
}

func TestPush_RoutineNeverAlertsImmediately(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	ch := &fakeChannel{name: "slack"}
	c := pushCheck("t.push.routine", SevRoutine, 0)
	p := newTestPusher(pool, clk, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusRed, clk.t)
	p.Tick(ctx)
	p.Tick(ctx)
	p.Tick(ctx)

	if len(ch.sent) != 0 {
		t.Fatalf("a routine check must never push an alert, got %v", ch.sent)
	}
	st, ok := loadState(t, p, c.ID)
	if !ok {
		t.Fatal("routine transitions must still advance the persisted state")
	}
	if st.LastNotifiedClass != "red" || st.CandidateStreak != 0 {
		t.Fatalf("state must have committed the red transition silently, got %+v", st)
	}
	if st.LastAlertAt != nil {
		t.Fatalf("routine checks never alert, so LastAlertAt must stay nil, got %v", st.LastAlertAt)
	}
}

func TestPush_SnoozedIsSkipped_ThenAlertsAfterExpiry(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	ch := &fakeChannel{name: "slack"}
	c := pushCheck("t.push.snoozed", SevCritical, 0)
	p := newTestPusher(pool, clk, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusRed, clk.t)
	snooze(t, pool, c.ID, clk.t.Add(time.Hour))
	p.Tick(ctx)
	p.Tick(ctx)
	if len(ch.sent) != 0 {
		t.Fatalf("a snoozed check must not push, got %v", ch.sent)
	}
	if _, ok := loadState(t, p, c.ID); ok {
		t.Fatal("a snoozed check must be skipped before ANY state mutation")
	}

	clk.advance(2 * time.Hour) // snooze expired, still red
	seedResult(t, pool, c.ID, StatusRed, clk.t)
	p.Tick(ctx)
	if len(ch.sent) != 0 {
		t.Fatalf("post-snooze red must still damp, got %v", ch.sent)
	}
	p.Tick(ctx)
	if len(ch.sent) != 1 || ch.sent[0] != (fakeSend{PushAlert, c.ID}) {
		t.Fatalf("expected the damped alert after snooze expiry, got %v", ch.sent)
	}
}

// State commits ONLY after a successful send: while every channel fails, the
// transition stays uncommitted and is retried on the next tick, so recovery
// of the channel yields exactly one alert — not zero, not several.
func TestPush_AllChannelsFailingRetriesNextTick(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	ch := &fakeChannel{name: "slack", fail: true}
	c := pushCheck("t.push.retry", SevCritical, 0)
	p := newTestPusher(pool, clk, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusRed, clk.t)
	p.Tick(ctx) // streak 1, no send attempted
	p.Tick(ctx) // damped: attempt 1 fails
	p.Tick(ctx) // retry: attempt 2 fails
	if ch.attempts != 2 {
		t.Fatalf("expected 2 failed attempts, got %d", ch.attempts)
	}
	if len(ch.sent) != 0 {
		t.Fatalf("nothing was delivered yet, got %v", ch.sent)
	}
	st, ok := loadState(t, p, c.ID)
	if ok && st.LastNotifiedClass != "" {
		t.Fatalf("the transition must NOT commit while sends fail, got %+v", st)
	}

	ch.fail = false
	p.Tick(ctx) // retry succeeds
	if len(ch.sent) != 1 || ch.sent[0] != (fakeSend{PushAlert, c.ID}) {
		t.Fatalf("expected exactly one alert once the channel recovers, got %v", ch.sent)
	}
	st, ok = loadState(t, p, c.ID)
	if !ok || st.LastNotifiedClass != "red" {
		t.Fatalf("the transition must commit on the successful send, got %+v (present=%v)", st, ok)
	}

	p.Tick(ctx)
	if len(ch.sent) != 1 {
		t.Fatalf("no re-alert after commit, got %v", ch.sent)
	}
}

// Zero channels configured: send() reports success so state still advances —
// the push canary owns detecting an unconfigured pipeline, not the damper.
func TestPush_ZeroChannelsStateStillAdvances(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	c := pushCheck("t.push.nochannels", SevCritical, 0)
	p := newTestPusher(pool, clk, []Check{c})

	seedResult(t, pool, c.ID, StatusRed, clk.t)
	p.Tick(ctx)
	p.Tick(ctx)

	st, ok := loadState(t, p, c.ID)
	if !ok || st.LastNotifiedClass != "red" {
		t.Fatalf("with zero channels the state must still advance, got %+v (present=%v)", st, ok)
	}
}

// Two replicas, one tick: the advisory lock makes the second replica's tick a
// no-op — no double alerts, and the heartbeat is owned by the lock holder.
func TestPush_TickSkipsWhenLockHeld(t *testing.T) {
	pool := pushTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Now().UTC().Truncate(time.Second)}
	ch := &fakeChannel{name: "slack"}
	c := pushCheck("t.push.lock", SevCritical, 0)
	p := newTestPusher(pool, clk, []Check{c}, ch)

	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire holder conn: %v", err)
	}
	defer holder.Release()
	var got bool
	if err := holder.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtext('ops_push_tick'))`).Scan(&got); err != nil || !got {
		t.Fatalf("could not take the tick lock for the test: got=%v err=%v", got, err)
	}

	seedResult(t, pool, c.ID, StatusRed, clk.t)
	p.Tick(ctx)
	p.Tick(ctx)
	if ch.attempts != 0 {
		t.Fatalf("a lock-skipped tick must not touch channels, got %d attempts", ch.attempts)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM ops_push_state`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("a lock-skipped tick must write no state (not even the heartbeat), rows=%d err=%v", n, err)
	}

	if _, err := holder.Exec(ctx,
		`SELECT pg_advisory_unlock(hashtext('ops_push_tick'))`); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	p.Tick(ctx)
	p.Tick(ctx)
	if len(ch.sent) != 1 || ch.sent[0] != (fakeSend{PushAlert, c.ID}) {
		t.Fatalf("once the lock frees, the damped alert must fire, got %v", ch.sent)
	}
}
