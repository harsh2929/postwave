// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

func TestRestoreSequenceRequiresExclusiveVersionedArchivedToDraftTransition(t *testing.T) {
	for _, tc := range []struct {
		name, body, version string
		want                int
	}{
		{"restore", `{"status":"draft"}`, "1", http.StatusOK},
		{"name edit", `{"status":"draft","name":"Changed"}`, "1", http.StatusConflict},
		{"content edit", `{"status":"draft","steps":[]}`, "1", http.StatusConflict},
		{"goal edit", `{"status":"draft","goal":null}`, "1", http.StatusConflict},
		{"stuck edit", `{"status":"draft","stuck_after_days":7}`, "1", http.StatusConflict},
		{"stale revision", `{"status":"draft"}`, "2", http.StatusPreconditionFailed},
		{"missing revision", `{"status":"draft"}`, "", http.StatusPreconditionRequired},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := NewMemorySequenceStore()
			initial := generation.Sequence{ID: "seq-restore", TenantID: "tenant-1", Name: "Archived draft", Status: "archived", Emails: []generation.GeneratedEmail{{Position: 1, Subject: "Keep me", Body: "Original copy"}}, Goal: &generation.SequenceGoal{Kind: "click", ExitOnGoal: true}, StuckAfterDays: 3}
			if err := store.Save(context.Background(), initial); err != nil {
				t.Fatal(err)
			}
			h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store})
			req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-restore", strings.NewReader(tc.body))
			req.Header.Set("X-Tenant-ID", "tenant-1")
			if tc.version != "" {
				req.Header.Set("If-Match", tc.version)
			}
			rec := httptest.NewRecorder()
			h.Routes().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", rec.Code, tc.want, rec.Body.String())
			}
			got, err := store.Get(context.Background(), "tenant-1", initial.ID)
			if err != nil {
				t.Fatal(err)
			}
			wantStatus, wantVersion := "archived", int64(1)
			if tc.want == http.StatusOK {
				wantStatus, wantVersion = "draft", 2
			}
			if got.Status != wantStatus || got.Version != wantVersion || got.Name != initial.Name || got.Emails[0].Subject != "Keep me" || got.Goal == nil || !got.Goal.ExitOnGoal || got.StuckAfterDays != 3 {
				t.Fatalf("restore changed more than lifecycle: %+v", got)
			}
			if tc.want == http.StatusOK && rec.Header().Get("ETag") != `"2"` {
				t.Fatalf("missing confirmed revision: %v", rec.Header())
			}
		})
	}
}
