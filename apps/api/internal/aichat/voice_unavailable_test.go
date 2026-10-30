// SPDX-License-Identifier: AGPL-3.0-only

package aichat

import (
	"bytes"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
)

// With no voice sidecar deployed, POST /api/v1/voice/generate answered 502 —
// "the upstream misbehaved" — for what is simply "AI is not available here".
// Through the production HTTP voice client and the real route it is now the
// stable 503, the response carries none of the transport detail, and the
// server log still records the cause.
func TestGenerateAnswersUnavailableWhenTheVoiceServiceCannotBeReached(t *testing.T) {
	var logs bytes.Buffer
	deps := &Deps{
		Voice:  aicompose.NewHTTPVoiceClient("http://voice-sidecar.invalid:8083", "internal-token"),
		Logger: slog.New(slog.NewJSONHandler(&logs, nil)),
	}

	recorder := serve(t, deps, encodeBody(t, map[string]any{
		"prompt": "Three subject lines for our spring launch", "kind": "subject_line",
	}), authorizedOptions())

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s, want 503", recorder.Code, recorder.Body.String())
	}
	for _, leak := range []string{"voice-sidecar", "lookup", "dial", "8083"} {
		if strings.Contains(recorder.Body.String(), leak) {
			t.Fatalf("response leaks %q: %s", leak, recorder.Body.String())
		}
	}
	if !strings.Contains(logs.String(), "voice-sidecar.invalid") {
		t.Fatalf("server log lost the transport cause: %s", logs.String())
	}
}
