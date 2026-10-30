// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type httpSafetyHealthReader struct{ err error }

func (r httpSafetyHealthReader) Resolve(
	context.Context, string, []string,
) ([]EmailHealth, error) {
	return nil, r.err
}

func TestVerificationHTTPFailuresNeverLogRawTenantRecipientOrProviderDetail(t *testing.T) {
	const (
		tenantDetailCanary   = "tenant-private-detail-71000000"
		recipientCanary      = "private.recipient@example.invalid"
		providerDetailCanary = "https://api.provider.invalid/v2?api_key=private-token"
	)
	raw := fmt.Errorf("tenant=%s recipient=%s provider=%s",
		tenantDetailCanary, recipientCanary, providerDetailCanary)

	for _, tc := range []struct {
		name string
		run  func(*Deps, http.ResponseWriter, *http.Request)
	}{
		{
			name: "general handler default",
			run: func(d *Deps, w http.ResponseWriter, r *http.Request) {
				d.writeProviderError(w, r, raw)
			},
		},
		{
			name: "health handler evidence read",
			run: func(d *Deps, w http.ResponseWriter, r *http.Request) {
				d.Health = httpSafetyHealthReader{err: raw}
				d.getHealth(w, r)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			d := &Deps{Logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			req := httptest.NewRequest(http.MethodGet,
				"/api/v1/verification/health?email=bounded@example.com", nil)
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
				ID: "71000000-0000-4000-8000-000000000001",
			}))
			rec := httptest.NewRecorder()

			tc.run(d, rec, req)
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status=%d body=%s, want generic 500", rec.Code, rec.Body.String())
			}
			captured := logs.String() + rec.Body.String()
			for _, canary := range []string{
				tenantDetailCanary, recipientCanary, providerDetailCanary,
				"private-token", "api.provider.invalid",
			} {
				if strings.Contains(captured, canary) {
					t.Fatalf("private error detail %q escaped: %s", canary, captured)
				}
			}
			if !strings.Contains(logs.String(), `"err":"internal_or_dependency"`) {
				t.Fatalf("closed HTTP failure class missing from log: %s", logs.String())
			}
		})
	}
}

func TestVerificationHTTPErrorClassIsClosedAndNonReflective(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "nil", want: "internal_or_dependency"},
		{name: "raw", err: errors.New("private@example.invalid"), want: "internal_or_dependency"},
		{name: "canceled", err: fmt.Errorf("private: %w", context.Canceled), want: "context_canceled"},
		{name: "deadline", err: fmt.Errorf("private: %w", context.DeadlineExceeded), want: "deadline_exceeded"},
		{name: "cache", err: fmt.Errorf("private: %w", ErrCacheUnavailable), want: "cache_unavailable"},
		{name: "job header", err: errInvalidStoredJob, want: "stored_contract_invalid"},
		{name: "job result", err: errInvalidStoredJobResult, want: "stored_contract_invalid"},
		{name: "health snapshot", err: errStoredHealthVerificationInvalid, want: "stored_contract_invalid"},
		{name: "policy", err: errInvalidStoredVerificationPolicy, want: "stored_contract_invalid"},
	}
	closed := map[string]struct{}{
		"internal_or_dependency":  {},
		"context_canceled":        {},
		"deadline_exceeded":       {},
		"cache_unavailable":       {},
		"stored_contract_invalid": {},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := verificationHTTPErrorClass(tc.err)
			if got != tc.want {
				t.Fatalf("class=%q, want %q", got, tc.want)
			}
			if _, ok := closed[got]; !ok || strings.Contains(got, "private") {
				t.Fatalf("classifier returned non-closed value %q", got)
			}
		})
	}
}

func TestVerificationHandlersCannotBypassSafeInternalErrorWrapper(t *testing.T) {
	for _, name := range []string{"handlers.go", "health_handlers.go"} {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if bytes.Contains(raw, []byte("httperror.WriteInternal")) {
			t.Fatalf("%s calls the raw internal-error logger; use writeVerificationInternal", name)
		}
	}
}
