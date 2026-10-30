// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

func TestSubscriberImportHTTPFailuresNeverExposeRawRowOrProviderDetail(t *testing.T) {
	const (
		addressCanary  = "private.import.row@example.invalid"
		providerCanary = "https://provider.invalid/verify?token=private-import-token"
	)

	tests := []struct {
		name       string
		err        error
		wantStatus int
	}{
		{
			name:       "database or verification failure",
			err:        fmt.Errorf("rejected row for %s via %s", addressCanary, providerCanary),
			wantStatus: http.StatusInternalServerError,
		},
		{
			name: "outbound storage failure",
			err: &url.Error{
				Op:  "GET",
				URL: providerCanary + "&email=" + addressCanary,
				Err: errors.New("private transport detail"),
			},
			wantStatus: http.StatusBadGateway,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			rec := httptest.NewRecorder()
			handler := chimiddleware.RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeSubscriberImportInternal(w, logger, tc.err, r.Context())
			}))
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/subscriber-imports/id/confirm", nil))

			if rec.Code != tc.wantStatus {
				t.Fatalf("status=%d body=%s, want %d", rec.Code, rec.Body.String(), tc.wantStatus)
			}
			captured := logs.String() + rec.Body.String()
			for _, canary := range []string{
				addressCanary, providerCanary, "private-import-token", "provider.invalid", "private transport detail",
			} {
				if strings.Contains(captured, canary) {
					t.Fatalf("private import failure detail %q escaped: %s", canary, captured)
				}
			}
			if !strings.Contains(logs.String(), `"err":"internal_or_dependency"`) {
				t.Fatalf("closed HTTP failure class missing from log: %s", logs.String())
			}
			var body struct {
				Error struct {
					RequestID string `json:"request_id"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error.RequestID == "" {
				t.Fatalf("generic response lost request id: body=%s err=%v", rec.Body.String(), err)
			}
		})
	}
}

func TestSubscriberImportHTTPErrorClassIsClosedAndNonReflective(t *testing.T) {
	closed := map[string]struct{}{
		"none":                          {},
		"context_canceled":              {},
		"deadline_exceeded":             {},
		"verification_binding_conflict": {},
		"record_not_found":              {},
		"internal_or_dependency":        {},
	}
	for _, err := range []error{
		nil,
		errors.New("private@example.invalid"),
		fmt.Errorf("private: %w", context.Canceled),
		fmt.Errorf("private: %w", context.DeadlineExceeded),
		fmt.Errorf("private: %w", ErrImportVerificationBinding),
	} {
		got := subscriberImportLogErrorClass(err)
		if _, ok := closed[got]; !ok || strings.Contains(got, "private") {
			t.Fatalf("classifier returned non-closed value %q", got)
		}
	}
}

func TestSubscriberImportHandlersCannotBypassSafeInternalErrorWrapper(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") || name == "http_error_safety.go" {
			continue
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if bytes.Contains(raw, []byte("httperror.WriteInternal")) {
			t.Fatalf("%s calls the raw internal-error logger; use writeSubscriberImportInternal", name)
		}
	}
}
