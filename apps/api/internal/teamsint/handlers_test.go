package teamsint

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestCreateInvalidURLReturnsTeamsGuidance(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/v1/integrations/teams", strings.NewReader(`{
		"url": "https://discord.com/api/webhooks/123/secret",
		"events": ["campaign.sent"]
	}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	(&Deps{Repo: &Repo{}}).Create(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Microsoft Teams webhook URL") {
		t.Fatalf("body should mention Teams guidance, got %s", body)
	}
	if strings.Contains(body, "Discord") {
		t.Fatalf("body should not mention Discord, got %s", body)
	}
}

func TestCreateMissingKEKReturnsTeamsGuidance(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/v1/integrations/teams", strings.NewReader(`{
		"url": "https://outlook.office.com/webhook/abc",
		"events": ["campaign.sent"]
	}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	(&Deps{Repo: &Repo{}}).Create(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Teams integrations require POSTWAVE_SENDING_KEK") {
		t.Fatalf("body should mention Teams KEK guidance, got %s", body)
	}
	if strings.Contains(body, "Discord") {
		t.Fatalf("body should not mention Discord, got %s", body)
	}
}

func TestListReturnsServiceUnavailableWhenRepoMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/integrations/teams", nil)
	rec := httptest.NewRecorder()

	(&Deps{}).List(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "repo_unavailable") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestUpdateNoEventsReturnsSpecificError(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPatch, "/api/v1/integrations/teams/teams_1", strings.NewReader(`{"events":[]}`))
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
	req := httptest.NewRequestWithContext(ctx, http.MethodPatch, "/api/v1/integrations/teams/teams_1", strings.NewReader(`{
		"url": "https://outlook.office.com/webhook/abc"
	}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	(&Deps{Repo: &Repo{}}).Update(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "kek_unconfigured") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
