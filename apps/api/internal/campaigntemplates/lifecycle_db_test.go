// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"errors"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestEditableTemplateLifecycleIsRevisionBoundAndImmutableDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	nonce := randHex4(t)

	created, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "lifecycle-" + nonce, Name: "Lifecycle v1", Subject: "Lifecycle",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Version != 1 || created.ETag != templateETag(created) {
		t.Fatalf("created version/etag=%d/%q", created.Version, created.ETag)
	}

	nameV2 := "Lifecycle v2"
	updated, err := repo.Update(ctx, tenantID, created.ID, UpdateInput{
		Name: &nameV2, IfMatch: created.ETag,
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Version != 2 || updated.Name != nameV2 {
		t.Fatalf("updated=%+v, want version 2", updated)
	}

	staleName := "stale overwrite"
	if _, err := repo.Update(ctx, tenantID, created.ID, UpdateInput{
		Name: &staleName, IfMatch: created.ETag,
	}); !errors.Is(err, ErrTemplatePrecondition) {
		t.Fatalf("stale update error=%v, want ErrTemplatePrecondition", err)
	}
	afterStale, err := repo.Get(ctx, tenantID, created.ID)
	if err != nil || afterStale.Name != nameV2 || afterStale.Version != 2 {
		t.Fatalf("stale update changed row: got=%+v err=%v", afterStale, err)
	}

	// Two clients race on the same entity tag. SQL CAS guarantees one winner
	// and one 412-equivalent repository result.
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, candidate := range []string{"concurrent A", "concurrent B"} {
		candidate := candidate
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, updateErr := repo.Update(ctx, tenantID, created.ID, UpdateInput{
				Name: &candidate, IfMatch: updated.ETag,
			})
			results <- updateErr
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	var successes, stale int
	for result := range results {
		switch {
		case result == nil:
			successes++
		case errors.Is(result, ErrTemplatePrecondition):
			stale++
		default:
			t.Fatalf("concurrent update error=%v", result)
		}
	}
	if successes != 1 || stale != 1 {
		t.Fatalf("concurrent results success=%d stale=%d, want 1/1", successes, stale)
	}

	current, err := repo.Get(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("get after concurrent update: %v", err)
	}
	if current.Version != 3 {
		t.Fatalf("version after concurrent update=%d, want 3", current.Version)
	}
	archived, err := repo.Archive(ctx, tenantID, current.ID, current.ETag)
	if err != nil {
		t.Fatalf("archive: %v", err)
	}
	if archived.Version != 4 || archived.ArchivedAt == nil {
		t.Fatalf("archive state=%+v", archived)
	}
	if _, err := repo.Archive(ctx, tenantID, current.ID, current.ETag); !errors.Is(err, ErrTemplatePrecondition) {
		t.Fatalf("stale archive error=%v, want ErrTemplatePrecondition", err)
	}

	activeRows, err := repo.List(ctx, tenantID, ListFilter{Source: "mine"})
	if err != nil {
		t.Fatalf("list active: %v", err)
	}
	for _, item := range activeRows {
		if item.ID == created.ID {
			t.Fatal("archived template leaked into default-active list")
		}
	}
	archivedRows, err := repo.List(ctx, tenantID, ListFilter{Source: "mine", Archived: "archived"})
	if err != nil {
		t.Fatalf("list archived: %v", err)
	}
	found := false
	for _, item := range archivedRows {
		found = found || item.ID == created.ID
	}
	if !found {
		t.Fatal("archived filter did not return archived template")
	}

	restored, err := repo.Restore(ctx, tenantID, archived.ID, archived.ETag)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.Version != 5 || restored.ArchivedAt != nil {
		t.Fatalf("restore state=%+v", restored)
	}
	history, err := repo.ListRevisions(ctx, tenantID, created.ID, 1, 20)
	if err != nil {
		t.Fatalf("list revisions: %v", err)
	}
	if history.Total != 5 || len(history.Items) != 5 {
		t.Fatalf("history total/items=%d/%d, want 5", history.Total, len(history.Items))
	}
	beyondLast, err := repo.ListRevisions(ctx, tenantID, created.ID, 99, 2)
	if err != nil {
		t.Fatalf("list revisions beyond last page: %v", err)
	}
	if beyondLast.Total != history.Total || len(beyondLast.Items) != 0 ||
		beyondLast.Page != 99 || beyondLast.PerPage != 2 {
		t.Fatalf(
			"beyond-last history=%+v, want total=%d empty page=99 per_page=2",
			beyondLast,
			history.Total,
		)
	}
	wantTransitions := []string{"restore", "archive", "update", "update", "create"}
	for index, want := range wantTransitions {
		if history.Items[index].Version != int64(5-index) || history.Items[index].Transition != want {
			t.Fatalf("history[%d]=%+v, want version=%d transition=%s",
				index, history.Items[index], 5-index, want)
		}
	}
	revision, err := repo.GetRevision(ctx, tenantID, created.ID, 2)
	if err != nil {
		t.Fatalf("get revision: %v", err)
	}
	if revision.Snapshot.Name != nameV2 || revision.Snapshot.Version != 2 {
		t.Fatalf("revision snapshot=%+v", revision.Snapshot)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin immutable revision tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_revisions
   SET transition = 'update'
 WHERE tenant_id = $1::uuid
   AND template_id = $2::uuid
   AND version = 1`, tenantID, created.ID); err == nil {
		t.Fatal("runtime role unexpectedly mutated an immutable revision")
	}
}

func TestReferenceTemplateCannotArchiveDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	reference, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "reference-lifecycle-" + randHex4(t), Name: "Reference lifecycle",
		Subject: "Reference", TemplateKind: templateKindReference,
		SourceProvider: "external-lifecycle", SourceExternalID: randHex4(t),
		SourceLicenseStatus: licenseStatusUnreviewed, ReviewStatus: reviewStatusPending,
	})
	if err != nil {
		t.Fatalf("create reference: %v", err)
	}
	if _, err := repo.Archive(ctx, tenantID, reference.ID, reference.ETag); !errors.Is(err, ErrReferenceDeleteBlocked) {
		t.Fatalf("archive reference error=%v, want ErrReferenceDeleteBlocked", err)
	}
}
