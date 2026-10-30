// SPDX-License-Identifier: AGPL-3.0-only

package aicompose

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// On lean staging no voice sidecar runs, so voice.postwave.internal does not
// resolve. Generate wrapped that as "voice service unreachable: Post
// \"http://voice…\": dial tcp: lookup voice… on 172.31.0.2:53: no such host":
// not ErrVoiceUnavailable (so the chat route answered 502, not the stable 503
// "unavailable" signal), and carrying the internal host and resolver address
// into every caller that stores or shows generation errors.

func closedPortURL(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return "http://" + addr
}

func TestGenerateReportsAnUnreachableVoiceServiceAsUnavailable(t *testing.T) {
	for name, baseURL := range map[string]string{
		"name does not resolve": "http://voice-sidecar.invalid:8083",
		"nothing is listening":  closedPortURL(t),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := NewHTTPVoiceClient(baseURL, "token").
				Generate(context.Background(), "tenant-1", KindSubjectLine, "prompt", "")
			if !errors.Is(err, ErrVoiceUnavailable) {
				t.Fatalf("err = %v, want ErrVoiceUnavailable", err)
			}
			host := strings.TrimPrefix(baseURL, "http://")
			for _, leak := range []string{host, "lookup", "dial tcp", "/v1/voice/generate", "127.0.0.1"} {
				if strings.Contains(err.Error(), leak) {
					t.Fatalf("error text leaks %q: %q", leak, err.Error())
				}
			}
		})
	}
}

// The cause is withheld from the error text, not from the operator: a
// structured log line carries it.
func TestGenerateKeepsTheTransportCauseForServerLogs(t *testing.T) {
	_, err := NewHTTPVoiceClient("http://voice-sidecar.invalid:8083", "").
		Generate(context.Background(), "tenant-1", KindSubjectLine, "prompt", "")
	var logs bytes.Buffer
	slog.New(slog.NewJSONHandler(&logs, nil)).Error("AI chat generation failed", "err", err)
	if !strings.Contains(logs.String(), "voice-sidecar.invalid") {
		t.Fatalf("log line lost the transport cause: %s", logs.String())
	}
}

// A service that accepted the connection and then went quiet is a timeout,
// not "unavailable": the caller maps it to 504.
func TestGenerateReportsASlowVoiceServiceAsATimeout(t *testing.T) {
	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-release
	}))
	t.Cleanup(func() { close(release); slow.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := NewHTTPVoiceClient(slow.URL, "").Generate(ctx, "tenant-1", KindSubjectLine, "prompt", "")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want a deadline error", err)
	}
	if errors.Is(err, ErrVoiceUnavailable) {
		t.Fatalf("a reachable but slow service was reported unavailable: %v", err)
	}
	if strings.Contains(err.Error(), strings.TrimPrefix(slow.URL, "http://")) {
		t.Fatalf("error text leaks the service address: %q", err.Error())
	}
}
