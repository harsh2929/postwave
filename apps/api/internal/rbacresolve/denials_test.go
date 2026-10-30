// SPDX-License-Identifier: AGPL-3.0-only

package rbacresolve

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// Two refusals side by side that mean opposite things.
//
// `insufficient_permission` is a role denial: someone with the right role can
// do this, so the affordance is to go and ask them. `permission_check_failed`
// is the fail-closed path when the grant store cannot be READ — nothing about
// the caller is wrong, and asking an admin to change their role would be
// useless advice for an outage.
//
// Both went out as a 403 with prose, so a client could only ever render one
// answer for both. The second is also the more damaging to misreport: it tells
// a user their permissions are lacking when in fact the system could not look.

func decodeDeny(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	return env.Error
}

func TestAMissingPermissionIsARoleRefusal(t *testing.T) {
	rec := httptest.NewRecorder()
	writeInsufficientPermissionDenial(rec, "campaigns.send")

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", rec.Code)
	}
	e := decodeDeny(t, rec)
	if e["reason"] != string(entitlement.ReasonRole) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonRole)
	}
	if e["code"] != "insufficient_permission" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
	// The permission name has to survive: "your role does not have the X
	// permission" is the only part of this message that helps anyone.
	if msg, _ := e["message"].(string); msg == "" || !contains(msg, "campaigns.send") {
		t.Fatalf("message=%q lost the permission name", e["message"])
	}
}

func TestAnUnreadableGrantStoreIsNotTheCallersFault(t *testing.T) {
	// The fail-closed path. Reporting it as a role problem tells a user their
	// permissions are lacking when the system could not look — and sends them
	// to an admin who will find nothing wrong.
	rec := httptest.NewRecorder()
	writePermissionCheckFailedDenial(rec)

	e := decodeDeny(t, rec)
	if e["reason"] == string(entitlement.ReasonRole) {
		t.Fatal("an outage was reported as a role refusal")
	}
	if e["reason"] != string(entitlement.ReasonRuntime) {
		t.Fatalf("reason=%v, want %q — nothing the caller does changes it",
			e["reason"], entitlement.ReasonRuntime)
	}
	if e["code"] != "permission_check_failed" {
		t.Fatalf("code=%v, want the existing code", e["code"])
	}
}

func TestTheTwoAreDistinguishable(t *testing.T) {
	// The property that matters: a client switching on `reason` gets a
	// different answer for each. Before conversion both were `403` + prose.
	role := httptest.NewRecorder()
	writeInsufficientPermissionDenial(role, "campaigns.send")
	outage := httptest.NewRecorder()
	writePermissionCheckFailedDenial(outage)

	if decodeDeny(t, role)["reason"] == decodeDeny(t, outage)["reason"] {
		t.Fatal("a role refusal and a store outage still classify identically")
	}
}

func contains(h, n string) bool {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return true
		}
	}
	return false
}
