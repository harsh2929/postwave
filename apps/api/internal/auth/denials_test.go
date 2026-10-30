// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// Four refusals on the auth surface, four different things to do about them.
//
// All four arrived as prose, so a client had one move: print it. But "ask an
// admin", "verify your email", "you already lost access" and "that isn't a
// downgrade" are not the same screen, and the last two are not even problems
// the caller can solve by asking someone.

func decodeAuthDenial(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	return env.Error
}

func TestViewerModeNeedsARole(t *testing.T) {
	// This one IS a person to go and ask.
	rec := httptest.NewRecorder()
	writeViewerModeRoleDenial(w(rec))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", rec.Code)
	}
	e := decodeAuthDenial(t, rec)
	if e["reason"] != string(entitlement.ReasonRole) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonRole)
	}
	if e["required_role"] != "admin" {
		t.Fatalf("required_role=%v, want the role named", e["required_role"])
	}
	if e["code"] != "viewer_mode_forbidden" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
}

func TestPreviewingUpwardIsARule(t *testing.T) {
	// Not a permission: an owner asking to preview as an owner is asking for
	// something the feature does not mean, and no role change makes it valid.
	rec := httptest.NewRecorder()
	writeViewerModeNotDowngradeDenial(w(rec))

	e := decodeAuthDenial(t, rec)
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonPolicy)
	}
}

func TestAnUnverifiedEmailIsTheCallersOwnToFix(t *testing.T) {
	// The one refusal here the caller resolves themselves. Classifying it as a
	// role problem would send them to an admin who cannot verify their email
	// for them.
	rec := httptest.NewRecorder()
	writeEmailNotVerifiedDenial(w(rec))

	e := decodeAuthDenial(t, rec)
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "email_not_verified" {
		t.Fatalf("code=%v, want the existing code", e["code"])
	}
	if e["message"] == "" {
		t.Fatal("no message: this is the one denial where the specific action " +
			"is the entire answer")
	}
}

func TestRevokedAccessSaysSoWithoutOfferingAnUpgrade(t *testing.T) {
	rec := httptest.NewRecorder()
	writeWorkspaceAccessRevokedDenial(w(rec))

	e := decodeAuthDenial(t, rec)
	if e["remedy"] == entitlement.RemedyUpgradePlan {
		t.Fatal("offers an upgrade to someone who was removed from a workspace")
	}
	if e["message"] == "" {
		t.Fatal("the original site sent an EMPTY message, which renders as a " +
			"blank refusal; conversion is the moment to give it one")
	}
}

// w narrows the recorder to the interface the writers take.
func w(rec *httptest.ResponseRecorder) http.ResponseWriter { return rec }

// The MFA and identity-provider refusals.
//
// Five more sites, all prose. `mfa_required` is written twice with different
// wording and means "do this now"; `mfa_policy_required` looks almost identical
// and means "your workspace demands enrolment first"; the two OAuth refusals are
// facts about what the identity provider asserted, which nothing in Moosewave can
// change. A client rendering all five identically offers one button for five
// different situations.

func TestAnMFAChallengeIsSomethingTheCallerCanDoNow(t *testing.T) {
	rec := httptest.NewRecorder()
	writeMFAChallengeDenial(w(rec), "complete a TOTP challenge before disabling MFA")

	e := decodeAuthDenial(t, rec)
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q — a step to take, not a role to acquire",
			e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "mfa_required" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
	if e["remedy"] == entitlement.RemedyUpgradePlan {
		t.Fatal("offers an upgrade for a security step")
	}
}

func TestATenantMFAPolicyIsADifferentRefusal(t *testing.T) {
	// Nearly the same words, a different situation: the workspace requires an
	// enrolled factor, so "complete the challenge" is not available — there is
	// nothing to complete yet. Sharing a code with mfa_required would make the
	// two indistinguishable to a client.
	rec := httptest.NewRecorder()
	writeMFAPolicyDenial(w(rec))

	e := decodeAuthDenial(t, rec)
	if e["code"] != "mfa_policy_required" {
		t.Fatalf("code=%v, want the distinct code preserved", e["code"])
	}
	if e["code"] == "mfa_required" {
		t.Fatal("collapsed into the challenge denial")
	}
}

func TestAProviderAssertionIsNotSomethingPostwaveCanGrant(t *testing.T) {
	// The identity provider did not assert a verified email. No role, plan or
	// admin in Moosewave changes that — the user has to go and verify it there.
	for name, write := range map[string]func(http.ResponseWriter){
		"unverified_email":    writeProviderUnverifiedEmailDenial,
		"link_email_mismatch": writeProviderEmailMismatchDenial,
	} {
		rec := httptest.NewRecorder()
		write(w(rec))
		e := decodeAuthDenial(t, rec)
		if e["reason"] != string(entitlement.ReasonPolicy) {
			t.Fatalf("%s: reason=%v, want %q", name, e["reason"], entitlement.ReasonPolicy)
		}
		if e["remedy"] == entitlement.RemedyUpgradePlan {
			t.Fatalf("%s offers an upgrade for a fact about the identity provider", name)
		}
	}
}

// The CLI credential refusals.
//
// `cliErr` produced the same {"error":{"code","message"}} envelope as everything
// else, so conversion adds classification keys without breaking a consumer — and
// the two refusals here want different answers: one is a step to take, the other
// is a person to find. A terminal user given only prose has to guess which.

func TestTheCLIRefusalsAreDistinguishable(t *testing.T) {
	mfa := httptest.NewRecorder()
	writeCLIMFARequiredDenial(w(mfa))
	role := httptest.NewRecorder()
	writeCLIInsufficientRoleDenial(w(role))

	mfaErr := decodeAuthDenial(t, mfa)
	roleErr := decodeAuthDenial(t, role)

	if mfaErr["reason"] == roleErr["reason"] {
		t.Fatalf("both classify as %v; a terminal user cannot tell 'do this now' "+
			"from 'find a colleague'", mfaErr["reason"])
	}
	if roleErr["required_role"] != "admin" {
		t.Fatalf("required_role=%v — without it a terminal user has to guess "+
			"which colleague to ask", roleErr["required_role"])
	}
	// The codes are the existing contract and must survive conversion.
	if mfaErr["code"] != "mfa_required" || roleErr["code"] != "insufficient_role" {
		t.Fatalf("codes changed: %v / %v", mfaErr["code"], roleErr["code"])
	}
}
