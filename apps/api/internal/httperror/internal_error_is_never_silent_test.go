package httperror

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

// A 500 that logs nothing cannot be diagnosed. The caller gets an opaque
// envelope with a request_id, and grepping the server for that request_id
// returns only the access-log line -- no cause, no stack, nothing.
//
// WriteInternal guarded its logging with `if logger != nil`, and Deps structs
// are routinely built without one: the API-keys surface is constructed as
// `&apikeys.Deps{Repo: ..., Cache: ...}` while the mount on the very next line
// passes `Logger: logger`. Roughly a dozen other surfaces are the same.
//
// This was not found by reading the code. Minting an API key against the
// running server returned a 500, and the server had nothing whatsoever to say
// about it -- which is how the missing logger surfaced.
//
// The nil case must fall back to the default logger rather than discard. An
// internal error is exactly the event that must never be silent.

func captureDefaultLogger(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &buf
}

func TestInternalErrorWithNoLoggerStillGetsLogged(t *testing.T) {
	buf := captureDefaultLogger(t)
	rec := httptest.NewRecorder()

	WriteInternal(rec, nil, errors.New("the cause nobody could see"), context.Background())

	if rec.Code != 500 {
		t.Fatalf("expected 500, got %d", rec.Code)
	}
	logged := buf.String()
	if logged == "" {
		t.Fatal("a 500 was returned and the server said nothing at all")
	}
	if !strings.Contains(logged, "the cause nobody could see") {
		t.Fatalf("the cause must reach the log: %s", logged)
	}
	if !strings.Contains(logged, "http.internal_error") {
		t.Fatalf("must keep the same event name so existing queries match: %s", logged)
	}
}

func TestAnExplicitLoggerIsStillPreferred(t *testing.T) {
	// The fallback must not hijack callers that DO pass a logger -- their
	// records carry service/environment attributes the default does not.
	fallback := captureDefaultLogger(t)
	var mine bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&mine, nil))

	WriteInternal(httptest.NewRecorder(), logger, errors.New("routed"), context.Background())

	if !strings.Contains(mine.String(), "routed") {
		t.Fatalf("explicit logger must receive the record: %s", mine.String())
	}
	if strings.Contains(fallback.String(), "routed") {
		t.Fatalf("must not ALSO write to the default logger: %s", fallback.String())
	}
}
