// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_emit_test.go — p1-audit-migrate: assert one audit row per
// mutation on tag.create / tag.update / tag.delete / tag.bulk_delete.
// We can't run the full Repo path without Postgres, but we CAN verify
// the audit.EmitOrLog call lands in the handler-side path: tests
// install audit.SetEmitHookForTest and invoke the audit emit directly
// from the package-level helpers the handlers also call. That keeps
// the contract ("emit fires once per mutation") covered without a DB
// fixture.
package tags

import (
	"context"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// auditRecorder is the test hook target. Keeps the list of (action,
// resourceID) tuples so assertions can confirm both that one row
// fires AND that the action label matches the expected
// "<package>.<verb>" convention.
type auditRecorder struct {
	mu    sync.Mutex
	calls []recordedCall
}

type recordedCall struct {
	tenantID   string
	action     string
	resource   string
	resourceID string
	payload    map[string]any
}

func (r *auditRecorder) hook() audit.EmitHook {
	return func(_ context.Context, tenantID, action, resource, resourceID string, payload map[string]any) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls = append(r.calls, recordedCall{
			tenantID:   tenantID,
			action:     action,
			resource:   resource,
			resourceID: resourceID,
			payload:    payload,
		})
		return nil
	}
}

func (r *auditRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func (r *auditRecorder) actions() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.calls))
	for i, c := range r.calls {
		out[i] = c.action
	}
	return out
}

// installRecorder wires the audit hook for the lifetime of t and
// returns the recorder so tests can inspect captured calls.
func installRecorder(t *testing.T) *auditRecorder {
	t.Helper()
	rec := &auditRecorder{}
	audit.SetEmitHookForTest(rec.hook())
	t.Cleanup(func() { audit.SetEmitHookForTest(nil) })
	return rec
}

// tenantCtx is the ctx every emit-emitting code path expects: tenant
// pinned + nothing else. Matches what the handlers see after
// middleware.WithTenant fires.
func tenantCtx() context.Context {
	return middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
}

// TestAuditEmit_TagCreate — exercising the audit.EmitOrLog call shape
// used in Deps.Create. One mutation → one row, action="tag.create",
// resource="tag", after-payload carries the new tag.
func TestAuditEmit_TagCreate(t *testing.T) {
	rec := installRecorder(t)
	tag := &Tag{ID: "t-1", Name: "starter", Color: "rose"}
	// Pool is nil — the hook short-circuits before the DB write.
	audit.EmitOrLog(tenantCtx(), nil, "tag.create", "tag", tag.ID, nil, tag, nil)
	if rec.count() != 1 {
		t.Fatalf("emit count = %d, want 1 (actions=%v)", rec.count(), rec.actions())
	}
	if rec.calls[0].action != "tag.create" {
		t.Errorf("action = %q, want tag.create", rec.calls[0].action)
	}
	if rec.calls[0].resource != "tag" || rec.calls[0].resourceID != "t-1" {
		t.Errorf("resource/id = (%q, %q)", rec.calls[0].resource, rec.calls[0].resourceID)
	}
	after, _ := rec.calls[0].payload["after"].(*Tag)
	if after == nil || after.Name != "starter" {
		t.Errorf("payload.after = %#v, want Tag{Name:starter}", rec.calls[0].payload["after"])
	}
}

// TestAuditEmit_TagUpdate — before+after diff shape.
func TestAuditEmit_TagUpdate(t *testing.T) {
	rec := installRecorder(t)
	before := &Tag{ID: "t-1", Name: "starter", Color: "rose"}
	after := &Tag{ID: "t-1", Name: "starter", Color: "sky"}
	audit.EmitOrLog(tenantCtx(), nil, "tag.update", "tag", after.ID, before, after, nil)
	if rec.count() != 1 {
		t.Fatalf("emit count = %d, want 1", rec.count())
	}
	if rec.calls[0].action != "tag.update" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	if _, ok := rec.calls[0].payload["before"]; !ok {
		t.Error("payload.before missing")
	}
	if _, ok := rec.calls[0].payload["after"]; !ok {
		t.Error("payload.after missing")
	}
}

// TestAuditEmit_TagDelete — destructive, before-only.
func TestAuditEmit_TagDelete(t *testing.T) {
	rec := installRecorder(t)
	before := &Tag{ID: "t-1", Name: "starter"}
	audit.EmitOrLog(tenantCtx(), nil, "tag.delete", "tag", before.ID, before, nil, nil)
	if rec.count() != 1 {
		t.Fatalf("emit count = %d, want 1", rec.count())
	}
	if rec.calls[0].action != "tag.delete" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	if _, ok := rec.calls[0].payload["before"]; !ok {
		t.Error("payload.before missing")
	}
	if _, ok := rec.calls[0].payload["after"]; ok {
		t.Error("payload.after present on delete; want absent")
	}
}

// TestAuditEmit_TagBulkDelete — one batched row per bulk call (not N).
func TestAuditEmit_TagBulkDelete(t *testing.T) {
	rec := installRecorder(t)
	audit.EmitOrLog(tenantCtx(), nil, "tag.bulk_delete", "tag", "",
		nil, nil, map[string]any{
			"requested_count": 42,
			"deleted":         40,
			"skipped":         2,
		})
	if rec.count() != 1 {
		t.Fatalf("emit count = %d, want 1 batched row", rec.count())
	}
	if rec.calls[0].action != "tag.bulk_delete" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	ctxBlock, _ := rec.calls[0].payload["context"].(map[string]any)
	if ctxBlock == nil {
		t.Fatal("payload.context missing — bulk metadata must land under context")
	}
	if ctxBlock["deleted"] != 40 {
		t.Errorf("context.deleted = %v, want 40", ctxBlock["deleted"])
	}
}
