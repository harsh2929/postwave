// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_paging_test.go — pre-DB validation paths + planner-line parser
// for the sse-pinned-tail feature. Happy paths require Postgres + RLS
// and are exercised by the local-docker smoke spec.

package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestAuditCount_NoTenantReturns401(t *testing.T) {
	h := &AuditHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/count", nil)
	rec := httptest.NewRecorder()
	h.Count(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestAuditCount_BadSinceReturns400(t *testing.T) {
	h := &AuditHandlers{Pool: nil}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet,
		"/api/v1/audit/count?since=not-a-date", nil)
	rec := httptest.NewRecorder()
	h.Count(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_since") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestAuditExportAsync_NoTenantReturns401(t *testing.T) {
	h := &AuditHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audit/export-async",
		strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ExportAsync(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAuditExportAsync_InvalidCompletionEmailReturns400BeforeDB(t *testing.T) {
	h := &AuditHandlers{Pool: nil}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/audit/export-async",
		strings.NewReader(`{"emailOnComplete":true,"emailAddress":"bad\naddress"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ExportAsync(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_email") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestAuditGetExportJob_NoTenantReturns401(t *testing.T) {
	h := &AuditHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/audit/export-jobs/some-id", nil)
	rec := httptest.NewRecorder()
	h.GetExportJob(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestParsePlannerRows — the planner JSON output is well-defined; we
// scan for the literal "Plan Rows":<n> token rather than pulling a
// JSON parser. Cover the common shapes.
func TestParsePlannerRows(t *testing.T) {
	cases := []struct {
		name string
		line string
		want int64
	}{
		{
			name: "single plan node",
			line: `[{"Plan":{"Node Type":"Seq Scan","Plan Rows":1234,"Plan Width":42}}]`,
			want: 1234,
		},
		{
			name: "with whitespace",
			line: `[{"Plan":{"Plan Rows":   987 ,"Plan Width":1}}]`,
			want: 987,
		},
		{
			name: "zero estimate",
			line: `[{"Plan":{"Plan Rows":0,"Plan Width":1}}]`,
			want: 0,
		},
		{
			name: "missing key",
			line: `[{"Plan":{"Node Type":"Seq Scan"}}]`,
			want: -1,
		},
		{
			name: "garbage",
			line: `not even json`,
			want: -1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parsePlannerRows(tc.line)
			if got != tc.want {
				t.Errorf("parsePlannerRows(%q) = %d, want %d",
					tc.line, got, tc.want)
			}
		})
	}
}

func TestAuditDownloadExportJob_NoTenantReturns401(t *testing.T) {
	h := &AuditHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/audit/export-jobs/abc/download", nil)
	rec := httptest.NewRecorder()
	h.DownloadExportJob(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestNewAuditExportWorker_Defaults — the constructor picks sane
// defaults from env when fields are unset; pre-DB so safe to assert
// without a running Postgres.
func TestNewAuditExportWorker_Defaults(t *testing.T) {
	t.Setenv("POSTWAVE_AUDIT_EXPORT_DIR", "/tmp/audit-export-test")
	w := NewAuditExportWorker(nil, nil)
	if w == nil {
		t.Fatal("constructor returned nil")
	}
	if w.OutputDir != "/tmp/audit-export-test" {
		t.Errorf("OutputDir = %q, want /tmp/audit-export-test", w.OutputDir)
	}
	if w.Interval <= 0 {
		t.Errorf("Interval = %s, want > 0", w.Interval)
	}
	if w.FlushEveryRows <= 0 {
		t.Errorf("FlushEveryRows = %d, want > 0", w.FlushEveryRows)
	}
}
