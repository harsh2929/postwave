// SPDX-License-Identifier: AGPL-3.0-only

package httperror

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func logRecord(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("expected one JSON log record, got %q: %v", buf.String(), err)
	}
	return rec
}

// A cancellation only means "the client left" when it is the request's own
// context that was cancelled. A handler that cancels a context of its own, or
// a shutdown that cancels a worker's, returns the same context.Canceled while
// the client is still connected and waiting; that is a real failure.
func TestCancellationThatIsNotTheClientsIsStillAnInternalError(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	rec := httptest.NewRecorder()

	WriteInternal(rec, logger, fmt.Errorf("db: begin tx: %w", context.Canceled), context.Background())

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 while the request is still live", rec.Code)
	}
	if got := logRecord(t, &buf); got["level"] != "ERROR" || got["msg"] != "http.internal_error" {
		t.Fatalf("logged %v, want ERROR http.internal_error", got)
	}
}

// The client closed the request, but the handler failed for a reason of its
// own. The error is not the cancellation, so it is still logged as an
// internal error; which status is sent is the root middleware's business.
func TestUnrelatedFailureAfterTheClientLeftIsStillLoggedAsError(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	WriteInternal(httptest.NewRecorder(), logger, fmt.Errorf("render: template %q missing", "digest"), ctx)

	if got := logRecord(t, &buf); got["level"] != "ERROR" {
		t.Fatalf("logged %v, want ERROR", got)
	}
}

func TestClientClosedRequestAnswers499WithTheStandardEnvelope(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()

	WriteInternal(rec, logger, fmt.Errorf("db: begin tx: %w", ctx.Err()), ctx)

	if rec.Code != StatusClientClosedRequest {
		t.Fatalf("status = %d, want 499", rec.Code)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error.Code != CodeClientClosedRequest {
		t.Fatalf("body = %s, want the error envelope with code %q", rec.Body.String(), CodeClientClosedRequest)
	}
	if got := logRecord(t, &buf); got["level"] != "INFO" || got["msg"] != "http.client_closed_request" {
		t.Fatalf("logged %v, want INFO http.client_closed_request", got)
	}
}
