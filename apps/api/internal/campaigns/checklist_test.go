package campaigns

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeAudienceCounter is a hand-rolled mock — keeps the unit test
// hermetic (no DB) and lets each case assert on the exact path the
// gate takes for the (list_id, segment_id) pair under test.
type fakeAudienceCounter struct {
	listCount    int64
	listErr      error
	segCount     int64
	segErr       error
	listCalls    int
	segCalls     int
	lastTenantID string
	lastListID   string
	lastSegID    string
}

func (f *fakeAudienceCounter) CountListAudience(_ context.Context, tenantID, listID string) (int64, error) {
	f.listCalls++
	f.lastTenantID = tenantID
	f.lastListID = listID
	return f.listCount, f.listErr
}

func (f *fakeAudienceCounter) CountSegmentAudience(_ context.Context, tenantID, segmentID string) (int64, error) {
	f.segCalls++
	f.lastTenantID = tenantID
	f.lastSegID = segmentID
	return f.segCount, f.segErr
}

// No list and no segment is the whole-workspace audience queue-fill and
// send-preview both send to; it is not "no audience". A counter can size a list
// or a segment but not a workspace, so without a database pool the gate cannot
// count it and says so — it must neither fail the send outright (the old
// "No audience selected") nor ask the counter a question it cannot answer.
// The pooled behaviour is proven against the real resolver in
// audience_authoring_db_test.go.
func TestCheckRecipients_WorkspaceAudienceIsNotCountedWithoutAPool(t *testing.T) {
	fake := &fakeAudienceCounter{listCount: 5, segCount: 5}
	r := &Repo{AudienceCounter: fake}
	c := &Campaign{} // no list_id, no segment_id

	got := r.checkRecipients(context.Background(), "tenant-1", c)

	if got.Status != CheckWarn {
		t.Fatalf("status: want %q, got %q (detail=%q)", CheckWarn, got.Status, got.Detail)
	}
	if fake.listCalls != 0 || fake.segCalls != 0 {
		t.Fatalf("workspace audience consulted a list/segment counter: list=%d segment=%d",
			fake.listCalls, fake.segCalls)
	}
}

func TestCheckRecipients_ListZeroFails(t *testing.T) {
	fake := &fakeAudienceCounter{listCount: 0}
	r := &Repo{AudienceCounter: fake}
	c := &Campaign{ListID: "00000000-0000-0000-0000-000000000001"}

	got := r.checkRecipients(context.Background(), "tenant-1", c)

	if got.Status != CheckFail {
		t.Fatalf("status: want %q, got %q (detail=%q)", CheckFail, got.Status, got.Detail)
	}
	if got.Detail != "Audience has zero subscribers" {
		t.Fatalf("detail: want %q, got %q", "Audience has zero subscribers", got.Detail)
	}
	if fake.listCalls != 1 {
		t.Fatalf("expected 1 list call, got %d", fake.listCalls)
	}
	if fake.segCalls != 0 {
		t.Fatalf("expected 0 segment calls (list path), got %d", fake.segCalls)
	}
	if fake.lastListID != c.ListID {
		t.Fatalf("list id: want %q, got %q", c.ListID, fake.lastListID)
	}
}

func TestCheckRecipients_ListPositivePasses(t *testing.T) {
	fake := &fakeAudienceCounter{listCount: 1234}
	r := &Repo{AudienceCounter: fake}
	c := &Campaign{ListID: "list-abc"}

	got := r.checkRecipients(context.Background(), "tenant-1", c)

	if got.Status != CheckPass {
		t.Fatalf("status: want %q, got %q (detail=%q)", CheckPass, got.Status, got.Detail)
	}
	if got.Detail != "1234 recipients" {
		t.Fatalf("detail: want %q, got %q", "1234 recipients", got.Detail)
	}
}

func TestCheckRecipients_SegmentPositivePasses(t *testing.T) {
	fake := &fakeAudienceCounter{segCount: 42}
	r := &Repo{AudienceCounter: fake}
	c := &Campaign{SegmentID: "seg-1"}

	got := r.checkRecipients(context.Background(), "tenant-1", c)

	if got.Status != CheckPass {
		t.Fatalf("status: want %q, got %q (detail=%q)", CheckPass, got.Status, got.Detail)
	}
	if got.Detail != "42 recipients" {
		t.Fatalf("detail: want %q, got %q", "42 recipients", got.Detail)
	}
	if fake.segCalls != 1 || fake.lastSegID != "seg-1" {
		t.Fatalf("segment counter not called as expected: calls=%d, last_seg_id=%q",
			fake.segCalls, fake.lastSegID)
	}
	if fake.listCalls != 0 {
		t.Fatalf("expected 0 list calls (segment path), got %d", fake.listCalls)
	}
}

// A campaign with both audience sources has no defined union/intersection
// contract. The checklist must fail before consulting either counter, matching
// queue-fill's fail-closed resolver.
func TestCheckRecipients_BothSetFailsClosed(t *testing.T) {
	fake := &fakeAudienceCounter{listCount: 7, segCount: 99}
	r := &Repo{AudienceCounter: fake}
	c := &Campaign{ListID: "list-1", SegmentID: "seg-1"}

	got := r.checkRecipients(context.Background(), "tenant-1", c)

	if got.Status != CheckFail {
		t.Fatalf("status: want %q, got %q", CheckFail, got.Status)
	}
	// Rendered verbatim by every client, so it is written for a person, not
	// the sentinel's developer text ("list_id and segment_id").
	if strings.Contains(got.Detail, "_id") || !strings.Contains(got.Detail, "list") ||
		!strings.Contains(got.Detail, "segment") {
		t.Fatalf("detail %q does not tell the operator to choose one list or one segment", got.Detail)
	}
	if fake.listCalls != 0 || fake.segCalls != 0 {
		t.Fatalf("mixed audience consulted counters: list=%d segment=%d", fake.listCalls, fake.segCalls)
	}
}

// An evaluator failure fails the gate closed, and the detail every client
// renders verbatim must not be the raw error: that text names tables, SQL and
// AST internals ("audience: compile activation population: segments: decode
// ast node: json: unknown field ...") and gives the reader nothing to act on.
func TestCheckRecipients_CounterErrorFailsClosed(t *testing.T) {
	const rawCause = "pq: relation segment_members does not exist"
	for _, tc := range []struct {
		name     string
		campaign *Campaign
		counter  *fakeAudienceCounter
		mentions string
	}{
		{"segment", &Campaign{SegmentID: "seg-1"}, &fakeAudienceCounter{segErr: errors.New(rawCause)}, "segment"},
		{"list", &Campaign{ListID: "16"}, &fakeAudienceCounter{listErr: errors.New(rawCause)}, "verified"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &Repo{AudienceCounter: tc.counter}

			got := r.checkRecipients(context.Background(), "tenant-1", tc.campaign)

			if got.Status != CheckFail {
				t.Fatalf("status: want %q, got %q (detail=%q)", CheckFail, got.Status, got.Detail)
			}
			if strings.Contains(got.Detail, rawCause) || strings.Contains(got.Detail, "pq:") {
				t.Fatalf("detail leaks the raw evaluator error: %q", got.Detail)
			}
			if !strings.Contains(got.Detail, tc.mentions) {
				t.Fatalf("detail %q does not say what could not be verified", got.Detail)
			}
		})
	}
}

// The known resolution failures each tell the operator what to do next.
func TestCheckRecipients_KnownAudienceFailuresAreActionable(t *testing.T) {
	for _, tc := range []struct {
		err      error
		mentions string
	}{
		{ErrAudienceListNotFound, "Choose another list or segment"},
		{ErrSegmentNotFound, "Choose another list or segment"},
		{ErrFrozenAudienceNotFound, "Duplicate the campaign"},
	} {
		r := &Repo{AudienceCounter: &fakeAudienceCounter{listErr: tc.err}}
		got := r.checkRecipients(context.Background(), "tenant-1", &Campaign{ListID: "16"})
		if got.Status != CheckFail || !strings.Contains(got.Detail, tc.mentions) {
			t.Fatalf("%v: got %q %q, want a failing check that says %q",
				tc.err, got.Status, got.Detail, tc.mentions)
		}
	}
}

// Sanity check the legacy fallback path: a nil AudienceCounter should
// still produce the prior behaviour (hint-based fail when the cache
// says zero) so older test rigs keep working.
func TestCheckRecipients_NilCounterFallsBackToHint(t *testing.T) {
	r := &Repo{AudienceCounter: nil}
	c := &Campaign{
		SegmentID:        "seg-1",
		TrackingSettings: map[string]any{"recipient_count": float64(0)},
	}

	got := r.checkRecipients(context.Background(), "tenant-1", c)

	if got.Status != CheckFail {
		t.Fatalf("status: want %q, got %q", CheckFail, got.Status)
	}
}
