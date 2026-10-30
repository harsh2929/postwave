// SPDX-License-Identifier: AGPL-3.0-only
package mobilepush

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteTestPushThrottledDenialUsesEntitlementContract(t *testing.T) {
	rec := httptest.NewRecorder()
	writeTestPushThrottledDenial(rec)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "60" {
		t.Fatalf("status=%d Retry-After=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
	var body struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode denial: %v", err)
	}
	if body.Error["reason"] != "quota" || body.Error["code"] != "test_push_throttled" {
		t.Fatalf("denial = %#v", body.Error)
	}
}
