// SPDX-License-Identifier: AGPL-3.0-only
//
// rotator_test.go — unit coverage on the parser helpers that drive the
// rotator's catalog introspection. We intentionally don't spin up a
// real Postgres here; the rest of the worker is exercised in
// integration tests (deferred — see task notes) and the pure-Go
// helpers are the ones most likely to silently break on a PG version
// bump (the bound-expression formatting differs slightly between PG14
// and PG15).

package partition_rotator

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestParseBoundUpper(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want time.Time
		ok   bool
	}{
		{
			name: "pg14 monthly upper bound with +00 timezone",
			in:   "FOR VALUES FROM ('2024-06-01 00:00:00+00') TO ('2024-07-01 00:00:00+00')",
			want: time.Date(2024, 7, 1, 0, 0, 0, 0, time.UTC),
			ok:   true,
		},
		{
			name: "upper bound rendered in a half-hour time zone",
			in:   "FOR VALUES FROM ('2024-01-01 00:00:00+05:30') TO ('2024-02-01 00:00:00+05:30')",
			want: time.Date(2024, 1, 31, 18, 30, 0, 0, time.UTC),
			ok:   true,
		},
		{
			name: "date-only upper bound",
			in:   "FOR VALUES FROM ('2024-06-01') TO ('2024-07-01')",
			want: time.Date(2024, 7, 1, 0, 0, 0, 0, time.UTC),
			ok:   true,
		},
		{
			name: "minvalue lower, parseable upper",
			in:   "FOR VALUES FROM (MINVALUE) TO ('2024-07-01 00:00:00+00')",
			want: time.Date(2024, 7, 1, 0, 0, 0, 0, time.UTC),
			ok:   true,
		},
		{
			name: "no TO clause — unparseable",
			in:   "DEFAULT",
			want: time.Time{},
			ok:   false,
		},
		{
			name: "garbage upper",
			in:   "FOR VALUES FROM ('a') TO ('nonsense-bound')",
			want: time.Time{},
			ok:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseBoundUpper(tc.in)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v (got=%v)", ok, tc.ok, got)
			}
			if ok && !got.Equal(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestParseChildMonth(t *testing.T) {
	cases := []struct {
		name   string
		parent string
		child  string
		want   time.Time
		ok     bool
	}{
		{
			name:   "current convention",
			parent: "audit_log",
			child:  "audit_log_p2024_06",
			want:   time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC),
			ok:     true,
		},
		{
			name:   "legacy partition skipped",
			parent: "audit_log",
			child:  "audit_log_legacy",
			want:   time.Time{},
			ok:     false,
		},
		{
			name:   "wrong parent",
			parent: "audit_log",
			child:  "event_log_p2024_06",
			want:   time.Time{},
			ok:     false,
		},
		{
			name:   "wrong suffix shape",
			parent: "audit_log",
			child:  "audit_log_p202406",
			want:   time.Time{},
			ok:     false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseChildMonth(tc.parent, tc.child)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if ok && !got.Equal(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsAllowedTable(t *testing.T) {
	for _, in := range []string{
		"audit_log",
		"subscriber_events",
		"campaign_report_events",
		"event_log",
		"web_vitals_events",
	} {
		if !isAllowedTable(in) {
			t.Fatalf("expected %q to be allowed", in)
		}
	}
	for _, bad := range []string{
		"",
		"audit_log; DROP TABLE tenants",
		"tenants",
		"audit_log_legacy",
	} {
		if isAllowedTable(bad) {
			t.Fatalf("expected %q to be disallowed", bad)
		}
	}
}

func TestFirstOfMonth(t *testing.T) {
	in := time.Date(2024, 6, 17, 13, 45, 22, 0, time.UTC)
	got := firstOfMonth(in)
	want := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// A lost lock race is retried; anything else is returned at once.
func TestRetryTransientDDL(t *testing.T) {
	saved := ddlRetryDelays
	ddlRetryDelays = []time.Duration{0, 0, 0, 0}
	t.Cleanup(func() { ddlRetryDelays = saved })
	deadlock := fmt.Errorf("ensure audit_log: %w", &pgconn.PgError{Code: "40P01"})
	lockTimeout := &pgconn.PgError{Code: "55P03"}
	permanent := &pgconn.PgError{Code: "42501"}

	for _, tc := range []struct {
		name      string
		answers   []error
		wantCalls int
		wantErr   error
	}{
		{"succeeds after a deadlock and a lock timeout", []error{deadlock, lockTimeout, nil}, 3, nil},
		{"returns any other error at once", []error{permanent, nil}, 1, permanent},
		{"gives up after the schedule", []error{deadlock, deadlock, deadlock, deadlock, deadlock, nil}, 5, deadlock},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			err := retryTransientDDL(context.Background(), func() error {
				calls++
				return tc.answers[calls-1]
			})
			if calls != tc.wantCalls || !errors.Is(err, tc.wantErr) {
				t.Fatalf("calls=%d err=%v, want calls=%d err=%v", calls, err, tc.wantCalls, tc.wantErr)
			}
		})
	}

	t.Run("stops retrying when the context ends", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		calls := 0
		ddlRetryDelays = []time.Duration{time.Hour}
		err := retryTransientDDL(ctx, func() error { calls++; return deadlock })
		if calls != 1 || !errors.Is(err, deadlock) {
			t.Fatalf("calls=%d err=%v, want one call and the deadlock", calls, err)
		}
	})
}
