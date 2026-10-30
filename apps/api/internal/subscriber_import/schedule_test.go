// SPDX-License-Identifier: AGPL-3.0-only
//
// One-time import execution coverage. Pure validation and scheduling math are
// locked here so recurring/drip inputs cannot silently become accepted while
// the worker lacks the durable semantics they promise.

package subscriber_import

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestValidateSchedule_RoundTrip(t *testing.T) {
	body := `{
		"schedule_type": " Scheduled ",
		"scheduled_at": "2026-06-20T02:00:00Z",
		"drip_hours_interval": 0,
		"drip_hours_total": 0
	}`
	var in patchInput
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		t.Fatalf("decode: %v", err)
	}
	sv, verr := validateSchedule(in.scheduleInput)
	if verr != nil {
		t.Fatalf("validate: %s (%s)", verr.msg, verr.code)
	}
	if sv.ScheduleType == nil || *sv.ScheduleType != "scheduled" {
		t.Errorf("schedule_type normalised: %v", sv.ScheduleType)
	}
	want := time.Date(2026, 6, 20, 2, 0, 0, 0, time.UTC)
	if sv.ScheduledAt == nil || !sv.ScheduledAt.Equal(want) {
		t.Errorf("scheduled_at: %v", sv.ScheduledAt)
	}
	if sv.DripHoursInterval == nil || *sv.DripHoursInterval != 0 ||
		sv.DripHoursTotal == nil || *sv.DripHoursTotal != 0 {
		t.Errorf("drip: %v/%v", sv.DripHoursInterval, sv.DripHoursTotal)
	}
	if !sv.touched() {
		t.Error("touched() should be true when fields are present")
	}
}

func TestValidateSchedule_AbsentUntouched(t *testing.T) {
	var in patchInput
	if err := json.Unmarshal([]byte(`{"on_existing":"skip"}`), &in); err != nil {
		t.Fatalf("decode: %v", err)
	}
	sv, verr := validateSchedule(in.scheduleInput)
	if verr != nil {
		t.Fatalf("validate: %v", verr)
	}
	if sv.touched() {
		t.Errorf("absent schedule must stay untouched: %+v", sv)
	}
}

func TestValidateSchedule_ExplicitEmptyClears(t *testing.T) {
	body := `{"scheduled_at": "", "schedule_cron": ""}`
	var in patchInput
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		t.Fatalf("decode: %v", err)
	}
	sv, verr := validateSchedule(in.scheduleInput)
	if verr != nil {
		t.Fatalf("validate: %v", verr)
	}
	if !sv.ClearScheduledAt || sv.ScheduledAt != nil {
		t.Errorf("empty scheduled_at should clear: %+v", sv)
	}
	if sv.ScheduleCron == nil || *sv.ScheduleCron != "" {
		t.Errorf("empty schedule_cron should clear: %v", sv.ScheduleCron)
	}
}

func TestValidateSchedule_Rejections(t *testing.T) {
	cases := []struct {
		name string
		body string
		code string
	}{
		{"bad type", `{"schedule_type":"someday"}`, "invalid_schedule_type"},
		{"bad timestamp", `{"scheduled_at":"tomorrow"}`, "invalid_scheduled_at"},
		{"date only", `{"scheduled_at":"2026-06-20"}`, "invalid_scheduled_at"},
		{"negative interval", `{"drip_hours_interval":-1}`, "unsupported_import_pacing"},
		{"positive interval", `{"drip_hours_interval":2}`, "unsupported_import_pacing"},
		{"negative total", `{"drip_hours_total":-5}`, "unsupported_import_pacing"},
		{"positive total", `{"drip_hours_total":12}`, "unsupported_import_pacing"},
		{"cron type", `{"schedule_type":"cron"}`, "unsupported_recurring_import"},
		{"cron expression", `{"schedule_cron":"0 2 * * *"}`, "unsupported_recurring_import"},
	}
	for _, c := range cases {
		var in patchInput
		if err := json.Unmarshal([]byte(c.body), &in); err != nil {
			t.Fatalf("%s: decode: %v", c.name, err)
		}
		_, verr := validateSchedule(in.scheduleInput)
		if verr == nil {
			t.Errorf("%s: expected rejection", c.name)
			continue
		}
		if verr.code != c.code {
			t.Errorf("%s: code %q want %q", c.name, verr.code, c.code)
		}
	}
}

func TestValidateConfirmExecutionFailsClosed(t *testing.T) {
	future := time.Now().UTC().Add(24 * time.Hour)
	cases := []struct {
		name string
		in   confirmSchedule
		code string
	}{
		{"legacy cron type", confirmSchedule{ScheduleType: "cron"}, "unsupported_recurring_import"},
		{"legacy cron expression", confirmSchedule{ScheduleType: "immediate", ScheduleCron: "0 2 * * *"}, "unsupported_recurring_import"},
		{"legacy interval", confirmSchedule{ScheduleType: "immediate", DripHoursInterval: 1}, "unsupported_import_pacing"},
		{"legacy total", confirmSchedule{ScheduleType: "immediate", DripHoursTotal: 24}, "unsupported_import_pacing"},
		{"scheduled without timestamp", confirmSchedule{ScheduleType: "scheduled"}, "invalid_scheduled_at"},
		{"immediate with timestamp", confirmSchedule{ScheduleType: "immediate", ScheduledAt: &future}, "conflicting_import_schedule"},
		{"unknown type", confirmSchedule{ScheduleType: "daily"}, "invalid_schedule_type"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := validateConfirmExecution(tc.in)
			if got == nil || got.code != tc.code {
				t.Fatalf("validateConfirmExecution() = %#v, want code %q", got, tc.code)
			}
		})
	}
	if got := validateConfirmExecution(confirmSchedule{ScheduleType: "immediate"}); got != nil {
		t.Fatalf("immediate execution rejected: %v", got)
	}
	if got := validateConfirmExecution(confirmSchedule{ScheduleType: "scheduled", ScheduledAt: &future}); got != nil {
		t.Fatalf("one-time scheduled execution rejected: %v", got)
	}
	past := time.Now().UTC().Add(-time.Second)
	if got := validateConfirmExecution(confirmSchedule{ScheduleType: "scheduled", ScheduledAt: &past}); got == nil || got.code != "scheduled_at_in_past" {
		t.Fatalf("past one-time schedule = %#v", got)
	}
	tooFar := time.Now().UTC().Add(MaxScheduleSkew + time.Hour)
	if got := validateConfirmExecution(confirmSchedule{ScheduleType: "scheduled", ScheduledAt: &tooFar}); got == nil || got.code != "scheduled_at_too_far" {
		t.Fatalf("too-far one-time schedule = %#v", got)
	}
}

// computeNextRun: immediate → nil (claim now).
func TestComputeNextRun_Immediate(t *testing.T) {
	now := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	if got := computeNextRun(confirmSchedule{ScheduleType: "immediate"}, now); got != nil {
		t.Errorf("immediate should be claimable now (nil), got %v", got)
	}
	// Unknown / default also immediate.
	if got := computeNextRun(confirmSchedule{ScheduleType: ""}, now); got != nil {
		t.Errorf("empty schedule_type should be immediate, got %v", got)
	}
}

// computeNextRun: a future scheduled_at gates the worker; a past one runs now.
func TestComputeNextRun_Scheduled(t *testing.T) {
	now := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	future := now.Add(4 * time.Hour)
	got := computeNextRun(confirmSchedule{ScheduleType: "scheduled", ScheduledAt: &future}, now)
	if got == nil || !got.Equal(future) {
		t.Errorf("future scheduled_at should gate: got %v want %v", got, future)
	}
	past := now.Add(-1 * time.Hour)
	if got := computeNextRun(confirmSchedule{ScheduleType: "scheduled", ScheduledAt: &past}, now); got != nil {
		t.Errorf("past scheduled_at should run now (nil), got %v", got)
	}
	// scheduled with no scheduled_at → run now.
	if got := computeNextRun(confirmSchedule{ScheduleType: "scheduled"}, now); got != nil {
		t.Errorf("scheduled without time should run now, got %v", got)
	}
}

// Handler-level: a PATCH carrying an invalid schedule is rejected with 400
// BEFORE any DB access (nil pool stays untouched).
func TestPatchHandler_RejectsInvalidScheduleBeforeDB(t *testing.T) {
	d := &Deps{Pool: nil}
	r := chi.NewRouter()
	r.Patch("/api/v1/subscriber-imports/{id}", d.Patch)

	for _, body := range []string{
		`{"schedule_type":"whenever"}`,
		`{"scheduled_at":"not-a-time"}`,
		`{"drip_hours_interval":-3}`,
		`{"drip_hours_interval":10,"drip_hours_total":2}`,
		`{"schedule_cron":"99 99 * * *"}`,
	} {
		req := httptest.NewRequest(http.MethodPatch,
			"/api/v1/subscriber-imports/11111111-1111-1111-1111-111111111111",
			bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(middleware.WithTenant(context.Background(),
			&middleware.Tenant{ID: "22222222-2222-2222-2222-222222222222"}))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status %d want 400 (%s)", body, rec.Code, rec.Body.String())
		}
	}
}
