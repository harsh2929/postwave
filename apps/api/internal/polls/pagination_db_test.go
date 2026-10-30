// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestCampaignPollListUsesStableDefinitionKeysetPages(t *testing.T) {
	pool := pollsDB(t)
	fixture := seedSemanticPollCampaign(t, pool)
	repo := testRepo(pool)
	createdAt := time.Date(2026, time.August, 30, 10, 0, 0, 123000, time.UTC)
	ids := []string{
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000002",
		"00000000-0000-4000-8000-000000000003",
	}

	tx, err := db.WithTenant(t.Context(), pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	for index, id := range ids {
		storageKey, err := campaignStorageKey(fixture.CampaignID, fmt.Sprintf("poll-%d", index+1))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(t.Context(), `
INSERT INTO campaign_polls
    (id, tenant_id, campaign_id, content_revision_id,
     content_revision_source_hash, poll_contract_sha256, poll_key, question,
     two_step_required, created_at, token_version, accepting_responses)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, repeat('a', 64),
        repeat('b', 64), $5, $6, true, $7, 3, true)`,
			id, fixture.TenantID, fixture.CampaignID, fixture.RevisionID,
			storageKey, fmt.Sprintf("Question %d?", index+1), createdAt); err != nil {
			t.Fatal(err)
		}
		for position, optionKey := range []string{"yes", "no"} {
			if _, err := tx.Exec(t.Context(), `
INSERT INTO campaign_poll_options
    (tenant_id, poll_id, option_key, label, position)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
				fixture.TenantID, id, optionKey, optionKey, position); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	first, err := repo.ListForCampaignPage(t.Context(), fixture.TenantID, fixture.CampaignID,
		CampaignPollListInput{Limit: 2})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(first.Items) != 2 || first.Items[0].ID != ids[0] || first.Items[1].ID != ids[1] ||
		first.NextCursor == "" {
		t.Fatalf("first page=%+v", first)
	}
	if len(first.Items[0].Options) != 2 || len(first.Items[1].Options) != 2 {
		t.Fatalf("definition options were split across pages: %+v", first.Items)
	}

	second, err := repo.ListForCampaignPage(t.Context(), fixture.TenantID, fixture.CampaignID,
		CampaignPollListInput{Limit: 2, Cursor: first.NextCursor})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(second.Items) != 1 || second.Items[0].ID != ids[2] || second.NextCursor != "" {
		t.Fatalf("terminal page=%+v", second)
	}

	all, err := repo.ListForCampaignRevision(
		t.Context(), fixture.TenantID, fixture.CampaignID, fixture.RevisionID,
	)
	if err != nil || len(all) != 3 {
		t.Fatalf("bounded exact-revision walk=%+v err=%v", all, err)
	}

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(middleware.WithTenant(
				r.Context(), &middleware.Tenant{ID: fixture.TenantID},
			)))
		})
	})
	if err := MountAdminRoutes(AdminRouters{
		ReadCampaigns: router, WriteCampaigns: router, ReadReports: router,
	}, &Deps{Repo: repo}); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/campaigns/" + fixture.CampaignID + "/polls?limit=2"
	firstHTTP := httptest.NewRecorder()
	router.ServeHTTP(firstHTTP, httptest.NewRequest(http.MethodGet, base, nil))
	if firstHTTP.Code != http.StatusOK {
		t.Fatalf("first HTTP page=%d body=%s", firstHTTP.Code, firstHTTP.Body.String())
	}
	var firstBody CampaignPollListPage
	if err := json.Unmarshal(firstHTTP.Body.Bytes(), &firstBody); err != nil {
		t.Fatal(err)
	}
	if len(firstBody.Items) != 2 || firstBody.NextCursor == "" {
		t.Fatalf("first HTTP page=%+v", firstBody)
	}
	terminalHTTP := httptest.NewRecorder()
	router.ServeHTTP(terminalHTTP, httptest.NewRequest(http.MethodGet,
		base+"&cursor="+url.QueryEscape(firstBody.NextCursor), nil))
	if terminalHTTP.Code != http.StatusOK ||
		strings.Contains(terminalHTTP.Body.String(), `"next_cursor"`) {
		t.Fatalf("terminal HTTP page=%d body=%s", terminalHTTP.Code, terminalHTTP.Body.String())
	}
}
