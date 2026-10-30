// SPDX-License-Identifier: AGPL-3.0-only
//
// members_db_test.go — GET /api/v1/segments/{id}/members answers "who is in
// this segment" live, without a snapshot first.

package segments

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestLiveMembersFollowTheSegmentsOwnScope_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool) // 2 active + 1 archived match
	repo := &Repo{Pool: pool}
	router := segmentsRouter(&Deps{Repo: repo})
	ctx := context.Background()

	active, err := repo.Create(ctx, tenantID, CreateInput{Name: "Live active " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	resp := serveSegments(t, router, tenantID, http.MethodGet, "/api/v1/segments/"+active.ID+"/members", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("members = %d %s", resp.Code, resp.Body.String())
	}
	if resp.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("members response is cacheable: %q", resp.Header().Get("Cache-Control"))
	}
	page := decodeBody[LiveMembersResponse](t, resp)
	if page.Total != 2 || len(page.Items) != 2 || page.ArchiveScope != "active_only" || page.Page != 1 || page.PerPage != 50 {
		t.Fatalf("active members = %+v", page)
	}
	for _, m := range page.Items {
		if !strings.Contains(m.Email, marker) || m.Archived || m.SubscriberID == "" {
			t.Fatalf("unexpected member %+v", m)
		}
	}

	withArchived, err := repo.Create(ctx, tenantID, CreateInput{Name: "Live archived " + marker, QueryAST: markerAST(marker), IncludeArchived: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	page = decodeBody[LiveMembersResponse](t, serveSegments(t, router, tenantID, http.MethodGet, "/api/v1/segments/"+withArchived.ID+"/members", nil))
	if page.Total != 3 || len(page.Items) != 3 || page.ArchiveScope != "including_archived" {
		t.Fatalf("include-archived members = %+v", page)
	}
	archived := 0
	for _, m := range page.Items {
		if m.Archived {
			archived++
			if !strings.HasPrefix(m.Email, "archived-") {
				t.Fatalf("%s flagged archived", m.Email)
			}
		}
	}
	if archived != 1 {
		t.Fatalf("%d members flagged archived, want 1", archived)
	}

	// Pages are disjoint, cover the set, and keep the total.
	seen := map[string]bool{}
	for p := 1; p <= 3; p++ {
		page = decodeBody[LiveMembersResponse](t, serveSegments(t, router, tenantID, http.MethodGet,
			"/api/v1/segments/"+withArchived.ID+"/members?per_page=1&page="+string(rune('0'+p)), nil))
		if page.Total != 3 || len(page.Items) != 1 {
			t.Fatalf("page %d = %+v", p, page)
		}
		if seen[page.Items[0].SubscriberID] {
			t.Fatalf("page %d repeats %s", p, page.Items[0].Email)
		}
		seen[page.Items[0].SubscriberID] = true
	}
	page = decodeBody[LiveMembersResponse](t, serveSegments(t, router, tenantID, http.MethodGet,
		"/api/v1/segments/"+withArchived.ID+"/members?per_page=1&page=4", nil))
	if page.Total != 3 || len(page.Items) != 0 {
		t.Fatalf("past the end = %+v, want no items and the total", page)
	}
}

func TestLiveMembersRefusals_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	otherTenant, otherMarker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	router := segmentsRouter(&Deps{Repo: repo})
	ctx := context.Background()
	seg, err := repo.Create(ctx, tenantID, CreateInput{Name: "Guarded " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	foreign, err := repo.Create(ctx, otherTenant, CreateInput{Name: "Foreign " + otherMarker, QueryAST: markerAST(otherMarker)})
	if err != nil {
		t.Fatalf("create foreign: %v", err)
	}
	path := "/api/v1/segments/" + seg.ID + "/members"

	if resp := serveSegments(t, router, tenantID, http.MethodGet, "/api/v1/segments/"+foreign.ID+"/members", nil); resp.Code != http.StatusNotFound {
		t.Fatalf("another tenant's segment = %d %s, want 404", resp.Code, resp.Body.String())
	}
	if resp := serveSegments(t, router, tenantID, http.MethodGet, "/api/v1/segments/"+uuid.NewString()+"/members", nil); resp.Code != http.StatusNotFound {
		t.Fatalf("unknown segment = %d, want 404", resp.Code)
	}
	for _, query := range []string{"?per_page=0", "?per_page=201", "?page=0", "?page=x", "?page=1000001"} {
		resp := serveSegments(t, router, tenantID, http.MethodGet, path+query, nil)
		if resp.Code != http.StatusBadRequest || decodeBody[errorEnvelope](t, resp).Error.Code != "bad_pagination" {
			t.Fatalf("%s = %d %s, want 400 bad_pagination", query, resp.Code, resp.Body.String())
		}
	}

	// An API key needs read:subscribers; one scoped to campaigns is refused.
	apiKey := func(scopes ...apikeys.Scope) func(context.Context) context.Context {
		return func(c context.Context) context.Context {
			c = middleware.WithTenant(c, &middleware.Tenant{ID: tenantID})
			c = middleware.WithAPIKeyAuth(c)
			return apikeys.WithScopes(c, scopes)
		}
	}
	if resp := serveSegmentsWith(t, router, http.MethodGet, path, nil, apiKey(apikeys.ScopeReadCampaigns)); resp.Code != http.StatusForbidden {
		t.Fatalf("campaign-scoped key = %d %s, want 403", resp.Code, resp.Body.String())
	}
	if resp := serveSegmentsWith(t, router, http.MethodGet, path, nil, apiKey(apikeys.ScopeReadSubscribers)); resp.Code != http.StatusOK {
		t.Fatalf("read:subscribers key = %d %s, want 200", resp.Code, resp.Body.String())
	}

	// A stored definition that no longer compiles is the segment's problem,
	// said in words, not a 500 and not a blame-the-request 400.
	broken, err := repo.Create(ctx, tenantID, CreateInput{Name: "Broken " + marker, QueryAST: rawJSON(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"` + seg.ID + `"}`)})
	if err != nil {
		t.Fatalf("create composed: %v", err)
	}
	withTenantTx(t, pool, tenantID, func(_ context.Context, exec func(string, ...any)) {
		exec(`DELETE FROM segments WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, seg.ID)
	})
	resp := serveSegments(t, router, tenantID, http.MethodGet, "/api/v1/segments/"+broken.ID+"/members", nil)
	if resp.Code != http.StatusUnprocessableEntity || decodeBody[errorEnvelope](t, resp).Error.Code != "segment_rules_invalid" {
		t.Fatalf("broken definition = %d %s, want 422 segment_rules_invalid", resp.Code, resp.Body.String())
	}
}
