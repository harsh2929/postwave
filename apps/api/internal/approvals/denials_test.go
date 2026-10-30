// SPDX-License-Identifier: AGPL-3.0-only

package approvals

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// Five refusals on this surface, four distinct causes, one affordance.
//
// `self_approval` (twice, hand-copied), `approver_mismatch`, and two `forbidden`
// envelopes all arrived as prose. A client could not tell "you personally cannot
// decide this one" from "you need the admin role" — and those want opposite
// screens: the first is a rule that no permission change resolves, the second is
// a person to go and ask.

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	return env.Error
}

func TestSelfApprovalIsARuleNotAPermission(t *testing.T) {
	// The requester cannot decide their own approval. No role grants this and
	// no plan buys it — separation of duties is the point. Classifying it as a
	// role problem would send them to an admin who also cannot help.
	rec := httptest.NewRecorder()
	writeSelfApprovalDenial(rec)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", rec.Code)
	}
	e := decode(t, rec)
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "self_approval" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
	if e["remedy"] == entitlement.RemedyUpgradePlan {
		t.Fatal("offers an upgrade for a separation-of-duties rule")
	}
}

func TestAnAdminRequirementIsARoleRefusal(t *testing.T) {
	// This one IS a person to go and ask, and the reason has to say so or the
	// client cannot render "ask a workspace admin" instead of a paywall.
	rec := httptest.NewRecorder()
	writeApprovalsRoleDenial(rec, "admin role required")

	e := decode(t, rec)
	if e["reason"] != string(entitlement.ReasonRole) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonRole)
	}
	// On the wire the server puts non-framing keys at the top of `error`;
	// @postwave/errors lifts them into `details` client-side, which is where
	// apps/web reads `details.required_role`. Assert the server's shape here —
	// asserting the client's would test the parser, not this handler.
	if e["required_role"] != "admin" {
		t.Fatalf("required_role=%v — apps/web renders the role name in "+
			"'ask a workspace <role>', so it has to be stated", e["required_role"])
	}
}

func TestALinkIssuedToSomeoneElseIsAPolicyRefusal(t *testing.T) {
	rec := httptest.NewRecorder()
	writeApproverMismatchDenial(rec)

	e := decode(t, rec)
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q — the link belongs to someone else, which "+
			"is not a role the caller can be granted", e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "approver_mismatch" {
		t.Fatalf("code=%v, want the existing code preserved", e["code"])
	}
}

func TestNoApprovalDenialOffersAnUpgrade(t *testing.T) {
	// None of these is about money. An upgrade prompt on any of them is a
	// paywall shown to someone whose workspace already paid.
	for name, write := range map[string]func(http.ResponseWriter){
		"self_approval":     writeSelfApprovalDenial,
		"approver_mismatch": writeApproverMismatchDenial,
		"role":              func(w http.ResponseWriter) { writeApprovalsRoleDenial(w, "admin role required") },
	} {
		rec := httptest.NewRecorder()
		write(rec)
		if e := decode(t, rec); e["remedy"] == entitlement.RemedyUpgradePlan {
			t.Fatalf("%s offers an upgrade", name)
		}
	}
}
