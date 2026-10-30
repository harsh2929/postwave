// SPDX-License-Identifier: AGPL-3.0-only
//
// dlq_bulk_test.go — pre-DB validation for the sse-pinned-tail bulk
// replay endpoint. DB-touching paths (actual replay) require Postgres
// and live in the local-docker smoke spec.

package auditsink

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestReplayDLQBulk_NoTenantReturns401(t *testing.T) {
	a := &AdminDeps{Pool: nil}
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/audit-sinks/dlq/replay-bulk",
		bytes.NewReader([]byte(`{"ids":[1,2,3]}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	a.ReplayDLQBulk(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestReplayDLQBulk_BadJSONReturns400(t *testing.T) {
	a := &AdminDeps{Pool: nil}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/audit-sinks/dlq/replay-bulk",
		bytes.NewReader([]byte(`{not json`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	a.ReplayDLQBulk(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_json") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestReplayDLQBulk_EmptyIDsReturns400(t *testing.T) {
	a := &AdminDeps{Pool: nil}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/audit-sinks/dlq/replay-bulk",
		bytes.NewReader([]byte(`{"ids":[]}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	a.ReplayDLQBulk(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "empty_ids") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestReplayDLQBulk_TooManyIDsReturns400(t *testing.T) {
	a := &AdminDeps{Pool: nil}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	// Build a body with 501 ids — one over the 500-id cap.
	ids := make([]int64, 501)
	for i := range ids {
		ids[i] = int64(i + 1)
	}
	body := `{"ids":[`
	for i, id := range ids {
		if i > 0 {
			body += ","
		}
		body += itoa(id)
	}
	body += "]}"

	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/audit-sinks/dlq/replay-bulk",
		bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	a.ReplayDLQBulk(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "too_many_ids") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestReplayEntryStatus_Shape — guards the wire shape so the frontend
// types in api-client.ts (DLQReplayEntryStatus) don't drift from the
// Go-side struct.
func TestReplayEntryStatus_Shape(t *testing.T) {
	s := ReplayEntryStatus{
		ID:       42,
		Status:   "ok",
		Rows:     7,
		ErrorMsg: "",
	}
	if s.ID != 42 || s.Status != "ok" || s.Rows != 7 {
		t.Errorf("zero-value round trip failed: %+v", s)
	}
}

// TestReplayResponse_JSONShape — round-trips the headline counters +
// per-entry array through encoding/json so we catch field-tag drift
// at build time rather than from a frontend regression. Table-driven
// to cover the empty + populated cases.
func TestReplayResponse_JSONShape(t *testing.T) {
	cases := []struct {
		name string
		resp ReplayResponse
		want string
	}{
		{
			name: "empty",
			resp: ReplayResponse{Entries: []ReplayEntryStatus{}},
			want: `{"replayed":0,"failed":0,"skipped":0,"entries":[]}`,
		},
		{
			name: "mixed outcomes",
			resp: ReplayResponse{
				Replayed: 2,
				Failed:   1,
				Skipped:  1,
				Entries: []ReplayEntryStatus{
					{ID: 1, Status: "ok", Rows: 3},
					{ID: 2, Status: "skipped", ErrorMsg: "already replayed at 2026-01-01"},
					{ID: 3, Status: "failed", ErrorMsg: "upstream 503"},
					{ID: 4, Status: "ok", Rows: 5},
				},
			},
			want: `{"replayed":2,"failed":1,"skipped":1,"entries":[{"id":1,"status":"ok","rows":3},{"id":2,"status":"skipped","rows":0,"errorMsg":"already replayed at 2026-01-01"},{"id":3,"status":"failed","rows":0,"errorMsg":"upstream 503"},{"id":4,"status":"ok","rows":5}]}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.resp)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(b) != tc.want {
				t.Fatalf("\n got: %s\nwant: %s", b, tc.want)
			}
		})
	}
}

// itoa — small local helper to avoid an extra import.
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
