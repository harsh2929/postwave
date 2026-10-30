// SPDX-License-Identifier: MIT

package klaviyo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// Compile-time guard: Klaviyo must keep satisfying the delta-sync contract.
var _ adapter.SourceEventAdapter = New()

func TestKlaviyoListSourceEvents(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		_, _ = w.Write([]byte(`{
		  "data": [
		    {"id":"P1","type":"profile","attributes":{"email":"a@b.com","updated":"2026-02-02T10:00:00+00:00"}},
		    {"id":"P2","type":"profile","attributes":{"email":"c@d.com","updated":"2026-02-03T10:00:00+00:00"}}
		  ],
		  "links": {"next":"https://a.klaviyo.com/api/profiles?page[cursor]=NEXTCUR"}
		}`))
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	sess := boundTestSession()
	a.snapshots[AccountFingerprint(sess)] = sourceEventTestSnapshot("P1", "P2")
	since := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	batch, err := a.ListSourceEvents(context.Background(), sess, since, "", 100)
	if err != nil {
		t.Fatalf("ListSourceEvents: %v", err)
	}
	if len(batch.Events) != 2 {
		t.Fatalf("want 2 events, got %d", len(batch.Events))
	}
	e := batch.Events[0]
	if e.SourceID != "klaviyo:profile:P1:2026-02-02T10:00:00Z" || e.Action != "upsert" || e.ResourceType != "subscriber" {
		t.Fatalf("event0 wrong: %+v", e)
	}
	if e.Subscriber == nil || e.Subscriber.Email != "a@b.com" {
		t.Fatalf("subscriber not mapped: %+v", e.Subscriber)
	}
	if e.Payload["profile_id"] != "P1" || e.Payload["email"] != "a@b.com" || e.Payload["updated"] != "2026-02-02T10:00:00+00:00" || e.Payload["event_type"] != "profile_changed" || e.Payload["api_revision"] != apiRevision {
		t.Fatalf("payload not preserved: %+v", e.Payload)
	}
	if e.SourcePlatform != canonical.SourceKlaviyo {
		t.Fatalf("source platform: %v", e.SourcePlatform)
	}
	// High-watermark = newest updated time.
	if !batch.HighWatermark.Equal(time.Date(2026, 2, 3, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("high watermark wrong: %v", batch.HighWatermark)
	}
	// Cursor extracted from the next link.
	if batch.NextCursor != "NEXTCUR" {
		t.Fatalf("next cursor wrong: %q", batch.NextCursor)
	}
	// First page sets the incremental filter + sort.
	if !strings.Contains(gotPath, "greater-than") || !strings.Contains(gotPath, "sort=updated") {
		t.Fatalf("incremental filter/sort missing: %s", gotPath)
	}
}

func TestKlaviyoListSourceEvents_DistinctSourceIDsForRepeatedProfile(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{
		  "data": [
		    {"id":"P1","type":"profile","attributes":{"email":"a@b.com","updated":"2026-02-02T10:00:00Z"}},
		    {"id":"P1","type":"profile","attributes":{"email":"a@b.com","updated":"2026-02-02T10:05:00Z"}}
		  ],
		  "links": {}
		}`))
	}))
	defer srv.Close()

	a := New()
	a.BaseURL = srv.URL
	sess := boundTestSession()
	a.snapshots[AccountFingerprint(sess)] = sourceEventTestSnapshot("P1")
	batch, err := a.ListSourceEvents(context.Background(), sess, time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC), "", 100)
	if err != nil {
		t.Fatalf("ListSourceEvents: %v", err)
	}
	if len(batch.Events) != 2 {
		t.Fatalf("want 2 events, got %d", len(batch.Events))
	}
	if batch.Events[0].SourceID == batch.Events[1].SourceID {
		t.Fatalf("repeated profile changes collapsed into same source id: %+v", batch.Events)
	}
	if batch.Events[0].SourceID != "klaviyo:profile:P1:2026-02-02T10:00:00Z" || batch.Events[1].SourceID != "klaviyo:profile:P1:2026-02-02T10:05:00Z" {
		t.Fatalf("source ids=%q %q", batch.Events[0].SourceID, batch.Events[1].SourceID)
	}
}

func TestKlaviyoListSourceEvents_CursorSkipsFilter(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		_, _ = w.Write([]byte(`{"data":[],"links":{}}`))
	}))
	defer srv.Close()
	a := New()
	a.BaseURL = srv.URL
	sess := boundTestSession()
	a.snapshots[AccountFingerprint(sess)] = sourceEventTestSnapshot()
	_, err := a.ListSourceEvents(context.Background(), sess, time.Now(), "CUR123", 100)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotPath, "page%5Bcursor%5D=CUR123") && !strings.Contains(gotPath, "page[cursor]=CUR123") {
		t.Fatalf("cursor not forwarded: %s", gotPath)
	}
	// On a cursor page the filter must NOT be re-sent (the cursor carries it).
	if strings.Contains(gotPath, "greater-than") {
		t.Fatalf("filter wrongly re-sent on cursor page: %s", gotPath)
	}
}

func TestKlaviyoListSourceEvents_EmailLessPagesAdvanceProviderWatermark(t *testing.T) {
	tests := []struct {
		name       string
		nextLink   string
		wantCursor string
	}{
		{
			name:       "nonterminal filtered page",
			nextLink:   `,"next":"https://a.klaviyo.com/api/profiles?page[cursor]=NEXT-NON-EMAIL"`,
			wantCursor: "NEXT-NON-EMAIL",
		},
		{name: "terminal filtered page"},
	}
	wantWatermark := time.Date(2026, 2, 4, 10, 30, 0, 0, time.UTC)
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{
				  "data":[{"id":"SMS_ONLY","type":"profile","attributes":{"phone_number":"+15551234567","updated":"2026-02-04T10:30:00Z"}}],
				  "links":{"self":"https://a.klaviyo.com/api/profiles"` + tc.nextLink + `}
				}`))
			}))
			defer srv.Close()

			a := New()
			a.BaseURL = srv.URL
			batch, err := a.ListSourceEvents(context.Background(), boundTestSession(), time.Time{}, "", 100)
			if err != nil {
				t.Fatalf("ListSourceEvents: %v", err)
			}
			if len(batch.Events) != 0 {
				t.Fatalf("events = %+v, want no email-subscriber events", batch.Events)
			}
			if batch.NextCursor != tc.wantCursor {
				t.Fatalf("next cursor = %q, want %q", batch.NextCursor, tc.wantCursor)
			}
			if !batch.HighWatermark.Equal(wantWatermark) {
				t.Fatalf("high watermark = %v, want %v", batch.HighWatermark, wantWatermark)
			}
		})
	}
}

func sourceEventTestSnapshot(ids ...string) *klaviyoSnapshot {
	snapshot := &klaviyoSnapshot{
		EmailProfileIDs: map[string]struct{}{},
		AllProfileIDs:   map[string]struct{}{},
		TagsByProfile:   map[string][]string{},
	}
	for _, id := range ids {
		snapshot.EmailProfileIDs[id] = struct{}{}
		snapshot.AllProfileIDs[id] = struct{}{}
	}
	return snapshot
}

func TestParseKlaviyoTime(t *testing.T) {
	if got := parseKlaviyoTime("2026-02-02T10:00:00Z"); !got.Equal(time.Date(2026, 2, 2, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("rfc3339 parse: %v", got)
	}
	if got := parseKlaviyoTime("garbage"); !got.IsZero() {
		t.Fatalf("bad input should be zero: %v", got)
	}
}
