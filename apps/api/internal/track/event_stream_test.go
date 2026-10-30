// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type eventStreamRepositoryStub struct {
	maxID        int64
	maxIDErr     error
	newer        []Event
	listErr      error
	maxIDCalls   int
	listNewCalls int
}

type cancelOnFirstFlushRecorder struct {
	*httptest.ResponseRecorder
	cancel  context.CancelFunc
	flushes int
}

func (r *cancelOnFirstFlushRecorder) Flush() {
	r.ResponseRecorder.Flush()
	r.flushes++
	if r.flushes == 1 {
		r.cancel()
	}
}

func (s *eventStreamRepositoryStub) MaxID(context.Context, string) (int64, error) {
	s.maxIDCalls++
	return s.maxID, s.maxIDErr
}

func (s *eventStreamRepositoryStub) ListNewerThan(
	context.Context,
	string,
	int64,
	int,
) ([]Event, error) {
	s.listNewCalls++
	return s.newer, s.listErr
}

func eventStreamRequest(t *testing.T, ctx context.Context) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/track/stream", nil)
	if ctx != nil {
		request = request.WithContext(ctx)
	}
	return request.WithContext(middleware.WithTenant(
		request.Context(),
		&middleware.Tenant{ID: "tenant-1"},
	))
}

func TestEventStreamBootstrapFailureDoesNotCommitSSEHeadersOrReplay(t *testing.T) {
	repo := &eventStreamRepositoryStub{
		maxIDErr: errors.New("database unavailable"),
	}
	deps := &Deps{EventStreamRepo: repo}
	recorder := httptest.NewRecorder()

	deps.EventStream(recorder, eventStreamRequest(t, nil))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf(
			"status = %d, want 500; headers=%v body=%q",
			recorder.Code,
			recorder.Header(),
			recorder.Body.String(),
		)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want JSON failure before SSE headers", got)
	}
	if strings.Contains(recorder.Body.String(), "event: hello") ||
		strings.Contains(recorder.Body.String(), `"sinceId":0`) {
		t.Fatalf("bootstrap failure emitted replay seed: %q", recorder.Body.String())
	}
	if repo.maxIDCalls != 1 || repo.listNewCalls != 0 {
		t.Fatalf(
			"repository calls: MaxID=%d ListNewerThan=%d, want 1/0",
			repo.maxIDCalls,
			repo.listNewCalls,
		)
	}
}

func TestEventStreamSuccessfulBootstrapEmitsHighWaterMarkAndHonorsCancel(t *testing.T) {
	repo := &eventStreamRepositoryStub{maxID: 42}
	deps := &Deps{EventStreamRepo: repo}
	ctx, cancel := context.WithCancel(context.Background())
	recorder := &cancelOnFirstFlushRecorder{
		ResponseRecorder: httptest.NewRecorder(),
		cancel:           cancel,
	}

	deps.EventStream(recorder, eventStreamRequest(t, ctx))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%q", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}
	if !strings.Contains(recorder.Body.String(), "event: hello") ||
		!strings.Contains(recorder.Body.String(), `"sinceId":42`) {
		t.Fatalf("hello frame = %q, want frozen high-water mark", recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), `"sinceId":0`) {
		t.Fatalf("successful bootstrap regressed to replay seed: %q", recorder.Body.String())
	}
	if recorder.flushes != 1 {
		t.Fatalf("flushes = %d, want one hello flush before cancellation", recorder.flushes)
	}
	if repo.maxIDCalls != 1 || repo.listNewCalls != 0 {
		t.Fatalf(
			"repository calls after canceled stream: MaxID=%d ListNewerThan=%d, want 1/0",
			repo.maxIDCalls,
			repo.listNewCalls,
		)
	}
}
