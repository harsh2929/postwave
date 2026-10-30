// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestContentRevisionRoutesAreMountedWithCampaignSurface(t *testing.T) {
	t.Parallel()
	router := chi.NewRouter()
	deps := &Deps{}
	MountRead(router, deps)
	MountWrite(router, deps)
	want := map[string]bool{
		http.MethodPost + " /api/v1/campaigns/{id}/content-revisions":             false,
		http.MethodGet + " /api/v1/campaigns/{id}/content-revisions":              false,
		http.MethodGet + " /api/v1/campaigns/{id}/content-revisions/{revisionID}": false,
	}
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		key := method + " " + route
		if _, exists := want[key]; exists {
			want[key] = true
		}
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	for route, mounted := range want {
		if !mounted {
			t.Errorf("route not mounted: %s", route)
		}
	}
}

const (
	revisionTestTenant   = "11111111-1111-4111-8111-111111111111"
	revisionTestCampaign = "22222222-2222-4222-8222-222222222222"
	revisionTestID       = "33333333-3333-4333-8333-333333333333"
	revisionTestUser     = "44444444-4444-4444-8444-444444444444"
)

type fakeCampaignArtifactStore struct {
	freeze func(context.Context, string, string, string) (*campaignartifact.Revision, error)
	list   func(context.Context, string, string, int) ([]campaignartifact.RevisionSummary, error)
	get    func(context.Context, string, string, string) (*campaignartifact.Revision, error)
}

func (f *fakeCampaignArtifactStore) FreezeCurrent(ctx context.Context, tenantID, campaignID, actorID string) (*campaignartifact.Revision, error) {
	return f.freeze(ctx, tenantID, campaignID, actorID)
}

func (f *fakeCampaignArtifactStore) ListRevisions(ctx context.Context, tenantID, campaignID string, limit int) ([]campaignartifact.RevisionSummary, error) {
	return f.list(ctx, tenantID, campaignID, limit)
}

func (f *fakeCampaignArtifactStore) GetRevision(ctx context.Context, tenantID, campaignID, revisionID string) (*campaignartifact.Revision, error) {
	return f.get(ctx, tenantID, campaignID, revisionID)
}

func revisionRequest(method, target string, includeRevision bool) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", revisionTestCampaign)
	if includeRevision {
		route.URLParams.Add("revisionID", revisionTestID)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, route)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: revisionTestTenant})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: revisionTestUser})
	return req.WithContext(ctx)
}

func frozenRevision() *campaignartifact.Revision {
	return &campaignartifact.Revision{
		ID:                   revisionTestID,
		CampaignID:           revisionTestCampaign,
		RevisionNo:           7,
		SourceMode:           campaignartifact.SourceModeSemantic,
		ContentSchemaVersion: 2,
		Subject:              "Launch",
		SemanticTree:         json.RawMessage(`[{"id":"heading"}]`),
		FactContract:         json.RawMessage(`{}`),
		Variants:             json.RawMessage(`[]`),
		Locales:              json.RawMessage(`[]`),
		SourceHash:           "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		CreatedAt:            time.Date(2026, time.August, 9, 12, 0, 0, 0, time.UTC),
	}
}

func TestFreezeContentRevisionBindsTenantCampaignAndActor(t *testing.T) {
	t.Parallel()
	want := frozenRevision()
	store := &fakeCampaignArtifactStore{
		freeze: func(_ context.Context, tenantID, campaignID, actorID string) (*campaignartifact.Revision, error) {
			if tenantID != revisionTestTenant || campaignID != revisionTestCampaign || actorID != revisionTestUser {
				t.Fatalf("freeze identity = (%q,%q,%q)", tenantID, campaignID, actorID)
			}
			return want, nil
		},
	}
	rec := httptest.NewRecorder()
	(&Deps{Artifacts: store}).FreezeContentRevision(rec, revisionRequest(http.MethodPost,
		"/api/v1/campaigns/"+revisionTestCampaign+"/content-revisions", false))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("ETag"); got != httpcache.ETagStrong("campaign-revision", revisionTestID, 7) {
		t.Fatalf("ETag = %q", got)
	}
	var response campaignartifact.Revision
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode revision: %v", err)
	}
	if response.ID != want.ID || response.SourceHash != want.SourceHash {
		t.Fatalf("response = %+v, want id/hash from %+v", response, want)
	}
}

func TestContentRevisionHandlersValidatePathsBeforeStore(t *testing.T) {
	t.Parallel()
	called := false
	store := &fakeCampaignArtifactStore{
		freeze: func(context.Context, string, string, string) (*campaignartifact.Revision, error) {
			called = true
			return nil, errors.New("unexpected")
		},
	}
	req := revisionRequest(http.MethodPost, "/api/v1/campaigns/not-a-uuid/content-revisions", false)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", "not-a-uuid")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
	rec := httptest.NewRecorder()
	(&Deps{Artifacts: store}).FreezeContentRevision(rec, req)
	if rec.Code != http.StatusBadRequest || called {
		t.Fatalf("status=%d called=%v body=%s", rec.Code, called, rec.Body.String())
	}
}

func TestListContentRevisionsPassesBoundedLimit(t *testing.T) {
	t.Parallel()
	store := &fakeCampaignArtifactStore{
		list: func(_ context.Context, tenantID, campaignID string, limit int) ([]campaignartifact.RevisionSummary, error) {
			if tenantID != revisionTestTenant || campaignID != revisionTestCampaign || limit != 17 {
				t.Fatalf("list input = (%q,%q,%d)", tenantID, campaignID, limit)
			}
			return []campaignartifact.RevisionSummary{{
				ID: revisionTestID, CampaignID: revisionTestCampaign,
				RevisionNo: 7, SourceMode: campaignartifact.SourceModeSemantic,
				ContentSchemaVersion: 2, Subject: "Launch",
				SourceHash: frozenRevision().SourceHash,
			}}, nil
		},
	}
	rec := httptest.NewRecorder()
	(&Deps{Artifacts: store}).ListContentRevisions(rec, revisionRequest(http.MethodGet,
		"/api/v1/campaigns/"+revisionTestCampaign+"/content-revisions?limit=17", false))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var revisions []campaignartifact.RevisionSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &revisions); err != nil || len(revisions) != 1 {
		t.Fatalf("response revisions=%+v err=%v", revisions, err)
	}

	bad := httptest.NewRecorder()
	(&Deps{Artifacts: store}).ListContentRevisions(bad, revisionRequest(http.MethodGet,
		"/api/v1/campaigns/"+revisionTestCampaign+"/content-revisions?limit=101", false))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid limit status = %d", bad.Code)
	}
}

func TestGetContentRevisionSupportsImmutableConditionalRead(t *testing.T) {
	t.Parallel()
	revision := frozenRevision()
	store := &fakeCampaignArtifactStore{
		get: func(_ context.Context, tenantID, campaignID, revisionID string) (*campaignartifact.Revision, error) {
			if tenantID != revisionTestTenant || campaignID != revisionTestCampaign || revisionID != revisionTestID {
				t.Fatalf("get input = (%q,%q,%q)", tenantID, campaignID, revisionID)
			}
			return revision, nil
		},
	}
	req := revisionRequest(http.MethodGet,
		"/api/v1/campaigns/"+revisionTestCampaign+"/content-revisions/"+revisionTestID, true)
	req.Header.Set("If-None-Match", httpcache.ETagStrong("campaign-revision", revisionTestID, 7))
	rec := httptest.NewRecorder()
	(&Deps{Artifacts: store}).GetContentRevision(rec, req)
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestFreezeContentRevisionMapsIncompleteSourceAndUnavailableStore(t *testing.T) {
	t.Parallel()
	store := &fakeCampaignArtifactStore{
		freeze: func(context.Context, string, string, string) (*campaignartifact.Revision, error) {
			return nil, campaignartifact.ErrSourceIncomplete
		},
	}
	rec := httptest.NewRecorder()
	(&Deps{Artifacts: store}).FreezeContentRevision(rec, revisionRequest(http.MethodPost, "/", false))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("incomplete status=%d body=%s", rec.Code, rec.Body.String())
	}

	unavailable := httptest.NewRecorder()
	(&Deps{}).FreezeContentRevision(unavailable, revisionRequest(http.MethodPost, "/", false))
	if unavailable.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable status=%d body=%s", unavailable.Code, unavailable.Body.String())
	}
}

func TestFreezeQueueContentRevisionReusesHTTPArtifactBoundary(t *testing.T) {
	t.Parallel()
	store := &fakeCampaignArtifactStore{
		freeze: func(_ context.Context, tenantID, campaignID, actorID string) (*campaignartifact.Revision, error) {
			if tenantID != revisionTestTenant || campaignID != revisionTestCampaign || actorID != revisionTestUser {
				t.Fatalf("queue freeze input = (%q,%q,%q)", tenantID, campaignID, actorID)
			}
			return frozenRevision(), nil
		},
	}
	revision, queueErr := (&Deps{Artifacts: store}).freezeQueueContentRevision(
		context.Background(), revisionTestTenant, revisionTestCampaign,
		ApprovalActor{UserID: revisionTestUser},
	)
	if queueErr != nil || revision == nil || revision.ID != revisionTestID {
		t.Fatalf("revision=%+v queueErr=%+v", revision, queueErr)
	}

	store.freeze = func(context.Context, string, string, string) (*campaignartifact.Revision, error) {
		return nil, &campaignartifact.FactContractReferenceError{MissingBlockIDs: []string{"cta"}}
	}
	_, queueErr = (&Deps{Artifacts: store}).freezeQueueContentRevision(
		context.Background(), revisionTestTenant, revisionTestCampaign, ApprovalActor{},
	)
	if queueErr == nil || queueErr.Status != http.StatusUnprocessableEntity ||
		queueErr.Code != "fact_contract_references_invalid" {
		t.Fatalf("queueErr=%+v", queueErr)
	}
}
