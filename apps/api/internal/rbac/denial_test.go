// SPDX-License-Identifier: AGPL-3.0-only
package rbac

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// What a permission refusal must tell the caller.
//
// This is THE permission chokepoint: every session-cookie route gated on a
// permission refuses here. It used to emit a hand-concatenated
// `{"error":{"code":…,"message":…}}` with no machine-readable class, no
// indication of which role would work, and none of the headers a refusal needs.
//
// The class matters most. `entitlement`'s whole premise is that "your plan does
// not include this" and "your role does not permit this" need different
// affordances, and a client with only a message string cannot tell them apart —
// which is how a paywall gets shown to someone who needs an admin to change
// their role. `reason: "role"` is what makes that distinguishable, and
// `required_role` is what turns "forbidden" into something a user can act on.

func TestAPermissionRefusalNamesTheRoleThatWouldWork(t *testing.T) {
	// `viewer` cannot manage team members; some role can.
	h := RequirePermission(PermSubscribersWrite, func(*http.Request) (string, bool) {
		return "viewer", true
	})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("the handler ran despite an insufficient role")
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/team", nil))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	var body struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error == nil {
		t.Fatalf("not the shared denial envelope: %s", rec.Body.String())
	}
	if body.Error["reason"] != "role" {
		t.Errorf("reason = %v, want \"role\". Without it a client cannot tell this "+
			"apart from a plan denial, and shows a paywall to someone who needs an "+
			"admin to change their role.", body.Error["reason"])
	}
	required, _ := body.Error["required_role"].(string)
	if required == "" {
		t.Errorf("required_role is empty. \"Forbidden\" a user cannot act on is a "+
			"dead end; naming the role that would work turns it into \"ask an %s\".",
			"admin")
	} else if !Can(required, PermSubscribersWrite) {
		t.Errorf("required_role = %q, which does NOT hold %s — the denial names a "+
			"role that would be refused too", required, PermSubscribersWrite)
	}
	// LEAST privilege, not merely *a* sufficient role. Telling a viewer to
	// become an owner when editor suffices asks for more access than the task
	// needs, and that is how privilege creeps. A mutation reversing the search
	// order passed until this was asserted.
	if required != "" {
		for _, lower := range []Role{RoleViewer, RoleMember, RoleEditor, RoleAdmin, RoleOwner} {
			if string(lower) == required {
				break
			}
			if Can(string(lower), PermSubscribersWrite) {
				t.Errorf("required_role = %q, but %q also holds %s and is less "+
					"privileged — the denial asks for more access than the task needs",
					required, lower, PermSubscribersWrite)
				break
			}
		}
	}
	if body.Error["remedy"] == "upgrade_plan" {
		t.Error("a role refusal offered a plan upgrade; buying a bigger plan does " +
			"not grant a permission")
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store — a refusal names what this "+
			"principal may not do and must not sit in a shared cache", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
}

func TestAnAuthorisedRolePassesThrough(t *testing.T) {
	// The control: a gate that refuses everyone would satisfy the test above.
	served := false
	h := RequirePermission(PermSubscribersWrite, func(*http.Request) (string, bool) {
		return "owner", true
	})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { served = true }))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/v1/team", nil))
	if !served {
		t.Fatal("an authorised role was refused")
	}
}

func TestAMissingPrincipalIsStill401(t *testing.T) {
	// Unauthenticated is not a role problem, and must not be reported as one:
	// telling an anonymous caller to "ask an admin for the owner role" is wrong.
	h := RequirePermission(PermSubscribersWrite, func(*http.Request) (string, bool) {
		return "", false
	})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/team", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
