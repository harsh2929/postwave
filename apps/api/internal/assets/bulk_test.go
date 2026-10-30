// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type bulkCheckedDeleteFake struct {
	errs  map[string]error
	calls []string
}

func (f *bulkCheckedDeleteFake) DeleteChecked(_ context.Context, _ string, id string, expectedVersion int64, _ bool) (int64, int, []Referrer, error) {
	f.calls = append(f.calls, id)
	return expectedVersion + 1, 0, nil, f.errs[id]
}

func bulkDeleteRequest(body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/assets/bulk-delete", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(len(body))
	return req
}

func TestBulkDeleteRejectsMissingItems(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	req := bulkDeleteRequest(`{"items":[]}`)
	rec := httptest.NewRecorder()
	d.BulkDelete(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_items") {
		t.Fatalf("expected missing_items error, got %s", rec.Body.String())
	}
}

func TestBulkDeleteRejectsRepoMissing(t *testing.T) {
	d := &Deps{}
	req := bulkDeleteRequest(`{"items":[{"id":"00000000-0000-0000-0000-000000000001","expected_version":1}]}`)
	rec := httptest.NewRecorder()
	d.BulkDelete(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "repo_unavailable") {
		t.Fatalf("expected repo_unavailable error, got %s", rec.Body.String())
	}
}

func TestBulkDeleteRejectsOversizedBatch(t *testing.T) {
	// 1001 ids -> over BulkMaxIDs(1000) cap.
	ids := make([]string, 1001)
	for i := range ids {
		ids[i] = "00000000-0000-0000-0000-00000000abcd"
	}
	// We can't actually exceed via JSON encoding cheaply if we dedup —
	// use distinct fake ids by appending hex suffix.
	for i := range ids {
		ids[i] = strings.Repeat("0", 32-len(itohex(i))) + itohex(i)
		// Convert into uuid-ish shape ("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx").
		ids[i] = ids[i][0:8] + "-" + ids[i][8:12] + "-" + ids[i][12:16] + "-" +
			ids[i][16:20] + "-" + ids[i][20:32]
	}
	items := make([]map[string]any, len(ids))
	for i, id := range ids {
		items[i] = map[string]any{"id": id, "expected_version": 1}
	}
	body, _ := json.Marshal(map[string]any{"items": items})
	d := &Deps{Repo: &Repo{}}
	req := bulkDeleteRequest(string(body))
	rec := httptest.NewRecorder()
	d.BulkDelete(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "too_many_items") {
		t.Fatalf("expected too_many_items error, got %s", rec.Body.String())
	}
}

func TestBulkDeleteRequiresTenant(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/assets/bulk-delete",
		strings.NewReader(`{"items":[{"id":"x","expected_version":1}]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Deps{Repo: &Repo{}}).BulkDelete(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestBulkDeleteRejectsDuplicateOrPaddedItemIDs(t *testing.T) {
	body := `{"items":[{"id":"  00000000-0000-0000-0000-000000000001  ","expected_version":1},{"id":"00000000-0000-0000-0000-000000000001","expected_version":1}]}`
	d := &Deps{}
	req := bulkDeleteRequest(body)
	rec := httptest.NewRecorder()
	d.BulkDelete(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestBulkDeleteRejectsNonCanonicalUUID(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{}).BulkDelete(rec, bulkDeleteRequest(`{"items":[{"id":"not-a-uuid","expected_version":1}]}`))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_item") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestBulkDeleteUsesStablePerIDErrorsAndVersionedReceipts(t *testing.T) {
	const (
		referenced = "00000000-0000-0000-0000-000000000001"
		missing    = "00000000-0000-0000-0000-000000000002"
		broken     = "00000000-0000-0000-0000-000000000003"
	)
	fake := &bulkCheckedDeleteFake{errs: map[string]error{
		referenced: ErrHasReferences,
		missing:    ErrNotFound,
		broken:     errors.New("secret postgres detail"),
	}}
	body := `{"items":[{"id":"` + referenced + `","expected_version":1},{"id":"` + missing + `","expected_version":2},{"id":"` + broken + `","expected_version":3}]}`
	rec := httptest.NewRecorder()
	(&Deps{deleteRepo: fake}).BulkDelete(rec, bulkDeleteRequest(body))

	if rec.Code != http.StatusOK || len(fake.calls) != 3 {
		t.Fatalf("status=%d calls=%v body=%s", rec.Code, fake.calls, rec.Body.String())
	}
	for _, reason := range []string{"has_references", "not_found", "internal_error"} {
		if !strings.Contains(rec.Body.String(), `"reason":"`+reason+`"`) {
			t.Fatalf("missing stable reason %q: %s", reason, rec.Body.String())
		}
	}
	if strings.Contains(rec.Body.String(), "postgres") || strings.Contains(rec.Body.String(), "secret") {
		t.Fatalf("raw error leaked: %s", rec.Body.String())
	}
}

// itohex is a tiny helper for the 1001-id test — keeps the test file
// self-contained without dragging in strconv just for one call.
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
