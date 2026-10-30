package intelligent_retry

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type retryClaimRows struct {
	pgx.Rows
	events []Event
	index  int
	err    error
}

func (rows *retryClaimRows) Close() {}

func (rows *retryClaimRows) Err() error { return rows.err }

func (rows *retryClaimRows) Next() bool {
	if rows.index >= len(rows.events) {
		return false
	}
	rows.index++
	return true
}

func (rows *retryClaimRows) Scan(dest ...any) error {
	if rows.index == 0 || rows.index > len(rows.events) {
		return errors.New("retry claim scan called without a current row")
	}
	return retryEventRow{event: rows.events[rows.index-1]}.Scan(dest...)
}

type retryClaimTx struct {
	pgx.Tx
	candidate Event
	clock     time.Time
	clockSQL  string
	execSQL   string
	querySQL  string
	queryArgs []any
	commits   int
	rollbacks int
}

type retryClockRow struct{ value time.Time }

func (row retryClockRow) Scan(dest ...any) error {
	if len(dest) != 1 {
		return errors.New("unexpected retry clock scan width")
	}
	*(dest[0].(*time.Time)) = row.value
	return nil
}

func (tx *retryClaimTx) QueryRow(_ context.Context, query string, _ ...any) pgx.Row {
	tx.clockSQL = query
	return retryClockRow{value: tx.clock}
}

type retryAdmissionTx struct {
	pgx.Tx
	execSQL string
	args    []any
	err     error
	commits int
}

type retryAdmissionRows struct {
	pgx.Rows
	emails []string
	index  int
}

func (rows *retryAdmissionRows) Close()     {}
func (rows *retryAdmissionRows) Err() error { return nil }
func (rows *retryAdmissionRows) Next() bool {
	if rows.index >= len(rows.emails) {
		return false
	}
	rows.index++
	return true
}
func (rows *retryAdmissionRows) Scan(dest ...any) error {
	if rows.index == 0 || rows.index > len(rows.emails) || len(dest) != 1 {
		return errors.New("unexpected retry admission scan")
	}
	*(dest[0].(*string)) = rows.emails[rows.index-1]
	return nil
}

func (tx *retryAdmissionTx) Exec(_ context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	tx.execSQL = query
	tx.args = append([]any(nil), args...)
	if tx.err != nil {
		return pgconn.CommandTag{}, tx.err
	}
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (tx *retryAdmissionTx) Query(_ context.Context, _ string, args ...any) (pgx.Rows, error) {
	if tx.err != nil {
		return nil, tx.err
	}
	emails, _ := args[1].([]string)
	return &retryAdmissionRows{emails: append([]string(nil), emails...)}, nil
}

func (tx *retryAdmissionTx) Commit(context.Context) error {
	tx.commits++
	return nil
}

func (tx *retryClaimTx) Exec(_ context.Context, query string, _ ...any) (pgconn.CommandTag, error) {
	tx.execSQL = query
	return pgconn.NewCommandTag("SELECT 1"), nil
}

func (tx *retryClaimTx) Query(_ context.Context, query string, args ...any) (pgx.Rows, error) {
	tx.querySQL = query
	tx.queryArgs = append([]any(nil), args...)
	claimNow := args[1].(time.Time)
	leaseCutoff := args[2].(time.Time)
	events := []Event{}
	if tx.candidate.Status == "retrying" && !tx.candidate.UpdatedAt.After(leaseCutoff) {
		claimed := tx.candidate
		claimed.Status = "retrying"
		claimed.Attempts++
		claimed.UpdatedAt = claimNow
		events = append(events, claimed)
	}
	return &retryClaimRows{events: events}, nil
}

func (tx *retryClaimTx) Commit(context.Context) error {
	tx.commits++
	return nil
}

func (tx *retryClaimTx) Rollback(context.Context) error {
	tx.rollbacks++
	return nil
}

func TestRetryClaimReclaimsOnlyExpiredLeaseAtExactBoundary(t *testing.T) {
	claimedAt := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	candidate := retryEventFixture("retrying", claimedAt, claimedAt)
	for _, tc := range []struct {
		name      string
		now       time.Time
		wantCount int
	}{
		{name: "active lease", now: claimedAt.Add(RetryClaimLeaseDuration - time.Microsecond)},
		{name: "exactly expired lease", now: claimedAt.Add(RetryClaimLeaseDuration), wantCount: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := &retryClaimTx{candidate: candidate}
			queue := &Queue{
				beginWorker: func(context.Context) (pgx.Tx, error) { return tx, nil },
				now:         func() time.Time { return tc.now },
			}
			events, err := queue.claimDue(context.Background(), 7)
			if err != nil {
				t.Fatalf("claim due: %v", err)
			}
			if len(events) != tc.wantCount {
				t.Fatalf("claimed=%d, want %d", len(events), tc.wantCount)
			}
			if tx.commits != 1 || !strings.Contains(tx.execSQL, "app.intelligent_retry_worker") {
				t.Fatalf("worker scope exec=%q commits=%d", tx.execSQL, tx.commits)
			}
			if len(tx.queryArgs) != 3 || tx.queryArgs[0] != 7 || tx.queryArgs[1] != tc.now || tx.queryArgs[2] != tc.now.Add(-RetryClaimLeaseDuration) {
				t.Fatalf("claim args=%#v, want limit/now/cutoff", tx.queryArgs)
			}
			for _, fragment := range []string{
				"status = 'retrying' AND updated_at <= $3",
				"ORDER BY (status = 'retrying') DESC",
				"FOR UPDATE SKIP LOCKED",
				"updated_at = $2",
			} {
				if !strings.Contains(tx.querySQL, fragment) {
					t.Errorf("claim query missing %q", fragment)
				}
			}
			if tc.wantCount == 1 && (!events[0].UpdatedAt.Equal(tc.now) || events[0].Attempts != candidate.Attempts+1) {
				t.Fatalf("reclaimed event=%+v, want renewed lease and incremented attempt", events[0])
			}
		})
	}
}

func TestRetryClaimUsesDatabaseLeaseClockInProductionPath(t *testing.T) {
	databaseNow := time.Date(2026, time.August, 30, 14, 0, 0, 0, time.UTC)
	tx := &retryClaimTx{clock: databaseNow}
	queue := &Queue{beginWorker: func(context.Context) (pgx.Tx, error) { return tx, nil }}
	if _, err := queue.claimDue(context.Background(), 1); err != nil {
		t.Fatalf("claim with database clock: %v", err)
	}
	if !strings.Contains(tx.clockSQL, "clock_timestamp()") {
		t.Fatalf("worker lease clock query=%q", tx.clockSQL)
	}
	if len(tx.queryArgs) != 3 || tx.queryArgs[1] != databaseNow || tx.queryArgs[2] != databaseNow.Add(-RetryClaimLeaseDuration) {
		t.Fatalf("database lease args=%#v", tx.queryArgs)
	}
}

func TestFrequencyRetryTxInsertionUsesCallerTransaction(t *testing.T) {
	retryAfter := time.Date(2026, time.August, 30, 13, 0, 0, 0, time.UTC)
	tx := &retryAdmissionTx{}
	queue := &Queue{}
	err := queue.EnqueueFrequencySkippedTx(
		context.Background(), tx, "tenant-1", "campaign-1",
		[]string{"held@example.test"},
		[]Breakdown{{RuleID: "cap-1", RuleLabel: "Daily", Skipped: 1}},
		retryAfter,
	)
	if err != nil {
		t.Fatalf("transactional retry insert: %v", err)
	}
	if tx.commits != 0 {
		t.Fatalf("transactional retry insert committed caller transaction %d times", tx.commits)
	}
	if !strings.Contains(tx.execSQL, "INSERT INTO intelligent_retry_events") || len(tx.args) != 5 {
		t.Fatalf("retry insert SQL=%q args=%#v", tx.execSQL, tx.args)
	}
	if tx.args[0] != "tenant-1" || tx.args[1] != "campaign-1" || tx.args[2] != retryAfter {
		t.Fatalf("retry insert owner/revision args=%#v", tx.args)
	}
	if got, ok := tx.args[4].([]string); !ok || len(got) != 1 || got[0] != "held@example.test" {
		t.Fatalf("retry insert emails=%#v", tx.args[4])
	}

	sentinel := errors.New("retry insert unavailable")
	failing := &retryAdmissionTx{err: sentinel}
	if err := queue.EnqueueFrequencySkippedTx(
		context.Background(), failing, "tenant-1", "campaign-1",
		[]string{"held@example.test"}, nil, retryAfter,
	); !errors.Is(err, sentinel) {
		t.Fatalf("retry insert error=%v, want sentinel", err)
	}
	if failing.commits != 0 {
		t.Fatalf("failed transactional retry insert committed caller transaction")
	}
}
