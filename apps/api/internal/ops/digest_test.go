// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// countingChannel is the concurrency-safe fake for the digest tests: an
// atomic send counter (the claim-race test reads it from the main goroutine
// while two Ticks race) plus the last delivered message under a mutex.
type countingChannel struct {
	sends atomic.Int64
	mu    sync.Mutex
	last  PushMessage
}

func (c *countingChannel) Name() string { return "fake" }

func (c *countingChannel) Send(_ context.Context, m PushMessage) error {
	c.sends.Add(1)
	c.mu.Lock()
	c.last = m
	c.mu.Unlock()
	return nil
}

func (c *countingChannel) lastMsg() PushMessage {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.last
}

// digestTestPool extends testPool with the 1701 guard, truncates the digest
// tables, and re-seeds the singleton claim row the migration guarantees —
// TRUNCATE removes it, and the claim UPDATE needs a row to win.
//
// ops_push_state is left alone. The Digester never reads or writes it: its
// claim is ops_digest_state and its board is ops_check_results. The
// push-canary tests in internal/ops/checks use that table too, so wiping it
// here did nothing for these tests and could erase the canary's heartbeat
// while a canary test was running.
func digestTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := testPool(t)

	var reg *string
	if err := pool.QueryRow(context.Background(),
		`SELECT to_regclass('ops_digest_state')::text`).Scan(&reg); err != nil {
		t.Fatalf("checking for ops_digest_state: %v", err)
	}
	if reg == nil {
		t.Fatalf("ops digest table missing: apply infra/migrations/1701_ops_push_state.sql")
	}

	truncate(t, pool, "ops_check_results", "ops_check_history", "ops_digest_state")
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO ops_digest_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING`); err != nil {
		t.Fatalf("re-seeding ops_digest_state singleton: %v", err)
	}
	return pool
}

func newTestDigester(pool *pgxpool.Pool, clk *clock, tz *time.Location, hour int,
	checks []Check, chans ...Channel) *Digester {
	return &Digester{
		Store:    NewStore(pool),
		State:    NewPushStateStore(pool),
		Channels: chans,
		Hour:     hour,
		TZ:       tz,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:      clk.now,
		checks:   checks,
	}
}

// kolkata is a fixed +05:30: FixedZone keeps the TZ test independent of the
// host's zoneinfo database.
var kolkata = time.FixedZone("Asia/Kolkata", 5*3600+30*60)

// ---------------------------------------------------------------------------
// The claim: once per local day, after the hour
// ---------------------------------------------------------------------------

func TestDigest_SameDayDoubleTickSendsOnce(t *testing.T) {
	pool := digestTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Date(2026, 7, 11, 9, 0, 0, 0, time.UTC)}
	ch := &countingChannel{}
	c := pushCheck("t.digest.sameday", SevHigh, 0)
	d := newTestDigester(pool, clk, time.UTC, 8, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusOK, clk.t)
	d.Tick(ctx)
	if got := ch.sends.Load(); got != 1 {
		t.Fatalf("first tick after the hour must send the digest, got %d sends", got)
	}
	if m := ch.lastMsg(); m.Kind != PushDigest {
		t.Fatalf("digest must go out as PushDigest, got %q", m.Kind)
	}

	d.Tick(ctx)
	clk.advance(3 * time.Hour) // still 2026-07-11
	d.Tick(ctx)
	if got := ch.sends.Load(); got != 1 {
		t.Fatalf("same-day re-ticks must not re-send, got %d sends", got)
	}
}

func TestDigest_NextLocalDaySendsAgain(t *testing.T) {
	pool := digestTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Date(2026, 7, 11, 9, 0, 0, 0, time.UTC)}
	ch := &countingChannel{}
	c := pushCheck("t.digest.nextday", SevHigh, 0)
	d := newTestDigester(pool, clk, time.UTC, 8, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusOK, clk.t)
	d.Tick(ctx)
	clk.advance(24 * time.Hour) // 2026-07-12 09:00
	d.Tick(ctx)
	if got := ch.sends.Load(); got != 2 {
		t.Fatalf("the next local day must send again, got %d sends", got)
	}
}

func TestDigest_BeforeHourSendsNothing(t *testing.T) {
	pool := digestTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Date(2026, 7, 11, 7, 59, 0, 0, time.UTC)}
	ch := &countingChannel{}
	c := pushCheck("t.digest.beforehour", SevHigh, 0)
	d := newTestDigester(pool, clk, time.UTC, 8, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusOK, clk.t)
	d.Tick(ctx)
	if got := ch.sends.Load(); got != 0 {
		t.Fatalf("07:59 with Hour=8 must send nothing, got %d sends", got)
	}

	// The early tick must not have burned today's claim.
	var lastSentOn *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT last_sent_on FROM ops_digest_state WHERE id`).Scan(&lastSentOn); err != nil {
		t.Fatalf("reading ops_digest_state: %v", err)
	}
	if lastSentOn != nil {
		t.Fatalf("a before-hour tick must not claim the day, got last_sent_on=%v", lastSentOn)
	}

	clk.advance(time.Minute) // 08:00
	d.Tick(ctx)
	if got := ch.sends.Load(); got != 1 {
		t.Fatalf("the first tick at/after the hour must send, got %d sends", got)
	}
}

// Hour is a LOCAL hour: at 03:30 UTC it is already 09:00 in Asia/Kolkata, so
// the Kolkata digester sends while the UTC one (same instant, same claim row)
// correctly stays quiet.
func TestDigest_TimezoneRespected(t *testing.T) {
	pool := digestTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Date(2026, 7, 11, 3, 30, 0, 0, time.UTC)}
	ch := &countingChannel{}
	c := pushCheck("t.digest.tz", SevHigh, 0)
	seedResult(t, pool, c.ID, StatusOK, clk.t)

	utcD := newTestDigester(pool, clk, time.UTC, 8, []Check{c}, ch)
	utcD.Tick(ctx)
	if got := ch.sends.Load(); got != 0 {
		t.Fatalf("03:30 UTC with Hour=8 in UTC must send nothing, got %d sends", got)
	}

	istD := newTestDigester(pool, clk, kolkata, 8, []Check{c}, ch)
	istD.Tick(ctx)
	if got := ch.sends.Load(); got != 1 {
		t.Fatalf("09:00 in Asia/Kolkata with Hour=8 must send, got %d sends", got)
	}
}

// Two replicas tick at the same instant; the atomic claim UPDATE arbitrates:
// exactly one send, no double digest.
func TestDigest_ConcurrentTicksSendExactlyOnce(t *testing.T) {
	pool := digestTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Date(2026, 7, 11, 9, 0, 0, 0, time.UTC)}
	ch := &countingChannel{}
	c := pushCheck("t.digest.race", SevHigh, 0)
	seedResult(t, pool, c.ID, StatusOK, clk.t)

	d1 := newTestDigester(pool, clk, time.UTC, 8, []Check{c}, ch)
	d2 := newTestDigester(pool, clk, time.UTC, 8, []Check{c}, ch)

	var wg sync.WaitGroup
	for _, d := range []*Digester{d1, d2} {
		wg.Add(1)
		go func(d *Digester) {
			defer wg.Done()
			d.Tick(ctx)
		}(d)
	}
	wg.Wait()

	if got := ch.sends.Load(); got != 1 {
		t.Fatalf("two concurrent ticks must produce exactly one digest, got %d sends", got)
	}
}

// ---------------------------------------------------------------------------
// The body, end to end through the pipe
// ---------------------------------------------------------------------------

// A red-but-snoozed check leaves ON FIRE / NEEDS YOU empty (the digest opens
// with the all-clear) yet still shows up under SNOOZED with its reason.
func TestDigest_BodyCarriesSnoozeReason(t *testing.T) {
	pool := digestTestPool(t)
	ctx := context.Background()
	clk := &clock{t: time.Date(2026, 7, 11, 9, 0, 0, 0, time.UTC)}
	ch := &countingChannel{}
	c := pushCheck("t.digest.snoozed", SevCritical, 0)
	d := newTestDigester(pool, clk, time.UTC, 8, []Check{c}, ch)

	seedResult(t, pool, c.ID, StatusRed, clk.t)
	until := clk.t.Add(2 * time.Hour)
	if _, err := pool.Exec(ctx,
		`UPDATE ops_check_results SET acked_until = $2, ack_reason = $3 WHERE check_id = $1`,
		c.ID, until, "vendor maintenance window"); err != nil {
		t.Fatalf("snoozing %s: %v", c.ID, err)
	}

	d.Tick(ctx)
	if got := ch.sends.Load(); got != 1 {
		t.Fatalf("expected exactly one digest, got %d sends", got)
	}
	body := ch.lastMsg().Body
	if !strings.Contains(body, "✓ nothing on fire") {
		t.Fatalf("a board with only a snoozed red must open with the all-clear, got:\n%s", body)
	}
	if !strings.Contains(body, "SNOOZED (1)") || !strings.Contains(body, "vendor maintenance window") {
		t.Fatalf("digest must list the snoozed check with its reason, got:\n%s", body)
	}
}

// ---------------------------------------------------------------------------
// BuildDigestBody: pure over BoardResponse
// ---------------------------------------------------------------------------

func TestBuildDigestBody_NothingOnFire(t *testing.T) {
	body := BuildDigestBody(BoardResponse{Lanes: []Lane{
		{Name: "ON FIRE"},
		{Name: "NEEDS YOU"},
		{Name: "CLOCKS"},
		{Name: "AUTOMATIONS", Count: 2, Alive: 2},
		{Name: "SNOOZED"},
		{Name: "GREEN", Count: 5, IDs: []string{"a", "b", "c", "d", "e"}},
	}})
	if !strings.HasPrefix(body, "✓ nothing on fire") {
		t.Fatalf("a clean board must open with the all-clear, got:\n%s", body)
	}
	for _, banned := range []string{"ON FIRE", "NEEDS YOU", "SNOOZED", "QUIET"} {
		if strings.Contains(body, banned) {
			t.Fatalf("empty sections must be omitted, found %q in:\n%s", banned, body)
		}
	}
}

func TestBuildDigestBody_SectionsInOrder(t *testing.T) {
	due := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	body := BuildDigestBody(BoardResponse{Lanes: []Lane{
		{Name: "ON FIRE", Count: 1, Cards: []Card{
			{Title: "SES send failures", Detail: "12% bounce rate"}}},
		{Name: "NEEDS YOU", Count: 1, Cards: []Card{
			{Title: "DLQ depth", Detail: "3 dead-lettered"}}},
		{Name: "CLOCKS", Count: 1, Cards: []Card{
			{Title: "Renew TLS cert", Detail: "expires soon", DueAt: &due}}},
		{Name: "AUTOMATIONS", Count: 3, Alive: 2, Stale: 1,
			StaleIDs: []string{"data.nightly-backup"}},
		{Name: "SNOOZED", Count: 1, Cards: []Card{
			{Title: "Vendor webhook lag", Detail: "p95 40s", AckReason: "vendor incident 4711"}}},
		{Name: "GREEN", Count: 1, IDs: []string{"x"}},
	}})

	if strings.Contains(body, "✓ nothing on fire") {
		t.Fatalf("a burning board must not claim the all-clear:\n%s", body)
	}

	wantInOrder := []string{
		"ON FIRE (1)",
		"SES send failures — 12% bounce rate",
		"NEEDS YOU (1)",
		"DLQ depth — 3 dead-lettered",
		"CLOCKS (30d)",
		"Renew TLS cert — expires soon",
		"QUIET (stale automations)",
		"data.nightly-backup",
		"SNOOZED (1)",
		"Vendor webhook lag — p95 40s",
		"vendor incident 4711",
	}
	pos := -1
	for _, want := range wantInOrder {
		i := strings.Index(body, want)
		if i < 0 {
			t.Fatalf("digest body missing %q:\n%s", want, body)
		}
		if i < pos {
			t.Fatalf("%q appears out of order:\n%s", want, body)
		}
		pos = i
	}
	if strings.Contains(body, "GREEN") {
		t.Fatalf("the digest must not list the GREEN lane:\n%s", body)
	}
}
