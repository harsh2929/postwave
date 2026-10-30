package main

import (
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// auditRBACSessionScopes maps the durable dashboard role to the editable
// roles_permissions row set. It is path-gated so ordinary product traffic
// pays no extra database round trip; API-key requests already carry their
// own scopes and pass straight through.
func auditRBACSessionScopes(pool *db.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if middleware.IsAPIKeyAuth(r.Context()) || !isAuditRBACPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			tenant, tenantOK := middleware.TenantFromContext(r.Context())
			user, userOK := middleware.UserFromContext(r.Context())
			if !tenantOK || !userOK {
				next.ServeHTTP(w, r)
				return
			}
			// Audit evidence is a permission-gated surface, so a down-scoped
			// View-as-Viewer session must resolve the preview role rather than the
			// user's durable owner/admin role. DurableRole remains authoritative
			// for attribution and escalation decisions elsewhere.
			effectiveRole := user.EffectiveRoleOrDurable()
			tx, err := db.WithTenant(r.Context(), pool, tenant.ID)
			if err != nil {
				httperror.Write(w, http.StatusInternalServerError, "audit_rbac_unavailable", "audit permissions could not be resolved")
				return
			}
			defer func() { _ = tx.Rollback(r.Context()) }()
			var roleExists bool
			var values []string
			err = tx.QueryRow(r.Context(), `
SELECT EXISTS (
         SELECT 1 FROM roles
          WHERE tenant_id=$1::uuid AND lower(name)=lower($2)
       ),
       COALESCE(array_agg(rp.scope ORDER BY rp.scope)
         FILTER (WHERE rp.scope IS NOT NULL), '{}'::text[])
  FROM roles r
  LEFT JOIN roles_permissions rp ON rp.role_id=r.id
 WHERE r.tenant_id=$1::uuid AND lower(r.name)=lower($2)`, tenant.ID, effectiveRole).
				Scan(&roleExists, &values)
			if err != nil {
				httperror.Write(w, http.StatusInternalServerError, "audit_rbac_unavailable", "audit permissions could not be resolved")
				return
			}
			if err := tx.Commit(r.Context()); err != nil {
				httperror.Write(w, http.StatusInternalServerError, "audit_rbac_unavailable", "audit permissions could not be resolved")
				return
			}
			if !roleExists {
				values = defaultAuditScopesForRole(effectiveRole, r.URL.Path)
			}
			scopes := apikeys.ScopesFromContext(r.Context())
			for _, value := range values {
				scopes = append(scopes, apikeys.Scope(value))
			}
			next.ServeHTTP(w, r.WithContext(apikeys.WithScopes(r.Context(), scopes)))
		})
	}
}

func isAuditRBACPath(path string) bool {
	return strings.HasPrefix(path, "/api/v1/audit") ||
		strings.HasPrefix(path, "/api/v1/roles")
}

// isAuditSinkConfigPath reports whether the path is part of the audit EGRESS
// CONFIGURATION tree rather than the audit log itself. The two only share a
// prefix by accident of naming: "/api/v1/audit" prefix-matches
// "/api/v1/audit-sinks", so the audit:read default below silently applied to a
// surface that describes where a workspace ships its logs (webhook URLs, S3
// buckets, Splunk hosts) rather than what the logs contain.
func isAuditSinkConfigPath(path string) bool {
	return strings.HasPrefix(path, "/api/v1/audit-sinks")
}

func defaultAuditScopesForRole(role, path string) []string {
	if strings.EqualFold(role, "owner") || strings.EqualFold(role, "admin") {
		return handlers.AuditScopeStrings()
	}
	// Non-admin roles get read access to the audit trail by default, but never
	// to the sink configuration tree — reading a destination is a step toward
	// changing it, and the route gates there now require configure_sinks.
	// Injecting audit:read here anyway would only re-open the hole one layer up.
	if isAuditSinkConfigPath(path) {
		return nil
	}
	return []string{string(apikeys.ScopeAuditRead)}
}
