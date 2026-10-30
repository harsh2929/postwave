// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

func decodeDenial(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not the standard error envelope: %s", rec.Body.String())
	}
	return env.Error
}

func TestNotAnAgencyIsAConfigurationRefusal(t *testing.T) {
	rec := httptest.NewRecorder()
	writeNotAgencyDenial(rec)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", rec.Code)
	}
	e := decodeDenial(t, rec)
	if e["reason"] != string(entitlement.ReasonFlag) {
		t.Fatalf("reason=%v, want %q — this is a workspace configuration, not a "+
			"plan the caller can buy their way past", e["reason"], entitlement.ReasonFlag)
	}
	if e["code"] != "not_agency" {
		t.Fatalf("code=%v — the existing code is a client contract and must not "+
			"change under conversion", e["code"])
	}
	if e["remedy"] == entitlement.RemedyUpgradePlan {
		t.Fatalf("remedy=%v, want something a person can actually act on", e["remedy"])
	}
}
