package views

import (
	"context"
	"net/http"
)

// QueueDepthLister / DeadLetterLister are the narrow read surfaces the send
// handlers need. *Reader satisfies both; tests use fakes.
type QueueDepthLister interface {
	QueueDepthByTenant(ctx context.Context, limit int) ([]QueueDepthRow, error)
}
type DeadLetterLister interface {
	ListDeadLetters(ctx context.Context, limit int) ([]DeadLetterRow, error)
}

// QueueDepthHandler serves GET /api/internal/ops/views/send/queue-depth. Read
// failure is a loud 500, never an empty 200 (an empty ops surface reads as
// "no backlog", the falsely-green failure this console prevents).
func QueueDepthHandler(l QueueDepthLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := viewLimit(r)
		rows, err := l.QueueDepthByTenant(r.Context(), limit)
		if err != nil {
			writeViewError(w, http.StatusInternalServerError, "queue_depth_unavailable", "queue depth is unavailable")
			return
		}
		writeViewJSON(w, map[string]any{"tenants": rows, "truncated": len(rows) >= limit})
	}
}

// DeadLettersHandler serves GET /api/internal/ops/views/send/dead-letters.
func DeadLettersHandler(l DeadLetterLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := viewLimit(r)
		rows, err := l.ListDeadLetters(r.Context(), limit)
		if err != nil {
			writeViewError(w, http.StatusInternalServerError, "dead_letters_unavailable", "dead letters are unavailable")
			return
		}
		writeViewJSON(w, map[string]any{"dead_letters": rows, "truncated": len(rows) >= limit})
	}
}
