// SPDX-License-Identifier: AGPL-3.0-only

package lifecycle

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestLifecycleUpsertRequiresOneExactStrongRevision(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		header   string
		wantCode string
	}{
		{name: "missing", wantCode: "precondition_required"},
		{name: "wildcard", header: "*", wantCode: "precondition_required"},
		{name: "weak", header: `W/"subscriber:id:v1"`, wantCode: "precondition_required"},
		{name: "multiple", header: `"subscriber:id:v1", "subscriber:id:v2"`, wantCode: "precondition_required"},
	}
	deps := &Deps{Repo: &Repo{}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "/api/v1/subscribers/id/lifecycle", strings.NewReader(`{"stage":"lead"}`))
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-test"}))
			if tc.header != "" {
				req.Header.Set("If-Match", tc.header)
			}
			rec := httptest.NewRecorder()
			deps.Upsert(rec, req)
			if rec.Code != http.StatusPreconditionRequired || !strings.Contains(rec.Body.String(), `"code":"`+tc.wantCode+`"`) {
				t.Fatalf("response = %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestLifecycleUpsertRejectsUnknownJSONBeforeMutation(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/subscribers/id/lifecycle", strings.NewReader(`{"stage":"lead","unexpected":true}`))
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-test"}))
	req.Header.Set("If-Match", `"subscriber:id:v1"`)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Deps{Repo: &Repo{}}).Upsert(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"unknown_field"`) {
		t.Fatalf("response = %d %s", rec.Code, rec.Body.String())
	}
}

func TestLifecycleUpsertRejectsWrongMediaTypeAsClientError(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/subscribers/id/lifecycle", strings.NewReader(`{"stage":"lead"}`))
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-test"}))
	req.Header.Set("If-Match", `"subscriber:id:v1"`)
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	(&Deps{Repo: &Repo{}}).Upsert(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType || !strings.Contains(rec.Body.String(), `"code":"unsupported_media_type"`) {
		t.Fatalf("response = %d %s", rec.Code, rec.Body.String())
	}
}

func TestLifecycleAutomationStorageFailureIsRetryableAndSanitized(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/subscribers/id/lifecycle", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).writeErr(
		rec,
		req,
		fmt.Errorf("%w: private database detail", ErrAutomationOutboxRequired),
		"upsert_failed",
	)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("response = %d retry-after=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
	if strings.Contains(rec.Body.String(), "private database detail") || !strings.Contains(rec.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("unsanitized/unexpected response: %s", rec.Body.String())
	}
}
