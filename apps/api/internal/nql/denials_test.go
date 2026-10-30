// SPDX-License-Identifier: AGPL-3.0-only
package nql

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestWriteNLQCostCapDenialUsesEntitlementQuotaContract(t *testing.T) {
	rec := httptest.NewRecorder()
	writeNLQCostCapDenial(rec, "daily limit reached")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if seconds, err := strconv.Atoi(rec.Header().Get("Retry-After")); err != nil || seconds < 1 || seconds > 24*60*60 {
		t.Fatalf("Retry-After = %q, want seconds until UTC midnight", rec.Header().Get("Retry-After"))
	}
	var body struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode denial: %v", err)
	}
	if body.Error["reason"] != "quota" || body.Error["code"] != "cost_cap_exceeded" || body.Error["resource"] != "daily_nlq_tokens" {
		t.Fatalf("denial = %#v", body.Error)
	}
}
