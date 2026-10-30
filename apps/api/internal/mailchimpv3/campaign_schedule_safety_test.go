package mailchimpv3

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestCampaignRepositoryRejectsCompatibilityScheduleBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()

	_, err := (&Repo{}).CampaignAction(
		context.Background(),
		&middleware.Tenant{ID: "tenant-1"},
		"campaign-1",
		"schedule",
		map[string]any{"schedule_time": "2030-01-01T12:00:00Z"},
	)
	if !errors.Is(err, ErrCampaignSchedulingUnavailable) {
		t.Fatalf("schedule error=%v, want ErrCampaignSchedulingUnavailable before DB access", err)
	}
}
