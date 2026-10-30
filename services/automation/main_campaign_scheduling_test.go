package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/automation/internal/config"
)

type recurrenceTriggerProbe struct{ calls int }

func (p *recurrenceTriggerProbe) Trigger(context.Context) (int, error) {
	p.calls++
	return 1, nil
}

func TestRecurrenceStartupCannotBeEnabledByEnvironmentFlagsAlone(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		CampaignLiveDispatchEnabled: true,
		CampaignSchedulerEnabled:    true,
	}
	if campaignSchedulingStartupEnabled(cfg) {
		t.Fatal("runtime flags bypassed shared compile-time scheduling qualification")
	}
}

func TestRecurrenceAdminTriggerReturnsStablePolicyErrorWithoutCallingScanner(t *testing.T) {
	t.Parallel()

	probe := &recurrenceTriggerProbe{}
	rec := httptest.NewRecorder()
	recurrenceRunHandler(true, probe).ServeHTTP(rec,
		httptest.NewRequest(http.MethodPost, "/admin/recurrence/run", nil))
	if rec.Code != http.StatusServiceUnavailable ||
		!strings.Contains(rec.Body.String(), `"code":"campaign_scheduling_unqualified"`) {
		t.Fatalf("response=(%d,%s), want stable compile-time policy failure", rec.Code, rec.Body.String())
	}
	if probe.calls != 0 {
		t.Fatalf("disabled recurrence handler called scanner %d times", probe.calls)
	}
}
