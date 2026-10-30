// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteFormUploadQuotaDenialUsesEntitlementContract(t *testing.T) {
	rec := httptest.NewRecorder()
	writeFormUploadQuotaDenial(rec, "too_many_quarantined_uploads", "wait for scanning")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	var body struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode denial: %v", err)
	}
	if body.Error["reason"] != "quota" || body.Error["code"] != "too_many_quarantined_uploads" || body.Error["subject"] != "form_upload" {
		t.Fatalf("denial = %#v", body.Error)
	}
}

func TestWriteFormUploadIPRateLimitStaysOpaqueProtocolBoundary(t *testing.T) {
	rec := httptest.NewRecorder()
	writeFormUploadIPRateLimit(rec)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if rec.Body.String() == "" {
		t.Fatal("rate-limit response is empty")
	}
}
