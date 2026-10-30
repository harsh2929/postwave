// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// Device trust is the flag denial that DOES have a remedy.
//
// Most ReasonFlag refusals in this codebase have none — `is_agency_account` and
// the ops provisioning switch are not things a workspace admin can change. This
// one is: an admin can turn "remember this device" on, so withholding the remedy
// would leave a user stuck in front of a setting somebody they know controls.

func TestDeviceTrustDisabledPointsAtSomeoneWhoCanFixIt(t *testing.T) {
	rec := httptest.NewRecorder()
	writeDeviceTrustDisabledDenial(w(rec))

	e := decodeAuthDenial(t, rec)
	if e["reason"] != string(entitlement.ReasonFlag) {
		t.Fatalf("reason=%v, want %q — workspace configuration",
			e["reason"], entitlement.ReasonFlag)
	}
	if e["remedy"] != entitlement.RemedyContactWorkspaceAdmin {
		t.Fatalf("remedy=%v, want %q — unlike most flag denials here, an admin "+
			"really can turn this on", e["remedy"], entitlement.RemedyContactWorkspaceAdmin)
	}
	if e["remedy"] == entitlement.RemedyUpgradePlan {
		t.Fatal("offers an upgrade for a workspace setting")
	}
}
