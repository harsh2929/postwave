// SPDX-License-Identifier: AGPL-3.0-only

package apikeys

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// The route gate's refusals — eight sites, two distinct causes.
//
// `insufficient_role` is a person: someone with a higher role can do this, so
// the affordance is to go and ask them. `insufficient_scope` is a CREDENTIAL:
// the API key was minted without the permission, and no colleague can fix that —
// the key's owner has to issue a new one. Asking an admin for a role change does
// nothing for a scoped key.
//
// Both went out as 403-with-prose, so a client had one answer for both, and the
// wrong one sends an integrator to their workspace admin instead of to their own
// key settings.

func decodeGate(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	return env.Error
}

func TestARoleRefusalPointsAtAPerson(t *testing.T) {
	rec := httptest.NewRecorder()
	writeInsufficientRoleDenial(rec, "this route requires a higher role")

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", rec.Code)
	}
	e := decodeGate(t, rec)
	if e["reason"] != string(entitlement.ReasonRole) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonRole)
	}
	if e["code"] != "insufficient_role" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
}

func TestAScopeRefusalPointsAtTheCredential(t *testing.T) {
	// The distinction that matters. A scoped API key cannot be fixed by any
	// role change, so classifying it as a role problem sends an integrator to
	// their workspace admin instead of to their own key settings.
	rec := httptest.NewRecorder()
	writeInsufficientScopeDenial(rec, "api key does not have permission for this route")

	e := decodeGate(t, rec)
	if e["reason"] == string(entitlement.ReasonRole) {
		t.Fatal("a credential's missing scope was reported as a role problem")
	}
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "insufficient_scope" {
		t.Fatalf("code=%v, want the existing code preserved", e["code"])
	}
}

func TestTheTwoRefusalsAreDistinguishable(t *testing.T) {
	role := httptest.NewRecorder()
	writeInsufficientRoleDenial(role, "x")
	scope := httptest.NewRecorder()
	writeInsufficientScopeDenial(scope, "y")

	if decodeGate(t, role)["reason"] == decodeGate(t, scope)["reason"] {
		t.Fatal("a role refusal and a scope refusal still classify identically; " +
			"a client cannot tell 'ask a colleague' from 'reissue your key'")
	}
}

func TestNeitherOffersAnUpgrade(t *testing.T) {
	// Neither is about money. An upgrade prompt on either is a paywall shown to
	// someone whose workspace already paid.
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"role":  httptest.NewRecorder(),
		"scope": httptest.NewRecorder(),
	} {
		if name == "role" {
			writeInsufficientRoleDenial(rec, "x")
		} else {
			writeInsufficientScopeDenial(rec, "y")
		}
		if decodeGate(t, rec)["remedy"] == entitlement.RemedyUpgradePlan {
			t.Fatalf("%s offers an upgrade", name)
		}
	}
}
