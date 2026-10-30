// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/db"
)

var designDBTestActor = ReferenceReviewActor{
	Type: "service",
	ID:   "design-db-test",
}

func seedReadyDesignDraft(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID string,
) *DesignDraft {
	t.Helper()
	deps := &Deps{
		Repo:    &Repo{Pool: pool},
		Designs: &DesignDraftRepo{Pool: pool},
	}
	draft, _, err := deps.StartDesignDraft(
		ctx,
		tenantID,
		designDBTestActor,
		"create-"+randHex4(t),
		CreateDesignDraftInput{
			Mode: "generate", Brief: "A durable integration-test newsletter",
			Goal: "newsletter",
		},
	)
	if err != nil {
		t.Fatalf("StartDesignDraft: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin ready-design tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	hash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_template_design_revisions (
    tenant_id, draft_id, revision, operation, base_revision,
    output, output_hash, validation, warnings
) VALUES (
    $1::uuid, $2::uuid, 1, 'initial', NULL,
    jsonb_build_object(
        'name', 'Durable digest',
        'subject', 'This week',
        'body_html', '<html><body><p>Reviewed</p></body></html>',
        'unresolved_variables', jsonb_build_array(),
        'reference_template_ids', jsonb_build_array(),
        'warnings', jsonb_build_array()
    ),
    $3,
    '{"status":"pass","checks":[]}'::jsonb,
    '[]'::jsonb
)`, tenantID, draft.ID, hash); err != nil {
		t.Fatalf("insert design revision: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'ready', current_revision = 1
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, draft.ID,
	); err != nil {
		t.Fatalf("mark design ready: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit ready design: %v", err)
	}
	ready, err := deps.FetchDesignDraft(
		ctx, tenantID, designDBTestActor, draft.ID,
	)
	if err != nil {
		t.Fatalf("FetchDesignDraft: %v", err)
	}
	return ready
}

func TestDesignFollowupIdempotencyLedgerRejectsRequestDriftDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	repo := &DesignDraftRepo{Pool: pool}
	keyHash := sha256.Sum256([]byte("stable-refinement-key"))
	requestHash := sha256.Sum256([]byte(`{"base_revision":1,"instructions":"shorter"}`))

	registration, err := repo.RegisterDesignMutation(
		ctx, tenantID, designDBTestActor,
		draft.ID, "refine", keyHash[:], requestHash[:])

	if err != nil || registration.Replayed {
		t.Fatalf("first registration=%+v error=%v", registration, err)
	}
	registration, err = repo.RegisterDesignMutation(
		ctx, tenantID, designDBTestActor,
		draft.ID, "refine", keyHash[:], requestHash[:])

	if err != nil || !registration.Replayed {
		t.Fatalf("exact replay registration=%+v error=%v", registration, err)
	}
	changedHash := sha256.Sum256(
		[]byte(`{"base_revision":1,"instructions":"different"}`),
	)
	if _, err := repo.RegisterDesignMutation(
		ctx, tenantID, designDBTestActor,
		draft.ID, "refine", keyHash[:], changedHash[:]); !errors.Is(err, ErrDesignDraftIdempotencyConflict) {
		t.Fatalf("changed request error=%v, want idempotency conflict", err)
	}

	otherTenantID := seedCampaignTemplateTenant(t, ctx, pool)
	otherDraft := seedReadyDesignDraft(t, ctx, pool, otherTenantID)
	if registration, err := repo.RegisterDesignMutation(
		ctx, otherTenantID, designDBTestActor,
		otherDraft.ID, "refine", keyHash[:], requestHash[:]); err != nil || registration.Replayed {
		t.Fatalf("tenant-scoped registration=%+v error=%v", registration, err)
	}
}

func TestDesignRetryRegistrationPersistsAttemptBaselineDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	assertDesignRetryReceiptGuardDB(t, ctx, pool)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	setDesignDraftFailedDB(t, ctx, pool, tenantID, draft.ID, 4)

	repo := &DesignDraftRepo{Pool: pool}
	if legacy, legacyErr := repo.Retry(
		ctx, tenantID, designDBTestActor,
		draft.ID); legacyErr == nil || legacy != nil {
		t.Fatalf(
			"legacy retry bypassed receipt guard: draft=%+v error=%v",
			legacy,
			legacyErr,
		)
	}
	afterLegacy, err := repo.Get(ctx, tenantID, designDBTestActor, draft.ID)
	if err != nil {
		t.Fatalf("fetch after guarded legacy retry: %v", err)
	}
	if afterLegacy.Status != designDraftStatusFailed ||
		afterLegacy.AttemptCount != 4 {
		t.Fatalf("guarded legacy retry mutated draft: %+v", afterLegacy)
	}
	keyHash := sha256.Sum256([]byte("retry-baseline-key"))
	requestHash := sha256.Sum256([]byte(`{"payload":{}}`))
	queued, registration, err := repo.RetryDesignDraftWithMutation(
		ctx, tenantID, designDBTestActor,
		draft.ID, keyHash[:], requestHash[:])

	if err != nil {
		t.Fatalf("first atomic retry registration: %v", err)
	}
	if registration.Replayed ||
		registration.RegisteredAttemptCount == nil ||
		*registration.RegisteredAttemptCount != 4 ||
		queued.Status != designDraftStatusQueued {
		t.Fatalf("first retry registration=%+v, want baseline 4", registration)
	}

	replayedDraft, replayed, err := repo.RetryDesignDraftWithMutation(
		ctx, tenantID, designDBTestActor,
		draft.ID, keyHash[:], requestHash[:])

	if err != nil {
		t.Fatalf("replayed atomic retry registration: %v", err)
	}
	if !replayed.Replayed ||
		replayed.RegisteredAttemptCount == nil ||
		*replayed.RegisteredAttemptCount != 4 ||
		replayedDraft.Status != designDraftStatusQueued {
		t.Fatalf("replayed retry registration=%+v, want stable baseline 4", replayed)
	}
}

func TestDesignRetryReplayDoesNotRequeueCompletedFailedAttemptDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	setDesignDraftFailedDB(t, ctx, pool, tenantID, draft.ID, 3)

	deps := &Deps{Designs: &DesignDraftRepo{Pool: pool}}
	const key = "completed-failed-retry-key"
	queued, replayed, err := deps.RetryDesignDraftJobWithKey(
		ctx, tenantID, designDBTestActor,
		draft.ID, key)

	if err != nil {
		t.Fatalf("first retry: %v", err)
	}
	if replayed || queued.Status != designDraftStatusQueued ||
		queued.AttemptCount != 3 {
		t.Fatalf("first retry draft=%+v replayed=%v", queued, replayed)
	}

	// Model the accepted retry being claimed once and failing before the
	// original HTTP response can be observed. A replay must acknowledge that
	// materialized attempt, not silently enqueue another run.
	setDesignDraftFailedDB(t, ctx, pool, tenantID, draft.ID, 4)
	got, replayed, err := deps.RetryDesignDraftJobWithKey(
		ctx, tenantID, designDBTestActor,
		draft.ID, key)

	if err != nil {
		t.Fatalf("completed-failed replay: %v", err)
	}
	if !replayed || got.Status != designDraftStatusFailed ||
		got.AttemptCount != 4 {
		t.Fatalf("completed-failed replay draft=%+v replayed=%v", got, replayed)
	}

	persisted, err := deps.FetchDesignDraft(ctx, tenantID, designDBTestActor, draft.ID)
	if err != nil {
		t.Fatalf("fetch replayed retry: %v", err)
	}
	if persisted.Status != designDraftStatusFailed ||
		persisted.AttemptCount != 4 {
		t.Fatalf(
			"replay requeued or mutated completed attempt: %+v",
			persisted,
		)
	}
}

func TestDesignRetryRaceRegistersOnlyWinningKeyDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	setDesignDraftFailedDB(t, ctx, pool, tenantID, draft.ID, 3)

	repo := &DesignDraftRepo{Pool: pool}
	deps := &Deps{Designs: repo}
	keys := []string{"tab-a-retry-key", "tab-b-retry-key"}
	type result struct {
		key      string
		draft    *DesignDraft
		replayed bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan result, len(keys))
	for _, key := range keys {
		key := key
		go func() {
			<-start
			got, replayed, err := deps.RetryDesignDraftJobWithKey(
				ctx, tenantID, designDBTestActor,
				draft.ID, key)

			results <- result{
				key: key, draft: got, replayed: replayed, err: err,
			}
		}()
	}
	close(start)

	var winner, loser *result
	for range keys {
		got := <-results
		switch {
		case got.err == nil:
			copy := got
			winner = &copy
		case errors.Is(got.err, ErrDesignDraftRetryUnavailable):
			copy := got
			loser = &copy
		default:
			t.Fatalf(
				"unexpected competing retry result=%+v error=%v",
				got.draft,
				got.err,
			)
		}
	}
	if winner == nil || loser == nil {
		t.Fatalf("retry race winner=%+v loser=%+v", winner, loser)
	}
	if winner.replayed || winner.draft == nil ||
		winner.draft.Status != designDraftStatusQueued ||
		loser.replayed || loser.draft != nil {
		t.Fatalf("retry race winner=%+v loser=%+v", winner, loser)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin retry race receipt tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		receiptCount int
		receiptKey   []byte
	)
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND draft_id = $2::uuid
   AND operation = 'retry'`,
		tenantID, draft.ID,
	).Scan(&receiptCount); err != nil {
		t.Fatalf("read retry race receipts: %v", err)
	}
	if receiptCount == 1 {
		if err := tx.QueryRow(ctx, `
SELECT idempotency_key_hash
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND draft_id = $2::uuid
   AND operation = 'retry'`,
			tenantID, draft.ID,
		).Scan(&receiptKey); err != nil {
			t.Fatalf("read retry race receipt key: %v", err)
		}
	}
	expectedWinnerKey := sha256.Sum256([]byte(winner.key))
	if receiptCount != 1 || !bytes.Equal(receiptKey, expectedWinnerKey[:]) {
		t.Fatalf(
			"retry race receipts count=%d key=%x, want winner %x",
			receiptCount,
			receiptKey,
			expectedWinnerKey,
		)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit retry race receipt read: %v", err)
	}

	exactWinner, replayed, err := deps.RetryDesignDraftJobWithKey(
		ctx, tenantID, designDBTestActor,
		draft.ID, winner.key)

	if err != nil || !replayed ||
		exactWinner.Status != designDraftStatusQueued {
		t.Fatalf(
			"winning queued retry replay=%+v replayed=%v error=%v",
			exactWinner,
			replayed,
			err,
		)
	}

	claim := claimDesignDraftDB(t, ctx, pool, draft.ID)
	if err := repo.Fail(
		ctx, claim, "provider_failed", "The provider failed.", false,
	); err != nil {
		t.Fatalf("fail winning retry attempt: %v", err)
	}

	exactWinner, replayed, err = deps.RetryDesignDraftJobWithKey(
		ctx, tenantID, designDBTestActor,
		draft.ID, winner.key)

	if err != nil || !replayed ||
		exactWinner.Status != designDraftStatusFailed ||
		exactWinner.AttemptCount != 4 {
		t.Fatalf(
			"winning completed replay=%+v replayed=%v error=%v",
			exactWinner,
			replayed,
			err,
		)
	}
}

func TestDesignRetrySameTenantKeyAcrossDraftsQueuesOnlyWinnerDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draftA := seedReadyDesignDraft(t, ctx, pool, tenantID)
	draftB := seedReadyDesignDraft(t, ctx, pool, tenantID)
	setDesignDraftFailedDB(t, ctx, pool, tenantID, draftA.ID, 2)
	setDesignDraftFailedDB(t, ctx, pool, tenantID, draftB.ID, 5)

	deps := &Deps{Designs: &DesignDraftRepo{Pool: pool}}
	const key = "same-tenant-cross-draft-retry-key"
	type result struct {
		draftID  string
		draft    *DesignDraft
		replayed bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for _, draftID := range []string{draftA.ID, draftB.ID} {
		draftID := draftID
		go func() {
			<-start
			got, replayed, err := deps.RetryDesignDraftJobWithKey(
				ctx, tenantID, designDBTestActor,
				draftID, key)

			results <- result{
				draftID: draftID, draft: got, replayed: replayed, err: err,
			}
		}()
	}
	close(start)

	var winner, loser *result
	for range 2 {
		got := <-results
		switch {
		case got.err == nil:
			copy := got
			winner = &copy
		case errors.Is(got.err, ErrDesignDraftIdempotencyConflict):
			copy := got
			loser = &copy
		default:
			t.Fatalf(
				"cross-draft retry result draft=%s value=%+v error=%v",
				got.draftID,
				got.draft,
				got.err,
			)
		}
	}
	if winner == nil || loser == nil {
		t.Fatalf("cross-draft winner=%+v loser=%+v", winner, loser)
	}
	if winner.replayed || winner.draft == nil ||
		winner.draft.Status != designDraftStatusQueued ||
		winner.draft.ID != winner.draftID ||
		loser.replayed || loser.draft != nil {
		t.Fatalf("cross-draft winner=%+v loser=%+v", winner, loser)
	}

	losingDraft, err := deps.FetchDesignDraft(ctx, tenantID, designDBTestActor, loser.draftID)
	if err != nil {
		t.Fatalf("fetch losing cross-draft retry: %v", err)
	}
	if losingDraft.Status != designDraftStatusFailed {
		t.Fatalf("losing cross-draft retry mutated draft: %+v", losingDraft)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin cross-draft receipt tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		receiptDraftID string
		receiptCount   int
		baseline       *int
	)
	keyHash := sha256.Sum256([]byte(key))
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND idempotency_key_hash = $2`,
		tenantID,
		keyHash[:],
	).Scan(&receiptCount); err != nil {
		t.Fatalf("read cross-draft retry receipt: %v", err)
	}
	if receiptCount == 1 {
		if err := tx.QueryRow(ctx, `
SELECT draft_id::text, registered_attempt_count
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND idempotency_key_hash = $2`,
			tenantID,
			keyHash[:],
		).Scan(&receiptDraftID, &baseline); err != nil {
			t.Fatalf("read cross-draft retry receipt identity: %v", err)
		}
	}
	expectedBaseline := 2
	if winner.draftID == draftB.ID {
		expectedBaseline = 5
	}
	if receiptCount != 1 ||
		receiptDraftID != winner.draftID ||
		baseline == nil ||
		*baseline != expectedBaseline {
		t.Fatalf(
			"cross-draft receipt count=%d draft=%s baseline=%v; winner=%+v",
			receiptCount,
			receiptDraftID,
			baseline,
			winner,
		)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit cross-draft receipt read: %v", err)
	}
}

func TestDesignRetryAndRefineRegistrationSameKeyRaceDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	setDesignDraftFailedDB(t, ctx, pool, tenantID, draft.ID, 3)

	repo := &DesignDraftRepo{Pool: pool}
	deps := &Deps{Designs: repo}
	const key = "same-draft-mixed-operation-key"
	keyHash := sha256.Sum256([]byte(key))
	refineRequestHash := sha256.Sum256(
		[]byte(`{"base_revision":1,"instructions":"mixed-race"}`),
	)
	raceCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	start := make(chan struct{})
	type retryResult struct {
		draft    *DesignDraft
		replayed bool
		err      error
	}
	type refineResult struct {
		registration designMutationRegistration
		err          error
	}
	retryResults := make(chan retryResult, 1)
	refineResults := make(chan refineResult, 1)
	go func() {
		<-start
		got, replayed, err := deps.RetryDesignDraftJobWithKey(
			raceCtx, tenantID, designDBTestActor,
			draft.ID, key)

		retryResults <- retryResult{draft: got, replayed: replayed, err: err}
	}()
	go func() {
		<-start
		registration, err := repo.RegisterDesignMutation(
			raceCtx,
			tenantID, designDBTestActor,

			draft.ID,
			"refine",
			keyHash[:],
			refineRequestHash[:])

		refineResults <- refineResult{registration: registration, err: err}
	}()
	close(start)
	retry := <-retryResults
	refine := <-refineResults

	retryWon := retry.err == nil
	refineWon := refine.err == nil
	if retryWon == refineWon {
		t.Fatalf(
			"mixed retry/refine race retry=%+v refine=%+v",
			retry,
			refine,
		)
	}
	if retryWon {
		if retry.replayed || retry.draft == nil ||
			retry.draft.Status != designDraftStatusQueued ||
			!errors.Is(refine.err, ErrDesignDraftIdempotencyConflict) {
			t.Fatalf(
				"retry-won mixed race retry=%+v refine=%+v",
				retry,
				refine,
			)
		}
	} else {
		if !errors.Is(retry.err, ErrDesignDraftIdempotencyConflict) ||
			retry.replayed || retry.draft != nil ||
			refine.registration.Replayed {
			t.Fatalf(
				"refine-won mixed race retry=%+v refine=%+v",
				retry,
				refine,
			)
		}
		persisted, err := deps.FetchDesignDraft(ctx, tenantID, designDBTestActor, draft.ID)
		if err != nil {
			t.Fatalf("fetch refine-won mixed race: %v", err)
		}
		if persisted.Status != designDraftStatusFailed {
			t.Fatalf("refine registration queued retry work: %+v", persisted)
		}
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin mixed-operation receipt tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var operation string
	if err := tx.QueryRow(ctx, `
SELECT operation
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND idempotency_key_hash = $2`,
		tenantID,
		keyHash[:],
	).Scan(&operation); err != nil {
		t.Fatalf("read mixed-operation winner: %v", err)
	}
	expectedOperation := "refine"
	if retryWon {
		expectedOperation = "retry"
	}
	if operation != expectedOperation {
		t.Fatalf(
			"mixed-operation ledger winner=%q, want %q",
			operation,
			expectedOperation,
		)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit mixed-operation receipt read: %v", err)
	}
}

func TestDesignRetryAtAttemptLimitStaysFailedAndWorkerRemainsHealthyDB(
	t *testing.T,
) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	exhausted := seedReadyDesignDraft(t, ctx, pool, tenantID)
	setDesignDraftFailedDB(t, ctx, pool, tenantID, exhausted.ID, 20)
	healthy := seedQueuedDesignDraft(t, ctx, pool, tenantID)

	repo := &DesignDraftRepo{Pool: pool}
	deps := &Deps{Designs: repo}
	const key = "attempt-limit-retry-key"
	got, replayed, err := deps.RetryDesignDraftJobWithKey(
		ctx, tenantID, designDBTestActor,
		exhausted.ID, key)

	if !errors.Is(err, ErrDesignDraftRetryUnavailable) ||
		got != nil || replayed {
		t.Fatalf(
			"attempt-limit retry=%+v replayed=%v error=%v",
			got,
			replayed,
			err,
		)
	}
	assertDesignMutationReceiptCountDB(
		t, ctx, pool, tenantID, key, 0,
	)
	persisted, err := deps.FetchDesignDraft(ctx, tenantID, designDBTestActor, exhausted.ID)
	if err != nil {
		t.Fatalf("fetch attempt-limit draft: %v", err)
	}
	if persisted.Status != designDraftStatusFailed ||
		persisted.AttemptCount != 20 {
		t.Fatalf("attempt-limit retry mutated draft: %+v", persisted)
	}

	claim, err := repo.ClaimNext(ctx)
	if err != nil {
		t.Fatalf("ClaimNext after attempt-limit rejection: %v", err)
	}
	if claim == nil ||
		claim.Draft.ID == exhausted.ID ||
		claim.Draft.AttemptCount > 20 {
		t.Fatalf(
			"ClaimNext after attempt-limit rejection=%+v, exhausted=%s healthy=%s",
			claim,
			exhausted.ID,
			healthy.ID,
		)
	}
	if err := repo.Fail(
		ctx, *claim, "test_complete", "Test worker cleanup.", false,
	); err != nil {
		t.Fatalf("finish healthy worker claim: %v", err)
	}
}

func TestDesignRetryExpiredFailedDraftStaysFailedWithoutReceiptDB(
	t *testing.T,
) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	setDesignDraftExpiredFailedDB(t, ctx, pool, tenantID, draft.ID, 3)

	deps := &Deps{Designs: &DesignDraftRepo{Pool: pool}}
	const key = "expired-failed-retry-key"
	got, replayed, err := deps.RetryDesignDraftJobWithKey(
		ctx, tenantID, designDBTestActor,
		draft.ID, key)

	if !errors.Is(err, ErrDesignDraftRetryUnavailable) ||
		got != nil || replayed {
		t.Fatalf(
			"expired retry=%+v replayed=%v error=%v",
			got,
			replayed,
			err,
		)
	}
	assertDesignMutationReceiptCountDB(
		t, ctx, pool, tenantID, key, 0,
	)
	persisted, err := deps.FetchDesignDraft(ctx, tenantID, designDBTestActor, draft.ID)
	if err != nil {
		t.Fatalf("fetch expired failed draft: %v", err)
	}
	if persisted.Status != designDraftStatusFailed ||
		persisted.AttemptCount != 3 ||
		!persisted.ExpiresAt.Before(time.Now()) {
		t.Fatalf("expired retry mutated draft: %+v", persisted)
	}
}

func TestDesignRetryReplayWithLegacyNullReceiptFailsClosedDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	setDesignDraftFailedDB(t, ctx, pool, tenantID, draft.ID, 2)

	const key = "pre-1832-null-retry-key"
	insertLegacyRetryMutationDB(t, ctx, pool, tenantID, draft.ID, key)

	deps := &Deps{Designs: &DesignDraftRepo{Pool: pool}}
	got, replayed, err := deps.RetryDesignDraftJobWithKey(
		ctx, tenantID, designDBTestActor,
		draft.ID, key)

	if !errors.Is(err, ErrDesignDraftReplayAmbiguous) {
		t.Fatalf(
			"legacy NULL retry replay draft=%+v replayed=%v error=%v, want ambiguous",
			got,
			replayed,
			err,
		)
	}

	persisted, fetchErr := deps.FetchDesignDraft(ctx, tenantID, designDBTestActor, draft.ID)
	if fetchErr != nil {
		t.Fatalf("fetch after legacy retry replay: %v", fetchErr)
	}
	if persisted.Status != designDraftStatusFailed ||
		persisted.AttemptCount != 2 {
		t.Fatalf("legacy replay changed draft instead of failing closed: %+v", persisted)
	}
}

func TestDesignRefinementReplayRequiresExactCompletedReceiptDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	repo := &DesignDraftRepo{Pool: pool}
	deps := &Deps{Designs: repo}
	tabA := RefineDesignDraftInput{
		BaseRevision: 1,
		Instructions: "Use a compact editorial layout",
	}
	tabB := RefineDesignDraftInput{
		BaseRevision: 1,
		Instructions: "Use a bold visual magazine layout",
	}

	// Tab A records its identity but loses the response before queueing. Tab B
	// then legitimately wins the ready-draft transition and produces revision
	// two. Revision number alone must not satisfy A's later replay.
	registrationA, err := deps.registerDesignMutation(
		ctx, tenantID, designDBTestActor,
		draft.ID, "refine", "tab-a-refine-key", tabA,
	)
	if err != nil || registrationA.Replayed {
		t.Fatalf("register tab A=%+v error=%v", registrationA, err)
	}
	queued, replayed, err := deps.QueueDesignDraftRefinementWithKey(
		ctx, tenantID, designDBTestActor,
		draft.ID, "tab-b-refine-key", tabB)

	if err != nil || replayed || queued.Status != designDraftStatusQueued {
		t.Fatalf("queue tab B draft=%+v replayed=%v error=%v", queued, replayed, err)
	}

	claim := claimDesignDraftDB(t, ctx, pool, draft.ID)
	completed, err := repo.Complete(
		ctx,
		claim,
		DesignResponse{
			Name:                 "Bold weekly digest",
			Subject:              "A visual week in review",
			BodyHTML:             "<html><body><h1>Week in review</h1></body></html>",
			UnresolvedVariables:  []string{},
			ReferenceTemplateIDs: []string{},
			Warnings:             []string{},
		},
		DesignValidation{Status: "pass", Checks: []DesignValidationCheck{}},
		[]TemplateWarning{},
	)
	if err != nil {
		t.Fatalf("complete tab B refinement: %v", err)
	}
	if completed.CurrentRevision != 2 {
		t.Fatalf("completed revision=%d, want 2", completed.CurrentRevision)
	}

	expectedReceipt := normalizedRefinementRequestHash(tabB)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin refinement receipt tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var persistedReceipt []byte
	if err := tx.QueryRow(ctx, `
SELECT refinement_request_hash
  FROM campaign_template_design_revisions
 WHERE tenant_id = $1::uuid
   AND draft_id = $2::uuid
   AND revision = 2`,
		tenantID, draft.ID,
	).Scan(&persistedReceipt); err != nil {
		t.Fatalf("read refinement receipt: %v", err)
	}
	if !bytes.Equal(persistedReceipt, expectedReceipt[:]) {
		t.Fatalf(
			"refinement receipt=%x, want %x",
			persistedReceipt,
			expectedReceipt,
		)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit refinement receipt read: %v", err)
	}

	if raw, marshalErr := json.Marshal(completed); marshalErr != nil {
		t.Fatalf("marshal completed draft: %v", marshalErr)
	} else if strings.Contains(string(raw), "refinement_request_hash") {
		t.Fatalf("internal refinement receipt leaked in response: %s", raw)
	}

	wrongDraft, _, wrongErr := deps.QueueDesignDraftRefinementWithKey(
		ctx, tenantID, designDBTestActor,
		draft.ID, "tab-a-refine-key", tabA)

	if wrongErr == nil || wrongDraft != nil {
		t.Fatalf(
			"tab A replay falsely acknowledged tab B revision: draft=%+v error=%v",
			wrongDraft,
			wrongErr,
		)
	}

	exact, replayed, err := deps.QueueDesignDraftRefinementWithKey(
		ctx, tenantID, designDBTestActor,
		draft.ID, "tab-b-refine-key", tabB)

	if err != nil {
		t.Fatalf("tab B exact replay: %v", err)
	}
	if !replayed || exact.CurrentRevision != 2 ||
		exact.Revision == nil || exact.Revision.Revision != 2 {
		t.Fatalf("tab B exact replay draft=%+v replayed=%v", exact, replayed)
	}
}

func setDesignDraftFailedDB(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, draftID string,
	attemptCount int,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin failed-design tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'failed',
       attempt_count = $3,
       claim_token = NULL,
       lease_expires_at = NULL,
       last_error_code = 'provider_failed',
       last_error_message = 'The generation attempt failed.'
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID, draftID, attemptCount,
	); err != nil {
		t.Fatalf("mark design failed: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit failed design: %v", err)
	}
}

func seedQueuedDesignDraft(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID string,
) *DesignDraft {
	t.Helper()
	deps := &Deps{
		Repo:    &Repo{Pool: pool},
		Designs: &DesignDraftRepo{Pool: pool},
	}
	draft, replayed, err := deps.StartDesignDraft(
		ctx,
		tenantID,
		designDBTestActor,
		"queued-"+randHex4(t),
		CreateDesignDraftInput{
			Mode:  "generate",
			Brief: "A healthy queued worker-control newsletter",
			Goal:  "newsletter",
		},
	)
	if err != nil {
		t.Fatalf("StartDesignDraft queued control: %v", err)
	}
	if replayed || draft.Status != designDraftStatusQueued {
		t.Fatalf("queued control draft=%+v replayed=%v", draft, replayed)
	}
	return draft
}

func setDesignDraftExpiredFailedDB(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, draftID string,
	attemptCount int,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin expired failed-design tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'failed',
       attempt_count = $3,
       claim_token = NULL,
       lease_expires_at = NULL,
       created_at = now() - interval '48 hours',
       expires_at = now() - interval '24 hours',
       last_error_code = 'design_expired',
       last_error_message = 'This design expired.'
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID, draftID, attemptCount,
	); err != nil {
		t.Fatalf("mark design expired and failed: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit expired failed design: %v", err)
	}
}

func assertDesignMutationReceiptCountDB(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, key string,
	want int,
) {
	t.Helper()
	keyHash := sha256.Sum256([]byte(key))
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin mutation receipt count tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND idempotency_key_hash = $2`,
		tenantID,
		keyHash[:],
	).Scan(&got); err != nil {
		t.Fatalf("count design mutation receipts: %v", err)
	}
	if got != want {
		t.Fatalf("design mutation receipt count=%d, want %d", got, want)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit mutation receipt count: %v", err)
	}
}

func assertDesignRetryReceiptGuardDB(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
) {
	t.Helper()
	var installed bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation
        ON relation.oid = trigger.tgrelid
     WHERE relation.relname = 'campaign_template_design_drafts'
       AND trigger.tgname =
           'campaign_template_design_retry_receipt_guard'
       AND NOT trigger.tgisinternal
)`).Scan(&installed); err != nil {
		t.Fatalf("inspect retry receipt guard: %v", err)
	}
	if !installed {
		t.Fatal("campaign template design retry receipt guard is not installed")
	}
}

func claimDesignDraftDB(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	draftID string,
) claimedDesignDraft {
	t.Helper()
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("begin design claim tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	draft, err := scanDesignDraft(tx.QueryRow(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'generating',
       attempt_count = attempt_count + 1,
       claim_token = gen_random_uuid(),
       lease_expires_at = now() + interval '3 minutes'
 WHERE id = $1::uuid
   AND status = 'queued'
 RETURNING `+designDraftColumns,
		draftID,
	))
	if err != nil {
		t.Fatalf("claim design %s: %v", draftID, err)
	}
	if draft.CurrentRevision > 0 {
		draft.Revision, err = loadDesignRevision(
			ctx, tx, "", draft.ID, draft.CurrentRevision, true,
		)
		if err != nil {
			t.Fatalf("load claimed design revision: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit design claim: %v", err)
	}
	return claimedDesignDraft{Draft: *draft}
}

func insertLegacyRetryMutationDB(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, draftID, key string,
) {
	t.Helper()
	requestRaw, err := json.Marshal(struct {
		DraftID   string `json:"draft_id"`
		Operation string `json:"operation"`
		Payload   any    `json:"payload"`
	}{
		DraftID:   draftID,
		Operation: "retry",
		Payload:   map[string]any{},
	})
	if err != nil {
		t.Fatalf("marshal legacy retry identity: %v", err)
	}
	keyHash := sha256.Sum256([]byte(key))
	requestHash := sha256.Sum256(requestRaw)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin legacy retry mutation tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_template_design_mutations (
    tenant_id, draft_id, operation, idempotency_key_hash, request_hash,
    registered_attempt_count
) VALUES ($1::uuid, $2::uuid, 'retry', $3, $4, NULL)`,
		tenantID, draftID, keyHash[:], requestHash[:],
	); err != nil {
		t.Fatalf("insert legacy retry mutation: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy retry mutation: %v", err)
	}
}

func TestDesignSaveRaceRejectsDifferentMaterializedOutcomeDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	if draft.Revision == nil {
		t.Fatal("ready draft has no revision")
	}
	templateRepo := &Repo{Pool: pool}
	deps := &Deps{
		Repo:    templateRepo,
		Designs: &DesignDraftRepo{Pool: pool},
	}
	commit := CommitDesignDraftInput{
		Revision:   draft.Revision.Revision,
		OutputHash: draft.Revision.OutputHash,
	}
	type request struct {
		key   string
		input SaveDesignDraftInput
	}
	requests := []request{
		{
			key: "save-race-a",
			input: SaveDesignDraftInput{
				CommitDesignDraftInput: commit,
				Slug:                   "save-race-a-" + randHex4(t),
				Name:                   "Editorial save outcome",
				Subject:                "Editorial weekly",
			},
		},
		{
			key: "save-race-b",
			input: SaveDesignDraftInput{
				CommitDesignDraftInput: commit,
				Slug:                   "save-race-b-" + randHex4(t),
				Name:                   "Visual save outcome",
				Subject:                "Visual weekly",
			},
		},
	}
	type result struct {
		request  request
		template *Template
		replayed bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan result, len(requests))
	for index := range requests {
		item := requests[index]
		go func() {
			<-start
			template, replayed, err := deps.SaveDesignDraftRevisionWithKey(
				ctx,
				tenantID, designDBTestActor,

				draft.ID,
				item.key,
				item.input)

			results <- result{
				request: item, template: template, replayed: replayed, err: err,
			}
		}()
	}
	close(start)

	var winner, loser *result
	for range requests {
		got := <-results
		switch {
		case got.err == nil:
			copy := got
			winner = &copy
		case errors.Is(got.err, ErrDesignDraftOutcomeConflict):
			copy := got
			loser = &copy
		default:
			t.Fatalf("unexpected save race result=%+v error=%v", got.template, got.err)
		}
	}
	if winner == nil || loser == nil {
		t.Fatalf("save race winner=%+v loser=%+v", winner, loser)
	}
	if winner.replayed || winner.template == nil ||
		winner.template.Slug != winner.request.input.Slug ||
		winner.template.Name != winner.request.input.Name {
		t.Fatalf("save race winner=%+v", winner)
	}
	if loser.template != nil {
		t.Fatalf("save race loser returned winner template: %+v", loser)
	}

	exact, replayed, err := deps.SaveDesignDraftRevisionWithKey(
		ctx,
		tenantID, designDBTestActor,

		draft.ID,
		winner.request.key,
		winner.request.input)

	if err != nil || !replayed || exact == nil ||
		exact.ID != winner.template.ID {
		t.Fatalf("winning save replay=%+v replayed=%v error=%v", exact, replayed, err)
	}
	wrong, replayed, err := deps.SaveDesignDraftRevisionWithKey(
		ctx,
		tenantID, designDBTestActor,

		draft.ID,
		loser.request.key,
		loser.request.input)

	if !errors.Is(err, ErrDesignDraftOutcomeConflict) ||
		!replayed || wrong != nil {
		t.Fatalf("losing save replay=%+v replayed=%v error=%v", wrong, replayed, err)
	}

	persisted, err := templateRepo.GetByDesignDraft(ctx, tenantID, draft.ID)
	if err != nil {
		t.Fatalf("get saved race winner: %v", err)
	}
	if persisted.ID != winner.template.ID ||
		persisted.Slug != winner.request.input.Slug ||
		persisted.Name != winner.request.input.Name {
		t.Fatalf("persisted save race outcome=%+v winner=%+v", persisted, winner)
	}
}

func TestDesignCreateCampaignRaceRejectsDifferentMaterializedOutcomeDB(
	t *testing.T,
) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
	if draft.Revision == nil {
		t.Fatal("ready draft has no revision")
	}
	campaignRepo := &campaigns.Repo{Pool: pool}
	deps := &Deps{
		Repo:      &Repo{Pool: pool},
		Designs:   &DesignDraftRepo{Pool: pool},
		Campaigns: campaignRepo,
	}
	commit := CommitDesignDraftInput{
		Revision:   draft.Revision.Revision,
		OutputHash: draft.Revision.OutputHash,
	}
	type request struct {
		key   string
		input CreateCampaignFromDesignDraftInput
	}
	requests := []request{
		{
			key: "campaign-race-a",
			input: CreateCampaignFromDesignDraftInput{
				CommitDesignDraftInput: commit,
				Name:                   "Editorial campaign outcome",
				Subject:                "Editorial campaign subject",
				PreviewText:            "Editorial campaign preview",
				Variables:              map[string]any{"edition": "editorial"},
			},
		},
		{
			key: "campaign-race-b",
			input: CreateCampaignFromDesignDraftInput{
				CommitDesignDraftInput: commit,
				Name:                   "Visual campaign outcome",
				Subject:                "Visual campaign subject",
				PreviewText:            "Visual campaign preview",
				Variables:              map[string]any{"edition": "visual"},
			},
		},
	}
	type result struct {
		request  request
		campaign *campaigns.Campaign
		replayed bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan result, len(requests))
	for index := range requests {
		item := requests[index]
		go func() {
			<-start
			campaign, replayed, err :=
				deps.CreateCampaignFromDesignRevisionWithKey(
					ctx,
					tenantID, designDBTestActor,

					draft.ID,
					item.key,
					item.input)

			results <- result{
				request: item, campaign: campaign,
				replayed: replayed, err: err,
			}
		}()
	}
	close(start)

	var winner, loser *result
	for range requests {
		got := <-results
		switch {
		case got.err == nil:
			copy := got
			winner = &copy
		case errors.Is(got.err, ErrDesignDraftOutcomeConflict):
			copy := got
			loser = &copy
		default:
			t.Fatalf(
				"unexpected campaign race result=%+v error=%v",
				got.campaign,
				got.err,
			)
		}
	}
	if winner == nil || loser == nil {
		t.Fatalf("campaign race winner=%+v loser=%+v", winner, loser)
	}
	if winner.replayed || winner.campaign == nil ||
		winner.campaign.Name != winner.request.input.Name ||
		winner.campaign.Subject != winner.request.input.Subject {
		t.Fatalf("campaign race winner=%+v", winner)
	}
	if loser.campaign != nil {
		t.Fatalf("campaign race loser returned winner campaign: %+v", loser)
	}

	exact, replayed, err := deps.CreateCampaignFromDesignRevisionWithKey(
		ctx,
		tenantID, designDBTestActor,

		draft.ID,
		winner.request.key,
		winner.request.input)

	if err != nil || !replayed || exact == nil ||
		exact.ID != winner.campaign.ID {
		t.Fatalf(
			"winning campaign replay=%+v replayed=%v error=%v",
			exact,
			replayed,
			err,
		)
	}
	wrong, replayed, err := deps.CreateCampaignFromDesignRevisionWithKey(
		ctx,
		tenantID, designDBTestActor,

		draft.ID,
		loser.request.key,
		loser.request.input)

	if !errors.Is(err, ErrDesignDraftOutcomeConflict) ||
		!replayed || wrong != nil {
		t.Fatalf(
			"losing campaign replay=%+v replayed=%v error=%v",
			wrong,
			replayed,
			err,
		)
	}

	persisted, err := campaignRepo.GetByTemplateDesignDraft(
		ctx, tenantID, draft.ID,
	)
	if err != nil {
		t.Fatalf("get campaign race winner: %v", err)
	}
	if persisted.ID != winner.campaign.ID ||
		persisted.Name != winner.request.input.Name ||
		persisted.Subject != winner.request.input.Subject {
		t.Fatalf(
			"persisted campaign race outcome=%+v winner=%+v",
			persisted,
			winner,
		)
	}
}

func TestDesignTemplateAndCampaignCommitsWorkInEitherOrderDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	templateRepo := &Repo{Pool: pool}
	designRepo := &DesignDraftRepo{Pool: pool}
	campaignRepo := &campaigns.Repo{Pool: pool}

	for _, order := range []string{"template-first", "campaign-first"} {
		t.Run(order, func(t *testing.T) {
			draft := seedReadyDesignDraft(t, ctx, pool, tenantID)
			template, err := templateRepo.Create(ctx, tenantID, CreateInput{
				Slug: "design-commit-" + randHex4(t),
				Name: "Committed design", Subject: "This week",
				TemplateKind: templateKindEditable, SourceProvider: "postwave",
				SourceLicenseStatus: licenseStatusOwned,
				ReviewStatus:        reviewStatusApproved,
			})
			if err != nil {
				t.Fatalf("create template: %v", err)
			}
			campaign, err := campaignRepo.Create(ctx, tenantID, campaigns.CreateInput{
				Name: "Committed campaign", Subject: "This week",
				CampaignType: "regular", EditorMode: "html",
				BodyHTML: "<html><body><p>Reviewed</p></body></html>",
			})
			if err != nil {
				t.Fatalf("create campaign: %v", err)
			}
			if order == "template-first" {
				if _, err := designRepo.MarkSaved(
					ctx, tenantID, designDBTestActor,
					draft.ID, 1, template.ID); err != nil {
					t.Fatalf("MarkSaved first: %v", err)
				}
				if _, err := designRepo.MarkCampaignCreated(
					ctx, tenantID, designDBTestActor,
					draft.ID, 1, campaign.ID); err != nil {
					t.Fatalf("MarkCampaignCreated second: %v", err)
				}
			} else {
				if _, err := designRepo.MarkCampaignCreated(
					ctx, tenantID, designDBTestActor,
					draft.ID, 1, campaign.ID); err != nil {
					t.Fatalf("MarkCampaignCreated first: %v", err)
				}
				if _, err := designRepo.MarkSaved(
					ctx, tenantID, designDBTestActor,
					draft.ID, 1, template.ID); err != nil {
					t.Fatalf("MarkSaved second: %v", err)
				}
			}
			got, err := designRepo.Get(ctx, tenantID, designDBTestActor, draft.ID)
			if err != nil {
				t.Fatalf("Get committed design: %v", err)
			}
			if got.SavedTemplateID != template.ID ||
				got.CreatedCampaignID != campaign.ID ||
				got.Capabilities.CanSave ||
				got.Capabilities.CanCreateCampaign {
				t.Fatalf("committed design=%+v", got)
			}
		})
	}
}
