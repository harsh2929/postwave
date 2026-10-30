package views

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeSendReader struct {
	depth []QueueDepthRow
	dead  []DeadLetterRow
	err   error
}

func (f fakeSendReader) QueueDepthByTenant(_ context.Context, _ int) ([]QueueDepthRow, error) {
	return f.depth, f.err
}
func (f fakeSendReader) ListDeadLetters(_ context.Context, _ int) ([]DeadLetterRow, error) {
	return f.dead, f.err
}

func TestQueueDepthHandler_OKAndFailLoud(t *testing.T) {
	ok := QueueDepthHandler(fakeSendReader{depth: []QueueDepthRow{{TenantID: "t1", Pending: 5}}})
	w := httptest.NewRecorder()
	ok(w, httptest.NewRequest("GET", "/views/send/queue-depth", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d want 200", w.Code)
	}

	bad := QueueDepthHandler(fakeSendReader{err: context.DeadlineExceeded})
	w2 := httptest.NewRecorder()
	bad(w2, httptest.NewRequest("GET", "/views/send/queue-depth", nil))
	if w2.Code != http.StatusInternalServerError {
		t.Fatalf("a failed read must be 500, got %d", w2.Code)
	}
}

func TestDeadLettersHandler_OKAndFailLoud(t *testing.T) {
	ok := DeadLettersHandler(fakeSendReader{dead: []DeadLetterRow{{TenantID: "t1", Kind: "automation.email", DeadCount: 3}}})
	w := httptest.NewRecorder()
	ok(w, httptest.NewRequest("GET", "/views/send/dead-letters", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d want 200", w.Code)
	}
	bad := DeadLettersHandler(fakeSendReader{err: context.DeadlineExceeded})
	w2 := httptest.NewRecorder()
	bad(w2, httptest.NewRequest("GET", "/views/send/dead-letters", nil))
	if w2.Code != http.StatusInternalServerError {
		t.Fatalf("a failed read must be 500, got %d", w2.Code)
	}
}
