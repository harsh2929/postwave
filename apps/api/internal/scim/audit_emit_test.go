// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_emit_test.go — p1-audit-migrate: assert one audit row per
// mutation on scim.role_mapping.upsert / scim.role_mapping.delete /
// scim.token.mint / scim.token.revoke. Hook-driven so no DB is
// required.
package scim

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type scimAuditRec struct {
	mu    sync.Mutex
	calls []scimAuditCall
}

type scimAuditCall struct {
	action     string
	resource   string
	resourceID string
	payload    map[string]any
}

func (r *scimAuditRec) hook() audit.EmitHook {
	return func(_ context.Context, _, action, resource, resourceID string, payload map[string]any) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls = append(r.calls, scimAuditCall{action, resource, resourceID, payload})
		return nil
	}
}

func installScimRecorder(t *testing.T) *scimAuditRec {
	t.Helper()
	rec := &scimAuditRec{}
	audit.SetEmitHookForTest(rec.hook())
	t.Cleanup(func() { audit.SetEmitHookForTest(nil) })
	return rec
}

func scimTenantCtx() context.Context {
	return middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
}

func TestAuditEmit_ScimRoleMappingUpsert(t *testing.T) {
	rec := installScimRecorder(t)
	m := RoleMapping{ID: "rm-1", GroupName: "engineering", Role: "admin", Precedence: 100, CreatedAt: time.Now()}
	audit.EmitOrLog(scimTenantCtx(), nil, "scim.role_mapping.upsert",
		"scim_role_mapping", m.ID, nil, m, map[string]any{
			"group_name": m.GroupName,
			"role":       m.Role,
		})
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d, want 1", len(rec.calls))
	}
	if rec.calls[0].action != "scim.role_mapping.upsert" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
}

func TestAuditEmit_ScimRoleMappingDelete(t *testing.T) {
	rec := installScimRecorder(t)
	audit.EmitOrLog(scimTenantCtx(), nil, "scim.role_mapping.delete",
		"scim_role_mapping", "rm-1", nil, nil, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "scim.role_mapping.delete" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
}

// TestAuditEmit_ScimTokenMint verifies the security-critical case
// that the audit payload contains the prefix + description but NEVER
// the plaintext token or its sha hash.
func TestAuditEmit_ScimTokenMint(t *testing.T) {
	rec := installScimRecorder(t)
	prefix := "scim_xyz"
	audit.EmitOrLog(scimTenantCtx(), nil, "scim.token.mint", "scim_token", prefix,
		nil, map[string]any{
			"prefix":      prefix,
			"description": "Okta",
		}, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	after, _ := rec.calls[0].payload["after"].(map[string]any)
	if after == nil {
		t.Fatal("payload.after missing")
	}
	if after["prefix"] != prefix {
		t.Errorf("prefix = %v, want %v", after["prefix"], prefix)
	}
	// Forensic: the plaintext / sha never lands in the audit row.
	for k, v := range after {
		if sv, ok := v.(string); ok && (strings.Contains(strings.ToLower(k), "secret") || strings.Contains(strings.ToLower(k), "hash") || strings.Contains(strings.ToLower(k), "plaintext")) {
			t.Errorf("audit payload leaked sensitive key %q = %q", k, sv)
		}
	}
}

func TestAuditEmit_ScimTokenRevoke(t *testing.T) {
	rec := installScimRecorder(t)
	audit.EmitOrLog(scimTenantCtx(), nil, "scim.token.revoke", "scim_token", "tok-1",
		nil, nil, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "scim.token.revoke" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
}
