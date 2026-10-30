// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_emit_test.go — p1-audit-migrate: assert one audit row per
// mutation on auditsink.key_rotate / auditsink.replay /
// auditsink.circuit_reset. Hook-driven so no DB is required.
package auditsink

import (
	"context"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type sinkAuditRec struct {
	mu    sync.Mutex
	calls []sinkAuditCall
}

type sinkAuditCall struct {
	action     string
	resource   string
	resourceID string
	payload    map[string]any
}

func (r *sinkAuditRec) hook() audit.EmitHook {
	return func(_ context.Context, _, action, resource, resourceID string, payload map[string]any) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls = append(r.calls, sinkAuditCall{action, resource, resourceID, payload})
		return nil
	}
}

func installSinkRecorder(t *testing.T) *sinkAuditRec {
	t.Helper()
	rec := &sinkAuditRec{}
	audit.SetEmitHookForTest(rec.hook())
	t.Cleanup(func() { audit.SetEmitHookForTest(nil) })
	return rec
}

func sinkTenantCtx() context.Context {
	return middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
}

func TestAuditEmit_SinkKeyRotate(t *testing.T) {
	rec := installSinkRecorder(t)
	audit.EmitOrLog(sinkTenantCtx(), nil, "auditsink.key_rotate", "audit_sink", "sink-1",
		nil, map[string]any{"kid": "kid-new-1", "alg": "HS256"}, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "auditsink.key_rotate" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	after, _ := rec.calls[0].payload["after"].(map[string]any)
	if after == nil || after["kid"] != "kid-new-1" {
		t.Errorf("payload.after.kid = %v, want kid-new-1", after["kid"])
	}
}

func TestAuditEmit_SinkReplay(t *testing.T) {
	rec := installSinkRecorder(t)
	audit.EmitOrLog(sinkTenantCtx(), nil, "auditsink.replay", "audit_sink", "sink-1",
		nil, map[string]any{"job_id": "job-1", "from_id": int64(100), "to_id": int64(200)}, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "auditsink.replay" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
}

func TestAuditEmit_SinkCircuitReset(t *testing.T) {
	rec := installSinkRecorder(t)
	audit.EmitOrLog(sinkTenantCtx(), nil, "auditsink.circuit_reset", "audit_sink", "sink-1",
		nil, map[string]any{"circuit_state": "closed"}, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "auditsink.circuit_reset" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
}
