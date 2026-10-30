// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func campaignTemplateSecurityDB(t *testing.T) (*db.Pool, context.Context) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping campaign-template security integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, ctx
}

func seedCampaignTemplateUser(t *testing.T, ctx context.Context, pool *db.Pool, tenantID string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin user tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var userID string
	nonce := randHex4(t)
	if err := tx.QueryRow(ctx, `
INSERT INTO users (tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2, $3, 'owner')
RETURNING id::text`, tenantID, "template-security-"+nonce, "template-security-"+nonce+"@example.com").Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit user: %v", err)
	}
	return userID
}

func campaignTemplateSecurityExec(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, query string, args ...any) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin security tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		t.Fatalf("security exec: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit security tx: %v", err)
	}
}

func TestFavoriteEligibilityVisibilityAndGetStateDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	otherTenantID := seedCampaignTemplateTenant(t, ctx, pool)
	userID := seedCampaignTemplateUser(t, ctx, pool, tenantID)
	repo := &Repo{Pool: pool}
	prefix := "security-" + randHex4(t) + "-"

	eligible, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: prefix + "eligible", Name: "Eligible", Subject: "Eligible",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create eligible template: %v", err)
	}
	pending, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: prefix + "pending", Name: "Pending", Subject: "Pending",
		TemplateKind: templateKindReference, SourceProvider: "external-test",
		SourceLicenseStatus: licenseStatusUnreviewed, ReviewStatus: reviewStatusPending,
	})
	if err != nil {
		t.Fatalf("create pending template: %v", err)
	}
	rejected, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: prefix + "rejected", Name: "Rejected", Subject: "Rejected",
		TemplateKind: templateKindReference, SourceProvider: "external-test",
		SourceLicenseStatus: licenseStatusUnreviewed, ReviewStatus: reviewStatusRejected,
	})
	if err != nil {
		t.Fatalf("create rejected template: %v", err)
	}
	foreign, err := repo.Create(ctx, otherTenantID, CreateInput{
		Slug: prefix + "foreign", Name: "Foreign", Subject: "Foreign",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create foreign template: %v", err)
	}

	if err := repo.SetFavorite(ctx, tenantID, userID, eligible.ID, true); err != nil {
		t.Fatalf("favorite eligible template: %v", err)
	}
	if err := repo.SetFavorite(ctx, tenantID, userID, pending.ID, true); err != nil {
		t.Fatalf("favorite pending template for review: %v", err)
	}
	userCtx := middleware.WithUser(ctx, &middleware.User{ID: userID, TenantID: tenantID})
	got, err := repo.Get(userCtx, tenantID, eligible.ID)
	if err != nil {
		t.Fatalf("get favorited template: %v", err)
	}
	if !got.IsFavorited {
		t.Fatal("Get did not return the persisted favorite state for the acting user")
	}
	withoutUser, err := repo.Get(ctx, tenantID, eligible.ID)
	if err != nil {
		t.Fatalf("get without user: %v", err)
	}
	if withoutUser.IsFavorited {
		t.Fatal("favorite state leaked into a request without an acting user")
	}
	platforms, err := repo.List(ctx, tenantID, ListFilter{Source: "platform", PerPage: maxLegacyListPageSize})
	if err != nil {
		t.Fatalf("list platform templates: %v", err)
	}
	var eligiblePlatform *Template
	for i := range platforms {
		if ValidateTemplateEligibility(&platforms[i]) == nil {
			eligiblePlatform = &platforms[i]
			break
		}
	}
	if eligiblePlatform == nil {
		t.Fatal("no approved owned platform template available for favorite test")
	}
	if err := repo.SetFavorite(ctx, tenantID, userID, eligiblePlatform.ID, true); err != nil {
		t.Fatalf("favorite eligible platform template: %v", err)
	}
	platformWithFavorite, err := repo.Get(userCtx, tenantID, eligiblePlatform.ID)
	if err != nil || !platformWithFavorite.IsFavorited {
		t.Fatalf("platform favorite state=%#v error=%v", platformWithFavorite, err)
	}

	missingID := "00000000-0000-4000-8000-000000000001"
	for name, id := range map[string]string{
		"rejected": rejected.ID,
		"foreign":  foreign.ID,
		"missing":  missingID,
	} {
		t.Run(name, func(t *testing.T) {
			if err := repo.SetFavorite(ctx, tenantID, userID, id, true); !errors.Is(err, ErrNotFound) {
				t.Fatalf("SetFavorite(%s) error=%v, want indistinguishable ErrNotFound", name, err)
			}
		})
	}

	if err := repo.SetFavorite(ctx, tenantID, userID, eligible.ID, false); err != nil {
		t.Fatalf("unfavorite eligible template: %v", err)
	}
	got, err = repo.Get(userCtx, tenantID, eligible.ID)
	if err != nil {
		t.Fatalf("get unfavorited template: %v", err)
	}
	if got.IsFavorited {
		t.Fatal("Get still reports a deleted favorite")
	}
	if err := repo.SetFavorite(ctx, tenantID, userID, eligiblePlatform.ID, false); err != nil {
		t.Fatalf("unfavorite platform template: %v", err)
	}
	// A bookmark can always be removed after the underlying template is later
	// rejected, even though a new favorite would now be refused.
	if _, err := repo.ReviewReference(ctx, tenantID, pending.ID, ReferenceReviewDecisionInput{
		Decision: "reject", Note: "Reference is unsuitable for catalog use",
	}, ReferenceReviewActor{Type: "service", ID: "favorite-security-test"}); err != nil {
		t.Fatalf("reject pending reference through audited transition: %v", err)
	}
	if err := repo.SetFavorite(ctx, tenantID, userID, pending.ID, false); err != nil {
		t.Fatalf("unfavorite later-rejected pending template: %v", err)
	}
	pendingAfter, err := repo.Get(userCtx, tenantID, pending.ID)
	if err != nil || pendingAfter.IsFavorited {
		t.Fatalf("later-rejected favorite state=%#v error=%v", pendingAfter, err)
	}
}

func TestRollupsAndLegacyListExcludeRejectedTemplatesDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	userID := seedCampaignTemplateUser(t, ctx, pool, tenantID)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)

	before, err := repo.GetStats(ctx, tenantID, userID)
	if err != nil {
		t.Fatalf("stats before: %v", err)
	}
	beforeGoals, err := repo.GoalCounts(ctx, tenantID)
	if err != nil {
		t.Fatalf("goals before: %v", err)
	}
	goalCount := func(rows []GoalCount, goal string) int {
		for _, row := range rows {
			if row.Goal == goal {
				return row.Count
			}
		}
		return 0
	}

	pending, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "rollup-pending-" + nonce, Name: "Rollup pending " + nonce,
		Subject: "Rollup pending " + nonce, Goal: "automation",
		TemplateKind: templateKindReference, SourceProvider: "external-test",
		SourceLicenseStatus: licenseStatusUnreviewed, ReviewStatus: reviewStatusPending,
	})
	if err != nil {
		t.Fatalf("create pending: %v", err)
	}
	rejected, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "rollup-rejected-" + nonce, Name: "Rollup rejected " + nonce,
		Subject: "Rollup rejected " + nonce, Goal: "automation",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create to-reject: %v", err)
	}
	if err := repo.SetFavorite(ctx, tenantID, userID, rejected.ID, true); err != nil {
		t.Fatalf("favorite before rejection: %v", err)
	}
	campaignTemplateSecurityExec(t, ctx, pool, tenantID, `
UPDATE campaign_templates
   SET usage_count = CASE id WHEN $2::uuid THEN 1000000000 ELSE 2000000000 END,
       last_used_at = now(),
       is_featured = true,
       review_status = CASE id WHEN $3::uuid THEN 'rejected' ELSE review_status END
 WHERE tenant_id = $1::uuid
   AND id IN ($2::uuid, $3::uuid)`, tenantID, pending.ID, rejected.ID)

	after, err := repo.GetStats(ctx, tenantID, userID)
	if err != nil {
		t.Fatalf("stats after: %v", err)
	}
	if after.Total != before.Total+1 || after.Mine != before.Mine+1 ||
		after.Featured != before.Featured+1 || after.UsedLast30d != before.UsedLast30d+1 {
		t.Fatalf("rollup before=%+v after=%+v; rejected row leaked or pending row vanished", before, after)
	}
	if after.Favorites != before.Favorites {
		t.Fatalf("favorites before=%d after=%d; later-rejected favorite leaked", before.Favorites, after.Favorites)
	}
	if after.TopTemplateID != pending.ID || after.TopUsageCount != 1000000000 {
		t.Fatalf("top template=%+v, want pending %s; rejected row ranked", after, pending.ID)
	}
	afterGoals, err := repo.GoalCounts(ctx, tenantID)
	if err != nil {
		t.Fatalf("goals after: %v", err)
	}
	if got, want := goalCount(afterGoals, "automation"), goalCount(beforeGoals, "automation")+1; got != want {
		t.Fatalf("automation goal count=%d, want %d (rejected must be excluded)", got, want)
	}
	listed, err := repo.List(ctx, tenantID, ListFilter{Query: nonce, PerPage: maxLegacyListPageSize})
	if err != nil {
		t.Fatalf("legacy list: %v", err)
	}
	if len(listed) != 1 || listed[0].ID != pending.ID {
		t.Fatalf("legacy list=%+v, want only pending template %s", listed, pending.ID)
	}
}

func TestUpdatePlatformTemplateIsNondisclosingDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	platforms, err := repo.List(ctx, tenantID, ListFilter{Source: "platform", PerPage: maxLegacyListPageSize})
	if err != nil {
		t.Fatalf("list platform templates: %v", err)
	}
	if len(platforms) == 0 {
		t.Fatal("no visible platform template available for immutability test")
	}
	before, err := repo.Get(ctx, tenantID, platforms[0].ID)
	if err != nil {
		t.Fatalf("get platform before patch: %v", err)
	}
	mutatedName := "Tenant must not mutate platform row"
	if _, err := repo.Update(ctx, tenantID, before.ID, UpdateInput{Name: &mutatedName}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Update platform error=%v, want nondisclosing ErrNotFound", err)
	}
	after, err := repo.Get(ctx, tenantID, before.ID)
	if err != nil {
		t.Fatalf("get platform after patch: %v", err)
	}
	if after.Name != before.Name || after.UpdatedAt != before.UpdatedAt {
		t.Fatalf("platform template mutated: before=%+v after=%+v", before, after)
	}
}

func TestUpdateReferenceTemplateRequiresAdaptationDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)
	reference, err := repo.Create(ctx, tenantID, CreateInput{
		Slug:                "immutable-reference-" + nonce,
		Name:                "Immutable reference",
		Subject:             "Reference subject",
		TemplateKind:        templateKindReference,
		SourceProvider:      "external-test",
		SourceExternalID:    "immutable-reference-" + nonce,
		SourceLicenseStatus: licenseStatusOwned,
		ReviewStatus:        reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create reference: %v", err)
	}
	before := reference.UpdatedAt
	mutatedName := "Mutated reference"
	if _, err := repo.Update(ctx, tenantID, reference.ID, UpdateInput{Name: &mutatedName}); !errors.Is(err, ErrReferenceMutationBlocked) {
		t.Fatalf("Update reference error=%v, want ErrReferenceMutationBlocked", err)
	}
	after, err := repo.Get(ctx, tenantID, reference.ID)
	if err != nil {
		t.Fatalf("get reference after blocked update: %v", err)
	}
	if after.Name != reference.Name || !after.UpdatedAt.Equal(before) {
		t.Fatalf("reference mutated despite guard: before=%+v after=%+v", reference, after)
	}
}

func TestDeleteSafelyArchivesCampaignAndTemplateLineageDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)
	create := func(label string, references []string) *Template {
		t.Helper()
		tpl, err := repo.Create(ctx, tenantID, CreateInput{
			Slug: "delete-lineage-" + label + "-" + nonce,
			Name: "Delete lineage " + label, Subject: "Delete lineage " + label,
			TemplateKind: templateKindEditable, SourceProvider: "postwave",
			SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
			ReferenceTemplateIDs: references,
		})
		if err != nil {
			t.Fatalf("create %s: %v", label, err)
		}
		return tpl
	}
	sourcePrimary := create("campaign-source", nil)
	sourceReference := create("campaign-reference", nil)
	sourceDerivative := create("template-reference", nil)
	sourceLegacyMetadata := create("legacy-metadata-source", nil)
	unreferenced := create("unreferenced", nil)
	_ = create("dependent", []string{sourceDerivative.ID})
	legacyDependent := create("legacy-metadata-dependent", nil)
	campaignTemplateSecurityExec(t, ctx, pool, tenantID, `
UPDATE campaign_templates
   SET generation_metadata = jsonb_build_object('operation', 'clone', 'source_template_id', $3::text)
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, legacyDependent.ID, sourceLegacyMetadata.ID)
	campaignTemplateSecurityExec(t, ctx, pool, tenantID, `
INSERT INTO campaigns
       (tenant_id, name, subject, source_template_id, reference_template_ids)
VALUES ($1::uuid, 'Lineage retention', 'Lineage retention', $2::uuid, ARRAY[$3::uuid])`,
		tenantID, sourcePrimary.ID, sourceReference.ID)

	all := map[string]*Template{
		"campaign source":            sourcePrimary,
		"campaign reference":         sourceReference,
		"template reference":         sourceDerivative,
		"legacy generation metadata": sourceLegacyMetadata,
		"unreferenced":               unreferenced,
	}
	for name, tpl := range all {
		t.Run(name, func(t *testing.T) {
			archived, err := repo.Delete(ctx, tenantID, tpl.ID, templateETag(tpl))
			if err != nil {
				t.Fatalf("safe Delete/archive error=%v", err)
			}
			if archived.ArchivedAt == nil || archived.Version != tpl.Version+1 {
				t.Fatalf("archived lifecycle=%+v, want archived_at and version %d", archived, tpl.Version+1)
			}
			got, err := repo.Get(ctx, tenantID, tpl.ID)
			if err != nil || got.ArchivedAt == nil {
				t.Fatalf("archived template was removed or active: got=%+v err=%v", got, err)
			}
		})
	}
	if _, err := repo.Delete(ctx, tenantID, "00000000-0000-4000-8000-000000000001", `"campaign-template:missing:v1"`); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete missing error=%v, want ErrNotFound", err)
	}
}

func TestDirectHardDeleteIsDeniedWhileArchivedRowsRemainReferenceableDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)
	source, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "reference-race-source-" + nonce, Name: "Reference race source", Subject: "Source",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create race source: %v", err)
	}

	deleteTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin direct-delete transaction: %v", err)
	}
	defer func() { _ = deleteTx.Rollback(ctx) }()
	if _, err := deleteTx.Exec(ctx, `
DELETE FROM campaign_templates
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, source.ID); err != nil {
		if !strings.Contains(strings.ToLower(err.Error()), "permission denied") {
			t.Fatalf("direct delete error=%v, want permission denied", err)
		}
	} else {
		t.Fatal("postwave_app unexpectedly hard-deleted a campaign template")
	}
	_ = deleteTx.Rollback(ctx)

	archived, err := repo.Archive(ctx, tenantID, source.ID, templateETag(source))
	if err != nil {
		t.Fatalf("archive source: %v", err)
	}
	if archived.ArchivedAt == nil {
		t.Fatal("source was not archived")
	}
	if _, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "reference-race-dependent-" + nonce, Name: "Reference race dependent", Subject: "Dependent",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
		ReferenceTemplateIDs: []string{source.ID},
	}); err != nil {
		t.Fatalf("archived source should remain referenceable for immutable lineage: %v", err)
	}
}

func TestRecordUseCannotMutateSharedOrIneligibleTemplatesDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	prefix := "usage-security-" + randHex4(t) + "-"

	eligible, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: prefix + "eligible", Name: "Eligible", Subject: "Eligible",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create eligible template: %v", err)
	}
	pending, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: prefix + "pending", Name: "Pending", Subject: "Pending",
		TemplateKind: templateKindReference, SourceProvider: "external-test",
		SourceLicenseStatus: licenseStatusUnreviewed, ReviewStatus: reviewStatusPending,
	})
	if err != nil {
		t.Fatalf("create pending template: %v", err)
	}

	visible, err := repo.List(ctx, tenantID, ListFilter{})
	if err != nil {
		t.Fatalf("list visible templates: %v", err)
	}
	var platform *Template
	for i := range visible {
		if visible[i].TenantID == "" && ValidateTemplateEligibility(&visible[i]) == nil {
			platform = &visible[i]
			break
		}
	}
	if platform == nil {
		t.Fatal("no approved owned platform template available for mutation test")
	}

	if err := repo.RecordUse(ctx, tenantID, eligible.ID); err != nil {
		t.Fatalf("RecordUse eligible template: %v", err)
	}
	used, err := repo.Get(ctx, tenantID, eligible.ID)
	if err != nil {
		t.Fatalf("get used template: %v", err)
	}
	if used.UsageCount != eligible.UsageCount+1 || used.LastUsedAt == nil {
		t.Fatalf("eligible usage state=%#v, want count increment and timestamp", used)
	}

	for name, template := range map[string]*Template{
		"pending":  pending,
		"platform": platform,
	} {
		t.Run(name, func(t *testing.T) {
			before, err := repo.Get(ctx, tenantID, template.ID)
			if err != nil {
				t.Fatalf("get before: %v", err)
			}
			if err := repo.RecordUse(ctx, tenantID, template.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("RecordUse error=%v, want ErrNotFound", err)
			}
			after, err := repo.Get(ctx, tenantID, template.ID)
			if err != nil {
				t.Fatalf("get after: %v", err)
			}
			if after.UsageCount != before.UsageCount || !sameOptionalTime(after.LastUsedAt, before.LastUsedAt) {
				t.Fatalf("ineligible/shared usage mutated: before=%#v after=%#v", before, after)
			}
		})
	}
}

func TestFailedReimportStillDemotesExistingApprovalDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)
	existing, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "reimport-security-" + nonce, Name: "Previously approved", Subject: "Old content",
		TemplateKind: templateKindReference, SourceProvider: "external-security-test",
		SourceExternalID: "external-" + nonce, SourceLicenseStatus: licenseStatusOwned,
		ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create previously approved source: %v", err)
	}

	_, created, err := repo.UpsertImported(ctx, tenantID, CreateInput{
		Slug: existing.Slug, Name: "Unreviewed refresh", Subject: "New external content",
		Goal: "invalid-goal", SourceProvider: existing.SourceProvider,
		SourceExternalID: existing.SourceExternalID,
		ContentHash:      importBodyHTMLHash(""),
	})
	if created || !errors.Is(err, ErrInvalidGoal) {
		t.Fatalf("reimport created=%v error=%v, want false/ErrInvalidGoal", created, err)
	}
	got, err := repo.Get(ctx, tenantID, existing.ID)
	if err != nil {
		t.Fatalf("get failed reimport: %v", err)
	}
	if got.TemplateKind != templateKindReference || got.ReviewStatus != reviewStatusPending ||
		got.SourceLicenseStatus != licenseStatusUnreviewed {
		t.Fatalf("failed reimport retained executable governance: %#v", got)
	}
}

func sameOptionalTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}
