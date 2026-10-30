// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteAuditNLQCostCapDenialUsesEntitlementQuotaContract(t *testing.T) {
	rec := httptest.NewRecorder()
	writeAuditNLQCostCapDenial(rec, "daily limit reached")
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("status=%d Retry-After=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
	var body struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode denial: %v", err)
	}
	if body.Error["reason"] != "quota" || body.Error["code"] != "cost_cap_exceeded" || body.Error["subject"] != "audit_nlq" {
		t.Fatalf("denial = %#v", body.Error)
	}
}
