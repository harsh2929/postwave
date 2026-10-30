// SPDX-License-Identifier: MIT

package activecampaign

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

func TestActiveCampaignProviderDateBoundsAreConservativeAndDateOnly(t *testing.T) {
	lower := mustParseTime(t, "2026-05-12T09:59:59Z")
	upper := mustParseTime(t, "2026-05-12T12:00:00Z")
	if got := activeCampaignProviderUpdatedAfter(lower); got != "2026-05-11" {
		t.Fatalf("updated_after = %q, want 2026-05-11", got)
	}
	if got := activeCampaignProviderUpdatedBefore(upper); got != "2026-05-13" {
		t.Fatalf("updated_before = %q, want 2026-05-13", got)
	}
	if got := activeCampaignProviderUpdatedAfter(time.Time{}); got != "" {
		t.Fatalf("initial replay updated_after = %q, want empty", got)
	}
}

func TestActiveCampaignDeltaTimestampWindowIncludesExactEdges(t *testing.T) {
	lower := mustParseTime(t, "2026-05-12T09:59:59Z")
	upper := mustParseTime(t, "2026-05-12T12:00:00Z")
	for _, occurred := range []time.Time{lower, upper} {
		if !activeCampaignDeltaTimestampInWindow(occurred, lower, upper) {
			t.Fatalf("exact boundary %s was excluded", occurred.Format(time.RFC3339Nano))
		}
	}
	for _, occurred := range []time.Time{lower.Add(-time.Nanosecond), upper.Add(time.Nanosecond)} {
		if activeCampaignDeltaTimestampInWindow(occurred, lower, upper) {
			t.Fatalf("out-of-window timestamp %s was included", occurred.Format(time.RFC3339Nano))
		}
	}
}

func TestListSourceEventsInternallyAdvancesPastDateFalsePositivePage(t *testing.T) {
	var seenIDGreater []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			if got := r.URL.Query().Get("filters[updated_after]"); got != "2026-05-11" {
				t.Fatalf("updated_after = %q", got)
			}
			if got := r.URL.Query().Get("filters[updated_before]"); got != "2026-05-13" {
				t.Fatalf("updated_before = %q", got)
			}
			idGreater := r.URL.Query().Get("id_greater")
			seenIDGreater = append(seenIDGreater, idGreater)
			switch idGreater {
			case "":
				writeJSON(t, w, map[string]any{
					"contacts": []any{map[string]any{"id": "1", "email": "stale@example.com", "udate": "2026-05-12T09:59:58Z"}},
					"meta":     map[string]any{"total": 2},
				})
			case "1":
				writeJSON(t, w, map[string]any{
					"contacts": []any{map[string]any{"id": "2", "email": "current@example.com", "udate": "2026-05-12T11:00:00Z"}},
					"meta":     map[string]any{"total": 1},
				})
			default:
				t.Fatalf("unexpected id_greater %q", idGreater)
			}
		case "/api/3/contacts/1":
			writeJSON(t, w, map[string]any{"contact": map[string]any{"id": "1", "email": "stale@example.com", "udate": "2026-05-12T09:59:58Z"}})
		case "/api/3/contacts/2":
			writeJSON(t, w, map[string]any{"contact": map[string]any{"id": "2", "email": "current@example.com", "udate": "2026-05-12T11:00:00Z"}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	ad.now = func() time.Time { return mustParseTime(t, "2026-05-12T12:00:00Z") }
	batch, err := ad.ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(seenIDGreater) != 2 || seenIDGreater[0] != "" || seenIDGreater[1] != "1" {
		t.Fatalf("id_greater sequence = %#v, want [empty, 1]", seenIDGreater)
	}
	if len(batch.Events) != 1 || !strings.Contains(batch.Events[0].SourceID, "activecampaign:contact:2:") {
		t.Fatalf("events = %#v, want only exact-window contact 2", batch.Events)
	}
	if batch.NextCursor != "" {
		t.Fatalf("next cursor = %q, want closed window", batch.NextCursor)
	}
	if got := batch.HighWatermark.Format(time.RFC3339); got != "2026-05-12T12:00:00Z" {
		t.Fatalf("high watermark = %s", got)
	}
}

func TestListSourceEventsFiltersExactTimestampWindowAfterHydration(t *testing.T) {
	timestamps := map[string]string{
		"1": "2026-05-12T09:59:58.999999999Z",
		"2": "2026-05-12T09:59:59Z",
		"3": "2026-05-12T12:00:00Z",
		"4": "2026-05-12T12:00:00.000000001Z",
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			contacts := make([]any, 0, len(timestamps))
			for _, id := range []string{"1", "2", "3", "4"} {
				contacts = append(contacts, map[string]any{"id": id, "email": "contact" + id + "@example.com", "udate": timestamps[id]})
			}
			writeJSON(t, w, map[string]any{"contacts": contacts, "meta": map[string]any{"total": len(contacts)}})
		default:
			id := strings.TrimPrefix(r.URL.Path, "/api/3/contacts/")
			timestamp, ok := timestamps[id]
			if !ok || id == r.URL.Path {
				t.Fatalf("unexpected path %s", r.URL.Path)
			}
			writeJSON(t, w, map[string]any{"contact": map[string]any{"id": id, "email": "contact" + id + "@example.com", "udate": timestamp}})
		}
	}))
	defer srv.Close()

	ad := New()
	ad.now = func() time.Time { return mustParseTime(t, "2026-05-12T12:00:00Z") }
	batch, err := ad.ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 2 {
		t.Fatalf("events = %#v, want exact lower and upper boundary contacts", batch.Events)
	}
	if !strings.Contains(batch.Events[0].SourceID, "activecampaign:contact:2:") ||
		!strings.Contains(batch.Events[1].SourceID, "activecampaign:contact:3:") {
		t.Fatalf("event IDs = %q / %q, want contacts 2 and 3", batch.Events[0].SourceID, batch.Events[1].SourceID)
	}
}

func TestListSourceEventsRacedFutureContactIsEligibleInNextWindow(t *testing.T) {
	const changedAt = "2026-05-12T12:00:01Z"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "raced@example.com", "udate": changedAt}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{"contact": map[string]any{"id": "42", "email": "raced@example.com", "udate": changedAt}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	current := mustParseTime(t, "2026-05-12T12:00:00Z")
	ad := New()
	ad.now = func() time.Time { return current }
	sess := adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}
	first, err := ad.ListSourceEvents(context.Background(), sess, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Events) != 0 || first.NextCursor != "" {
		t.Fatalf("first batch = %#v, want raced future contact deferred", first)
	}

	current = mustParseTime(t, "2026-05-12T13:00:00Z")
	second, err := ad.ListSourceEvents(context.Background(), sess, first.HighWatermark, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Events) != 1 || !strings.Contains(second.Events[0].SourceID, "activecampaign:contact:42:") {
		t.Fatalf("second events = %#v, want deferred contact in next overlapping window", second.Events)
	}
}
