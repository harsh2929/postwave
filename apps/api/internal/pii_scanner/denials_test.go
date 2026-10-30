// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// A PII finding needs a reviewer who can be named later.
//
// This refuses a caller with no stable identity — an API key, say — from
// recording a review decision. It is not a role refusal: no role turns an
// anonymous credential into a person, and telling someone to ask an admin sends
// them somewhere that cannot help. It is a property of HOW they authenticated,
// and the answer is to sign in as themselves.

func TestReviewingAFindingNeedsANameableReviewer(t *testing.T) {
	rec := httptest.NewRecorder()
	writeStableReviewerRequiredDenial(rec)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", rec.Code)
	}
	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard envelope: %s", rec.Body.String())
	}
	e := env.Error
	if e["reason"] == string(entitlement.ReasonRole) {
		t.Fatal("reported as a role refusal; no role turns an anonymous " +
			"credential into a person")
	}
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q", e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "stable_reviewer_required" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
	if e["remedy"] == entitlement.RemedyUpgradePlan {
		t.Fatal("offers an upgrade for an authentication-method requirement")
	}
}
