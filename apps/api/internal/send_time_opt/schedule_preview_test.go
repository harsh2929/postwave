// SPDX-License-Identifier: AGPL-3.0-only

package send_time_opt

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestBuildDistribution verifies the 24-bucket histogram lays out
// counts correctly and never short-returns even on empty schedules.
func TestBuildDistribution(t *testing.T) {
	base := time.Date(2026, 6, 3, 9, 0, 0, 0, time.UTC)
	sched := []Schedule{
		{Email: "a", SendAt: base},                     // 09:00
		{Email: "b", SendAt: base},                     // 09:00
		{Email: "c", SendAt: base.Add(2 * time.Hour)},  // 11:00
		{Email: "d", SendAt: base.Add(24 * time.Hour)}, // 09:00 next day
		{Email: "e", SendAt: base.Add(-9 * time.Hour)}, // 00:00
		{Email: "f", SendAt: base.Add(15 * time.Hour)}, // 00:00 next day
	}
	d := buildDistribution(sched)
	if len(d) != 24 {
		t.Fatalf("want 24 buckets, got %d", len(d))
	}
	wantHours := map[int]int{0: 2, 9: 3, 11: 1}
	for _, b := range d {
		want, ok := wantHours[b.Hour]
		if !ok {
			if b.Count != 0 {
				t.Errorf("hour %d: want 0, got %d", b.Hour, b.Count)
			}
			continue
		}
		if b.Count != want {
			t.Errorf("hour %d: want %d, got %d", b.Hour, want, b.Count)
		}
	}

	// Empty schedule → still 24 zero-buckets.
	empty := buildDistribution(nil)
	if len(empty) != 24 {
		t.Fatalf("empty: want 24 buckets, got %d", len(empty))
	}
	for _, b := range empty {
		if b.Count != 0 {
			t.Errorf("empty hour %d: want 0, got %d", b.Hour, b.Count)
		}
	}
}

// TestComputeBurstWindows pins the per-minute and per-day peak logic
// the warmup-cap-breach check depends on.
func TestComputeBurstWindows(t *testing.T) {
	day1 := time.Date(2026, 6, 3, 9, 0, 0, 0, time.UTC)
	day2 := day1.Add(24 * time.Hour)
	sched := []Schedule{
		// 5 recipients same minute on day1
		{Email: "a", SendAt: day1},
		{Email: "b", SendAt: day1},
		{Email: "c", SendAt: day1},
		{Email: "d", SendAt: day1},
		{Email: "e", SendAt: day1},
		// 2 recipients in a different minute, same day1
		{Email: "f", SendAt: day1.Add(time.Minute)},
		{Email: "g", SendAt: day1.Add(time.Minute)},
		// 3 recipients on day2
		{Email: "h", SendAt: day2},
		{Email: "i", SendAt: day2.Add(2 * time.Hour)},
		{Email: "j", SendAt: day2.Add(3 * time.Hour)},
	}
	maxMin, maxDay, peak := computeBurstWindows(sched)
	if maxMin != 5 {
		t.Errorf("max_per_minute: want 5, got %d", maxMin)
	}
	if maxDay != 7 {
		t.Errorf("max_per_day: want 7 (day1), got %d", maxDay)
	}
	if peak != "2026-06-03" {
		t.Errorf("peak_day_utc: want 2026-06-03, got %q", peak)
	}

	// Empty schedule → all zero, empty peak.
	mm, md, p := computeBurstWindows(nil)
	if mm != 0 || md != 0 || p != "" {
		t.Errorf("empty: want (0, 0, \"\"), got (%d, %d, %q)", mm, md, p)
	}
}

func TestNormalizeSchedulePreviewOptionsDefaultsAndUsesReferenceAt(t *testing.T) {
	fallback := time.Date(2026, 7, 26, 12, 0, 0, 0, time.FixedZone("local", 5*60*60+30*60))
	options, err := normalizeSchedulePreviewOptions(schedulePreviewRequest{}, fallback)
	if err != nil {
		t.Fatalf("defaults: %v", err)
	}
	if options.withinDays != 7 {
		t.Fatalf("within days = %d, want 7", options.withinDays)
	}
	if options.strategy != "per_recipient" {
		t.Fatalf("strategy = %q, want per_recipient", options.strategy)
	}
	if !options.referenceAt.Equal(fallback.UTC()) || options.referenceAt.Location() != time.UTC {
		t.Fatalf("reference = %s, want UTC %s", options.referenceAt, fallback.UTC())
	}

	const supplied = "2026-08-01T09:15:00+05:30"
	options, err = normalizeSchedulePreviewOptions(schedulePreviewRequest{
		WithinDays:  30,
		Strategy:    " modal_hour ",
		ReferenceAt: supplied,
	}, fallback)
	if err != nil {
		t.Fatalf("explicit options: %v", err)
	}
	want, parseErr := time.Parse(time.RFC3339, supplied)
	if parseErr != nil {
		t.Fatal(parseErr)
	}
	if !options.referenceAt.Equal(want.UTC()) {
		t.Fatalf("reference = %s, want %s", options.referenceAt, want.UTC())
	}
	if options.withinDays != 30 || options.strategy != "modal_hour" {
		t.Fatalf("options = %+v, want 30-day modal_hour", options)
	}
}

func TestNormalizeSchedulePreviewOptionsRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name string
		body schedulePreviewRequest
		code string
	}{
		{name: "window below minimum", body: schedulePreviewRequest{WithinDays: 6}, code: "invalid_within_days"},
		{name: "window above maximum", body: schedulePreviewRequest{WithinDays: 31}, code: "invalid_within_days"},
		{name: "unknown strategy", body: schedulePreviewRequest{Strategy: "fastest"}, code: "invalid_strategy"},
		{name: "malformed reference", body: schedulePreviewRequest{ReferenceAt: "tomorrow"}, code: "invalid_reference_at"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := normalizeSchedulePreviewOptions(test.body, time.Now())
			if err == nil || !strings.Contains(err.Error(), test.code) {
				t.Fatalf("error = %v, want %s", err, test.code)
			}
		})
	}
}

func TestSchedulePreviewDecodesUnknownLengthBodyAndSetsNoStore(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/campaigns/00000000-0000-0000-0000-000000000001/schedule-by-best-time/preview",
		strings.NewReader(`{"within_days":`),
	)
	req.ContentLength = -1
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "acme",
		Name: "Acme",
	})
	req = req.WithContext(ctx)

	// Exercise the handler directly so this test isolates body decoding
	// from API-key scope middleware.
	rec := httptest.NewRecorder()
	(&Deps{}).SchedulePreview(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"bad_json"`) {
		t.Fatalf("status=%d body=%s, want bad_json", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
}

func TestSchedulePreviewRejectsMalformedCampaignIDBeforeRepository(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", "not-a-uuid")
	ctx := contextWithRouteAndTenant(req, routeContext)
	rec := httptest.NewRecorder()

	(&Deps{}).SchedulePreview(rec, req.WithContext(ctx))

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_campaign_id") {
		t.Fatalf("status=%d body=%s, want invalid_campaign_id", rec.Code, rec.Body.String())
	}
}

func TestSchedulePreviewResponseNeverSerializesRecipientEmails(t *testing.T) {
	payload, err := json.Marshal(SchedulePreviewResponse{
		CampaignID:   "00000000-0000-0000-0000-000000000001",
		Distribution: buildDistribution(nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "first_50") || strings.Contains(string(payload), "email") {
		t.Fatalf("preview serialized recipient data: %s", payload)
	}
}

func contextWithRouteAndTenant(req *http.Request, routeContext *chi.Context) context.Context {
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeContext)
	return middleware.WithTenant(ctx, &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "acme",
		Name: "Acme",
	})
}
