// SPDX-License-Identifier: AGPL-3.0-only

package routeauth

import (
	"net/http"
	"reflect"
	"testing"
)

func TestAuditRawEvidenceManifestRequiresReadAndPII(t *testing.T) {
	t.Parallel()

	paths := []string{
		"/api/v1/audit",
		"/api/v1/audit/export",
		"/api/v1/audit/export/manifests",
		"/api/v1/audit/stats",
		"/api/v1/audit/chain/{requestId}",
		"/api/v1/audit/stream",
		"/api/v1/audit/saved-views",
		"/api/v1/audit/count",
		"/api/v1/audit/events",
		"/api/v1/audit/export-jobs",
		"/api/v1/audit/export-jobs/{id}",
		"/api/v1/audit/export-jobs/{id}/download",
		"/api/v1/audit/export-schedules",
		"/api/v1/audit/investigations",
		"/api/v1/audit/investigations/{id}",
		"/api/v1/audit/investigations/{id}/stream",
		"/api/v1/audit/ai-session/{session_id}/aivs-bundle",
		"/api/v1/audit/anomalies/recent",
		"/api/v1/audit/{id}/anomaly-score",
		"/api/v1/audit/{id}/session-replay",
		"/api/v1/audit/retention-activity",
		"/api/v1/audit/portal/sessions",
	}
	wantScopes := []string{"audit:read", "audit:read_pii"}

	for _, path := range paths {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			assertAuditManifestPolicy(t, http.MethodGet, path, "viewer", wantScopes)
		})
	}
}

func TestAuditRawEvidenceMutationsPreserveActionScope(t *testing.T) {
	t.Parallel()

	tests := []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/api/v1/audit/nlq"},
		{method: http.MethodPost, path: "/api/v1/audit/export-async"},
		{method: http.MethodPost, path: "/api/v1/audit/saved-views"},
		{method: http.MethodPatch, path: "/api/v1/audit/saved-views/{id}"},
		{method: http.MethodDelete, path: "/api/v1/audit/saved-views/{id}"},
		{method: http.MethodPost, path: "/api/v1/audit/{id}/investigate"},
		{method: http.MethodPost, path: "/api/v1/audit/{id}/unmask"},
	}
	wantScopes := []string{"audit:read", "audit:read_pii", "audit:execute_actions"}

	for _, test := range tests {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			assertAuditManifestPolicy(t, test.method, test.path, "admin", wantScopes)
		})
	}
}

func TestAuditExportScheduleMutationsMatchMountedScopeGate(t *testing.T) {
	t.Parallel()

	wantScopes := []string{"audit:read", "audit:read_pii", "audit:configure_sinks"}
	for _, test := range []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/api/v1/audit/export-schedules"},
		{method: http.MethodDelete, path: "/api/v1/audit/export-schedules/{id}"},
	} {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			assertAuditManifestPolicy(t, test.method, test.path, "admin", wantScopes)
		})
	}
}

func TestAuditCapabilityAndAccessRequestPoliciesStayExplicitAndConservative(t *testing.T) {
	t.Parallel()

	tests := []struct {
		method string
		path   string
		role   string
		scope  string
	}{
		{method: http.MethodGet, path: "/api/v1/audit/my-scopes", role: "viewer", scope: "audit:read"},
		{method: http.MethodGet, path: "/api/v1/audit/access-requests", role: "admin", scope: "admin"},
		// Requesting is not granting: any authenticated workspace member may
		// persist an idempotent pending request, while API keys retain the
		// execute-actions floor.
		{method: http.MethodPost, path: "/api/v1/audit/access-requests", role: "viewer", scope: "audit:execute_actions"},
		{method: http.MethodPatch, path: "/api/v1/audit/access-requests/{id}", role: "admin", scope: "admin"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()

			policy, ok := PolicyFor(test.method, test.path)
			if !ok {
				t.Fatalf("policy not found for %s %s", test.method, test.path)
			}
			if policy.Exposure != ExposureAuthenticated {
				t.Fatalf("exposure = %q, want %q", policy.Exposure, ExposureAuthenticated)
			}
			if !reflect.DeepEqual(policy.AuthMethods, []string{"session", "api_key"}) {
				t.Fatalf("auth methods = %v, want [session api_key]", policy.AuthMethods)
			}
			if policy.SessionMinimumRole != test.role {
				t.Fatalf("session role = %q, want %q", policy.SessionMinimumRole, test.role)
			}
			if policy.APIKeyScopeMode != ScopeModeAny {
				t.Fatalf("scope mode = %q, want %q", policy.APIKeyScopeMode, ScopeModeAny)
			}
			if !reflect.DeepEqual(policy.APIKeyScopes, []string{test.scope}) {
				t.Fatalf("scopes = %v, want [%s]", policy.APIKeyScopes, test.scope)
			}
			if policy.PolicySource != "openapi.x-required-scopes" {
				t.Fatalf("policy source = %q, want explicit OpenAPI policy", policy.PolicySource)
			}
			if policy.ReviewStatus != "reviewed" {
				t.Fatalf("review status = %q, want reviewed", policy.ReviewStatus)
			}
		})
	}
}

func assertAuditManifestPolicy(
	t *testing.T,
	method string,
	path string,
	wantRole string,
	wantScopes []string,
) {
	t.Helper()

	policy, ok := PolicyFor(method, path)
	if !ok {
		t.Fatalf("policy not found for %s %s", method, path)
	}
	if policy.Exposure != ExposureAuthenticated {
		t.Fatalf("exposure = %q, want %q", policy.Exposure, ExposureAuthenticated)
	}
	if !reflect.DeepEqual(policy.AuthMethods, []string{"session", "api_key"}) {
		t.Fatalf("auth methods = %v, want [session api_key]", policy.AuthMethods)
	}
	if policy.SessionMinimumRole != wantRole {
		t.Fatalf("session role = %q, want %q", policy.SessionMinimumRole, wantRole)
	}
	if policy.APIKeyScopeMode != ScopeModeAll {
		t.Fatalf("scope mode = %q, want %q", policy.APIKeyScopeMode, ScopeModeAll)
	}
	if !reflect.DeepEqual(policy.APIKeyScopes, wantScopes) {
		t.Fatalf("scopes = %v, want %v", policy.APIKeyScopes, wantScopes)
	}
	if policy.PolicySource != "openapi.x-required-scope-mode+openapi.x-required-scopes" {
		t.Fatalf("policy source = %q, want explicit conjunctive OpenAPI policy", policy.PolicySource)
	}
	if policy.ReviewStatus != "reviewed" {
		t.Fatalf("review status = %q, want reviewed", policy.ReviewStatus)
	}
}
