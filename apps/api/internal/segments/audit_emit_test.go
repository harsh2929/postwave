// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_emit_test.go — p1-audit-migrate: assert one audit row per
// mutation on segment.create / segment.update / segment.delete.
// Hook-driven so no DB is required.
package segments

import (
	"context"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type segAuditRec struct {
	mu    sync.Mutex
	calls []segAuditCall
}

type segAuditCall struct {
	action     string
	resource   string
	resourceID string
	payload    map[string]any
}

func (r *segAuditRec) hook() audit.EmitHook {
	return func(_ context.Context, _, action, resource, resourceID string, payload map[string]any) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls = append(r.calls, segAuditCall{action, resource, resourceID, payload})
		return nil
	}
}

func installSegRecorder(t *testing.T) *segAuditRec {
	t.Helper()
	rec := &segAuditRec{}
	audit.SetEmitHookForTest(rec.hook())
	t.Cleanup(func() { audit.SetEmitHookForTest(nil) })
	return rec
}

func segTenantCtx() context.Context {
	return middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
}

func TestAuditEmit_SegmentCreate(t *testing.T) {
	rec := installSegRecorder(t)
	s := &Segment{ID: "seg-1", Name: "active 30d"}
	audit.EmitOrLog(segTenantCtx(), nil, "segment.create", "segment", s.ID, nil, s, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "segment.create" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
}

func TestAuditEmit_SegmentUpdate(t *testing.T) {
	rec := installSegRecorder(t)
	before := &Segment{ID: "seg-1", Name: "active 30d"}
	after := &Segment{ID: "seg-1", Name: "active 60d"}
	audit.EmitOrLog(segTenantCtx(), nil, "segment.update", "segment", after.ID,
		before, after, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "segment.update" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	if _, ok := rec.calls[0].payload["before"]; !ok {
		t.Error("payload.before missing")
	}
}

func TestAuditEmit_SegmentDelete(t *testing.T) {
	rec := installSegRecorder(t)
	before := &Segment{ID: "seg-1", Name: "active 30d"}
	audit.EmitOrLog(segTenantCtx(), nil, "segment.delete", "segment", before.ID,
		before, nil, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "segment.delete" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
}
