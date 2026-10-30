package main

import (
	"reflect"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestAuditRBACPathBoundary(t *testing.T) {
	t.Parallel()
	for _, path := range []string{
		"/api/v1/audit",
		"/api/v1/audit/export",
		"/api/v1/roles",
		"/api/v1/roles/role-1/scopes",
	} {
		if !isAuditRBACPath(path) {
			t.Errorf("isAuditRBACPath(%q) = false", path)
		}
	}
	if isAuditRBACPath("/api/v1/campaigns") {
		t.Fatal("campaign path unexpectedly triggers audit RBAC lookup")
	}
}

func TestAuditScopeRoleUsesEffectiveSessionRole(t *testing.T) {
	t.Parallel()
	user := &middleware.User{Role: "owner", EffectiveRole: "viewer"}
	if got := user.EffectiveRoleOrDurable(); got != "viewer" {
		t.Fatalf("audit scope role = %q, want viewer", got)
	}
	want := []string{string(apikeys.ScopeAuditRead)}
	if got := defaultAuditScopesForRole(user.EffectiveRoleOrDurable(), "/api/v1/audit"); !reflect.DeepEqual(got, want) {
		t.Fatalf("down-scoped audit grants = %v, want %v", got, want)
	}
}

func TestDefaultAuditScopesForRole(t *testing.T) {
	t.Parallel()
	for _, role := range []string{"owner", "OWNER", "admin", "Admin"} {
		if got := defaultAuditScopesForRole(role, "/api/v1/audit"); !reflect.DeepEqual(got, handlers.AuditScopeStrings()) {
			t.Errorf("defaultAuditScopesForRole(%q) = %v", role, got)
		}
	}
	wantReadOnly := []string{string(apikeys.ScopeAuditRead)}
	if got := defaultAuditScopesForRole("viewer", "/api/v1/audit"); !reflect.DeepEqual(got, wantReadOnly) {
		t.Fatalf("viewer scopes = %v, want %v", got, wantReadOnly)
	}
}

// "/api/v1/audit" prefix-matches "/api/v1/audit-sinks", so the read-only
// default bled onto the audit EGRESS CONFIGURATION tree: a viewer session was
// handed audit:read, which is in readOnlyScopes (no role check), and
// GET /api/v1/audit-sinks returned every sink's raw config — webhook URL, S3
// bucket, Splunk host — to anyone in the workspace.
func TestDefaultAuditScopesDoNotBleedOntoSinkConfiguration(t *testing.T) {
	t.Parallel()
	for _, path := range []string{
		"/api/v1/audit-sinks",
		"/api/v1/audit-sinks/sink-1/signing-keys",
		"/api/v1/audit-sinks/dlq",
	} {
		if got := defaultAuditScopesForRole("viewer", path); len(got) != 0 {
			t.Errorf("viewer scopes on %q = %v, want none", path, got)
		}
		if got := defaultAuditScopesForRole("editor", path); len(got) != 0 {
			t.Errorf("editor scopes on %q = %v, want none", path, got)
		}
		// Admins and owners keep the full set: they are who configures sinks.
		if got := defaultAuditScopesForRole("admin", path); !reflect.DeepEqual(got, handlers.AuditScopeStrings()) {
			t.Errorf("admin scopes on %q = %v, want the full audit set", path, got)
		}
	}
}
