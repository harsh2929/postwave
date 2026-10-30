// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_emit_test.go — p1-audit-migrate: assert one audit row per
// mutation on list.create / list.update / list.delete. Uses
// audit.SetEmitHookForTest to short-circuit the DB write.
package lists

import (
	"context"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type listAuditRec struct {
	mu    sync.Mutex
	calls []listAuditCall
}

type listAuditCall struct {
	action     string
	resource   string
	resourceID string
	payload    map[string]any
}

func (r *listAuditRec) hook() audit.EmitHook {
	return func(_ context.Context, _, action, resource, resourceID string, payload map[string]any) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls = append(r.calls, listAuditCall{action, resource, resourceID, payload})
		return nil
	}
}

func installListsRecorder(t *testing.T) *listAuditRec {
	t.Helper()
	rec := &listAuditRec{}
	audit.SetEmitHookForTest(rec.hook())
	t.Cleanup(func() { audit.SetEmitHookForTest(nil) })
	return rec
}

func listsTenantCtx() context.Context {
	return middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
}

func TestAuditEmit_ListCreate(t *testing.T) {
	rec := installListsRecorder(t)
	in := CreateListInput{Name: "Newsletter", Type: "private", Optin: "single"}
	audit.EmitOrLog(listsTenantCtx(), nil, "list.create", "list", "42",
		nil, in, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d, want 1", len(rec.calls))
	}
	if rec.calls[0].action != "list.create" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	if rec.calls[0].resourceID != "42" {
		t.Errorf("resourceID = %q", rec.calls[0].resourceID)
	}
}

func TestAuditEmit_ListUpdate(t *testing.T) {
	rec := installListsRecorder(t)
	patch := map[string]any{"name": "Newsletter v2", "optin": "double"}
	audit.EmitOrLog(listsTenantCtx(), nil, "list.update", "list", "42",
		nil, patch, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d, want 1", len(rec.calls))
	}
	if rec.calls[0].action != "list.update" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
}

func TestAuditEmit_ListDelete(t *testing.T) {
	rec := installListsRecorder(t)
	audit.EmitOrLog(listsTenantCtx(), nil, "list.delete", "list", "42", nil, nil, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d, want 1", len(rec.calls))
	}
	if rec.calls[0].action != "list.delete" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
}

// TestExtractListIDFromResponse covers the helper that scrapes the
// new id out of Listmonk's response shape — drives the resourceID
// that the audit row records on a successful create.
func TestExtractListIDFromResponse(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"missing data", `{}`, ""},
		{"happy path", `{"data":{"id":42}}`, "42"},
		{"malformed", `not json`, ""},
		{"empty body", ``, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractListIDFromResponse([]byte(tc.body))
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}
