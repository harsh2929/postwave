// SPDX-License-Identifier: AGPL-3.0-only

package routeauth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// The manifest gate's five refusals, three distinct causes.
//
// Two mirror the apikeys gate (role vs scope). The third is different in kind:
// `route_authorization_unclassified` fires when the manifest has no approved
// policy for a route — nothing is wrong with the CALLER at all. It is a
// deployment/config gap, and reporting it as a permission problem sends someone
// to hunt a permission that was never the issue.

func decodeRoute(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	return env.Error
}

func TestAnUnclassifiedRouteIsNotTheCallersProblem(t *testing.T) {
	// The fail-closed path for a route the manifest does not describe. Nothing
	// about the caller is wrong; someone forgot to classify a route.
	rec := httptest.NewRecorder()
	writeUnclassifiedRouteDenial(rec)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403 (fail closed)", rec.Code)
	}
	e := decodeRoute(t, rec)
	if e["reason"] == string(entitlement.ReasonRole) {
		t.Fatal("a missing route classification was reported as a role problem; " +
			"no role change makes an unclassified route classified")
	}
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "route_authorization_unclassified" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
}

func TestAnAuthMethodRefusalIsAboutHowYouAuthenticated(t *testing.T) {
	// e.g. an API key on a session-only route. No scope or role fixes it — the
	// caller has to authenticate differently.
	rec := httptest.NewRecorder()
	writeAuthMethodDenial(rec)

	e := decodeRoute(t, rec)
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "insufficient_auth_method" {
		t.Fatalf("code=%v, want the existing code", e["code"])
	}
}

func TestTheThreeCausesAreDistinguishable(t *testing.T) {
	// A client must be able to tell "ask a colleague", "reissue your key" and
	// "this route is misconfigured" apart. All three were 403-with-prose.
	unclassified := httptest.NewRecorder()
	writeUnclassifiedRouteDenial(unclassified)
	role := httptest.NewRecorder()
	writeRouteRoleDenial(role)
	scope := httptest.NewRecorder()
	writeRouteScopeDenial(scope, "api key does not have permission for this route")

	codes := map[string]bool{}
	for _, rec := range []*httptest.ResponseRecorder{unclassified, role, scope} {
		codes[decodeRoute(t, rec)["code"].(string)] = true
	}
	if len(codes) != 3 {
		t.Fatalf("got %d distinct codes across three causes: %v", len(codes), codes)
	}
	if decodeRoute(t, role)["reason"] == decodeRoute(t, scope)["reason"] {
		t.Fatal("role and scope still classify identically")
	}
}
