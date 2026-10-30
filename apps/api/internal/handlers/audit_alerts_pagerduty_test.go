// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestVerifyPagerDutyChecksDocumentedLengthWithoutEchoingCredential(t *testing.T) {
	for _, tc := range []struct {
		name, key string
		status    int
	}{
		{"short placeholder", "not-a-key", http.StatusBadRequest},
		{"31 characters", strings.Repeat("a", 31), http.StatusBadRequest},
		{"33 characters", strings.Repeat("a", 33), http.StatusBadRequest},
		{"32 characters", strings.Repeat("a", 32), http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]string{"routing_key": tc.key})
			r := httptest.NewRequest(http.MethodPost, "/api/v1/audit-alerts/pagerduty/auth", strings.NewReader(string(body)))
			r.Header.Set("Content-Type", "application/json")
			r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "00000000-0000-4000-8000-000000000001"}))
			w := httptest.NewRecorder()
			(&AuditAlertChannelHandlers{}).VerifyPagerDuty(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.status, w.Body.String())
			}
			if strings.Contains(w.Body.String(), tc.key) {
				t.Fatal("response echoed the supplied routing key")
			}
		})
	}
}
