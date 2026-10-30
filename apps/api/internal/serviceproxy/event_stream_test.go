package serviceproxy

import (
	"bufio"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A proxied event stream (the migrations service's progress events) used to
// end at the API server's WriteTimeout, because the proxy never moved the
// write deadline. Serve the proxy from a server whose WriteTimeout is far
// shorter than the stream and require every event to arrive.
func TestProxiedEventStreamOutlivesTheServerWriteTimeout(t *testing.T) {
	const events = 8
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		for i := range events {
			_, _ = fmt.Fprintf(w, "data: {\"n\":%d}\n\n", i)
			_ = rc.Flush()
			time.Sleep(100 * time.Millisecond)
		}
	}))
	t.Cleanup(upstream.Close)

	gateway := httptest.NewUnstartedServer(New(Options{
		Target:         upstream.URL,
		PublicPrefix:   "/api/v1/migrations",
		UpstreamPrefix: "/api/v1/migrations",
	}))
	gateway.Config.WriteTimeout = 300 * time.Millisecond
	gateway.Start()
	t.Cleanup(gateway.Close)

	resp, err := gateway.Client().Get(gateway.URL + "/api/v1/migrations/m-1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	received := 0
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			received++
		}
	}
	// 8 events over ~800 ms against a 300 ms WriteTimeout.
	if received != events {
		t.Fatalf("received %d of %d events (scan error: %v)", received, events, scanner.Err())
	}
}

// Only event streams get the rolling deadline: an ordinary response still
// ends at the server's WriteTimeout.
func TestProxiedJSONKeepsTheServerWriteTimeout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		for range 8 {
			_, _ = w.Write([]byte(" "))
			_ = rc.Flush()
			time.Sleep(100 * time.Millisecond)
		}
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(upstream.Close)

	gateway := httptest.NewUnstartedServer(New(Options{Target: upstream.URL}))
	gateway.Config.WriteTimeout = 300 * time.Millisecond
	gateway.Start()
	t.Cleanup(gateway.Close)

	resp, err := gateway.Client().Get(gateway.URL + "/slow.json")
	if err != nil {
		return // cut before the headers: the deadline held
	}
	defer func() { _ = resp.Body.Close() }()
	body := new(strings.Builder)
	if _, err := bufio.NewReader(resp.Body).WriteTo(body); err == nil && strings.HasSuffix(body.String(), "{}") {
		t.Fatalf("a non-stream response outlived the server WriteTimeout: %q", body.String())
	}
}
