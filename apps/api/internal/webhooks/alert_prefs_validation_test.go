package webhooks

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func alertPrefsRequest(body string) *http.Request {
	req := httptest.NewRequest(
		http.MethodPut,
		"/api/v1/webhooks/alert-prefs",
		strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(
		req.Context(),
		&middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"},
	)
	ctx = middleware.WithUser(
		ctx,
		&middleware.User{
			ID:       "22222222-2222-4222-8222-222222222222",
			TenantID: "11111111-1111-4111-8111-111111111111",
		},
	)
	return req.WithContext(ctx)
}

func TestPutAlertPrefsRequiresCompleteBoundedReplacement(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		body string
		code string
	}{
		{
			name: "partial replacement",
			body: `{"notify_auto_disabled":true}`,
			code: `"code":"invalid_alert_preferences"`,
		},
		{
			name: "missing boolean remains missing not false",
			body: `{
				"notify_auto_disabled":true,
				"notify_failure_rate":true,
				"failure_rate_pct":20,
				"latency_ms":5000
			}`,
			code: `"code":"invalid_alert_preferences"`,
		},
		{
			name: "failure rate below range",
			body: `{
				"notify_auto_disabled":true,
				"notify_failure_rate":true,
				"failure_rate_pct":0,
				"notify_latency":true,
				"latency_ms":5000
			}`,
			code: `"code":"invalid_alert_preferences"`,
		},
		{
			name: "latency above range",
			body: `{
				"notify_auto_disabled":true,
				"notify_failure_rate":true,
				"failure_rate_pct":20,
				"notify_latency":true,
				"latency_ms":600001
			}`,
			code: `"code":"invalid_alert_preferences"`,
		},
		{
			name: "unknown field",
			body: `{
				"notify_auto_disabled":true,
				"notify_failure_rate":true,
				"failure_rate_pct":20,
				"notify_latency":true,
				"latency_ms":5000,
				"tenant_id":"attacker-controlled"
			}`,
			code: `"code":"unknown_field"`,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			recorder := httptest.NewRecorder()
			(&Deps{}).PutAlertPrefsHandler(recorder, alertPrefsRequest(test.body))

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), test.code) {
				t.Fatalf("body = %q, want %q", recorder.Body.String(), test.code)
			}
		})
	}
}

func TestPutAlertPrefsAcceptsExactReplacementBeforeRepositoryBoundary(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	(&Deps{}).PutAlertPrefsHandler(recorder, alertPrefsRequest(`{
		"notify_auto_disabled":true,
		"notify_failure_rate":false,
		"failure_rate_pct":20,
		"notify_latency":false,
		"latency_ms":5000
	}`))

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf(
			"status = %d, want 503 repo boundary after valid input: %s",
			recorder.Code,
			recorder.Body.String(),
		)
	}
}
