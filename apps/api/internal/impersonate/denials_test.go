// SPDX-License-Identifier: AGPL-3.0-only

package impersonate

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// A read-only support session refusing a write is not a permission problem.
//
// The support engineer's own role may be unlimited; what limits them is the
// SESSION they are inside, which they chose when they started it. Rendered as
// prose a client can only say "forbidden", and the two natural readings — "ask
// for more access" and "your account is limited" — are both wrong. The answer is
// specific: change the scope, or end and restart the session.

func TestAReadOnlyImpersonationSessionSaysWhatToDo(t *testing.T) {
	rec := httptest.NewRecorder()
	writeImpersonationReadOnlyDenial(rec)

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
		t.Fatalf("reason=%v, want %q — the SESSION is read-only, not the person",
			e["reason"], entitlement.ReasonPolicy)
	}
	if e["reason"] == string(entitlement.ReasonRole) {
		t.Fatal("reported as a role problem; the engineer's role may be unlimited")
	}
	if e["code"] != "impersonation_read_only" {
		t.Fatalf("code=%v, want the existing code preserved", e["code"])
	}
	// The instruction is the whole value of this message.
	msg, _ := e["message"].(string)
	if msg == "" || !has(msg, "scope") {
		t.Fatalf("message=%q lost the specific remedy", msg)
	}
}

func has(h, n string) bool {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return true
		}
	}
	return false
}
