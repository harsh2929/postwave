// SPDX-License-Identifier: AGPL-3.0-only
package suppressions

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestCSVImportAppearsInCanonicalRosterAndPreservesExistingHold(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	store := &Store{Pool: pool}
	const existing = "existing@example.invalid"
	const added = "csv@example.invalid"
	if _, err := store.Add(ctx, tenantID, existing, ReasonHardBounce, SourceManual, "", nil, nil); err != nil {
		t.Fatal(err)
	}
	d := &Deps{Repo: &Repo{Pool: pool}, CanonicalStore: store, Audit: &AuditLogger{Pool: pool}}
	for attempt := 0; attempt < 2; attempt++ {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		file, err := form.CreateFormFile("file", "qa.csv")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = file.Write([]byte("email,reason\n" + existing + ",list_manual\n" + added + ",list_manual\n"))
		_ = form.Close()
		r := httptest.NewRequest(http.MethodPost, "/api/v1/suppressions/import", &body)
		r.Header.Set("Content-Type", form.FormDataContentType())
		r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID}))
		w := httptest.NewRecorder()
		d.Import(w, r)
		var result importResponse
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != http.StatusOK {
			t.Fatalf("import status=%d body=%s err=%v", w.Code, w.Body.String(), err)
		}
		if result.Inserted != 1-attempt || result.Existing != 1+attempt || result.Errors != 0 {
			t.Fatalf("unexpected import receipt %+v", result)
		}
	}
	rows, total, err := store.ListPagedFiltered(ctx, tenantID, "", "", 1, 100)
	if err != nil || total != 2 {
		t.Fatalf("roster total=%d err=%v", total, err)
	}
	for _, row := range rows {
		want := ReasonListManual
		if row.Email == existing {
			want = ReasonHardBounce
		}
		if row.Reason != want {
			t.Fatalf("%s reason=%s want=%s", row.Email, row.Reason, want)
		}
	}
	audit, err := store.RecentAuditForEmail(ctx, tenantID, added, 10)
	if err != nil || len(audit) != 1 || audit[0].Action != AuditActionAdd {
		t.Fatalf("CSV audit=%+v err=%v", audit, err)
	}
}
