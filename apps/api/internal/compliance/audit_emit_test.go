// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_emit_test.go — p1-audit-migrate: assert one audit row per
// mutation on compliance.attest / compliance.revoke. Hook-driven
// so no DB is required.
package compliance

import (
	"context"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type compAuditRec struct {
	mu    sync.Mutex
	calls []compAuditCall
}

type compAuditCall struct {
	action     string
	resource   string
	resourceID string
	payload    map[string]any
}

func (r *compAuditRec) hook() audit.EmitHook {
	return func(_ context.Context, _, action, resource, resourceID string, payload map[string]any) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls = append(r.calls, compAuditCall{action, resource, resourceID, payload})
		return nil
	}
}

func installCompRecorder(t *testing.T) *compAuditRec {
	t.Helper()
	rec := &compAuditRec{}
	audit.SetEmitHookForTest(rec.hook())
	t.Cleanup(func() { audit.SetEmitHookForTest(nil) })
	return rec
}

func compTenantCtx() context.Context {
	return middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
}

func TestAuditEmit_ComplianceAttest(t *testing.T) {
	rec := installCompRecorder(t)
	audit.EmitOrLog(compTenantCtx(), nil, "compliance.attest", "compliance_program",
		FrameworkSOC2, map[string]any{"prev_status": "draft"},
		map[string]any{
			"framework":    FrameworkSOC2,
			"event_type":   "attested",
			"signed_by":    "ceo@example.com",
			"signer_name":  "Jane Doe",
			"document_sha": "deadbeef",
		}, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "compliance.attest" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	if rec.calls[0].resourceID != FrameworkSOC2 {
		t.Errorf("resourceID = %q, want %q", rec.calls[0].resourceID, FrameworkSOC2)
	}
}

func TestAuditEmit_ComplianceRevoke(t *testing.T) {
	rec := installCompRecorder(t)
	audit.EmitOrLog(compTenantCtx(), nil, "compliance.revoke", "compliance_program",
		FrameworkGDPR, nil,
		map[string]any{"framework": FrameworkGDPR, "status": "revoked"},
		map[string]any{"reason": "annual review failed"})
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "compliance.revoke" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	ctxBlock, _ := rec.calls[0].payload["context"].(map[string]any)
	if ctxBlock == nil || ctxBlock["reason"] != "annual review failed" {
		t.Errorf("payload.context.reason = %v", ctxBlock["reason"])
	}
}
