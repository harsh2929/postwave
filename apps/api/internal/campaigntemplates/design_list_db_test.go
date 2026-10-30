// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func createRecoveryDesignDraftDB(
	t *testing.T,
	ctx context.Context,
	deps *Deps,
	tenantID string,
	actor ReferenceReviewActor,
	key string,
) *DesignDraft {
	t.Helper()
	draft, replayed, err := deps.StartDesignDraft(
		ctx,
		tenantID,
		actor,
		key,
		CreateDesignDraftInput{
			Mode: "generate", Brief: "Recover this acknowledged design",
			Goal: "newsletter",
		},
	)
	if err != nil {
		t.Fatalf("StartDesignDraft(%s): %v", key, err)
	}
	if replayed {
		t.Fatalf("StartDesignDraft(%s) unexpectedly replayed", key)
	}
	return draft
}

func TestDesignDraftRecoveryIsActorScopedAndKeysetPagedDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	deps := &Deps{
		Repo:    &Repo{Pool: pool},
		Designs: &DesignDraftRepo{Pool: pool},
	}
	actorA := ReferenceReviewActor{Type: "user", ID: "actor-a"}
	actorB := ReferenceReviewActor{Type: "user", ID: "actor-b"}
	first := createRecoveryDesignDraftDB(
		t, ctx, deps, tenantID, actorA, "recovery-first-"+randHex4(t),
	)
	second := createRecoveryDesignDraftDB(
		t, ctx, deps, tenantID, actorA, "recovery-second-"+randHex4(t),
	)
	archived := createRecoveryDesignDraftDB(
		t, ctx, deps, tenantID, actorA, "recovery-archived-"+randHex4(t),
	)
	expired := createRecoveryDesignDraftDB(
		t, ctx, deps, tenantID, actorA, "recovery-expired-"+randHex4(t),
	)
	_ = createRecoveryDesignDraftDB(
		t, ctx, deps, tenantID, actorB, "recovery-other-"+randHex4(t),
	)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin recovery fixture tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'archived'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, archived.ID,
	); err != nil {
		t.Fatalf("archive recovery fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET created_at = now() - interval '40 days',
       expires_at = now() - interval '1 day'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, expired.ID,
	); err != nil {
		t.Fatalf("expire recovery fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit recovery fixtures: %v", err)
	}

	page, err := deps.ListRecoverableDesignDrafts(
		ctx,
		tenantID,
		actorA,
		DesignDraftListFilter{Limit: 1},
	)
	if err != nil {
		t.Fatalf("list first recovery page: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != second.ID ||
		page.NextCursor == "" {
		t.Fatalf("first recovery page=%#v, want second draft + cursor", page)
	}
	page, err = deps.ListRecoverableDesignDrafts(
		ctx,
		tenantID,
		actorA,
		DesignDraftListFilter{Limit: 1, Cursor: page.NextCursor},
	)
	if err != nil {
		t.Fatalf("list second recovery page: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != first.ID ||
		page.NextCursor != "" {
		t.Fatalf("second recovery page=%#v, want first draft only", page)
	}
}
