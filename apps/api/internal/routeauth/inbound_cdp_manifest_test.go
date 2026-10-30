// SPDX-License-Identifier: AGPL-3.0-only

package routeauth

import (
	"reflect"
	"testing"
)

func TestInboundRouteControlPlaneMatchesMountedAdminBoundary(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		method string
		path   string
	}{
		{method: "GET", path: "/api/v1/inbound-routes"},
		{method: "POST", path: "/api/v1/inbound-routes"},
		{method: "POST", path: "/api/v1/inbound-routes/bulk-archive"},
		{method: "POST", path: "/api/v1/inbound-routes/bulk-snooze"},
		{method: "GET", path: "/api/v1/inbound-routes/matches/{match_id}/runs"},
		{method: "POST", path: "/api/v1/inbound-routes/preview"},
		{method: "POST", path: "/api/v1/inbound-routes/reorder"},
		{method: "DELETE", path: "/api/v1/inbound-routes/{id}"},
		{method: "PATCH", path: "/api/v1/inbound-routes/{id}"},
		{method: "GET", path: "/api/v1/inbound-routes/{id}/matches"},
	} {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			assertExplicitAnyScopePolicy(t, test.method, test.path, "admin", "admin")
		})
	}
}

func TestCDPTransformPreviewAuthorityIsExplicit(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		method string
		path   string
		role   string
		scope  string
	}{
		{method: "POST", path: "/api/v1/cdp/transforms/apply", role: "admin", scope: "admin"},
		{method: "GET", path: "/api/v1/cdp/transforms/ops", role: "viewer", scope: "read:reports"},
		{method: "POST", path: "/api/v1/cdp/transforms/preview", role: "admin", scope: "admin"},
	} {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			assertExplicitAnyScopePolicy(t, test.method, test.path, test.role, test.scope)
		})
	}
}

func assertExplicitAnyScopePolicy(
	t *testing.T,
	method string,
	path string,
	wantRole string,
	wantScope string,
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
	if policy.APIKeyScopeMode != ScopeModeAny {
		t.Fatalf("scope mode = %q, want %q", policy.APIKeyScopeMode, ScopeModeAny)
	}
	if !reflect.DeepEqual(policy.APIKeyScopes, []string{wantScope}) {
		t.Fatalf("scopes = %v, want [%s]", policy.APIKeyScopes, wantScope)
	}
	if policy.PolicySource != "openapi.x-required-scopes" {
		t.Fatalf("policy source = %q, want explicit OpenAPI policy", policy.PolicySource)
	}
	if policy.ReviewStatus != "reviewed" {
		t.Fatalf("review status = %q, want reviewed", policy.ReviewStatus)
	}
}
