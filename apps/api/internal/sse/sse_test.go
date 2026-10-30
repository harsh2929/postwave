// SPDX-License-Identifier: AGPL-3.0-only

package sse

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// statusOnlyWriter is the shape of the gateway's status-recording wrappers
// before they were fixed: it embeds the writer and unwraps to it, but does not
// declare Flush itself, so asserting http.Flusher on it fails.
type statusOnlyWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusOnlyWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusOnlyWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// opaqueWriter hides every optional interface of the writer it wraps.
type opaqueWriter struct{ inner http.ResponseWriter }

func (w opaqueWriter) Header() http.Header         { return w.inner.Header() }
func (w opaqueWriter) Write(p []byte) (int, error) { return w.inner.Write(p) }
func (w opaqueWriter) WriteHeader(code int)        { w.inner.WriteHeader(code) }

func startStreamServer(t *testing.T, writeTimeout time.Duration, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.Config.WriteTimeout = writeTimeout
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func openEventStream(t *testing.T, url string) (*http.Response, *bufio.Reader) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept", "text/event-stream")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response, bufio.NewReader(response.Body)
}

// readFrame reads one SSE frame (up to the blank line that ends it).
func readFrame(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	var frame strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read frame: %v (so far %q)", err, frame.String())
		}
		if line == "\n" {
			return frame.String()
		}
		frame.WriteString(line)
	}
}

// A stream must outlive the server's WriteTimeout. The timeout is measured
// from when the request was read, so without moving the deadline the second
// event below is written after it expired and the connection is closed under
// the client.
func TestStreamOutlivesTheServerWriteTimeout(t *testing.T) {
	t.Parallel()
	server := startStreamServer(t, 200*time.Millisecond, func(w http.ResponseWriter, _ *http.Request) {
		stream, ok := Open(w)
		if !ok {
			http.Error(w, "cannot stream", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if err := stream.Sendf("event: first\ndata: {}\n\n"); err != nil {
			t.Errorf("first event: %v", err)
			return
		}
		time.Sleep(500 * time.Millisecond)
		if err := stream.Sendf("event: second\ndata: {}\n\n"); err != nil {
			t.Errorf("second event after the write timeout: %v", err)
		}
	})

	_, reader := openEventStream(t, server.URL)
	if got := readFrame(t, reader); !strings.Contains(got, "event: first") {
		t.Fatalf("first frame = %q", got)
	}
	if got := readFrame(t, reader); !strings.Contains(got, "event: second") {
		t.Fatalf("second frame = %q", got)
	}
}

// A flush must reach the client while the handler is still running, even
// when the writer the handler holds is a wrapper that only unwraps. The
// handler below does not return until the client has read the first event,
// so a flush that stopped at the wrapper would leave both sides waiting.
func TestFlushReachesTheClientThroughAWrapperThatOnlyUnwraps(t *testing.T) {
	t.Parallel()
	clientHasEvent := make(chan struct{})
	server := startStreamServer(t, 0, func(w http.ResponseWriter, _ *http.Request) {
		wrapped := &statusOnlyWriter{ResponseWriter: w}
		if _, isFlusher := any(wrapped).(http.Flusher); isFlusher {
			t.Error("fixture must not implement http.Flusher")
		}
		stream, ok := Open(wrapped)
		if !ok {
			t.Error("Open refused a writer chain that unwraps to a flusher")
			return
		}
		wrapped.Header().Set("Content-Type", "text/event-stream")
		wrapped.WriteHeader(http.StatusOK)
		if err := stream.Sendf("event: ready\ndata: {}\n\n"); err != nil {
			t.Errorf("send: %v", err)
			return
		}
		select {
		case <-clientHasEvent:
		case <-time.After(5 * time.Second):
			t.Error("client never received the flushed event while the handler was running")
		}
	})

	response, reader := openEventStream(t, server.URL)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	got := readFrame(t, reader)
	close(clientHasEvent)
	if !strings.Contains(got, "event: ready") {
		t.Fatalf("frame = %q", got)
	}
}

func TestOpenRefusesAChainThatCannotFlush(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	if _, ok := Open(opaqueWriter{inner: recorder}); ok {
		t.Fatal("Open accepted a writer that can never flush")
	}
	if _, ok := Open(&statusOnlyWriter{ResponseWriter: opaqueWriter{inner: recorder}}); ok {
		t.Fatal("Open accepted a chain that unwraps to a writer that can never flush")
	}
}

// httptest.ResponseRecorder has no connection and so no write deadline; a
// stream over it must still write and flush, which is what handler unit tests
// rely on.
func TestStreamOverARecorderFlushesWithoutADeadline(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	stream, ok := Open(recorder)
	if !ok {
		t.Fatal("Open refused httptest.ResponseRecorder")
	}
	if err := stream.Sendf(":keepalive\n\n"); err != nil {
		t.Fatalf("Sendf: %v", err)
	}
	if !recorder.Flushed {
		t.Fatal("recorder was not flushed")
	}
	if got := recorder.Body.String(); got != ":keepalive\n\n" {
		t.Fatalf("body = %q", got)
	}
}
