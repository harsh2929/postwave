// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func batchReq(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/batch", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t-1"})
	return req.WithContext(ctx)
}

func TestBatchUpsert_ValidationRejections(t *testing.T) {
	d := &Deps{} // validation rejects before any DB access
	// empty -> 400
	rec := httptest.NewRecorder()
	d.BatchUpsert(rec, batchReq(`{"subscribers":[]}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty batch: want 400, got %d", rec.Code)
	}
	// too many -> 422
	var sb strings.Builder
	sb.WriteString(`{"subscribers":[`)
	for i := 0; i <= MaxBatchUpsert; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(fmt.Sprintf(`{"email":"u%d@x.com"}`, i))
	}
	sb.WriteString(`]}`)
	rec = httptest.NewRecorder()
	d.BatchUpsert(rec, batchReq(sb.String()))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("oversized batch: want 422, got %d", rec.Code)
	}
	// no tenant -> 401
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/batch", strings.NewReader(`{"subscribers":[{"email":"a@x.com"}]}`))
	req.Header.Set("Content-Type", "application/json")
	d.BatchUpsert(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no tenant: want 401, got %d", rec.Code)
	}
}

// TestBatchRecordToCreateInput_NameFolding verifies first/last name fold into
// custom_fields and the display name is derived when absent.
func TestBatchRecordToCreateInput_NameFolding(t *testing.T) {
	in := batchRecordToCreateInput(BatchUpsertRecord{
		Email:     " A@X.com ",
		FirstName: "Ada",
		LastName:  "Lovelace",
		Tags:      []string{"vip", "vip", ""},
	})
	if in.Email != "A@X.com" {
		t.Errorf("email not trimmed: %q", in.Email)
	}
	if in.ConsentSource != ConsentUnknown {
		t.Errorf("batch provenance must not imply consent, got %q", in.ConsentSource)
	}
	if in.CustomFields["first_name"] != "Ada" || in.CustomFields["last_name"] != "Lovelace" {
		t.Errorf("name parts not folded: %v", in.CustomFields)
	}
	if in.CustomFields["name"] != "Ada Lovelace" {
		t.Errorf("display name not derived: %v", in.CustomFields["name"])
	}
	// dedupe + blank-drop on tags (normalizeTags contract)
	if len(in.Tags) != 1 || in.Tags[0] != "vip" {
		t.Errorf("tags not normalized: %v", in.Tags)
	}

	// Explicit name wins over derived.
	in2 := batchRecordToCreateInput(BatchUpsertRecord{
		Email: "b@x.com", FirstName: "X", CustomFields: map[string]any{"name": "Custom"},
	})
	if in2.CustomFields["name"] != "Custom" {
		t.Errorf("explicit name should win, got %v", in2.CustomFields["name"])
	}
}
