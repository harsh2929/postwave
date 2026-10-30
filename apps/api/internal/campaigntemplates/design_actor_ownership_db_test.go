// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func seedActorReadyDesignDraftDB(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID string,
	actor ReferenceReviewActor,
) (*Deps, *DesignDraft) {
	t.Helper()
	deps := &Deps{
		Repo:    &Repo{Pool: pool},
		Designs: &DesignDraftRepo{Pool: pool},
	}
	draft := createRecoveryDesignDraftDB(
		t,
		ctx,
		deps,
		tenantID,
		actor,
		"actor-ready-"+randHex4(t),
	)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin actor-ready fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	outputHash := strings.Repeat("a", 64)
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_template_design_revisions (
    tenant_id, draft_id, revision, operation, base_revision,
    output, output_hash, validation, warnings
) VALUES (
    $1::uuid, $2::uuid, 1, 'initial', NULL,
    jsonb_build_object(
        'name', 'Actor-private digest',
        'subject', 'Private weekly update',
        'body_html', '<html><body><p>Private reviewed body</p></body></html>',
        'unresolved_variables', jsonb_build_array(),
        'reference_template_ids', jsonb_build_array(),
        'warnings', jsonb_build_array()
    ),
    $3,
    '{"status":"pass","checks":[]}'::jsonb,
    '[]'::jsonb
)`, tenantID, draft.ID, outputHash); err != nil {
		t.Fatalf("insert actor-ready revision: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'ready', current_revision = 1
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID, draft.ID,
	); err != nil {
		t.Fatalf("mark actor-ready draft: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit actor-ready fixture: %v", err)
	}
	ready, err := deps.FetchDesignDraft(
		ctx,
		tenantID,
		actor,
		draft.ID,
	)
	if err != nil {
		t.Fatalf("fetch actor-ready draft: %v", err)
	}
	return deps, ready
}

type actorOwnershipCampaignProbe struct {
	createCalls int
}

func (probe *actorOwnershipCampaignProbe) Create(
	context.Context,
	string,
	campaigns.CreateInput,
) (*campaigns.Campaign, error) {
	probe.createCalls++
	return &campaigns.Campaign{ID: "must-not-create"}, nil
}

func TestDesignDraftCreateIdempotencyNeverCrossesActorsDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	deps := &Deps{
		Repo:    &Repo{Pool: pool},
		Designs: &DesignDraftRepo{Pool: pool},
	}
	actorA := ReferenceReviewActor{Type: "user", ID: "create-owner-a"}
	actorB := ReferenceReviewActor{Type: "user", ID: "create-owner-b"}
	key := "same-actor-private-create-key-" + randHex4(t)
	input := CreateDesignDraftInput{
		Mode: "generate", Brief: "Private founder digest",
		Goal: "newsletter",
	}
	owned, replayed, err := deps.StartDesignDraft(
		ctx, tenantID, actorA, key, input,
	)
	if err != nil || replayed || owned == nil {
		t.Fatalf("owner create=(%#v,%v,%v)", owned, replayed, err)
	}

	for name, otherInput := range map[string]CreateDesignDraftInput{
		"same payload": input,
		"different payload": {
			Mode: "generate", Brief: "A different private digest",
			Goal: "newsletter",
		},
	} {
		t.Run(name, func(t *testing.T) {
			got, gotReplay, gotErr := deps.StartDesignDraft(
				ctx, tenantID, actorB, key, otherInput,
			)
			if got != nil || gotReplay ||
				!errors.Is(gotErr, ErrDesignDraftNotFound) {
				t.Fatalf(
					"foreign create=(%#v,%v,%v), want nondisclosing not found",
					got,
					gotReplay,
					gotErr,
				)
			}
		})
	}

	refetched, err := deps.FetchDesignDraft(
		ctx, tenantID, actorA, owned.ID,
	)
	if err != nil || refetched.ID != owned.ID {
		t.Fatalf("owner refetch=(%#v,%v)", refetched, err)
	}
}

func TestDesignDraftReadsAndMutationsAreExactActorPrivateDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	actorA := ReferenceReviewActor{Type: "user", ID: "workflow-owner-a"}
	actorB := ReferenceReviewActor{Type: "user", ID: "workflow-owner-b"}
	deps, draft := seedActorReadyDesignDraftDB(
		t, ctx, pool, tenantID, actorA,
	)
	probe := &actorOwnershipCampaignProbe{}
	deps.Campaigns = probe

	if _, err := deps.FetchDesignDraft(
		ctx, tenantID, actorB, draft.ID,
	); !errors.Is(err, ErrDesignDraftNotFound) {
		t.Fatalf("foreign get error=%v, want not found", err)
	}
	if _, err := deps.FetchDesignDraftRevisions(
		ctx, tenantID, actorB, draft.ID,
	); !errors.Is(err, ErrDesignDraftNotFound) {
		t.Fatalf("foreign revisions error=%v, want not found", err)
	}
	if _, _, err := deps.QueueDesignDraftRefinementWithKey(
		ctx,
		tenantID,
		actorB,
		draft.ID,
		"foreign-refine-"+randHex4(t),
		RefineDesignDraftInput{
			BaseRevision: 1,
			Instructions: "Try to change another actor's design",
		},
	); !errors.Is(err, ErrDesignDraftNotFound) {
		t.Fatalf("foreign refine error=%v, want not found", err)
	}
	if _, _, err := deps.ArchiveDesignDraftJobWithKey(
		ctx,
		tenantID,
		actorB,
		draft.ID,
		"foreign-archive-"+randHex4(t),
	); !errors.Is(err, ErrDesignDraftNotFound) {
		t.Fatalf("foreign archive error=%v, want not found", err)
	}
	commit := CommitDesignDraftInput{
		Revision:   1,
		OutputHash: strings.Repeat("a", 64),
	}
	if _, _, err := deps.SaveDesignDraftRevisionWithKey(
		ctx,
		tenantID,
		actorB,
		draft.ID,
		"foreign-save-"+randHex4(t),
		SaveDesignDraftInput{
			CommitDesignDraftInput: commit,
			Slug:                   "foreign-save-must-not-exist",
		},
	); !errors.Is(err, ErrDesignDraftNotFound) {
		t.Fatalf("foreign save error=%v, want not found", err)
	}
	if _, _, err := deps.CreateCampaignFromDesignRevisionWithKey(
		ctx,
		tenantID,
		actorB,
		draft.ID,
		"foreign-campaign-"+randHex4(t),
		CreateCampaignFromDesignDraftInput{
			CommitDesignDraftInput: commit,
		},
	); !errors.Is(err, ErrDesignDraftNotFound) {
		t.Fatalf("foreign campaign error=%v, want not found", err)
	}
	if probe.createCalls != 0 {
		t.Fatalf("foreign campaign reached create dependency %d times", probe.createCalls)
	}

	repo := deps.Designs.(*DesignDraftRepo)
	if _, err := repo.MarkSaved(
		ctx,
		tenantID,
		actorB,
		draft.ID,
		1,
		"11111111-1111-4111-8111-111111111111",
	); !errors.Is(err, ErrDesignDraftNotFound) {
		t.Fatalf("foreign saved marker error=%v, want not found", err)
	}
	if _, err := repo.MarkCampaignCreated(
		ctx,
		tenantID,
		actorB,
		draft.ID,
		1,
		"22222222-2222-4222-8222-222222222222",
	); !errors.Is(err, ErrDesignDraftNotFound) {
		t.Fatalf("foreign campaign marker error=%v, want not found", err)
	}

	setDesignDraftFailedDB(t, ctx, pool, tenantID, draft.ID, 2)
	if _, _, err := deps.RetryDesignDraftJobWithKey(
		ctx,
		tenantID,
		actorB,
		draft.ID,
		"foreign-retry-"+randHex4(t),
	); !errors.Is(err, ErrDesignDraftNotFound) {
		t.Fatalf("foreign retry error=%v, want not found", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin ownership verification: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var receipts int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND draft_id = $2::uuid`,
		tenantID,
		draft.ID,
	).Scan(&receipts); err != nil {
		t.Fatalf("count foreign receipts: %v", err)
	}
	if receipts != 0 {
		t.Fatalf("foreign actor persisted %d mutation receipts", receipts)
	}
	var status string
	if err := tx.QueryRow(ctx, `
SELECT status
  FROM campaign_template_design_drafts
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID,
		draft.ID,
	).Scan(&status); err != nil {
		t.Fatalf("read protected draft status: %v", err)
	}
	if status != designDraftStatusFailed {
		t.Fatalf("foreign operations changed protected draft to %q", status)
	}
}

func TestDesignMutationReceiptsNeverCrossActorsDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	actorA := ReferenceReviewActor{Type: "user", ID: "receipt-owner-a"}
	actorB := ReferenceReviewActor{Type: "user", ID: "receipt-owner-b"}
	depsA, draftA := seedActorReadyDesignDraftDB(
		t, ctx, pool, tenantID, actorA,
	)
	_, draftB := seedActorReadyDesignDraftDB(
		t, ctx, pool, tenantID, actorB,
	)
	repo := depsA.Designs.(*DesignDraftRepo)

	const refineKey = "same-cross-actor-refine-key"
	keyHashA, requestHashA, err := designMutationIdentityHashes(
		draftA.ID,
		"refine",
		refineKey,
		RefineDesignDraftInput{
			BaseRevision: 1,
			Instructions: "Owner A direction",
		},
	)
	if err != nil {
		t.Fatalf("owner A refinement identity: %v", err)
	}
	if _, err := repo.RegisterDesignMutation(
		ctx,
		tenantID,
		actorA,
		draftA.ID,
		"refine",
		keyHashA,
		requestHashA,
	); err != nil {
		t.Fatalf("register owner A refinement: %v", err)
	}
	keyHashB, requestHashB, err := designMutationIdentityHashes(
		draftB.ID,
		"refine",
		refineKey,
		RefineDesignDraftInput{
			BaseRevision: 1,
			Instructions: "Owner B direction",
		},
	)
	if err != nil {
		t.Fatalf("owner B refinement identity: %v", err)
	}
	if _, err := repo.RegisterDesignMutation(
		ctx,
		tenantID,
		actorB,
		draftB.ID,
		"refine",
		keyHashB,
		requestHashB,
	); !errors.Is(err, ErrDesignDraftIdempotencyConflict) {
		t.Fatalf(
			"cross-actor refinement receipt error=%v, want conflict",
			err,
		)
	}

	setDesignDraftFailedDB(t, ctx, pool, tenantID, draftA.ID, 2)
	setDesignDraftFailedDB(t, ctx, pool, tenantID, draftB.ID, 2)
	const retryKey = "same-cross-actor-retry-key"
	retryKeyHashA, retryRequestHashA, err := designMutationIdentityHashes(
		draftA.ID,
		"retry",
		retryKey,
		map[string]any{},
	)
	if err != nil {
		t.Fatalf("owner A retry identity: %v", err)
	}
	if _, _, err := repo.RetryDesignDraftWithMutation(
		ctx,
		tenantID,
		actorA,
		draftA.ID,
		retryKeyHashA,
		retryRequestHashA,
	); err != nil {
		t.Fatalf("register owner A retry: %v", err)
	}
	retryKeyHashB, retryRequestHashB, err := designMutationIdentityHashes(
		draftB.ID,
		"retry",
		retryKey,
		map[string]any{},
	)
	if err != nil {
		t.Fatalf("owner B retry identity: %v", err)
	}
	if _, _, err := repo.RetryDesignDraftWithMutation(
		ctx,
		tenantID,
		actorB,
		draftB.ID,
		retryKeyHashB,
		retryRequestHashB,
	); !errors.Is(err, ErrDesignDraftIdempotencyConflict) {
		t.Fatalf("cross-actor retry receipt error=%v, want conflict", err)
	}
	protectedB, err := depsA.FetchDesignDraft(
		ctx,
		tenantID,
		actorB,
		draftB.ID,
	)
	if err != nil {
		t.Fatalf("fetch owner B draft: %v", err)
	}
	if protectedB.Status != designDraftStatusFailed {
		t.Fatalf(
			"owner A retry receipt changed actor B draft to %q",
			protectedB.Status,
		)
	}
}
