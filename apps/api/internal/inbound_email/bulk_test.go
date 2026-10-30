// SPDX-License-Identifier: AGPL-3.0-only
package inbound_email

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func bulkRouteRequest(path, body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, path,
		strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(len(body))
	return req
}

func TestBulkSnoozeRejectsMissingIDs(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	rec := httptest.NewRecorder()
	d.BulkSnoozeRoutes(rec, bulkRouteRequest("/api/v1/inbound-routes/bulk-snooze", `{"ids":[]}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_ids") {
		t.Fatalf("expected missing_ids error, got %s", rec.Body.String())
	}
}

func TestBulkSnoozeRejectsBadUntil(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	rec := httptest.NewRecorder()
	d.BulkSnoozeRoutes(rec, bulkRouteRequest("/api/v1/inbound-routes/bulk-snooze",
		`{"ids":["abc"], "until":"not-a-date"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_until") {
		t.Fatalf("expected bad_until error, got %s", rec.Body.String())
	}
}

func TestBulkSnoozeRejectsOversizedBatch(t *testing.T) {
	ids := make([]string, BulkRouteMaxIDs+1)
	for i := range ids {
		s := strings.Repeat("0", 32-len(routeItohex(i))) + routeItohex(i)
		ids[i] = s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" +
			s[16:20] + "-" + s[20:32]
	}
	body, _ := json.Marshal(map[string]any{"ids": ids})
	d := &Deps{Repo: &Repo{}}
	rec := httptest.NewRecorder()
	d.BulkSnoozeRoutes(rec, bulkRouteRequest("/api/v1/inbound-routes/bulk-snooze", string(body)))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "too_many_ids") {
		t.Fatalf("expected too_many_ids error, got %s", rec.Body.String())
	}
}

func TestBulkSnoozeRequiresTenant(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/inbound-routes/bulk-snooze",
		strings.NewReader(`{"ids":["x"]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Deps{Repo: &Repo{}}).BulkSnoozeRoutes(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestBulkSnoozeNoRepo(t *testing.T) {
	d := &Deps{}
	rec := httptest.NewRecorder()
	d.BulkSnoozeRoutes(rec, bulkRouteRequest("/api/v1/inbound-routes/bulk-snooze",
		`{"ids":["abc"]}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestBulkArchiveRejectsMissingIDs(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	rec := httptest.NewRecorder()
	d.BulkArchiveRoutes(rec, bulkRouteRequest("/api/v1/inbound-routes/bulk-archive",
		`{"ids":[], "archive":true}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_ids") {
		t.Fatalf("expected missing_ids error, got %s", rec.Body.String())
	}
}

func TestBulkArchiveRequiresTenant(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/inbound-routes/bulk-archive",
		strings.NewReader(`{"ids":["x"]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Deps{Repo: &Repo{}}).BulkArchiveRoutes(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestBulkArchiveNoRepo(t *testing.T) {
	d := &Deps{}
	rec := httptest.NewRecorder()
	d.BulkArchiveRoutes(rec, bulkRouteRequest("/api/v1/inbound-routes/bulk-archive",
		`{"ids":["abc"], "archive":true}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDedupeRouteIDs(t *testing.T) {
	cases := []struct {
		in   []string
		want []string
	}{
		{nil, nil},
		{[]string{}, nil},
		{[]string{"  "}, []string{}},
		{[]string{"a", "b", "a", "  b "}, []string{"a", "b"}},
	}
	for i, c := range cases {
		got := dedupeRouteIDs(c.in)
		if len(got) != len(c.want) {
			t.Fatalf("case %d: got %v want %v", i, got, c.want)
		}
		for j := range got {
			if got[j] != c.want[j] {
				t.Fatalf("case %d idx %d: got %q want %q", i, j, got[j], c.want[j])
			}
		}
	}
}

// routeItohex — hex encoder for the oversized-batch test.
func routeItohex(n int) string {
	const hex = "0123456789abcdef"
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = hex[n&0xf]
		n >>= 4
	}
	return string(b[i:])
}
