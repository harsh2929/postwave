// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestReferenceReviewDecisionAuditAndEligibilityDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	userID := seedCampaignTemplateUser(t, ctx, pool, tenantID)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)

	reference, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "review-governance-" + nonce, Name: "Review governance",
		Subject: "Reference", BodyHTML: "<p>Captured source</p>",
		TemplateKind: templateKindReference, SourceProvider: "external-review-test",
		SourceExternalID: "review-" + nonce, SourceLicenseStatus: licenseStatusUnreviewed,
		ReviewStatus: reviewStatusPending, ContentHash: "hash-before-review",
	})
	if err != nil {
		t.Fatalf("create reference: %v", err)
	}
	result, err := repo.ReviewReference(ctx, tenantID, reference.ID, ReferenceReviewDecisionInput{
		Decision: "approve", AdaptationAllowed: true,
		Note: "Reviewed for original-layout inspiration only",
	}, ReferenceReviewActor{Type: "user", ID: userID, Label: "reviewer@example.test"})
	if err != nil {
		t.Fatalf("review reference: %v", err)
	}
	if result.SourceLicenseStatus != licenseStatusUnreviewed ||
		result.Decision.DirectUseAllowed || !result.Decision.AdaptationAllowed {
		t.Fatalf("review result=%+v", result)
	}

	got, err := repo.Get(ctx, tenantID, reference.ID)
	if err != nil {
		t.Fatalf("get reviewed reference: %v", err)
	}
	if got.SourceLicenseStatus != licenseStatusUnreviewed ||
		got.ReviewStatus != reviewStatusApproved ||
		!got.ReferenceAdaptationAllowed || got.ReferenceDirectUseAllowed ||
		got.ReferenceReviewDecisionID != result.Decision.ID ||
		got.ReferenceReviewedAt == nil {
		t.Fatalf("reviewed reference=%+v", got)
	}
	if err := ValidateTemplateAdaptationEligibility(got); err != nil {
		t.Fatalf("adaptation gate: %v", err)
	}
	if err := ValidateTemplateEligibility(got); !errors.Is(err, ErrTemplateIneligible) {
		t.Fatalf("direct gate error=%v, want ErrTemplateIneligible", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin audit read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	var decision, contentHash, license, actorID string
	var adaptation, direct bool
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)::int, max(decision), max(source_content_hash),
       max(source_license_status), bool_or(adaptation_allowed),
       bool_or(direct_use_allowed), max(actor_id)
  FROM campaign_template_reference_review_decisions
 WHERE tenant_id = $1::uuid AND template_id = $2::uuid`,
		tenantID, reference.ID,
	).Scan(&count, &decision, &contentHash, &license, &adaptation, &direct, &actorID); err != nil {
		t.Fatalf("read audit decision: %v", err)
	}
	if count != 1 || decision != "approve" || contentHash != "hash-before-review" ||
		license != licenseStatusUnreviewed || !adaptation || direct || actorID != userID {
		t.Fatalf("audit receipt count=%d decision=%q hash=%q license=%q adaptation=%v direct=%v actor=%q",
			count, decision, contentHash, license, adaptation, direct, actorID)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit audit read: %v", err)
	}
}

func TestReferenceReviewRejectsUnownedDirectUseAndReferenceDeleteDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)
	reference, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "review-direct-license-" + nonce, Name: "Direct license guard",
		Subject: "Reference", TemplateKind: templateKindReference,
		SourceProvider: "external-review-test", SourceExternalID: "direct-" + nonce,
		SourceLicenseStatus: licenseStatusUnreviewed, ReviewStatus: reviewStatusPending,
	})
	if err != nil {
		t.Fatalf("create reference: %v", err)
	}
	_, err = repo.ReviewReference(ctx, tenantID, reference.ID, ReferenceReviewDecisionInput{
		Decision: "approve", AdaptationAllowed: true, DirectUseAllowed: true,
		Note: "Attempted direct use",
	}, ReferenceReviewActor{Type: "service", ID: "review-test"})
	if !errors.Is(err, ErrDirectUseLicenseRequired) {
		t.Fatalf("direct-use review error=%v, want ErrDirectUseLicenseRequired", err)
	}
	got, err := repo.Get(ctx, tenantID, reference.ID)
	if err != nil {
		t.Fatalf("get reference: %v", err)
	}
	if got.ReviewStatus != reviewStatusPending || got.ReferenceReviewDecisionID != "" ||
		got.ReferenceAdaptationAllowed || got.ReferenceDirectUseAllowed {
		t.Fatalf("failed review mutated reference=%+v", got)
	}
	if _, err := repo.Delete(ctx, tenantID, reference.ID, templateETag(reference)); !errors.Is(err, ErrReferenceDeleteBlocked) {
		t.Fatalf("delete reference error=%v, want ErrReferenceDeleteBlocked", err)
	}
	if _, err := repo.Get(ctx, tenantID, reference.ID); err != nil {
		t.Fatalf("reference was deleted: %v", err)
	}
}

func TestImportedReferenceRefreshInvalidatesReviewWithoutUsingPublicUpdateDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)
	sourceID := "refresh-" + nonce
	first, created, err := repo.UpsertImported(ctx, tenantID, CreateInput{
		Slug: "review-refresh-" + nonce, Name: "Refresh v1", Subject: "Version one",
		BodyHTML: "<p>Version one</p>", Goal: "newsletter", Category: "newsletter",
		SourceProvider: "external-refresh-test", SourceExternalID: sourceID,
		ContentHash: importBodyHTMLHash("<p>Version one</p>"),
	})
	if err != nil || !created {
		t.Fatalf("initial import created=%v error=%v", created, err)
	}
	review, err := repo.ReviewReference(ctx, tenantID, first.ID, ReferenceReviewDecisionInput{
		Decision: "approve", AdaptationAllowed: true, Note: "Approved v1 inspiration",
	}, ReferenceReviewActor{Type: "service", ID: "refresh-reviewer"})
	if err != nil {
		t.Fatalf("review initial import: %v", err)
	}
	if review.Decision.ID == "" {
		t.Fatal("review receipt id is empty")
	}

	updated, created, err := repo.UpsertImported(ctx, tenantID, CreateInput{
		Slug: first.Slug, Name: "Refresh v2", Subject: "Version two",
		BodyHTML: "<p>Version two</p>", Goal: "newsletter", Category: "newsletter",
		SourceProvider: "external-refresh-test", SourceExternalID: sourceID,
		ContentHash: importBodyHTMLHash("<p>Version two</p>"),
	})
	if err != nil || created {
		t.Fatalf("refresh created=%v error=%v", created, err)
	}
	if updated.Name != "Refresh v2" || updated.Subject != "Version two" ||
		updated.ContentHash != importBodyHTMLHash("<p>Version two</p>") {
		t.Fatalf("refresh content=%+v", updated)
	}
	if updated.BodyHTML != "" || !updated.HasSourceHTML {
		t.Fatalf("reference response exposed source HTML or lost its availability fact: %+v", updated)
	}
	if body, hash := rawReferenceContentDB(t, ctx, pool, tenantID, first.ID); body != "<p>Version two</p>" || hash != importBodyHTMLHash(body) {
		t.Fatalf("stored refresh body/hash = %q/%q", body, hash)
	}
	if updated.ReviewStatus != reviewStatusPending ||
		updated.SourceLicenseStatus != licenseStatusUnreviewed ||
		updated.ReferenceAdaptationAllowed || updated.ReferenceDirectUseAllowed ||
		updated.ReferenceReviewDecisionID != "" || updated.ReferenceReviewedAt != nil {
		t.Fatalf("refresh retained stale review=%+v", updated)
	}
	if err := ValidateTemplateAdaptationEligibility(updated); !errors.Is(err, ErrTemplateIneligible) {
		t.Fatalf("refreshed adaptation gate error=%v, want ErrTemplateIneligible", err)
	}
	if got := countReferenceReviewReceiptsDB(t, ctx, pool, tenantID, first.ID); got != 1 {
		t.Fatalf("historical audit receipt count=%d, want 1", got)
	}
}

func TestImportedReferenceConcurrentRefreshKeepsBodyAndHashAtomicDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)
	sourceID := "atomic-refresh-" + nonce
	first, created, err := repo.UpsertImported(ctx, tenantID, CreateInput{
		Slug: "atomic-refresh-" + nonce, Name: "Atomic refresh seed",
		Subject: "Seed", BodyHTML: "<p>seed</p>", Goal: "newsletter",
		Category: "newsletter", SourceProvider: "external-atomic-refresh-test",
		SourceExternalID: sourceID, ContentHash: importBodyHTMLHash("<p>seed</p>"),
	})
	if err != nil || !created {
		t.Fatalf("seed import created=%v error=%v", created, err)
	}

	const writers = 16
	start := make(chan struct{})
	results := make(chan error, writers)
	var ready sync.WaitGroup
	ready.Add(writers)
	for i := 0; i < writers; i++ {
		body := fmt.Sprintf("<p>concurrent-%02d</p>", i)
		go func(index int, bodyHTML string) {
			ready.Done()
			<-start
			_, wasCreated, upsertErr := repo.UpsertImported(ctx, tenantID, CreateInput{
				Slug: first.Slug, Name: fmt.Sprintf("Concurrent %02d", index),
				Subject: fmt.Sprintf("Concurrent %02d", index), BodyHTML: bodyHTML,
				Goal: "newsletter", Category: "newsletter",
				SourceProvider: first.SourceProvider, SourceExternalID: sourceID,
				ContentHash: importBodyHTMLHash(bodyHTML),
			})
			if wasCreated {
				results <- errors.New("concurrent refresh unexpectedly created a row")
				return
			}
			results <- upsertErr
		}(i, body)
	}
	ready.Wait()
	close(start)
	for i := 0; i < writers; i++ {
		if err := <-results; err != nil {
			t.Fatalf("concurrent refresh: %v", err)
		}
	}

	body, hash := rawReferenceContentDB(t, ctx, pool, tenantID, first.ID)
	if hash != importBodyHTMLHash(body) {
		t.Fatalf("concurrent refresh tore body/hash: body=%q hash=%q want=%q",
			body, hash, importBodyHTMLHash(body))
	}
}

func TestImportedReferenceAtomicWriterRejectsMismatchedHashDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)
	first, created, err := repo.UpsertImported(ctx, tenantID, CreateInput{
		Slug: "atomic-hash-" + nonce, Name: "Atomic hash seed",
		Subject: "Seed", BodyHTML: "<p>before</p>", Goal: "newsletter",
		Category: "newsletter", SourceProvider: "external-atomic-hash-test",
		SourceExternalID: "atomic-hash-" + nonce,
		ContentHash:      importBodyHTMLHash("<p>before</p>"),
	})
	if err != nil || !created {
		t.Fatalf("seed import created=%v error=%v", created, err)
	}
	beforeBody, beforeHash := rawReferenceContentDB(t, ctx, pool, tenantID, first.ID)
	prepared, err := prepareImportedReferenceRefresh(CreateInput{
		Name: "Mismatched refresh", Subject: "After", BodyHTML: "<p>after</p>",
		Goal: "newsletter", Category: "newsletter",
		SourceProvider: first.SourceProvider, SourceExternalID: first.SourceExternalID,
		ContentHash: beforeHash,
	})
	if err != nil {
		t.Fatalf("prepare mismatched refresh: %v", err)
	}
	if err := repo.refreshImportedReferenceAtomic(ctx, tenantID, first.ID, prepared); err == nil {
		t.Fatal("database atomic writer accepted a content hash for a different body")
	}
	afterBody, afterHash := rawReferenceContentDB(t, ctx, pool, tenantID, first.ID)
	if afterBody != beforeBody || afterHash != beforeHash {
		t.Fatalf("rejected refresh mutated body/hash: before=%q/%q after=%q/%q",
			beforeBody, beforeHash, afterBody, afterHash)
	}
}

func TestImportedReferenceLegacySplitWritersFailClosedDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	for _, signature := range []string{
		"campaign_template_refresh_reference_metadata(uuid,uuid,text,text,text,text,text,timestamptz,jsonb,text,text,text,jsonb,numeric,text,timestamptz)",
		"campaign_template_refresh_reference_content(uuid,uuid,text,text,text,text,text,text,text,jsonb,text[],text,text,text,text,text,jsonb)",
	} {
		var allowed bool
		if err := pool.QueryRow(ctx,
			`SELECT has_function_privilege(current_user, $1, 'EXECUTE')`,
			signature,
		).Scan(&allowed); err != nil {
			t.Fatalf("inspect legacy writer %q: %v", signature, err)
		}
		if allowed {
			t.Fatalf("legacy split writer %q remains executable", signature)
		}
	}
}

func rawReferenceContentDB(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, templateID string,
) (string, string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin raw reference read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var body, hash string
	if err := tx.QueryRow(ctx, `
SELECT body_html, content_hash
  FROM campaign_templates
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID, templateID,
	).Scan(&body, &hash); err != nil {
		t.Fatalf("read raw reference content: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit raw reference read: %v", err)
	}
	return body, hash
}

func TestReferenceProtectedFieldsAndDeletionAreDatabaseImmutableDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)
	sourceID := "immutable-" + nonce
	reference, created, err := repo.UpsertImported(ctx, tenantID, CreateInput{
		Slug: "reference-immutable-" + nonce, Name: "Immutable reference",
		Subject: "Original subject", BodyHTML: "<p>Original content</p>",
		SourceProvider: "external-immutability-test", SourceExternalID: sourceID,
		SourceURL:   "https://example.test/original",
		ContentHash: importBodyHTMLHash("<p>Original content</p>"),
	})
	if err != nil || !created {
		t.Fatalf("create imported reference created=%v error=%v", created, err)
	}
	review, err := repo.ReviewReference(ctx, tenantID, reference.ID, ReferenceReviewDecisionInput{
		Decision: "approve", AdaptationAllowed: true,
		Note: "Approved only as inspiration",
	}, ReferenceReviewActor{Type: "service", ID: "immutability-reviewer"})
	if err != nil {
		t.Fatalf("trusted review transition: %v", err)
	}

	for name, query := range map[string]string{
		"content and provenance update": `
UPDATE campaign_templates
   SET body_html = '<p>Tampered</p>',
       source_url = 'https://attacker.invalid/relabelled'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		"delete": `
DELETE FROM campaign_templates
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		"audit receipt update": `
UPDATE campaign_template_reference_review_decisions
   SET note = 'Tampered receipt'
 WHERE tenant_id = $1::uuid AND template_id = $2::uuid`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := referenceMutationAttemptDB(ctx, pool, tenantID, query, tenantID, reference.ID); err == nil {
				t.Fatal("direct database mutation unexpectedly succeeded")
			}
		})
	}

	after, err := repo.Get(ctx, tenantID, reference.ID)
	if err != nil {
		t.Fatalf("get reference after blocked mutations: %v", err)
	}
	if after.SourceURL != "https://example.test/original" ||
		after.ReferenceReviewDecisionID != review.Decision.ID {
		t.Fatalf("blocked direct mutation changed reference=%+v", after)
	}
	rawBody, rawHash := rawReferenceContentDB(
		t, ctx, pool, tenantID, reference.ID,
	)
	if rawBody != "<p>Original content</p>" ||
		rawHash != importBodyHTMLHash("<p>Original content</p>") {
		t.Fatalf(
			"blocked direct mutation changed stored reference body/hash: body=%q hash=%q",
			rawBody,
			rawHash,
		)
	}

	refreshed, created, err := repo.UpsertImported(ctx, tenantID, CreateInput{
		Slug: reference.Slug, Name: "Trusted refresh", Subject: "Refreshed subject",
		BodyHTML:       "<p>Trusted refreshed content</p>",
		SourceProvider: "external-immutability-test", SourceExternalID: sourceID,
		SourceURL:   "https://example.test/refreshed",
		ContentHash: importBodyHTMLHash("<p>Trusted refreshed content</p>"),
	})
	if err != nil || created {
		t.Fatalf("trusted refresh created=%v error=%v", created, err)
	}
	if refreshed.SourceURL != "https://example.test/refreshed" ||
		refreshed.ReferenceReviewDecisionID != "" ||
		refreshed.ReviewStatus != reviewStatusPending {
		t.Fatalf("trusted refresh result=%+v", refreshed)
	}
	rawBody, rawHash = rawReferenceContentDB(
		t, ctx, pool, tenantID, reference.ID,
	)
	if rawBody != "<p>Trusted refreshed content</p>" ||
		rawHash != importBodyHTMLHash("<p>Trusted refreshed content</p>") {
		t.Fatalf(
			"trusted refresh stored unexpected body/hash: body=%q hash=%q",
			rawBody,
			rawHash,
		)
	}
}

func referenceMutationAttemptDB(
	ctx context.Context,
	pool *db.Pool,
	tenantID, query string,
	args ...any,
) error {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, query, args...)
	return err
}

func countReferenceReviewReceiptsDB(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, templateID string,
) int {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin receipt count: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)::int
  FROM campaign_template_reference_review_decisions
 WHERE tenant_id = $1::uuid AND template_id = $2::uuid`,
		tenantID, templateID,
	).Scan(&count); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit receipt count: %v", err)
	}
	return count
}
