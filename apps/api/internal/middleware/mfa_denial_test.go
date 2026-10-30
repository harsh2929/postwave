// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// The MFA gate's refusal, and the writer beside it.

func TestTheMFAGateRefusalIsAStepNotARole(t *testing.T) {
	rec := httptest.NewRecorder()
	writeMFAPolicyGateDenial(rec, "tenant policy requires two-factor enrollment before retrying")

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
	if e["reason"] != string(entitlement.ReasonPolicy) {
		t.Fatalf("reason=%v, want %q — enrolling is something the caller does, "+
			"not a role they can be granted", e["reason"], entitlement.ReasonPolicy)
	}
	if e["code"] != "mfa_required" {
		t.Fatalf("code=%v — the existing code is a client contract", e["code"])
	}
}

func TestTheHandRolledWriterCannotEmitBrokenJSON(t *testing.T) {
	// It interpolated `message` straight into a JSON literal. Safe only while
	// every caller passed a quote-free constant — one message carrying a `"`
	// produced a malformed body, which a client reads as a transport failure
	// rather than the refusal it is.
	rec := httptest.NewRecorder()
	writeMFAError(rec, http.StatusServiceUnavailable, "mfa_policy_unavailable",
		`policy said "no" and \ broke`)

	var env struct {
		Error map[string]string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("emitted invalid JSON for a quoted message: %s", rec.Body.String())
	}
	if env.Error["message"] != `policy said "no" and \ broke` {
		t.Fatalf("message round-tripped as %q", env.Error["message"])
	}
}
