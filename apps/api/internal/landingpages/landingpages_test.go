// SPDX-License-Identifier: AGPL-3.0-only
package landingpages

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// LAND-038: the schedule fields are tri-state. A nil pointer alone can't tell
// "clear the schedule" from "leave it unchanged", so UpdateInput tracks the
// key's presence separately. This locks that contract.
func TestUpdateInputScheduleTriState(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		wantHasPub bool
		wantPubNil bool
	}{
		{"absent", `{"name":"x"}`, false, true},
		{"null clears", `{"publish_at":null}`, true, true},
		{"timestamp sets", `{"publish_at":"2030-01-02T03:04:05Z"}`, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var in UpdateInput
			if err := json.Unmarshal([]byte(tc.body), &in); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if in.HasPublishAt != tc.wantHasPub {
				t.Fatalf("HasPublishAt = %v, want %v", in.HasPublishAt, tc.wantHasPub)
			}
			if (in.PublishAt == nil) != tc.wantPubNil {
				t.Fatalf("PublishAt nil = %v, want %v", in.PublishAt == nil, tc.wantPubNil)
			}
		})
	}
}

func TestCreateRejectsOversizedBody(t *testing.T) {
	deps := &Deps{}
	body := `{"slug":"spring","name":"` + strings.Repeat("x", int(landingPageJSONMaxBodyBytes)) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/landing-pages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	rec := httptest.NewRecorder()

	deps.Create(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
