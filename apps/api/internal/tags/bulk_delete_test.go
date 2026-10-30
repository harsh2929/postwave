// SPDX-License-Identifier: AGPL-3.0-only
package tags

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func bulkDeleteTagRequest(body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/tags/bulk-delete", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(len(body))
	return req
}

func TestTagsBulkDeleteRejectsMissingIDs(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	rec := httptest.NewRecorder()
	d.BulkDelete(rec, bulkDeleteTagRequest(`{"ids":[]}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_ids") {
		t.Fatalf("expected missing_ids error, got %s", rec.Body.String())
	}
}

func TestTagsBulkDeleteRejectsNoRepo(t *testing.T) {
	d := &Deps{}
	rec := httptest.NewRecorder()
	d.BulkDelete(rec, bulkDeleteTagRequest(`{"ids":["abc"]}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "repo_unavailable") {
		t.Fatalf("expected repo_unavailable error, got %s", rec.Body.String())
	}
}

func TestTagsBulkDeleteRejectsOversized(t *testing.T) {
	ids := make([]string, BulkDeleteMaxIDs+1)
	for i := range ids {
		// Distinct uuids — dedup won't collapse the batch.
		s := strings.Repeat("0", 32-len(itohex(i))) + itohex(i)
		ids[i] = s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" +
			s[16:20] + "-" + s[20:32]
	}
	body, _ := json.Marshal(map[string]any{"ids": ids})
	d := &Deps{Repo: &Repo{}}
	rec := httptest.NewRecorder()
	d.BulkDelete(rec, bulkDeleteTagRequest(string(body)))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "too_many_ids") {
		t.Fatalf("expected too_many_ids error, got %s", rec.Body.String())
	}
}

func TestTagsBulkDeleteRequiresTenant(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/tags/bulk-delete",
		strings.NewReader(`{"ids":["x"]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Deps{Repo: &Repo{}}).BulkDelete(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

// itohex — tiny private hex encoder so the test file doesn't pull in
// strconv for a single call.
func itohex(n int) string {
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
