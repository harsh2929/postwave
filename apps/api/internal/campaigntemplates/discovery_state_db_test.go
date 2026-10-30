// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func seedCampaignTemplateDiscoveryUser(
	t *testing.T, ctx context.Context, pool *db.Pool, tenantID, label string,
) string {
	t.Helper()
	userID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin user seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, $4, 'editor')`,
		userID, tenantID, "template-discovery-"+label+"-"+userID,
		label+"-"+userID+"@example.test",
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit user seed: %v", err)
	}
	return userID
}

func TestCampaignTemplateDiscoveryStateIsolationAndStablePaginationDB(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping discovery-state integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	foreignTenantID := seedCampaignTemplateTenant(t, ctx, pool)
	userA := seedCampaignTemplateDiscoveryUser(t, ctx, pool, tenantID, "a")
	userB := seedCampaignTemplateDiscoveryUser(t, ctx, pool, tenantID, "b")
	foreignUser := seedCampaignTemplateDiscoveryUser(t, ctx, pool, foreignTenantID, "foreign")
	repo := &Repo{Pool: pool}
	userContext := middleware.WithUser(ctx, &middleware.User{ID: userA, TenantID: tenantID})

	templates := make([]Template, 0, 5)
	prefix := "discovery-" + randHex4(t) + "-"
	for index := 0; index < 5; index++ {
		template, err := repo.Create(userContext, tenantID, CreateInput{
			Slug:    prefix + string(rune('a'+index)),
			Name:    "Discovery template " + string(rune('A'+index)),
			Subject: "Discovery",
			Tags:    []string{"discovery"},
		})
		if err != nil {
			t.Fatalf("create template %d: %v", index, err)
		}
		templates = append(templates, *template)
	}

	first, err := repo.Search(ctx, tenantID, SearchFilter{
		Source: "mine", UserID: userA, Sort: "recommended", PerPage: 2,
	})
	if err != nil {
		t.Fatalf("first keyset page: %v", err)
	}
	if len(first.Items) != 2 || first.NextCursor == "" || first.Page != 1 {
		t.Fatalf("first page = %#v", first)
	}
	firstIDs := map[string]bool{first.Items[0].ID: true, first.Items[1].ID: true}

	inserted, err := repo.Create(userContext, tenantID, CreateInput{
		Slug: prefix + "inserted", Name: "Inserted before continuation",
		Subject: "Discovery", Tags: []string{"discovery"},
	})
	if err != nil {
		t.Fatalf("insert between pages: %v", err)
	}
	// Make the concurrent insert unambiguously sort ahead of the first-page
	// boundary even on databases whose clock resolution coalesces fast writes.
	insertTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin inserted-template timestamp update: %v", err)
	}
	defer func() { _ = insertTx.Rollback(ctx) }()
	if _, err := insertTx.Exec(ctx, `
UPDATE campaign_templates
   SET created_at = $2::timestamptz
 WHERE id = $1::uuid`,
		inserted.ID, first.Items[0].CreatedAt.Add(time.Hour)); err != nil {
		t.Fatalf("move inserted template ahead of cursor: %v", err)
	}
	if err := insertTx.Commit(ctx); err != nil {
		t.Fatalf("commit inserted-template timestamp update: %v", err)
	}
	second, err := repo.Search(ctx, tenantID, SearchFilter{
		Source: "mine", UserID: userA, Sort: "recommended", PerPage: 2,
		Cursor: first.NextCursor,
	})
	if err != nil {
		t.Fatalf("keyset continuation: %v", err)
	}
	if second.Page != 2 || len(second.Items) != 2 {
		t.Fatalf("second page = %#v", second)
	}
	for _, item := range second.Items {
		if firstIDs[item.ID] {
			t.Fatalf("cursor duplicated first-page template %s", item.ID)
		}
		if item.ID == inserted.ID {
			t.Fatalf("cursor admitted a row inserted ahead of its boundary")
		}
	}

	collection, err := repo.CreateCollection(ctx, tenantID, userA,
		CreateCampaignTemplateCollectionInput{
			Name: "Launch ideas", TemplateIDs: []string{templates[1].ID, templates[0].ID},
		})
	if err != nil {
		t.Fatalf("create collection: %v", err)
	}
	if len(collection.TemplateIDs) != 2 ||
		collection.TemplateIDs[0] != templates[1].ID ||
		collection.TemplateIDs[1] != templates[0].ID {
		t.Fatalf("ordered collection = %#v", collection.TemplateIDs)
	}
	collectionList, err := repo.ListCollections(ctx, tenantID, userA)
	if err != nil {
		t.Fatalf("list collections with membership: %v", err)
	}
	var listedCollection *CampaignTemplateCollection
	for index := range collectionList {
		if collectionList[index].ID == collection.ID {
			listedCollection = &collectionList[index]
			break
		}
	}
	if listedCollection == nil ||
		listedCollection.ItemCount != 2 ||
		len(listedCollection.TemplateIDs) != 2 ||
		listedCollection.TemplateIDs[0] != templates[1].ID ||
		listedCollection.TemplateIDs[1] != templates[0].ID {
		t.Fatalf("listed collection omitted ordered membership: %#v", listedCollection)
	}
	replayed, err := repo.ReplaceCollectionItems(
		ctx, tenantID, userA, collection.ID, collection.TemplateIDs,
	)
	if err != nil {
		t.Fatalf("idempotent collection retry: %v", err)
	}
	if !replayed.UpdatedAt.Equal(collection.UpdatedAt) {
		t.Fatalf("exact collection retry changed updated_at: %v -> %v",
			collection.UpdatedAt, replayed.UpdatedAt)
	}
	// Use one stable operation key for the actual ambiguous-retry assertion.
	stableCollectionKey := "collection-stable-" + randHex4(t)
	stableCollection, err := repo.CreateCollectionIdempotent(
		ctx, tenantID, userA, stableCollectionKey,
		CreateCampaignTemplateCollectionInput{
			Name: "Stable collection " + randHex4(t),
			TemplateIDs: []string{
				templates[2].ID, templates[3].ID,
			},
		},
	)
	if err != nil {
		t.Fatalf("stable collection create: %v", err)
	}
	stableCollectionReplay, err := repo.CreateCollectionIdempotent(
		ctx, tenantID, userA, stableCollectionKey,
		CreateCampaignTemplateCollectionInput{
			Name: stableCollection.Name,
			TemplateIDs: []string{
				templates[2].ID, templates[3].ID,
			},
		},
	)
	if err != nil {
		t.Fatalf("stable collection replay: %v", err)
	}
	if stableCollectionReplay.ID != stableCollection.ID ||
		stableCollectionReplay.Version != stableCollection.Version ||
		stableCollectionReplay.ETag != stableCollection.ETag ||
		!stableCollectionReplay.UpdatedAt.Equal(stableCollection.UpdatedAt) {
		t.Fatalf("stable collection replay drifted: %#v -> %#v",
			stableCollection, stableCollectionReplay)
	}
	if _, err := repo.CreateCollectionIdempotent(
		ctx, tenantID, userA, stableCollectionKey,
		CreateCampaignTemplateCollectionInput{
			Name: "Changed collection " + randHex4(t),
		},
	); !errors.Is(err, ErrDiscoveryIdempotencyReuse) {
		t.Fatalf("changed collection idempotency error = %v", err)
	}
	sameCollectionName := stableCollection.Name
	noOpCollection, err := repo.UpdateCollectionIfVersion(
		ctx, tenantID, userA, stableCollection.ID, stableCollection.Version,
		UpdateCampaignTemplateCollectionInput{Name: &sameCollectionName},
	)
	if err != nil {
		t.Fatalf("no-op collection update: %v", err)
	}
	if noOpCollection.Version != stableCollection.Version ||
		!noOpCollection.UpdatedAt.Equal(stableCollection.UpdatedAt) {
		t.Fatalf("no-op collection update changed version/time: %#v -> %#v",
			stableCollection, noOpCollection)
	}
	renamedCollectionName := stableCollection.Name + " renamed"
	renamedCollection, err := repo.UpdateCollectionIfVersion(
		ctx, tenantID, userA, stableCollection.ID, stableCollection.Version,
		UpdateCampaignTemplateCollectionInput{Name: &renamedCollectionName},
	)
	if err != nil {
		t.Fatalf("versioned collection update: %v", err)
	}
	if renamedCollection.Version != stableCollection.Version+1 ||
		renamedCollection.ETag == stableCollection.ETag {
		t.Fatalf("collection version/etag did not advance: %#v -> %#v",
			stableCollection, renamedCollection)
	}
	if _, err := repo.UpdateCollectionIfVersion(
		ctx, tenantID, userA, stableCollection.ID, stableCollection.Version,
		UpdateCampaignTemplateCollectionInput{Name: &sameCollectionName},
	); !errors.Is(err, ErrDiscoveryPrecondition) {
		t.Fatalf("stale collection update error = %v", err)
	}
	reorderedCollection, err := repo.ReplaceCollectionItemsIfVersion(
		ctx, tenantID, userA, stableCollection.ID, renamedCollection.Version,
		[]string{templates[3].ID, templates[2].ID},
	)
	if err != nil {
		t.Fatalf("versioned collection reorder: %v", err)
	}
	if reorderedCollection.Version != renamedCollection.Version+1 {
		t.Fatalf("reorder version=%d, want %d",
			reorderedCollection.Version, renamedCollection.Version+1)
	}
	exactReorderReplay, err := repo.ReplaceCollectionItemsIfVersion(
		ctx, tenantID, userA, stableCollection.ID, reorderedCollection.Version,
		reorderedCollection.TemplateIDs,
	)
	if err != nil {
		t.Fatalf("exact reorder retry: %v", err)
	}
	if exactReorderReplay.Version != reorderedCollection.Version ||
		!exactReorderReplay.UpdatedAt.Equal(reorderedCollection.UpdatedAt) {
		t.Fatalf("exact reorder retry changed version/time: %#v -> %#v",
			reorderedCollection, exactReorderReplay)
	}
	if _, err := repo.ReplaceCollectionItemsIfVersion(
		ctx, tenantID, userA, stableCollection.ID, renamedCollection.Version,
		[]string{templates[2].ID},
	); !errors.Is(err, ErrDiscoveryPrecondition) {
		t.Fatalf("stale collection reorder error = %v", err)
	}
	if _, err := repo.ReplaceCollectionItems(
		ctx, tenantID, userA, collection.ID,
		[]string{templates[0].ID, templates[0].ID},
	); !errors.Is(err, ErrInvalidCollectionItems) {
		t.Fatalf("duplicate membership error = %v", err)
	}
	if _, err := repo.ReplaceCollectionItems(
		ctx, tenantID, userA, uuid.NewString(), []string{templates[0].ID},
	); !errors.Is(err, ErrCollectionNotFound) {
		t.Fatalf("missing collection error = %v", err)
	}

	// Saved-search drift checks must use the complete authoritative taxonomy,
	// not the frequency-bounded tag facets returned with catalog pages. Seed
	// 101 equal-frequency tags and choose the lexically last value, which
	// cannot fit in the top-100 facet payload.
	authoritativeTags := make([]string, 101)
	for index := range authoritativeTags {
		authoritativeTags[index] = fmt.Sprintf(
			"taxonomy-authoritative-%03d",
			index,
		)
	}
	authoritativeTag := authoritativeTags[len(authoritativeTags)-1]
	replaceTemplateTags := func(tags []string) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("begin authoritative tag update: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := bindTemplateDiscoveryActor(ctx, tx, userA); err != nil {
			t.Fatalf("bind authoritative tag actor: %v", err)
		}
		if _, err := tx.Exec(ctx, `
UPDATE campaign_templates
   SET tags = $2::text[]
 WHERE id = $1::uuid`,
			templates[0].ID,
			tags,
		); err != nil {
			t.Fatalf("replace authoritative tags: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit authoritative tags: %v", err)
		}
	}
	replaceTemplateTags(authoritativeTags)
	tagSearch, err := repo.Search(ctx, tenantID, SearchFilter{
		Source: "mine", UserID: userA, Tags: []string{authoritativeTag},
	})
	if err != nil || len(tagSearch.Items) != 1 {
		t.Fatalf("authoritative tag search = %#v, %v", tagSearch, err)
	}
	for _, facet := range tagSearch.Facets.Tags {
		if facet.Value == authoritativeTag {
			t.Fatalf("authoritative test tag unexpectedly present in bounded facets")
		}
	}
	taxonomySaved, err := repo.CreateSavedSearch(
		ctx,
		tenantID,
		userA,
		CreateCampaignTemplateSavedSearchInput{
			Name: "Authoritative taxonomy " + randHex4(t),
			Filters: SavedSearchFilters{
				Tags: []string{authoritativeTag},
			},
		},
	)
	if err != nil {
		t.Fatalf("create authoritative-taxonomy saved search: %v", err)
	}
	if len(taxonomySaved.ObsoleteFilters) != 0 {
		t.Fatalf(
			"bounded facets incorrectly invalidated saved filter: %#v",
			taxonomySaved.ObsoleteFilters,
		)
	}
	replaceTemplateTags(authoritativeTags[:len(authoritativeTags)-1])
	driftedSaved, err := repo.GetSavedSearch(
		ctx,
		tenantID,
		userA,
		taxonomySaved.ID,
	)
	if err != nil {
		t.Fatalf("get drifted saved search: %v", err)
	}
	if len(driftedSaved.ObsoleteFilters) != 1 ||
		driftedSaved.ObsoleteFilters[0].Field != "tags" ||
		driftedSaved.ObsoleteFilters[0].Value != authoritativeTag {
		t.Fatalf("obsolete saved-search filters = %#v", driftedSaved.ObsoleteFilters)
	}
	cleanedFilters := driftedSaved.Filters
	cleanedFilters.Tags = []string{}
	cleanedSaved, err := repo.UpdateSavedSearchIfVersion(
		ctx,
		tenantID,
		userA,
		driftedSaved.ID,
		driftedSaved.Version,
		UpdateCampaignTemplateSavedSearchInput{Filters: &cleanedFilters},
	)
	if err != nil {
		t.Fatalf("clean obsolete saved-search filter: %v", err)
	}
	if cleanedSaved.Version != driftedSaved.Version+1 ||
		cleanedSaved.ETag == driftedSaved.ETag ||
		len(cleanedSaved.ObsoleteFilters) != 0 {
		t.Fatalf("etag-safe saved-search cleanup = %#v", cleanedSaved)
	}

	saved, err := repo.CreateSavedSearch(ctx, tenantID, userA,
		CreateCampaignTemplateSavedSearchInput{
			Name: "Favorite newsletters",
			Filters: SavedSearchFilters{
				Goal: "newsletter", FavoritedOnly: true, Sort: "most_used",
			},
		})
	if err != nil {
		t.Fatalf("create saved search: %v", err)
	}
	if _, err := repo.CreateSavedSearch(ctx, tenantID, userA,
		CreateCampaignTemplateSavedSearchInput{
			Name: "favorite NEWSLETTERS", Filters: SavedSearchFilters{},
		}); !errors.Is(err, ErrDiscoveryNameConflict) {
		t.Fatalf("duplicate saved-search name error = %v", err)
	}
	stableSavedKey := "saved-search-stable-" + randHex4(t)
	stableSavedInput := CreateCampaignTemplateSavedSearchInput{
		Name: "Stable search " + randHex4(t),
		Filters: SavedSearchFilters{
			Goal: "newsletter", Source: "mine", Sort: "name",
		},
	}
	stableSaved, err := repo.CreateSavedSearchIdempotent(
		ctx, tenantID, userA, stableSavedKey, stableSavedInput,
	)
	if err != nil {
		t.Fatalf("stable saved-search create: %v", err)
	}
	stableSavedReplay, err := repo.CreateSavedSearchIdempotent(
		ctx, tenantID, userA, stableSavedKey, stableSavedInput,
	)
	if err != nil {
		t.Fatalf("stable saved-search replay: %v", err)
	}
	if stableSavedReplay.ID != stableSaved.ID ||
		stableSavedReplay.Version != stableSaved.Version ||
		stableSavedReplay.ETag != stableSaved.ETag ||
		!stableSavedReplay.UpdatedAt.Equal(stableSaved.UpdatedAt) {
		t.Fatalf("stable saved-search replay drifted: %#v -> %#v",
			stableSaved, stableSavedReplay)
	}
	changedSavedInput := stableSavedInput
	changedSavedInput.Name += " changed"
	if _, err := repo.CreateSavedSearchIdempotent(
		ctx, tenantID, userA, stableSavedKey, changedSavedInput,
	); !errors.Is(err, ErrDiscoveryIdempotencyReuse) {
		t.Fatalf("changed saved-search idempotency error = %v", err)
	}
	noOpSavedFilters := stableSaved.Filters
	noOpSaved, err := repo.UpdateSavedSearchIfVersion(
		ctx, tenantID, userA, stableSaved.ID, stableSaved.Version,
		UpdateCampaignTemplateSavedSearchInput{Filters: &noOpSavedFilters},
	)
	if err != nil {
		t.Fatalf("no-op saved-search update: %v", err)
	}
	if noOpSaved.Version != stableSaved.Version ||
		!noOpSaved.UpdatedAt.Equal(stableSaved.UpdatedAt) {
		t.Fatalf("no-op saved-search update changed version/time: %#v -> %#v",
			stableSaved, noOpSaved)
	}
	renamedSavedName := stableSaved.Name + " renamed"
	renamedSaved, err := repo.UpdateSavedSearchIfVersion(
		ctx, tenantID, userA, stableSaved.ID, stableSaved.Version,
		UpdateCampaignTemplateSavedSearchInput{Name: &renamedSavedName},
	)
	if err != nil {
		t.Fatalf("versioned saved-search update: %v", err)
	}
	if renamedSaved.Version != stableSaved.Version+1 ||
		renamedSaved.ETag == stableSaved.ETag {
		t.Fatalf("saved-search version/etag did not advance: %#v -> %#v",
			stableSaved, renamedSaved)
	}
	if _, err := repo.UpdateSavedSearchIfVersion(
		ctx, tenantID, userA, stableSaved.ID, stableSaved.Version,
		UpdateCampaignTemplateSavedSearchInput{Name: &renamedSavedName},
	); !errors.Is(err, ErrDiscoveryPrecondition) {
		t.Fatalf("stale saved-search update error = %v", err)
	}

	view, err := repo.RecordRecentView(ctx, tenantID, userA, templates[0].ID)
	if err != nil || view.ViewCount != 1 {
		t.Fatalf("first recent = %#v, %v", view, err)
	}
	view, err = repo.RecordRecentView(ctx, tenantID, userA, templates[0].ID)
	if err != nil || view.ViewCount != 2 {
		t.Fatalf("repeat recent = %#v, %v", view, err)
	}
	recentA, err := repo.ListRecentViews(ctx, tenantID, userA, 10)
	if err != nil || len(recentA) != 1 {
		t.Fatalf("user A recents = %#v, %v", recentA, err)
	}
	recentB, err := repo.ListRecentViews(ctx, tenantID, userB, 10)
	if err != nil || len(recentB) != 0 {
		t.Fatalf("user B recents leaked = %#v, %v", recentB, err)
	}
	collectionsB, err := repo.ListCollections(ctx, tenantID, userB)
	if err != nil || len(collectionsB) != 0 {
		t.Fatalf("user B collections leaked = %#v, %v", collectionsB, err)
	}
	searchesB, err := repo.ListSavedSearches(ctx, tenantID, userB)
	if err != nil || len(searchesB) != 0 {
		t.Fatalf("user B saved searches leaked = %#v, %v", searchesB, err)
	}

	if err := repo.SetFavorite(ctx, tenantID, userA, templates[0].ID, true); err != nil {
		t.Fatalf("favorite: %v", err)
	}
	favoritesA, err := repo.Search(ctx, tenantID, SearchFilter{
		UserID: userA, FavoritedOnly: true, Source: "mine",
	})
	if err != nil || len(favoritesA.Items) != 1 {
		t.Fatalf("user A favorites = %#v, %v", favoritesA, err)
	}
	favoritesB, err := repo.Search(ctx, tenantID, SearchFilter{
		UserID: userB, FavoritedOnly: true, Source: "all",
	})
	if err != nil || len(favoritesB.Items) != 0 {
		t.Fatalf("user B favorites leaked = %#v, %v", favoritesB, err)
	}

	foreignComparison, err := repo.CompareTemplates(
		ctx, foreignTenantID, foreignUser,
		[]string{templates[0].ID, templates[1].ID},
	)
	if err != nil {
		t.Fatalf("cross-tenant compare error = %v", err)
	}
	if len(foreignComparison.Items) != 0 ||
		len(foreignComparison.UnavailableIdentifiers) != 2 ||
		foreignComparison.UnavailableIdentifiers[0] != templates[0].ID ||
		foreignComparison.UnavailableIdentifiers[1] != templates[1].ID {
		t.Fatalf("cross-tenant unavailable compare = %#v", foreignComparison)
	}
	comparison, err := repo.CompareTemplates(
		ctx,
		tenantID,
		userA,
		[]string{templates[1].ID, uuid.NewString(), templates[0].ID},
	)
	if err != nil {
		t.Fatalf("partial compare: %v", err)
	}
	if len(comparison.Items) != 2 ||
		comparison.Items[0].RequestedIdentifier != templates[1].ID ||
		comparison.Items[1].RequestedIdentifier != templates[0].ID ||
		len(comparison.UnavailableIdentifiers) != 1 {
		t.Fatalf("partial ordered compare = %#v", comparison)
	}

	// Repository pre-validation is not the security boundary: the migration
	// trigger must also reject a foreign tenant template through raw SQL.
	rawTx, err := db.WithTenant(ctx, pool, foreignTenantID)
	if err != nil {
		t.Fatalf("begin raw tenant-isolation check: %v", err)
	}
	defer func() { _ = rawTx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, rawTx, foreignUser); err != nil {
		t.Fatalf("bind raw tenant-isolation actor: %v", err)
	}
	if _, err := rawTx.Exec(ctx, `
INSERT INTO campaign_template_recent_views (tenant_id, user_id, template_id)
VALUES ($1::uuid, $2::uuid, $3::uuid)`,
		foreignTenantID, foreignUser, templates[0].ID); err == nil {
		t.Fatal("raw SQL attached a foreign tenant template to recent views")
	}
	_ = rawTx.Rollback(ctx)

	deleteCollectionCandidate, err := repo.CreateCollection(
		ctx, tenantID, userA,
		CreateCampaignTemplateCollectionInput{Name: "Delete candidate " + randHex4(t)},
	)
	if err != nil {
		t.Fatalf("create collection delete candidate: %v", err)
	}
	if _, err := repo.DeleteCollectionIfVersion(
		ctx, tenantID, userA, deleteCollectionCandidate.ID,
		deleteCollectionCandidate.Version+1,
	); !errors.Is(err, ErrDiscoveryPrecondition) {
		t.Fatalf("stale collection delete error = %v", err)
	}
	deleted, err := repo.DeleteCollectionIfVersion(
		ctx, tenantID, userA, deleteCollectionCandidate.ID,
		deleteCollectionCandidate.Version,
	)
	if err != nil || !deleted {
		t.Fatalf("versioned collection delete = %v, %v", deleted, err)
	}
	if _, err := repo.DeleteCollectionIfVersion(
		ctx, tenantID, userA, deleteCollectionCandidate.ID,
		deleteCollectionCandidate.Version,
	); !errors.Is(err, ErrCollectionNotFound) {
		t.Fatalf("repeat versioned collection delete error = %v", err)
	}

	deleteSavedCandidate, err := repo.CreateSavedSearch(
		ctx, tenantID, userA,
		CreateCampaignTemplateSavedSearchInput{
			Name: "Delete search " + randHex4(t), Filters: SavedSearchFilters{},
		},
	)
	if err != nil {
		t.Fatalf("create saved-search delete candidate: %v", err)
	}
	if _, err := repo.DeleteSavedSearchIfVersion(
		ctx, tenantID, userA, deleteSavedCandidate.ID,
		deleteSavedCandidate.Version+1,
	); !errors.Is(err, ErrDiscoveryPrecondition) {
		t.Fatalf("stale saved-search delete error = %v", err)
	}
	deleted, err = repo.DeleteSavedSearchIfVersion(
		ctx, tenantID, userA, deleteSavedCandidate.ID,
		deleteSavedCandidate.Version,
	)
	if err != nil || !deleted {
		t.Fatalf("versioned saved-search delete = %v, %v", deleted, err)
	}
	if _, err := repo.DeleteSavedSearchIfVersion(
		ctx, tenantID, userA, deleteSavedCandidate.ID,
		deleteSavedCandidate.Version,
	); !errors.Is(err, ErrSavedSearchNotFound) {
		t.Fatalf("repeat versioned saved-search delete error = %v", err)
	}

	deleted, err = repo.DeleteCollection(ctx, tenantID, userA, collection.ID)
	if err != nil || !deleted {
		t.Fatalf("delete collection = %v, %v", deleted, err)
	}
	deleted, err = repo.DeleteCollection(ctx, tenantID, userA, collection.ID)
	if err != nil || deleted {
		t.Fatalf("idempotent collection delete = %v, %v", deleted, err)
	}
	deleted, err = repo.DeleteSavedSearch(ctx, tenantID, userA, saved.ID)
	if err != nil || !deleted {
		t.Fatalf("delete saved search = %v, %v", deleted, err)
	}
	deleted, err = repo.DeleteSavedSearch(ctx, tenantID, userA, saved.ID)
	if err != nil || deleted {
		t.Fatalf("idempotent saved-search delete = %v, %v", deleted, err)
	}
}
