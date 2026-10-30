package zerocopy_triggers

// Worker-level unit tests. These exercise the dispatch decision tree
// (log-only / no-subscriber / fired / driver-error) against the
// in-package Driver seam — they do NOT touch Postgres. The Repo
// methods that hit the DB are exercised by the (DB-integration) tests
// in repo_test.go which run under POSTWAVE_TEST_DB.

import (
	"context"
	"errors"
	"testing"
	"time"
)

// stubDriver lets each test inject the rows that a hypothetical
// Snowflake / BigQuery driver would return.
type stubDriver struct {
	rows []DriverRow
	err  error
}

func (d *stubDriver) Poll(_ context.Context, _ Trigger, _ int) ([]DriverRow, error) {
	return d.rows, d.err
}

// fakeRepo replaces *Repo for these tests. It records the calls the
// worker makes so we can assert against them without standing up a DB.
type fakeRepo struct {
	resolveOut map[string]string // profileKey -> subscriberID ("" = unresolved)
	resolveErr error
	fires      []Fire
	ticks      []tickArgs
}

type tickArgs struct {
	cursor     string
	firedRows  int
	runErr     string
	occurredAt time.Time
}

func (f *fakeRepo) ResolveSubscriberID(_ context.Context, _, key string) (string, error) {
	if f.resolveErr != nil {
		return "", f.resolveErr
	}
	return f.resolveOut[key], nil
}

func (f *fakeRepo) RecordFire(_ context.Context, _ string, in Fire) (int64, error) {
	f.fires = append(f.fires, in)
	return int64(len(f.fires)), nil
}

func (f *fakeRepo) RecordTick(_ context.Context, _, _, cursor string, fired int, runErr string, t time.Time) error {
	f.ticks = append(f.ticks, tickArgs{cursor: cursor, firedRows: fired, runErr: runErr, occurredAt: t})
	return nil
}

// fakeEnq records EnqueueRun calls and returns synthetic flow_run ids.
type fakeEnq struct {
	calls  []EnqueueRequest
	err    error
	nextID int
}

func (e *fakeEnq) EnqueueRun(_ context.Context, _ string, in EnqueueRequest) (string, error) {
	e.calls = append(e.calls, in)
	if e.err != nil {
		return "", e.err
	}
	e.nextID++
	return "run-" + itoa(e.nextID), nil
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	buf := [20]byte{}
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}

// pollOnceWithRepo covers the ROW-DECISION half of PollOnce against a
// *fakeRepo: consent-gate filtering, subscriber resolution, and the mapping
// from those to a fire status. Production PollOnce takes *Repo (the Postgres
// type), so this cannot call it directly.
//
// It is deliberately NOT a full mirror any more, and the previous "keep this in
// lock-step with PollOnce" instruction has been removed because it was already
// false and could only become more so. PollOnce's claim/enqueueing/cursor
// semantics have no representation here — reimplementing them would mean two
// hand-copies of the rule that decides whether a subscriber is enrolled twice,
// which is the drift this package's own receipts exist to prevent.
//
// Those semantics are covered end to end, against a real database, in
// watermark_db_test.go and receipt_db_test.go. A test that agrees with a
// hand-copy certifies the copy, not the behaviour.
func pollOnceWithRepo(
	ctx context.Context,
	r *fakeRepo,
	enq FlowRunEnqueuer,
	tenantID string,
	t *Trigger,
	driver Driver,
	now time.Time,
) []Fire {
	rows, err := driver.Poll(ctx, *t, t.MaxRowsPerTick)
	if err != nil {
		_ = r.RecordTick(ctx, tenantID, t.ID, "", 0, err.Error(), now)
		return nil
	}
	fires := make([]Fire, 0, len(rows))
	maxCursor := t.LastSeenCursor
	for _, row := range rows {
		fire := Fire{TriggerID: t.ID, CursorValue: row.CursorValue, ProfileKey: row.ProfileKey, FiredAt: now, Status: "fired"}
		if row.CursorValue > maxCursor {
			maxCursor = row.CursorValue
		}
		subID, rerr := r.ResolveSubscriberID(ctx, tenantID, row.ProfileKey)
		if rerr != nil {
			fire.Status = "error"
			fire.Error = rerr.Error()
			_, _ = r.RecordFire(ctx, tenantID, fire)
			fires = append(fires, fire)
			continue
		}
		fire.SubscriberID = subID
		switch {
		case t.JourneyID == "":
			fire.Status = "skipped_log_only"
		case subID == "":
			fire.Status = "matched_no_subscriber"
		default:
			if enq == nil {
				fire.Status = "skipped_log_only"
			} else {
				id, eerr := enq.EnqueueRun(ctx, tenantID, EnqueueRequest{
					FlowID: t.JourneyID, SubscriberID: subID,
					TriggerEventName: "zerocopy:" + t.Name, ScheduledAt: now,
				})
				if eerr != nil {
					fire.Status = "error"
					fire.Error = eerr.Error()
				} else {
					fire.FlowRunID = id
					fire.Status = "fired"
				}
			}
		}
		_, _ = r.RecordFire(ctx, tenantID, fire)
		fires = append(fires, fire)
	}
	firedCount := 0
	for _, f := range fires {
		if f.Status == "fired" {
			firedCount++
		}
	}
	_ = r.RecordTick(ctx, tenantID, t.ID, maxCursor, firedCount, "", now)
	return fires
}

func TestPoll_FiresEnqueuesPerResolvedRow(t *testing.T) {
	now := time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC)
	trig := &Trigger{
		ID:               "t1",
		Name:             "VIP signups",
		JourneyID:        "j1",
		Status:           "active",
		Provider:         "noop",
		MaxRowsPerTick:   100,
		LastSeenCursor:   "2026-06-01T00:00:00Z",
		ProfileKeyColumn: "email",
		CursorColumn:     "updated_at",
	}
	driver := &stubDriver{rows: []DriverRow{
		{CursorValue: "2026-06-02T10:00:00Z", ProfileKey: "a@example.com"},
		{CursorValue: "2026-06-02T11:00:00Z", ProfileKey: "b@example.com"},
		{CursorValue: "2026-06-02T12:00:00Z", ProfileKey: "ghost@example.com"},
	}}
	r := &fakeRepo{
		resolveOut: map[string]string{"a@example.com": "sub-a", "b@example.com": "sub-b"},
	}
	enq := &fakeEnq{}

	fires := pollOnceWithRepo(context.Background(), r, enq, "tenant-x", trig, driver, now)

	if len(fires) != 3 {
		t.Fatalf("want 3 fires, got %d", len(fires))
	}
	if fires[0].Status != "fired" || fires[1].Status != "fired" {
		t.Fatalf("first two rows should be fired, got %q %q", fires[0].Status, fires[1].Status)
	}
	if fires[2].Status != "matched_no_subscriber" {
		t.Fatalf("ghost row should be matched_no_subscriber, got %q", fires[2].Status)
	}
	if len(enq.calls) != 2 {
		t.Fatalf("enqueuer should have been called twice, got %d", len(enq.calls))
	}
	if enq.calls[0].TriggerEventName != "zerocopy:VIP signups" {
		t.Fatalf("trigger_event_name shape wrong: %q", enq.calls[0].TriggerEventName)
	}
	if len(r.ticks) != 1 || r.ticks[0].cursor != "2026-06-02T12:00:00Z" {
		t.Fatalf("cursor should advance to max(rows) = 2026-06-02T12:00:00Z, got %+v", r.ticks)
	}
	if r.ticks[0].firedRows != 2 {
		t.Fatalf("firedRows should be 2, got %d", r.ticks[0].firedRows)
	}
}

func TestPoll_LogOnlyWhenJourneyMissing(t *testing.T) {
	now := time.Now()
	trig := &Trigger{ID: "t1", Status: "active", Provider: "noop", MaxRowsPerTick: 10}
	driver := &stubDriver{rows: []DriverRow{{CursorValue: "c1", ProfileKey: "a@example.com"}}}
	r := &fakeRepo{resolveOut: map[string]string{"a@example.com": "sub-a"}}
	enq := &fakeEnq{}

	fires := pollOnceWithRepo(context.Background(), r, enq, "tenant-x", trig, driver, now)

	if len(fires) != 1 || fires[0].Status != "skipped_log_only" {
		t.Fatalf("want one skipped_log_only fire, got %+v", fires)
	}
	if len(enq.calls) != 0 {
		t.Fatalf("enqueuer should not be called in log-only mode, got %d calls", len(enq.calls))
	}
}

func TestPoll_DriverErrorBumpsTickFailure(t *testing.T) {
	now := time.Now()
	trig := &Trigger{ID: "t1", JourneyID: "j1", Status: "active", Provider: "noop", MaxRowsPerTick: 10}
	driver := &stubDriver{err: errors.New("snowflake: timeout")}
	r := &fakeRepo{}

	_ = pollOnceWithRepo(context.Background(), r, nil, "tenant-x", trig, driver, now)

	if len(r.ticks) != 1 {
		t.Fatalf("want 1 tick recorded, got %d", len(r.ticks))
	}
	if r.ticks[0].runErr == "" {
		t.Fatalf("runErr should be set on driver failure, got empty")
	}
}

func TestValidateTrigger(t *testing.T) {
	cases := []struct {
		name    string
		in      Trigger
		wantErr bool
	}{
		{name: "empty name fails", in: Trigger{}, wantErr: true},
		{name: "bad provider fails", in: Trigger{Name: "x", Provider: "mysql"}, wantErr: true},
		{
			name: "active needs query",
			in:   Trigger{Name: "x", Status: "active", PollingIntervalSeconds: 60, MaxRowsPerTick: 100},
			// query empty in active -> error
			wantErr: true,
		},
		{
			name: "happy path", in: Trigger{
				Name: "x", Status: "draft", Provider: "snowflake",
				PollingIntervalSeconds: 60, MaxRowsPerTick: 100,
				Query: "SELECT 1", CursorColumn: "updated_at",
			}, wantErr: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := ValidateTrigger(c.in)
			if v.Valid == c.wantErr {
				t.Fatalf("Valid=%v errors=%v warnings=%v", v.Valid, v.Errors, v.Warnings)
			}
		})
	}
}
