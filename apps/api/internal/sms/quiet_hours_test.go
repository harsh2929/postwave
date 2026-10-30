package sms

// Tests for the quiet-hours window math (A7 / GAP-LS-145). All pure —
// QuietRuleActive / EvaluateQuietHours take `now` explicitly, so the
// same-day, overnight, whole-day, timezone, DST, and fail-closed branches are
// exercised without a DB or a clock.

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func qhRule(start, end int, days []int, tz string) QuietHoursRule {
	return QuietHoursRule{
		StartMinute: start,
		EndMinute:   end,
		Days:        days,
		Timezone:    tz,
		Enabled:     true,
	}
}

// utc builds a UTC instant on a fixed reference week.
// 2026-06-10 is a Wednesday (weekday 3).
func utc(day, hour, min int) time.Time {
	return time.Date(2026, 6, day, hour, min, 0, 0, time.UTC)
}

func TestQuietRuleActive_SameDayWindow(t *testing.T) {
	rule := qhRule(9*60, 17*60, []int{3}, "UTC") // Wed 09:00-17:00 UTC

	if ok, _ := QuietRuleActive(utc(10, 8, 59), rule); ok {
		t.Fatal("08:59 should be before the window")
	}
	ok, until := QuietRuleActive(utc(10, 9, 0), rule)
	if !ok {
		t.Fatal("09:00 should be inside the window (inclusive start)")
	}
	if want := utc(10, 17, 0); !until.Equal(want) {
		t.Fatalf("hold-until = %v, want %v", until, want)
	}
	if ok, _ := QuietRuleActive(utc(10, 16, 59), rule); !ok {
		t.Fatal("16:59 should be inside the window")
	}
	if ok, _ := QuietRuleActive(utc(10, 17, 0), rule); ok {
		t.Fatal("17:00 should be outside the window (exclusive end)")
	}
	// Thursday (weekday 4) is not listed — same clock time is allowed.
	if ok, _ := QuietRuleActive(utc(11, 12, 0), rule); ok {
		t.Fatal("window must not fire on an unlisted weekday")
	}
}

func TestQuietRuleActive_OvernightWindow(t *testing.T) {
	// Wed 21:00 -> Thu 09:00 UTC: an overnight window STARTING on
	// Wednesday (weekday 3) only.
	rule := qhRule(21*60, 9*60, []int{3}, "UTC")

	// Wednesday evening after start: active, holds until Thursday 09:00.
	ok, until := QuietRuleActive(utc(10, 22, 30), rule)
	if !ok {
		t.Fatal("Wed 22:30 should be inside the overnight window")
	}
	if want := utc(11, 9, 0); !until.Equal(want) {
		t.Fatalf("hold-until = %v, want %v (next-day end)", until, want)
	}

	// Thursday early morning: still active (window started yesterday).
	ok, until = QuietRuleActive(utc(11, 3, 0), rule)
	if !ok {
		t.Fatal("Thu 03:00 should still be inside the Wed-started window")
	}
	if want := utc(11, 9, 0); !until.Equal(want) {
		t.Fatalf("hold-until = %v, want %v (same-day end)", until, want)
	}

	// Thursday after end: over.
	if ok, _ := QuietRuleActive(utc(11, 9, 0), rule); ok {
		t.Fatal("Thu 09:00 should be outside (exclusive end)")
	}
	// Thursday evening: Thursday is not a listed start day.
	if ok, _ := QuietRuleActive(utc(11, 22, 0), rule); ok {
		t.Fatal("Thu 22:00 must not start a window (day not listed)")
	}
	// Wednesday midday: between the early-morning tail (which belongs
	// to a Tuesday start — not listed) and the evening start.
	if ok, _ := QuietRuleActive(utc(10, 12, 0), rule); ok {
		t.Fatal("Wed 12:00 should be outside the overnight window")
	}
	// Wednesday 03:00 is the tail of a Tuesday-started window;
	// Tuesday (2) is not listed, so it must be inactive.
	if ok, _ := QuietRuleActive(utc(10, 3, 0), rule); ok {
		t.Fatal("Wed 03:00 belongs to an unlisted Tuesday start")
	}
}

func TestQuietRuleActive_Timezone(t *testing.T) {
	// 21:00-09:00 in New York, every day. 2026-06-10 is EDT (UTC-4):
	// 02:00 UTC == 22:00 EDT previous day -> inside the window.
	rule := qhRule(21*60, 9*60, []int{0, 1, 2, 3, 4, 5, 6}, "America/New_York")

	ok, until := QuietRuleActive(utc(10, 2, 0), rule) // Tue 22:00 EDT
	if !ok {
		t.Fatal("22:00 New York local should be inside the window")
	}
	// Window ends Wed 09:00 EDT == 13:00 UTC.
	if want := utc(10, 13, 0); !until.Equal(want) {
		t.Fatalf("hold-until = %v, want %v (09:00 EDT in UTC)", until, want)
	}

	// 16:00 UTC == 12:00 EDT: outside.
	if ok, _ := QuietRuleActive(utc(10, 16, 0), rule); ok {
		t.Fatal("midday New York local should be outside the window")
	}
}

func TestQuietRuleActive_SpringGapEndNeverSchedulesBeforeNow(t *testing.T) {
	// New York skips 02:00..02:59 on 2024-03-10. A Saturday-started
	// overnight window ending at the nonexistent Sunday 02:30 must remain
	// held until the first real wall minute after the gap (03:00 EDT), not a
	// time.Date normalization before the current 01:45 EST instant.
	rule := qhRule(21*60, 2*60+30, []int{6}, "America/New_York")
	now := time.Date(2024, 3, 10, 6, 45, 0, 0, time.UTC) // Sun 01:45 EST
	ok, until := QuietRuleActive(now, rule)
	if !ok {
		t.Fatal("spring-gap overnight window should be active before the gap")
	}
	want := time.Date(2024, 3, 10, 7, 0, 0, 0, time.UTC) // Sun 03:00 EDT
	if !until.Equal(want) || !until.After(now) {
		t.Fatalf("spring-gap hold-until = %v, want conservative %v after now", until, want)
	}
}

func TestQuietRuleActive_FallFoldEndUsesLaterOccurrence(t *testing.T) {
	// New York repeats 01:00..01:59 on 2024-11-03. A Saturday-started
	// overnight window ending at 01:30 must remain held through the repeated
	// interval and resolve to the later 01:30 EST occurrence.
	rule := qhRule(21*60, 1*60+30, []int{6}, "America/New_York")
	want := time.Date(2024, 11, 3, 6, 30, 0, 0, time.UTC) // second 01:30, EST
	for _, now := range []time.Time{
		time.Date(2024, 11, 3, 5, 15, 0, 0, time.UTC), // first 01:15, EDT
		time.Date(2024, 11, 3, 5, 45, 0, 0, time.UTC), // first 01:45, EDT
		time.Date(2024, 11, 3, 6, 15, 0, 0, time.UTC), // second 01:15, EST
	} {
		ok, until := QuietRuleActive(now, rule)
		if !ok {
			t.Fatalf("fall-fold overnight window should be active at %v", now)
		}
		if !until.Equal(want) || !until.After(now) {
			t.Fatalf("fall-fold hold-until at %v = %v, want later occurrence %v", now, until, want)
		}
	}
}

func TestQuietRuleActive_FallFoldSameDayEndAndRepeatedStartUseInstantInterval(t *testing.T) {
	// A same-day end in a fold resolves to the later occurrence. Wall-minute
	// membership would incorrectly allow sends at the first 01:45 EDT.
	endFold := qhRule(30, 90, []int{0}, "America/New_York")
	now := time.Date(2024, 11, 3, 5, 45, 0, 0, time.UTC) // first 01:45 EDT
	wantEnd := time.Date(2024, 11, 3, 6, 30, 0, 0, time.UTC)
	if active, until := QuietRuleActive(now, endFold); !active || !until.Equal(wantEnd) {
		t.Fatalf("same-day fold end at %v = active:%v until:%v, want active until %v", now, active, until, wantEnd)
	}

	// A repeated start resolves to its earliest occurrence. Once the window
	// starts at first 01:30 EDT it remains continuously active while the clock
	// repeats 01:00..01:29 in EST.
	startFold := qhRule(90, 3*60, []int{0}, "America/New_York")
	wantStartWindowEnd := time.Date(2024, 11, 3, 8, 0, 0, 0, time.UTC)
	cases := []struct {
		now    time.Time
		active bool
	}{
		{time.Date(2024, 11, 3, 5, 15, 0, 0, time.UTC), false}, // first 01:15
		{time.Date(2024, 11, 3, 5, 45, 0, 0, time.UTC), true},  // first 01:45
		{time.Date(2024, 11, 3, 6, 15, 0, 0, time.UTC), true},  // second 01:15
	}
	for _, tc := range cases {
		active, until := QuietRuleActive(tc.now, startFold)
		if active != tc.active {
			t.Fatalf("repeated-start activity at %v = %v, want %v", tc.now, active, tc.active)
		}
		if active && !until.Equal(wantStartWindowEnd) {
			t.Fatalf("repeated-start end at %v = %v, want %v", tc.now, until, wantStartWindowEnd)
		}
	}
}

func TestQuietRuleActive_WholeDayWindow(t *testing.T) {
	// start == end means the whole listed day. Sunday only (weekday 0);
	// 2026-06-14 is a Sunday.
	rule := qhRule(8*60, 8*60, []int{0}, "UTC")

	ok, until := QuietRuleActive(utc(14, 0, 30), rule)
	if !ok {
		t.Fatal("whole-day window should be active any time on the listed day")
	}
	if want := utc(15, 0, 0); !until.Equal(want) {
		t.Fatalf("hold-until = %v, want next local midnight %v", until, want)
	}
	if ok, _ := QuietRuleActive(utc(13, 12, 0), rule); ok {
		t.Fatal("whole-day window must not fire on unlisted days")
	}
}

func TestQuietRuleActive_FailClosed(t *testing.T) {
	now := utc(10, 23, 0)
	cases := map[string]QuietHoursRule{
		"disabled": {
			StartMinute: 0, EndMinute: 0, Days: []int{0, 1, 2, 3, 4, 5, 6},
			Timezone: "UTC", Enabled: false,
		},
		"bad timezone": {
			StartMinute: 0, EndMinute: 0, Days: []int{0, 1, 2, 3, 4, 5, 6},
			Timezone: "Mars/Olympus_Mons", Enabled: true,
		},
		"empty timezone": {
			StartMinute: 0, EndMinute: 0, Days: []int{0, 1, 2, 3, 4, 5, 6},
			Timezone: "", Enabled: true,
		},
		"start out of range": {
			StartMinute: 1500, EndMinute: 60, Days: []int{3},
			Timezone: "UTC", Enabled: true,
		},
		"end out of range": {
			StartMinute: 60, EndMinute: -1, Days: []int{3},
			Timezone: "UTC", Enabled: true,
		},
		"unsupported country scope": {
			StartMinute: 0, EndMinute: 0, Days: []int{3}, CountryCode: "US",
			Timezone: "UTC", Enabled: true,
		},
	}
	for name, rule := range cases {
		ok, _ := QuietRuleActive(now, rule)
		if name == "disabled" && ok {
			t.Errorf("%s: disabled rule must remain inactive", name)
		}
		if name != "disabled" && !ok {
			t.Errorf("%s: malformed configured rule must fail closed (active block)", name)
		}
	}
}

func TestEvaluateQuietHoursCheckedReturnsTypedPolicyError(t *testing.T) {
	_, _, err := EvaluateQuietHoursChecked(utc(10, 23, 0), []QuietHoursRule{{
		StartMinute: 0, EndMinute: 0, Days: []int{3}, Timezone: "Mars/Olympus_Mons", Enabled: true,
	}})
	if err == nil {
		t.Fatal("malformed enabled rule must produce a policy error")
	}
	_, _, err = EvaluateQuietHoursChecked(utc(10, 23, 0), []QuietHoursRule{{
		StartMinute: 0, EndMinute: 0, Days: []int{3}, Timezone: "UTC", CountryCode: "CA", Enabled: true,
	}})
	if err == nil || !strings.Contains(err.Error(), "unsupported country") {
		t.Fatalf("historical enabled country scope must fail closed with policy error: %v", err)
	}
}

func TestEvaluateQuietHours_LatestEndWins(t *testing.T) {
	now := utc(10, 22, 0) // Wed 22:00 UTC
	rules := []QuietHoursRule{
		qhRule(21*60, 23*60, []int{3}, "UTC"),          // ends Wed 23:00
		qhRule(20*60, 9*60, []int{3}, "UTC"),           // overnight, ends Thu 09:00
		qhRule(9*60, 17*60, []int{3}, "UTC"),           // not active at 22:00
		{StartMinute: 0, EndMinute: 0, Enabled: false}, // disabled
	}
	active, until := EvaluateQuietHours(now, rules)
	if !active {
		t.Fatal("expected at least one active window")
	}
	if want := utc(11, 9, 0); !until.Equal(want) {
		t.Fatalf("hold-until = %v, want latest end %v", until, want)
	}

	// No active windows: inactive with zero hold.
	active, until = EvaluateQuietHours(utc(11, 12, 0), rules)
	if active || !until.IsZero() {
		t.Fatalf("expected inactive/zero, got %v %v", active, until)
	}
}

func TestApplyQuietHoursInput(t *testing.T) {
	str := func(s string) *string { return &s }
	intp := func(n int) *int { return &n }

	// HH:MM strings populate the minute fields (scaffold compat).
	rule := defaultQuietHoursRule()
	if err := applyQuietHoursInput(&rule, QuietHoursInput{
		Label:      str("Weeknights"),
		StartLocal: str("22:30"),
		EndLocal:   str("06:15"),
		Timezone:   str("America/Chicago"),
	}); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
	if rule.StartMinute != 22*60+30 || rule.EndMinute != 6*60+15 {
		t.Fatalf("HH:MM not parsed: start=%d end=%d", rule.StartMinute, rule.EndMinute)
	}
	if rule.StartLocal != "22:30" || rule.EndLocal != "06:15" {
		t.Fatalf("derived labels wrong: %q %q", rule.StartLocal, rule.EndLocal)
	}

	// Validation failures.
	bad := []QuietHoursInput{
		{StartMinute: intp(-1)},
		{EndMinute: intp(minutesPerDay)},
		{StartLocal: str("25:00")},
		{Days: &[]int{}},
		{Days: &[]int{7}},
		{Timezone: str("Not/AZone")},
		{StartMinute: intp(60), StartLocal: str("01:00")},
		{EndMinute: intp(60), EndLocal: str("01:00")},
		{CountryCode: str("US")},
	}
	for i, in := range bad {
		r := defaultQuietHoursRule()
		if err := applyQuietHoursInput(&r, in); err == nil {
			t.Errorf("case %d: expected validation error", i)
		}
	}

	// Days are deduped + sorted.
	r := defaultQuietHoursRule()
	if err := applyQuietHoursInput(&r, QuietHoursInput{Days: &[]int{5, 1, 5, 0}}); err != nil {
		t.Fatalf("days input rejected: %v", err)
	}
	if len(r.Days) != 3 || r.Days[0] != 0 || r.Days[1] != 1 || r.Days[2] != 5 {
		t.Fatalf("days not normalized: %v", r.Days)
	}
}

func TestHistoricalCountryScopePatchRequiresExplicitAtomicRepair(t *testing.T) {
	empty := ""
	us := "US"
	disabled := false
	enabled := true

	for _, currentEnabled := range []bool{true, false} {
		legacy := defaultQuietHoursRule()
		legacy.CountryCode = "US"
		legacy.Enabled = currentEnabled
		for name, in := range map[string]QuietHoursInput{
			"country only":          {CountryCode: &empty},
			"explicitly enabled":    {CountryCode: &empty, Enabled: &enabled},
			"disable without clear": {Enabled: &disabled},
			"retain scope":          {CountryCode: &us, Enabled: &disabled},
		} {
			if err := validateQuietHoursPatchMutation(legacy, in); !errors.Is(err, errSMSQuietCountryScopeHeld) {
				t.Errorf("current enabled=%t, %s error = %v, want release hold", currentEnabled, name, err)
			}
		}
		if err := validateQuietHoursPatchMutation(legacy, QuietHoursInput{CountryCode: &empty, Enabled: &disabled}); err != nil {
			t.Fatalf("current enabled=%t atomic disable-and-clear repair rejected: %v", currentEnabled, err)
		}
	}
	if err := validateQuietHoursStoreTransition("US", QuietHoursRule{CountryCode: "", Enabled: true}); !errors.Is(err, errSMSQuietCountryScopeHeld) {
		t.Fatalf("Store clear-while-enabled error = %v, want release hold", err)
	}
	if err := validateQuietHoursStoreTransition("US", QuietHoursRule{CountryCode: "", Enabled: false}); err != nil {
		t.Fatalf("Store atomic disable-and-clear repair rejected: %v", err)
	}
}

// CreateQuietHours validates before touching the store, so the 422
// path is testable with an empty Deps.
func TestCreateQuietHours_ValidationReturns422(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sms/quiet-hours",
		strings.NewReader(`{"start_local":"9am","timezone":"UTC"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "33333333-3333-4333-8333-333333333333"}))
	rec := httptest.NewRecorder()
	d.CreateQuietHours(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "validation_failed") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestQuietHoursHandlersRejectAmbiguousRequestShapesBeforeDatabase(t *testing.T) {
	d := &Deps{}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sms/quiet-hours?x=1", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	rec := httptest.NewRecorder()
	d.ListQuietHours(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_query") {
		t.Fatalf("list query status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/sms/quiet-hours", strings.NewReader(`{"timezone":"UTC","surprise":true}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	rec = httptest.NewRecorder()
	d.CreateQuietHours(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "unknown_field") {
		t.Fatalf("unknown body status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/sms/quiet-hours", strings.NewReader(`{"start_minute":60,"start_local":"01:00"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	rec = httptest.NewRecorder()
	d.CreateQuietHours(rec, req)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "validation_failed") {
		t.Fatalf("ambiguous alias status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/sms/quiet-hours", strings.NewReader(`{"country_code":"US"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	rec = httptest.NewRecorder()
	d.CreateQuietHours(rec, req)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "country_scope_release_held") {
		t.Fatalf("unsupported country scope status/body = %d %s", rec.Code, rec.Body.String())
	}

	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/sms/quiet-hours/"+id, strings.NewReader(`{"enabled":false}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	req = withSMSRouteParam(req, "id", id)
	rec = httptest.NewRecorder()
	d.UpdateQuietHours(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_expected_updated_at") {
		t.Fatalf("missing PATCH version status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/v1/sms/quiet-hours/"+id, strings.NewReader(`{"expected_updated_at":"2026-08-28T00:00:00Z"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	req = withSMSRouteParam(req, "id", id)
	rec = httptest.NewRecorder()
	d.UpdateQuietHours(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "empty_patch") {
		t.Fatalf("empty PATCH status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/sms/quiet-hours/"+id, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	req = withSMSRouteParam(req, "id", id)
	rec = httptest.NewRecorder()
	d.DeleteQuietHours(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_expected_updated_at") {
		t.Fatalf("missing DELETE version status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/sms/quiet-hours/not-a-uuid", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	req = withSMSRouteParam(req, "id", "not-a-uuid")
	rec = httptest.NewRecorder()
	d.DeleteQuietHours(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_quiet_hours_id") {
		t.Fatalf("invalid id status/body = %d %s", rec.Code, rec.Body.String())
	}
}

func TestRoute42JSONBodyOperationsExposeMediaAndSizeRefusalsWithPrivateHeaders(t *testing.T) {
	d := &Deps{}
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	tests := []struct {
		name, method, path string
		maxBytes           int64
		handler            http.HandlerFunc
		pathID             bool
	}{
		{"create quiet hours", http.MethodPost, "/api/v1/sms/quiet-hours", smsPolicyBodyMaxBytes, d.CreateQuietHours, false},
		{"patch quiet hours", http.MethodPatch, "/api/v1/sms/quiet-hours/" + id, smsPolicyBodyMaxBytes, d.UpdateQuietHours, true},
		{"delete quiet hours", http.MethodDelete, "/api/v1/sms/quiet-hours/" + id, smsPolicyBodyMaxBytes, d.DeleteQuietHours, true},
		{"create keyword response", http.MethodPost, "/api/v1/sms/keyword-responses", smsPolicyBodyMaxBytes, d.CreateKeywordResponse, false},
		{"patch keyword response", http.MethodPatch, "/api/v1/sms/keyword-responses/" + id, smsPolicyBodyMaxBytes, d.UpdateKeywordResponse, true},
		{"delete keyword response", http.MethodDelete, "/api/v1/sms/keyword-responses/" + id, smsPolicyBodyMaxBytes, d.DeleteKeywordResponse, true},
		{"add suppression", http.MethodPost, "/api/v1/sms/suppressions", smsSuppressionBodyMaxBytes, d.AddSuppression, false},
		{"query suppression", http.MethodPost, "/api/v1/sms/suppressions/query", smsSuppressionBodyMaxBytes, d.QuerySuppressions, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for _, refusal := range []struct {
				name, contentType, body string
				status                  int
			}{
				{"unsupported media", "text/plain", `{}`, http.StatusUnsupportedMediaType},
				{"oversized JSON", "application/json", strings.Repeat(" ", int(tc.maxBytes)+1), http.StatusRequestEntityTooLarge},
			} {
				t.Run(refusal.name, func(t *testing.T) {
					req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(refusal.body))
					req.Header.Set("Content-Type", refusal.contentType)
					req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
					if tc.pathID {
						req = withSMSRouteParam(req, "id", id)
					}
					rec := httptest.NewRecorder()
					protectSMSInboxResponse(tc.handler).ServeHTTP(rec, req)
					if rec.Code != refusal.status {
						t.Fatalf("status = %d, want %d: %s", rec.Code, refusal.status, rec.Body.String())
					}
					if rec.Header().Get("Cache-Control") != "private, no-store" ||
						rec.Header().Get("Pragma") != "no-cache" ||
						rec.Header().Get("X-Content-Type-Options") != "nosniff" {
						t.Fatalf("private refusal headers = %#v", rec.Header())
					}
				})
			}
		})
	}
}

func TestQuietHoursRule_JSONShape(t *testing.T) {
	// The desktop codes against these names.
	rule := qhRule(21*60, 9*60, []int{1, 2}, "UTC")
	rule.StartLocal = minuteLabel(rule.StartMinute)
	rule.EndLocal = minuteLabel(rule.EndMinute)
	b := mustJSON(t, rule)
	for _, w := range []string{
		`"label"`, `"country_code"`, `"start_minute":1260`, `"end_minute":540`,
		`"start_local":"21:00"`, `"end_local":"09:00"`, `"days":[1,2]`,
		`"timezone":"UTC"`, `"enabled":true`,
	} {
		if !strings.Contains(b, w) {
			t.Errorf("missing %s in %s", w, b)
		}
	}
}
