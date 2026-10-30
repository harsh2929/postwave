// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	discoveryIntegrityTenantID = "11111111-1111-4111-8111-111111111111"
	discoveryIntegrityUserID   = "22222222-2222-4222-8222-222222222222"
	discoveryIntegrityObjectID = "33333333-3333-4333-8333-333333333333"
)

type discoveryIntegrityRepo struct {
	templateRepository
	templateDiscoveryRepository

	searchCalls       int
	collectionVersion int64
	savedVersion      int64
}

func (repo *discoveryIntegrityRepo) Search(
	context.Context,
	string,
	SearchFilter,
) (*SearchResponse, error) {
	repo.searchCalls++
	return &SearchResponse{Items: []Template{}, Facets: CatalogFacets{}}, nil
}

func (*discoveryIntegrityRepo) CompareTemplates(
	_ context.Context,
	_, _ string,
	identifiers []string,
) (*CompareTemplatesResponse, error) {
	return &CompareTemplatesResponse{
		Items: []CompareTemplateItem{
			{
				RequestedIdentifier: identifiers[0],
				MatchedBy:           "id",
				Template:            Template{ID: identifiers[0]},
			},
			{
				RequestedIdentifier: identifiers[2],
				MatchedBy:           "slug",
				Template:            Template{ID: discoveryIntegrityObjectID},
			},
		},
		UnavailableIdentifiers: []string{identifiers[1]},
	}, nil
}

func (repo *discoveryIntegrityRepo) CreateCollectionIdempotent(
	_ context.Context,
	_, _, _ string,
	in CreateCampaignTemplateCollectionInput,
) (*CampaignTemplateCollection, error) {
	if in.Name == "Different" {
		return nil, ErrDiscoveryIdempotencyReuse
	}
	out := &CampaignTemplateCollection{
		ID: discoveryIntegrityObjectID, Name: in.Name,
		Description: in.Description, TemplateIDs: []string{}, Items: []Template{},
		Version: 1,
	}
	out.ETag = collectionETag(out)
	return out, nil
}

func (repo *discoveryIntegrityRepo) UpdateCollectionIfVersion(
	_ context.Context,
	_, _, id string,
	expectedVersion int64,
	_ UpdateCampaignTemplateCollectionInput,
) (*CampaignTemplateCollection, error) {
	if expectedVersion != repo.collectionVersion {
		return nil, ErrDiscoveryPrecondition
	}
	out := &CampaignTemplateCollection{
		ID: id, Name: "Updated", TemplateIDs: []string{}, Items: []Template{},
		Version: expectedVersion + 1,
	}
	out.ETag = collectionETag(out)
	return out, nil
}

func (repo *discoveryIntegrityRepo) ReplaceCollectionItemsIfVersion(
	ctx context.Context,
	tenantID, userID, id string,
	expectedVersion int64,
	_ []string,
) (*CampaignTemplateCollection, error) {
	return repo.UpdateCollectionIfVersion(
		ctx, tenantID, userID, id, expectedVersion,
		UpdateCampaignTemplateCollectionInput{},
	)
}

func (repo *discoveryIntegrityRepo) DeleteCollectionIfVersion(
	_ context.Context,
	_, _, _ string,
	expectedVersion int64,
) (bool, error) {
	if expectedVersion != repo.collectionVersion {
		return false, ErrDiscoveryPrecondition
	}
	return true, nil
}

func (repo *discoveryIntegrityRepo) CreateSavedSearchIdempotent(
	_ context.Context,
	_, _, _ string,
	in CreateCampaignTemplateSavedSearchInput,
) (*CampaignTemplateSavedSearch, error) {
	if in.Name == "Different" {
		return nil, ErrDiscoveryIdempotencyReuse
	}
	out := &CampaignTemplateSavedSearch{
		ID: discoveryIntegrityObjectID, Name: in.Name, Filters: in.Filters,
		ObsoleteFilters: []CampaignTemplateSavedSearchFilter{},
		Version:         1,
	}
	out.ETag = savedSearchETag(out)
	return out, nil
}

func (repo *discoveryIntegrityRepo) UpdateSavedSearchIfVersion(
	_ context.Context,
	_, _, id string,
	expectedVersion int64,
	_ UpdateCampaignTemplateSavedSearchInput,
) (*CampaignTemplateSavedSearch, error) {
	if expectedVersion != repo.savedVersion {
		return nil, ErrDiscoveryPrecondition
	}
	out := &CampaignTemplateSavedSearch{
		ID: id, Name: "Updated", Filters: SavedSearchFilters{},
		ObsoleteFilters: []CampaignTemplateSavedSearchFilter{},
		Version:         expectedVersion + 1,
	}
	out.ETag = savedSearchETag(out)
	return out, nil
}

func (repo *discoveryIntegrityRepo) DeleteSavedSearchIfVersion(
	_ context.Context,
	_, _, _ string,
	expectedVersion int64,
) (bool, error) {
	if expectedVersion != repo.savedVersion {
		return false, ErrDiscoveryPrecondition
	}
	return true, nil
}

func discoveryIntegrityRequest(method, target, body string, withUser bool) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: discoveryIntegrityTenantID,
	})
	if withUser {
		ctx = middleware.WithUser(ctx, &middleware.User{
			ID: discoveryIntegrityUserID, TenantID: discoveryIntegrityTenantID,
		})
	}
	return req.WithContext(ctx)
}

func TestCatalogSearchOwnershipFiltersRequireBoundUser(t *testing.T) {
	for _, source := range []string{"mine", "team", "MINE", "TEAM"} {
		t.Run(strings.TrimSpace(source), func(t *testing.T) {
			repo := &discoveryIntegrityRepo{}
			deps := &Deps{Repo: repo}
			rec := httptest.NewRecorder()
			deps.Search(
				rec,
				discoveryIntegrityRequest(
					http.MethodGet,
					"/api/v1/campaign-templates/search?source="+source,
					"",
					false,
				),
			)
			if rec.Code != http.StatusUnauthorized ||
				!strings.Contains(rec.Body.String(), `"code":"no_user"`) {
				t.Fatalf("status/body = %d %s", rec.Code, rec.Body.String())
			}
			if repo.searchCalls != 0 {
				t.Fatalf("repository called %d times without a user", repo.searchCalls)
			}
		})
	}
}

func TestCatalogSearchRepositoryOwnershipFiltersFailBeforeDatabase(t *testing.T) {
	repo := &Repo{}
	for _, source := range []string{"mine", "team"} {
		if _, err := repo.Search(
			context.Background(),
			discoveryIntegrityTenantID,
			SearchFilter{Source: source},
		); err != ErrDiscoveryUserRequired {
			t.Fatalf("source=%s error=%v, want ErrDiscoveryUserRequired", source, err)
		}
	}
}

func TestCompareHandlerPreservesAvailableOrderAndReportsUnavailable(t *testing.T) {
	repo := &discoveryIntegrityRepo{}
	deps := &Deps{Repo: repo}
	first := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	missing := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	last := "weekly"
	rec := httptest.NewRecorder()
	deps.CompareTemplates(
		rec,
		discoveryIntegrityRequest(
			http.MethodGet,
			"/api/v1/campaign-templates/compare?template="+first+
				"&template="+missing+"&template="+last,
			"",
			true,
		),
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var response CompareTemplatesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode compare response: %v", err)
	}
	if len(response.Items) != 2 ||
		response.Items[0].RequestedIdentifier != first ||
		response.Items[1].RequestedIdentifier != last ||
		len(response.UnavailableIdentifiers) != 1 ||
		response.UnavailableIdentifiers[0] != missing {
		t.Fatalf("compare response = %#v", response)
	}
}

func TestObsoleteSavedSearchFiltersReportsLegacyInvalidEnumsWithoutMutation(t *testing.T) {
	filters := SavedSearchFilters{
		Goal:     "retired-goal",
		Kind:     "retired-kind",
		Archived: "retired-archive-mode",
		Sort:     "retired-sort",
	}
	obsolete := obsoleteSavedSearchFilters(
		filters,
		map[savedSearchTaxonomyKey]struct{}{},
	)
	if len(obsolete) != 4 ||
		obsolete[0].Field != "goal" ||
		obsolete[1].Field != "kind" ||
		obsolete[2].Field != "archived" ||
		obsolete[3].Field != "sort" {
		t.Fatalf("legacy obsolete filters = %#v", obsolete)
	}
	if filters.Goal != "retired-goal" ||
		filters.Kind != "retired-kind" ||
		filters.Archived != "retired-archive-mode" ||
		filters.Sort != "retired-sort" {
		t.Fatalf("obsolete detection mutated persisted filters: %#v", filters)
	}
}

func TestDiscoveryIfMatchRequiresOneExactStrongResourceVersion(t *testing.T) {
	resource := "campaign-template-collection"
	valid := httpcache.ETagStrong(resource, discoveryIntegrityObjectID, 7)
	tests := []struct {
		name   string
		values []string
		status int
		ok     bool
	}{
		{name: "missing", status: http.StatusPreconditionRequired},
		{name: "blank", values: []string{""}, status: http.StatusPreconditionRequired},
		{name: "wildcard", values: []string{"*"}, status: http.StatusPreconditionRequired},
		{name: "weak", values: []string{"W/" + valid}, status: http.StatusPreconditionFailed},
		{name: "multiple", values: []string{valid, valid}, status: http.StatusPreconditionFailed},
		{name: "cross resource", values: []string{httpcache.ETagStrong("other", discoveryIntegrityObjectID, 7)}, status: http.StatusPreconditionFailed},
		{name: "valid", values: []string{valid}, ok: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, "/", nil)
			for _, value := range test.values {
				req.Header.Add("If-Match", value)
			}
			rec := httptest.NewRecorder()
			version, ok := requireDiscoveryIfMatch(
				rec, req, resource, discoveryIntegrityObjectID,
			)
			if ok != test.ok {
				t.Fatalf("ok=%v, want %v; body=%s", ok, test.ok, rec.Body.String())
			}
			if test.ok {
				if version != 7 {
					t.Fatalf("version=%d, want 7", version)
				}
			} else if rec.Code != test.status {
				t.Fatalf("status=%d, want %d; body=%s", rec.Code, test.status, rec.Body.String())
			}
		})
	}
}

func TestDiscoveryMutationHandlersRequireCurrentVersion(t *testing.T) {
	repo := &discoveryIntegrityRepo{collectionVersion: 2, savedVersion: 2}
	deps := &Deps{Repo: repo}
	router := chi.NewRouter()
	router.Patch("/collections/{id}", deps.UpdateCollection)
	router.Put("/collections/{id}/items", deps.ReplaceCollectionItems)
	router.Delete("/collections/{id}", deps.DeleteCollection)
	router.Patch("/saved/{id}", deps.UpdateSavedSearch)
	router.Delete("/saved/{id}", deps.DeleteSavedSearch)

	tests := []struct {
		name, method, path, body string
		header                   string
		status                   int
	}{
		{name: "collection update missing", method: http.MethodPatch, path: "/collections/" + discoveryIntegrityObjectID, body: `{"name":"Updated"}`, status: http.StatusPreconditionRequired},
		{name: "collection update stale", method: http.MethodPatch, path: "/collections/" + discoveryIntegrityObjectID, body: `{"name":"Updated"}`, header: httpcache.ETagStrong("campaign-template-collection", discoveryIntegrityObjectID, 1), status: http.StatusPreconditionFailed},
		{name: "collection reorder stale", method: http.MethodPut, path: "/collections/" + discoveryIntegrityObjectID + "/items", body: `{"template_ids":[]}`, header: httpcache.ETagStrong("campaign-template-collection", discoveryIntegrityObjectID, 1), status: http.StatusPreconditionFailed},
		{name: "collection delete stale", method: http.MethodDelete, path: "/collections/" + discoveryIntegrityObjectID, header: httpcache.ETagStrong("campaign-template-collection", discoveryIntegrityObjectID, 1), status: http.StatusPreconditionFailed},
		{name: "saved update stale", method: http.MethodPatch, path: "/saved/" + discoveryIntegrityObjectID, body: `{"name":"Updated"}`, header: httpcache.ETagStrong("campaign-template-saved-search", discoveryIntegrityObjectID, 1), status: http.StatusPreconditionFailed},
		{name: "saved delete stale", method: http.MethodDelete, path: "/saved/" + discoveryIntegrityObjectID, header: httpcache.ETagStrong("campaign-template-saved-search", discoveryIntegrityObjectID, 1), status: http.StatusPreconditionFailed},
		{name: "collection update current", method: http.MethodPatch, path: "/collections/" + discoveryIntegrityObjectID, body: `{"name":"Updated"}`, header: httpcache.ETagStrong("campaign-template-collection", discoveryIntegrityObjectID, 2), status: http.StatusOK},
		{name: "saved update current", method: http.MethodPatch, path: "/saved/" + discoveryIntegrityObjectID, body: `{"name":"Updated"}`, header: httpcache.ETagStrong("campaign-template-saved-search", discoveryIntegrityObjectID, 2), status: http.StatusOK},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := discoveryIntegrityRequest(
				test.method, test.path, test.body, true,
			)
			if test.header != "" {
				req.Header.Set("If-Match", test.header)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != test.status {
				t.Fatalf("status=%d, want %d; body=%s", rec.Code, test.status, rec.Body.String())
			}
			if test.status == http.StatusOK && rec.Header().Get("ETag") == "" {
				t.Fatal("successful mutation omitted ETag")
			}
		})
	}
}

func TestDiscoveryCreateHandlersRequireIdempotencyAndExposeETag(t *testing.T) {
	repo := &discoveryIntegrityRepo{}
	deps := &Deps{Repo: repo}
	router := chi.NewRouter()
	router.Post("/collections", deps.CreateCollection)
	router.Post("/saved", deps.CreateSavedSearch)

	for _, test := range []struct {
		name, path, body, key string
		status                int
		code                  string
	}{
		{name: "collection missing", path: "/collections", body: `{"name":"Ideas"}`, status: http.StatusBadRequest, code: "idempotency_key_required"},
		{name: "saved missing", path: "/saved", body: `{"name":"Ideas","filters":{}}`, status: http.StatusBadRequest, code: "idempotency_key_required"},
		{name: "collection create", path: "/collections", body: `{"name":"Ideas"}`, key: "collection-create-1", status: http.StatusCreated},
		{name: "saved create", path: "/saved", body: `{"name":"Ideas","filters":{}}`, key: "saved-create-1", status: http.StatusCreated},
		{name: "changed payload conflict", path: "/collections", body: `{"name":"Different"}`, key: "collection-create-1", status: http.StatusUnprocessableEntity, code: "idempotency_key_request_mismatch"},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := discoveryIntegrityRequest(
				http.MethodPost, test.path, test.body, true,
			)
			if test.key != "" {
				req.Header.Set("Idempotency-Key", test.key)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != test.status {
				t.Fatalf("status=%d, want %d; body=%s", rec.Code, test.status, rec.Body.String())
			}
			if test.code != "" && !strings.Contains(rec.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("body=%s, want code %s", rec.Body.String(), test.code)
			}
			if test.status == http.StatusCreated && rec.Header().Get("ETag") == "" {
				t.Fatal("create response omitted ETag")
			}
			if test.name == "saved create" &&
				!strings.Contains(rec.Body.String(), `"obsolete_filters":[]`) {
				t.Fatalf(
					"saved-search response omitted obsolete filter contract: %s",
					rec.Body.String(),
				)
			}
		})
	}
}
