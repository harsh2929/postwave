// SPDX-License-Identifier: AGPL-3.0-only
package scheduled_reports

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestComputeNextDueUsesScheduledWallClockWithoutCursorDrift(t *testing.T) {
	t.Parallel()

	from := time.Date(2026, 7, 20, 9, 0, 0, 0, time.UTC) // Monday.
	got, err := computeNextDue("weekly:mon@09:00", "UTC", from)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("next weekly = %s, want %s", got, want)
	}

	// Recomputing from the frozen occurrence, even after a late worker tick,
	// keeps the exact cadence anchor.
	lateWorkerNow := from.Add(53*time.Hour + 17*time.Minute)
	_ = lateWorkerNow
	next, err := computeNextDue("weekly:mon@09:00", "UTC", got)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC); !next.Equal(want) {
		t.Fatalf("anchored next weekly = %s, want %s", next, want)
	}
}

func TestComputeNextDueDSTSpringGapAdvancesToFirstValidMinute(t *testing.T) {
	t.Parallel()

	// America/New_York jumps from 01:59 EST to 03:00 EDT on this date.
	from := time.Date(2026, 3, 7, 12, 0, 0, 0, time.UTC)
	got, err := computeNextDue(
		"weekly:sun@02:30",
		"America/New_York",
		from,
	)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 3, 8, 7, 0, 0, 0, time.UTC) // 03:00 EDT.
	if !got.Equal(want) {
		t.Fatalf("spring-gap next = %s, want first valid minute %s", got, want)
	}
}

func TestComputeNextDueDSTFallBackUsesFirstOccurrence(t *testing.T) {
	t.Parallel()

	from := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	got, err := computeNextDue(
		"weekly:sun@01:30",
		"America/New_York",
		from,
	)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC) // 01:30 EDT.
	if !got.Equal(want) {
		t.Fatalf("fall-back next = %s, want first occurrence %s", got, want)
	}
}

func TestMonthlyScheduleAndReportingWindowHonorLocalCalendar(t *testing.T) {
	t.Parallel()

	from := time.Date(2026, 2, 28, 16, 0, 0, 0, time.UTC)
	got, err := computeNextDue(
		"monthly:8@09:00",
		"America/New_York",
		from,
	)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 3, 8, 13, 0, 0, 0, time.UTC) // 09:00 EDT.
	if !got.Equal(want) {
		t.Fatalf("monthly next = %s, want %s", got, want)
	}
	start, err := reportingPeriodStart(
		"monthly:8@09:00",
		"America/New_York",
		got,
	)
	if err != nil {
		t.Fatal(err)
	}
	if wantStart := time.Date(2026, 2, 8, 14, 0, 0, 0, time.UTC); !start.Equal(wantStart) {
		t.Fatalf("monthly period start = %s, want %s", start, wantStart)
	}
}

func TestWeeklyReportingWindowPreservesWallClockAcrossDST(t *testing.T) {
	t.Parallel()

	end := time.Date(2026, 3, 8, 13, 0, 0, 0, time.UTC) // 09:00 EDT.
	start, err := reportingPeriodStart(
		"weekly:sun@09:00",
		"America/New_York",
		end,
	)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 3, 1, 14, 0, 0, 0, time.UTC) // 09:00 EST.
	if !start.Equal(want) {
		t.Fatalf("weekly period start = %s, want %s", start, want)
	}
	if got := end.Sub(start); got != 167*time.Hour {
		t.Fatalf("DST weekly duration = %s, want 167h wall-clock week", got)
	}
}

func TestNormalizeTimezoneRejectsAmbiguousAbbreviations(t *testing.T) {
	t.Parallel()

	for _, value := range []string{"", "UTC", "America/New_York", "Asia/Kolkata"} {
		name, _, err := normalizeTimezone(value)
		if err != nil {
			t.Errorf("normalizeTimezone(%q): %v", value, err)
		}
		if value == "" && name != "UTC" {
			t.Errorf("blank timezone = %q, want UTC", name)
		}
	}
	for _, value := range []string{"EST", "PST", "Local", "Mars/Olympus_Mons", "UTC\n"} {
		if _, _, err := normalizeTimezone(value); err == nil {
			t.Errorf("normalizeTimezone(%q) unexpectedly succeeded", value)
		}
	}
}

func TestRecipientNormalizationIsBoundedCanonicalAndDeduplicated(t *testing.T) {
	t.Parallel()

	got, err := normalizeRecipients([]string{
		"Alice <Alice@example.test>",
		"alice@EXAMPLE.test",
		"bob@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "Alice@example.test" || got[1] != "bob@example.test" {
		t.Fatalf("normalized recipients = %#v", got)
	}
	for _, values := range [][]string{
		nil,
		{"not-an-email"},
		{"victim@example.test\nBcc: other@example.test"},
	} {
		if _, err := normalizeRecipients(values); !errors.Is(err, ErrReportConfigInvalid) {
			t.Errorf("normalizeRecipients(%#v) error = %v", values, err)
		}
	}
	tooMany := make([]string, maxScheduledRecipients+1)
	for i := range tooMany {
		tooMany[i] = "user" + string(rune('a'+i)) + "@example.test"
	}
	if _, err := normalizeRecipients(tooMany); !errors.Is(err, ErrReportConfigInvalid) {
		t.Errorf("over-cap recipients error = %v", err)
	}
}

func TestRequiredIdempotencyKeyRejectsMissingDuplicateAndUnsafeValues(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		values []string
		want   error
	}{
		{name: "missing", want: ErrIdempotencyKeyRequired},
		{name: "blank", values: []string{"  "}, want: ErrIdempotencyKeyRequired},
		{name: "duplicate", values: []string{"one", "two"}, want: ErrIdempotencyKeyInvalid},
		{name: "control", values: []string{"one\n"}, want: ErrIdempotencyKeyInvalid},
		{
			name:   "oversized",
			values: []string{strings.Repeat("k", idempotency.MaxKeyLength+1)},
			want:   ErrIdempotencyKeyInvalid,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			header := http.Header{}
			if test.values != nil {
				header[idempotency.HeaderName] = test.values
			}
			if _, err := requiredIdempotencyKey(header); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
	if got, err := requiredIdempotencyKey(http.Header{
		idempotency.HeaderName: []string{"  stable-click  "},
	}); err != nil || got != "stable-click" {
		t.Fatalf("valid key = %q, %v", got, err)
	}
}

func TestDeliveryFailureClassificationNeverRetriesAmbiguousErrors(t *testing.T) {
	t.Parallel()

	ambiguous := classifyDeliveryFailure(context.DeadlineExceeded)
	if ambiguous.State != "unknown" ||
		ambiguous.Code != "provider_outcome_unknown" {
		t.Fatalf("ambiguous failure = %#v", ambiguous)
	}
	rejected := classifyDeliveryFailure(NewRejectedError(errors.New("bad mailbox")))
	if rejected.State != "failed" || rejected.Code != "provider_rejected" {
		t.Fatalf("rejected failure = %#v", rejected)
	}
	if strings.Contains(ambiguous.Summary, "deadline") ||
		strings.Contains(rejected.Summary, "bad mailbox") {
		t.Fatal("persisted delivery summaries copied raw provider errors")
	}
}

type recordingManualRunQueuer struct {
	mu      sync.Mutex
	keys    []string
	result  SendNowResult
	err     error
	reports []string
}

func (q *recordingManualRunQueuer) QueueManualRun(
	_ context.Context,
	_, reportID, key string,
) (SendNowResult, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.keys = append(q.keys, key)
	q.reports = append(q.reports, reportID)
	return q.result, q.err
}

func sendNowRequest(values ...string) *http.Request {
	ctx := middleware.WithTenant(
		context.Background(),
		&middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"},
	)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "22222222-2222-4222-8222-222222222222")
	ctx = context.WithValue(ctx, chi.RouteCtxKey, routeCtx)
	request := httptest.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"/api/v1/scheduled-reports/22222222-2222-4222-8222-222222222222/send-now",
		nil,
	)
	if values != nil {
		request.Header[idempotency.HeaderName] = values
	}
	return request
}

func TestSendNowHandlerRequiresKeyBeforeQueueing(t *testing.T) {
	t.Parallel()

	for _, values := range [][]string{nil, {"one", "two"}} {
		queue := &recordingManualRunQueuer{}
		recorder := httptest.NewRecorder()
		(&Deps{sendNowStore: queue}).SendNow(recorder, sendNowRequest(values...))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400; body=%s",
				recorder.Code, recorder.Body.String())
		}
		if len(queue.keys) != 0 {
			t.Fatalf("unsafe request reached queue: %#v", queue.keys)
		}
	}
}

func TestSendNowHandlerReturnsStableDurableRunContract(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 24, 9, 8, 7, 0, time.UTC)
	queue := &recordingManualRunQueuer{
		result: SendNowResult{
			RunID:             "33333333-3333-4333-8333-333333333333",
			ScheduledReportID: "22222222-2222-4222-8222-222222222222",
			RunKind:           "manual",
			Status:            "queued",
			OccurrenceAt:      now,
			CreatedAt:         now,
		},
	}
	deps := &Deps{sendNowStore: queue}
	invoke := func() string {
		recorder := httptest.NewRecorder()
		deps.SendNow(recorder, sendNowRequest("  operator-click-42  "))
		if recorder.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202; body=%s",
				recorder.Code, recorder.Body.String())
		}
		return recorder.Body.String()
	}
	first, second := invoke(), invoke()
	if first != second {
		t.Fatalf("idempotent response changed:\n%s\n%s", first, second)
	}
	queue.mu.Lock()
	defer queue.mu.Unlock()
	if len(queue.keys) != 2 ||
		queue.keys[0] != "operator-click-42" ||
		queue.keys[1] != "operator-click-42" {
		t.Fatalf("forwarded keys = %#v", queue.keys)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(first), &body); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{
		"queued",
		"run_id",
		"scheduled_report_id",
		"run_kind",
		"status",
		"occurrence_at",
		"created_at",
	} {
		if _, ok := body[field]; !ok {
			t.Errorf("response missing %q: %#v", field, body)
		}
	}
}

func TestSendNowHandlerMapsLifecycleFailures(t *testing.T) {
	t.Parallel()

	tests := []struct {
		err    error
		status int
		code   string
	}{
		{ErrReportNotFound, http.StatusNotFound, "not_found"},
		{ErrReportConfigInvalid, http.StatusConflict, "report_configuration_invalid"},
	}
	for _, test := range tests {
		queue := &recordingManualRunQueuer{err: test.err}
		recorder := httptest.NewRecorder()
		(&Deps{sendNowStore: queue}).SendNow(
			recorder,
			sendNowRequest("lifecycle"),
		)
		if recorder.Code != test.status ||
			!strings.Contains(recorder.Body.String(), `"`+test.code+`"`) {
			t.Errorf("err %v => status/body %d %s",
				test.err, recorder.Code, recorder.Body.String())
		}
	}
}

func TestMutationHandlersMapMalformedReportIDWithoutDatabase(t *testing.T) {
	t.Parallel()

	request := func(method, path string) *http.Request {
		ctx := middleware.WithTenant(
			context.Background(),
			&middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"},
		)
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", "not-a-uuid")
		ctx = context.WithValue(ctx, chi.RouteCtxKey, routeCtx)
		return httptest.NewRequestWithContext(
			ctx,
			method,
			path,
			strings.NewReader(`{"enabled":true}`),
		)
	}
	tests := []struct {
		name   string
		invoke func(*Deps, http.ResponseWriter, *http.Request)
		method string
		path   string
	}{
		{
			name:   "patch",
			invoke: (*Deps).Patch,
			method: http.MethodPatch,
			path:   "/api/v1/scheduled-reports/not-a-uuid",
		},
		{
			name:   "delete",
			invoke: (*Deps).Delete,
			method: http.MethodDelete,
			path:   "/api/v1/scheduled-reports/not-a-uuid",
		},
		{
			name:   "send now",
			invoke: (*Deps).SendNow,
			method: http.MethodPost,
			path:   "/api/v1/scheduled-reports/not-a-uuid/send-now",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			recorder := httptest.NewRecorder()
			test.invoke(&Deps{}, recorder, request(test.method, test.path))
			if recorder.Code != http.StatusNotFound ||
				!strings.Contains(recorder.Body.String(), `"not_found"`) {
				t.Fatalf("status/body = %d %s",
					recorder.Code, recorder.Body.String())
			}
		})
	}
}
