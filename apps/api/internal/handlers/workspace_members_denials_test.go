// SPDX-License-Identifier: AGPL-3.0-only

package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// The owner-only guard, twice, as prose.
//
// Both sites are genuine role refusals with a specific answer — go and ask an
// owner — and neither said so in a form a client could act on. Rendered as a
// generic message, the best the UI can offer is "ask an administrator", which
// is wrong here: an admin cannot grant the owner role either.

func TestOwnerOnlyRefusalsNameTheRole(t *testing.T) {
	for _, message := range []string{
		"only an owner can grant the owner role",
		"only an owner can modify another owner",
	} {
		rec := httptest.NewRecorder()
		writeOwnerRoleRequiredDenial(rec, message)

		var env struct {
			Error map[string]any `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("not the standard envelope: %s", rec.Body.String())
		}
		e := env.Error
		if e["reason"] != string(entitlement.ReasonRole) {
			t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonRole)
		}
		if e["required_role"] != "owner" {
			t.Fatalf("required_role=%v, want owner. Without it the client says "+
				"'ask an administrator', and an admin cannot grant the owner "+
				"role either", e["required_role"])
		}
		if e["code"] != "owner_role_required" {
			t.Fatalf("code=%v — the existing code is a client contract", e["code"])
		}
		if e["message"] != message {
			t.Fatalf("message=%v — the two sites refuse different things and "+
				"the wording is what distinguishes them", e["message"])
		}
	}
}

// The operator-gate refusals — three sites that are NOT about a tenant's
// entitlement and one that is.
//
// `direct_provision_disabled` is an operator switch: the route exists for ops
// emergencies and is off in production by design. `impersonation_read_only` is
// a property of the support session the caller is inside. Neither is a
// statement about what a workspace may do, and both are refusals nobody in the
// product can grant — which is precisely what ReasonFlag/ReasonPolicy encode.

func TestDirectProvisionIsAnOperatorSwitch(t *testing.T) {
	rec := httptest.NewRecorder()
	writeDirectProvisionDisabledDenial(rec)

	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	e := env.Error
	if e["reason"] != string(entitlement.ReasonFlag) {
		t.Fatalf("reason=%v, want %q — an operator switch, not a plan or a role",
			e["reason"], entitlement.ReasonFlag)
	}
	if e["code"] != "direct_provision_disabled" {
		t.Fatalf("code=%v, want the existing code preserved", e["code"])
	}
	if e["remedy"] == entitlement.RemedyUpgradePlan {
		t.Fatal("offers an upgrade for an operator gate")
	}
	// The env-var instruction has to survive: this message is read by the ops
	// engineer who needs to know how to override it.
	if msg, _ := e["message"].(string); msg == "" ||
		!contains(msg, "POSTWAVE_ALLOW_DIRECT_PROVISION") {
		t.Fatalf("message=%q lost the override instruction", e["message"])
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

// The audit surface's two genuine denials.
//
// `builtin_role` refuses deleting a role the product defines — a fact about the
// RESOURCE, not about the caller, and no permission makes a built-in role
// deletable. `missing_scope` is the audit-PII gate, which is the same class as
// the API-key scope refusals: a credential narrowing only its owner can widen.

func TestABuiltInRoleCannotBeDeletedByAnyone(t *testing.T) {
	rec := httptest.NewRecorder()
	writeBuiltInRoleDenial(rec)

	e := decodeMemberDenial(t, rec)
	if e["reason"] == string(entitlement.ReasonRole) {
		t.Fatal("reported as a role problem; no role makes a built-in role " +
			"deletable, so 'ask an admin' is advice that cannot work")
	}
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "builtin_role" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
}

func TestTheAuditPIIGateNamesTheScope(t *testing.T) {
	rec := httptest.NewRecorder()
	writeAuditPIIScopeDenial(rec)

	e := decodeMemberDenial(t, rec)
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q — a credential narrowing, not a role",
			e["reason"], entitlement.ReasonPolicy)
	}
	// The scope name is the whole answer: without it the reader cannot know
	// which scope to add to their key.
	if msg, _ := e["message"].(string); !contains(msg, "audit:read_pii") {
		t.Fatalf("message=%q lost the scope name", msg)
	}
}

func decodeMemberDenial(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	return env.Error
}
