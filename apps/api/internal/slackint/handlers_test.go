package slackint

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestListReturnsServiceUnavailableWhenRepoMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/integrations/slack", nil)
	rec := httptest.NewRecorder()

	(&Deps{}).List(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "repo_unavailable") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestUpdateNoEventsReturnsSpecificError(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPatch, "/api/v1/integrations/slack/slack_1", strings.NewReader(`{"events":[]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	(&Deps{}).Update(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no_events") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestUpdateMissingKEKReturnsSpecificError(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPatch, "/api/v1/integrations/slack/slack_1", strings.NewReader(`{
		"url": "https://hooks.slack.com/services/TABC123/BDEF456/abcdef123456"
	}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	(&Deps{Repo: &Repo{}}).Update(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "kek_unconfigured") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
