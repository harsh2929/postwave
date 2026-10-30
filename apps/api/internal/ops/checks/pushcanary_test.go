// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/postwave/apps/api/internal/ops"
	"github.com/postwave/postwave/apps/api/internal/ops/internal/pushstatetest"
)

// fakeCanaryChannel is a named Channel double whose Send outcome is toggled
// per test, mirroring internal/ops/push_test.go's fakeChannel. sends counts
// every Send, failed or not.
type fakeCanaryChannel struct {
	name  string
	fail  bool
	sends int
}

func (f *fakeCanaryChannel) Name() string { return f.name }

func (f *fakeCanaryChannel) Send(_ context.Context, _ ops.PushMessage) error {
	f.sends++
	if f.fail {
		return errors.New(f.name + " webhook unreachable")
	}
	return nil
}

// pushLoopHeartbeatRow is the reserved ops_push_state row the canary reads
// (ops.pushLoopCheckID, unexported). It is the only ops_push_state row these
// tests write or remove.
const pushLoopHeartbeatRow = "__push_loop__"

// pushCanaryPool mirrors internal/ops/push_test.go's pushTestPool. It fails
// (deterministically, no auto-migration) when ops_push_state has not been
// migrated. It holds the cross-package ops_push_state lock
// (pushstatetest.Lock) for the whole test, because the heartbeat is a
// deployment singleton that internal/ops's push tests also write and assert
// on. Every test then starts with no heartbeat, and the row is removed again
// at the end, before the lock is released. The canary reads nothing else in
// the table, so nothing else is touched.
func pushCanaryPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := testPool(t)

	var reg *string
	if err := pool.QueryRow(context.Background(),
		`SELECT to_regclass('ops_push_state')::text`).Scan(&reg); err != nil {
		t.Fatalf("checking for ops_push_state: %v", err)
	}
	if reg == nil {
		t.Fatalf("ops_push_state missing: apply infra/migrations/1701_ops_push_state.sql")
	}

	pushstatetest.Lock(t, pool)
	if _, err := pool.Exec(context.Background(),
		`DELETE FROM ops_push_state WHERE check_id = $1`, pushLoopHeartbeatRow); err != nil {
		t.Fatalf("clearing the push-loop heartbeat: %v", err)
	}
	// Premise: the row just removed is the one the canary reads. If the
	// reserved id ever changes, this fails here and not as a canary verdict
	// taken from a leftover heartbeat.
	if _, present, err := ops.NewPushStateStore(pool).LoopHeartbeatAge(context.Background()); err != nil || present {
		t.Fatalf("after clearing %q the push-loop heartbeat is still present=%v (err=%v); "+
			"pushLoopHeartbeatRow no longer matches the row PushStateStore reads", pushLoopHeartbeatRow, present, err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM ops_push_state WHERE check_id = $1`, pushLoopHeartbeatRow); err != nil {
			t.Errorf("removing the push-loop heartbeat: %v", err)
		}
	})
	return pool
}

// ---------------------------------------------------------------------------
// Branch matrix, exercised directly against the unexported probe
// constructor. BindPushCanaryProbe binds at most once per process (a second
// ops.BindProbe panics, and its sync.Once turns later calls into no-ops), so
// the state matrix below is driven through pushCanaryProbe rather than
// re-binding per case; the bind-and-fetch-from-the-board path is covered
// separately below.
// ---------------------------------------------------------------------------

func TestPushCanaryProbe_FailingChannelIsRedNamingIt(t *testing.T) {
	pool := pushCanaryPool(t)
	env := &ops.Env{Pool: pool}
	loop := ops.NewPushStateStore(pool)
	if err := loop.HeartbeatLoop(context.Background(), time.Now().UTC()); err != nil {
		t.Fatalf("HeartbeatLoop: %v", err)
	}

	ok := &fakeCanaryChannel{name: "email"}
	bad := &fakeCanaryChannel{name: "slack", fail: true}
	probe := pushCanaryProbe([]ops.Channel{bad, ok}, loop)

	st, detail, err := probe(context.Background(), env)
	if err != nil {
		t.Fatalf("probe() error = %v", err)
	}
	if st != ops.StatusRed {
		t.Fatalf("a failing channel must be RED, got %q (%s)", st, detail)
	}
	if !strings.Contains(detail, "slack") {
		t.Fatalf("detail must name the failing channel, got %q", detail)
	}
}

func TestPushCanaryProbe_FreshHeartbeatOkChannelsIsOK(t *testing.T) {
	pool := pushCanaryPool(t)
	env := &ops.Env{Pool: pool}
	loop := ops.NewPushStateStore(pool)
	if err := loop.HeartbeatLoop(context.Background(), time.Now().UTC()); err != nil {
		t.Fatalf("HeartbeatLoop: %v", err)
	}

	probe := pushCanaryProbe([]ops.Channel{&fakeCanaryChannel{name: "slack"}}, loop)

	st, detail, err := probe(context.Background(), env)
	if err != nil {
		t.Fatalf("probe() error = %v", err)
	}
	if st != ops.StatusOK {
		t.Fatalf("fresh heartbeat + ok channels must be OK, got %q (%s)", st, detail)
	}
}

func TestPushCanaryProbe_StaleHeartbeatIsRed(t *testing.T) {
	pool := pushCanaryPool(t)
	env := &ops.Env{Pool: pool}
	loop := ops.NewPushStateStore(pool)
	if err := loop.HeartbeatLoop(context.Background(), time.Now().UTC().Add(-10*time.Minute)); err != nil {
		t.Fatalf("HeartbeatLoop: %v", err)
	}

	probe := pushCanaryProbe([]ops.Channel{&fakeCanaryChannel{name: "slack"}}, loop)

	st, detail, err := probe(context.Background(), env)
	if err != nil {
		t.Fatalf("probe() error = %v", err)
	}
	if st != ops.StatusRed {
		t.Fatalf("a heartbeat older than 5m must be RED, got %q (%s)", st, detail)
	}
	if !strings.Contains(detail, "push loop dead") {
		t.Fatalf("detail must say the push loop is dead, got %q", detail)
	}
}

func TestPushCanaryProbe_AbsentHeartbeatIsRed(t *testing.T) {
	pool := pushCanaryPool(t) // cleared: no __push_loop__ row exists
	env := &ops.Env{Pool: pool}
	loop := ops.NewPushStateStore(pool)

	probe := pushCanaryProbe([]ops.Channel{&fakeCanaryChannel{name: "slack"}}, loop)

	st, detail, err := probe(context.Background(), env)
	if err != nil {
		t.Fatalf("probe() error = %v", err)
	}
	if st != ops.StatusRed {
		t.Fatalf("an absent push-loop heartbeat must be RED, got %q (%s)", st, detail)
	}
	if !strings.Contains(detail, "push loop dead") {
		t.Fatalf("detail must say the push loop is dead, got %q", detail)
	}
}

// clearProductionEnvKeys blanks every key ops.IsProductionEnv consults so
// the zero-channels tests are immune to the ambient shell (NODE_ENV in
// particular is commonly set on dev machines). t.Setenv restores the
// originals at test end.
func clearProductionEnvKeys(t *testing.T) {
	t.Helper()
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		t.Setenv(key, "")
	}
}

func TestPushCanaryProbe_ZeroChannelsProductionIsRed(t *testing.T) {
	clearProductionEnvKeys(t)
	t.Setenv("POSTWAVE_ENV", "production")
	pool := pushCanaryPool(t)
	env := &ops.Env{Pool: pool}
	loop := ops.NewPushStateStore(pool)
	if err := loop.HeartbeatLoop(context.Background(), time.Now().UTC()); err != nil {
		t.Fatalf("HeartbeatLoop: %v", err)
	}

	probe := pushCanaryProbe(nil, loop)

	st, detail, err := probe(context.Background(), env)
	if err != nil {
		t.Fatalf("probe() error = %v", err)
	}
	if st != ops.StatusRed {
		t.Fatalf("zero channels in production must be RED, got %q (%s)", st, detail)
	}
}

// TestPushCanaryProbe_ZeroChannelsAlternateProductionSpellingsAreRed pins
// the canary to the same production detector as main.go's boot check
// (ops.IsProductionEnv). The canary once matched only
// POSTWAVE_ENV=production, so a deployment identified as production via
// "prod" or via ENVIRONMENT/NODE_ENV got the boot error log but a WARN
// canary — and WARN lands in the board's green lane, hiding the unwired
// alert pipeline. Every spelling that earns the boot error must be RED here.
func TestPushCanaryProbe_ZeroChannelsAlternateProductionSpellingsAreRed(t *testing.T) {
	pool := pushCanaryPool(t)
	env := &ops.Env{Pool: pool}
	loop := ops.NewPushStateStore(pool)
	if err := loop.HeartbeatLoop(context.Background(), time.Now().UTC()); err != nil {
		t.Fatalf("HeartbeatLoop: %v", err)
	}

	probe := pushCanaryProbe(nil, loop)

	cases := []struct {
		name  string
		key   string
		value string
	}{
		{"POSTWAVE_ENV=prod", "POSTWAVE_ENV", "prod"},
		{"ENVIRONMENT=production", "ENVIRONMENT", "production"},
		{"ENVIRONMENT=prod", "ENVIRONMENT", "prod"},
		{"NODE_ENV=production", "NODE_ENV", "production"},
		{"NODE_ENV=prod", "NODE_ENV", "prod"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearProductionEnvKeys(t)
			t.Setenv(tc.key, tc.value)

			st, detail, err := probe(context.Background(), env)
			if err != nil {
				t.Fatalf("probe() error = %v", err)
			}
			if st != ops.StatusRed {
				t.Fatalf("zero channels with %s=%q must be RED (same detector as the boot check), got %q (%s)",
					tc.key, tc.value, st, detail)
			}
		})
	}
}

func TestPushCanaryProbe_ZeroChannelsDevIsWarn(t *testing.T) {
	clearProductionEnvKeys(t)
	t.Setenv("POSTWAVE_ENV", "development")
	pool := pushCanaryPool(t)
	env := &ops.Env{Pool: pool}
	loop := ops.NewPushStateStore(pool)
	if err := loop.HeartbeatLoop(context.Background(), time.Now().UTC()); err != nil {
		t.Fatalf("HeartbeatLoop: %v", err)
	}

	probe := pushCanaryProbe(nil, loop)

	st, detail, err := probe(context.Background(), env)
	if err != nil {
		t.Fatalf("probe() error = %v", err)
	}
	if st != ops.StatusWarn {
		t.Fatalf("zero channels in dev must be WARN, not RED (that's the digest's business), got %q (%s)", st, detail)
	}
}

// ---------------------------------------------------------------------------
// Binding wiring: this is the one test allowed to call BindPushCanaryProbe.
// Its sync.Once makes a second call here, or a later call from main.go, a
// safe no-op rather than a double-bind panic.
// ---------------------------------------------------------------------------

// canaryBinding holds the handles
// TestPushCanary_IsDeclaredAtCompileTimeAndItsProbeBoundOnce binds the
// canary's probe to.
//
// BindPushCanaryProbe binds once per process, as main.go does, so whatever
// the first call passes is what ops.BoundProbe returns until the process
// exits. The handles must live that long. The test used to bind a store over
// its own pool, which its cleanup closed; every later run in the same process
// (go test -count=N) then got the first run's probe back and failed on
// "closed pool". These are created once and never closed, the same lifetime
// as the handles main.go binds.
var canaryBinding struct {
	once    sync.Once
	channel *fakeCanaryChannel
	store   *ops.PushStateStore
	err     error
}

func processCanaryBinding(t *testing.T) ([]ops.Channel, *ops.PushStateStore) {
	t.Helper()
	canaryBinding.once.Do(func() {
		pool, err := pgxpool.New(context.Background(), os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
		if err != nil {
			canaryBinding.err = err
			return
		}
		canaryBinding.channel = &fakeCanaryChannel{name: "slack"}
		canaryBinding.store = ops.NewPushStateStore(pool)
	})
	if canaryBinding.err != nil {
		t.Fatalf("opening the process-lifetime pool the canary probe is bound to: %v", canaryBinding.err)
	}
	return []ops.Channel{canaryBinding.channel}, canaryBinding.store
}

func TestPushCanary_IsDeclaredAtCompileTimeAndItsProbeBoundOnce(t *testing.T) {
	pool := pushCanaryPool(t)
	loop := ops.NewPushStateStore(pool)
	if err := loop.HeartbeatLoop(context.Background(), time.Now().UTC()); err != nil {
		t.Fatalf("HeartbeatLoop: %v", err)
	}

	// Declared in init(), so it is in the compiled registry BEFORE anything
	// is bound. That is what keeps the coverage number CI prints equal to the
	// one the board shows.
	c, ok := ops.Get(PushCanaryCheckID)
	if !ok {
		t.Fatal("ops.push-canary must be in the compiled registry without any wiring")
	}
	if !c.RuntimeProbe {
		t.Fatal("the canary's probe needs live channels, so it must declare RuntimeProbe")
	}

	channels, store := processCanaryBinding(t)
	BindPushCanaryProbe(channels, store)
	// A second bind must neither panic (ops.BindProbe refuses a double bind)
	// nor replace the first. This one's channel fails, so a replacement would
	// turn the probe below RED, and its store reads a pool this test closes.
	late := &fakeCanaryChannel{name: "late-bind", fail: true}
	BindPushCanaryProbe([]ops.Channel{late}, loop)
	if c.Group != "Ops" {
		t.Errorf("Group = %q, want %q", c.Group, "Ops")
	}
	if c.Severity != ops.SevHigh {
		t.Errorf("Severity = %q, want %q", c.Severity, ops.SevHigh)
	}
	if c.Kind != ops.KindEvaluated {
		t.Errorf("Kind = %q, want %q", c.Kind, ops.KindEvaluated)
	}
	if c.Interval != 24*time.Hour {
		t.Errorf("Interval = %v, want 24h", c.Interval)
	}
	if c.Why == "" {
		t.Error("Why must not be empty")
	}
	if c.Remediation == "" {
		t.Error("Remediation must not be empty")
	}
	if c.Action == nil {
		t.Fatal("ops.push-canary declares no ActionMeta — the board would render no test-push button")
	}
	if c.Action.ID != "send-test-push" {
		t.Errorf("action ID = %q, want %q", c.Action.ID, "send-test-push")
	}
	if c.Action.Danger != ops.DangerSafe {
		t.Errorf("action Danger = %q, want %q — proving the alert path works must be one click",
			c.Action.Danger, ops.DangerSafe)
	}

	probe := ops.BoundProbe(PushCanaryCheckID)
	if probe == nil {
		t.Fatal("the probe must resolve after binding")
	}
	st, detail, err := probe(context.Background(), &ops.Env{Pool: pool})
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if late.sends != 0 {
		t.Fatalf("the second BindPushCanaryProbe replaced the first binding: the bound probe sent "+
			"the canary to the late channel (status %q: %s)", st, detail)
	}
	if st != ops.StatusOK {
		t.Fatalf("registered probe with a fresh heartbeat and a healthy channel must be OK, got %q (%s)", st, detail)
	}
}
