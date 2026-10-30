// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

func TestSubmissionsCSVAbortsAndLogsWhenALaterPageFails(t *testing.T) {
	var logs bytes.Buffer
	laterFailure := errors.New("later page failed")
	reader := &submissionPageReaderStub{
		pages: []submissionPageResult{
			{
				submissions: []Submission{{
					ID: "submission-1", Email: "person@example.com", Status: SubmissionConfirmed,
					SubmittedAt: time.Date(2026, 7, 16, 9, 0, 0, 0, time.UTC),
				}},
				next: pagination.Encode(pagination.Cursor{
					SortKey: time.Date(2026, 7, 16, 9, 0, 0, 0, time.UTC),
					ID:      "00000000-0000-0000-0000-000000000001",
				}),
			},
			{err: laterFailure},
		},
	}
	deps := &Deps{
		SubmissionPages: reader,
		Logger:          slog.New(slog.NewTextHandler(&logs, nil)),
	}
	recorder := httptest.NewRecorder()

	panicValue := captureSubmissionsCSVPanic(func() {
		deps.SubmissionsCSV(recorder, submissionsCSVRequest())
	})
	if panicValue != http.ErrAbortHandler {
		t.Fatalf("panic = %#v, want http.ErrAbortHandler", panicValue)
	}
	if reader.calls != 2 {
		t.Fatalf("page calls = %d, want 2", reader.calls)
	}
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "person@example.com") {
		t.Fatalf("first page was not streamed before abort: status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(logs.String(), "forms.submissions_csv_aborted") ||
		!strings.Contains(logs.String(), laterFailure.Error()) ||
		!strings.Contains(logs.String(), `tenant_id=tenant-1`) ||
		!strings.Contains(logs.String(), `form_id=form-1`) {
		t.Fatalf("abort log is incomplete: %s", logs.String())
	}
}

func TestSubmissionsCSVAbortsAndLogsCSVWriterFailure(t *testing.T) {
	var logs bytes.Buffer
	writeFailure := errors.New("response write failed")
	reader := &submissionPageReaderStub{pages: []submissionPageResult{{
		submissions: []Submission{{
			ID: "submission-1", Email: "person@example.com", Status: SubmissionConfirmed,
			SubmittedAt: time.Date(2026, 7, 16, 9, 0, 0, 0, time.UTC),
		}},
	}}}
	deps := &Deps{
		SubmissionPages: reader,
		Logger:          slog.New(slog.NewTextHandler(&logs, nil)),
	}
	response := &failingCSVResponseWriter{header: make(http.Header), err: writeFailure}

	panicValue := captureSubmissionsCSVPanic(func() {
		deps.SubmissionsCSV(response, submissionsCSVRequest())
	})
	if panicValue != http.ErrAbortHandler {
		t.Fatalf("panic = %#v, want http.ErrAbortHandler", panicValue)
	}
	if response.writes != 1 {
		t.Fatalf("response writes = %d, want 1", response.writes)
	}
	if !strings.Contains(logs.String(), "forms.submissions_csv_aborted") ||
		!strings.Contains(logs.String(), writeFailure.Error()) ||
		!strings.Contains(logs.String(), "flush submission rows") {
		t.Fatalf("write-failure log is incomplete: %s", logs.String())
	}
}

func TestSubmissionsCSVReturnsGeneric500BeforeCommittingOnInitialPageFailure(t *testing.T) {
	initialFailure := errors.New("database details must stay private")
	deps := &Deps{SubmissionPages: &submissionPageReaderStub{
		pages: []submissionPageResult{{err: initialFailure}},
	}}
	recorder := httptest.NewRecorder()

	panicValue := captureSubmissionsCSVPanic(func() {
		deps.SubmissionsCSV(recorder, submissionsCSVRequest())
	})
	if panicValue != nil {
		t.Fatalf("initial failure panic = %#v, want nil", panicValue)
	}
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), initialFailure.Error()) || !strings.Contains(recorder.Body.String(), "internal_error") {
		t.Fatalf("initial failure leaked or lost generic envelope: %s", recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); strings.Contains(got, "text/csv") {
		t.Fatalf("initial failure committed CSV content type %q", got)
	}
}

type submissionPageResult struct {
	submissions []Submission
	next        string
	err         error
}

type submissionPageReaderStub struct {
	pages []submissionPageResult
	calls int
}

func (s *submissionPageReaderStub) ListSubmissions(context.Context, string, string, int, pagination.Cursor) ([]Submission, string, error) {
	index := s.calls
	s.calls++
	if index >= len(s.pages) {
		return nil, "", errors.New("unexpected page request")
	}
	page := s.pages[index]
	return page.submissions, page.next, page.err
}

type failingCSVResponseWriter struct {
	header http.Header
	err    error
	writes int
}

func (w *failingCSVResponseWriter) Header() http.Header {
	return w.header
}

func (*failingCSVResponseWriter) WriteHeader(int) {}

func (w *failingCSVResponseWriter) Write([]byte) (int, error) {
	w.writes++
	return 0, w.err
}

func submissionsCSVRequest() *http.Request {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/forms/form-1/submissions.csv", http.NoBody)
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", "form-1")
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, routeContext)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
	return request.WithContext(ctx)
}

func captureSubmissionsCSVPanic(run func()) (recovered any) {
	defer func() {
		recovered = recover()
	}()
	run()
	return nil
}
