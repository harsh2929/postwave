// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type DesignDraftRepo struct {
	Pool *db.Pool
}

const designDraftColumns = `
       id::text, tenant_id::text, mode, status, COALESCE(source_template_id::text, ''),
       COALESCE(to_jsonb(reference_template_ids), '[]'::jsonb),
       request_payload, current_revision, pending_operation, pending_payload,
       pending_base_revision, attempt_count, COALESCE(claim_token::text, ''),
       last_error_code, last_error_message,
       COALESCE(saved_template_id::text, ''), saved_revision,
       COALESCE(created_campaign_id::text, ''), campaign_revision,
       expires_at, created_at, updated_at`

const designDraftSummaryColumns = `
       id::text, mode, status, COALESCE(source_template_id::text, ''),
       current_revision, attempt_count, last_error_code, last_error_message,
       COALESCE(saved_template_id::text, ''), saved_revision,
       COALESCE(created_campaign_id::text, ''), campaign_revision,
       expires_at, created_at, updated_at`

type designDraftRowScanner interface {
	Scan(...any) error
}

func scanDesignDraft(row designDraftRowScanner) (*DesignDraft, error) {
	var draft DesignDraft
	var referenceRaw, requestRaw, pendingRaw []byte
	var pendingBase *int
	if err := row.Scan(
		&draft.ID, &draft.tenantID, &draft.Mode, &draft.Status, &draft.SourceTemplateID,
		&referenceRaw, &requestRaw, &draft.CurrentRevision,
		&draft.pendingOperation, &pendingRaw, &pendingBase,
		&draft.AttemptCount, &draft.claimToken,
		&draft.LastErrorCode, &draft.LastErrorMessage,
		&draft.SavedTemplateID, &draft.SavedRevision,
		&draft.CreatedCampaignID, &draft.CampaignRevision,
		&draft.ExpiresAt, &draft.CreatedAt, &draft.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrDesignDraftNotFound
		}
		return nil, err
	}
	if err := json.Unmarshal(referenceRaw, &draft.ReferenceTemplateIDs); err != nil {
		return nil, fmt.Errorf("decode design draft references: %w", err)
	}
	if err := json.Unmarshal(requestRaw, &draft.RequestPayload); err != nil {
		return nil, fmt.Errorf("decode design draft request: %w", err)
	}
	if len(pendingRaw) > 0 {
		_ = json.Unmarshal(pendingRaw, &draft.pendingPayload)
	}
	draft.pendingBaseRevision = pendingBase
	if draft.ReferenceTemplateIDs == nil {
		draft.ReferenceTemplateIDs = []string{}
	}
	projectDesignDraft(&draft)
	return &draft, nil
}

func scanDesignDraftSummary(
	row designDraftRowScanner,
) (DesignDraftSummary, error) {
	var draft DesignDraft
	if err := row.Scan(
		&draft.ID, &draft.Mode, &draft.Status, &draft.SourceTemplateID,
		&draft.CurrentRevision, &draft.AttemptCount,
		&draft.LastErrorCode, &draft.LastErrorMessage,
		&draft.SavedTemplateID, &draft.SavedRevision,
		&draft.CreatedCampaignID, &draft.CampaignRevision,
		&draft.ExpiresAt, &draft.CreatedAt, &draft.UpdatedAt,
	); err != nil {
		return DesignDraftSummary{}, err
	}
	return summarizeDesignDraft(&draft), nil
}

func scanDesignRevision(row designDraftRowScanner) (*DesignRevision, error) {
	var revision DesignRevision
	var outputRaw, validationRaw, warningsRaw []byte
	if err := row.Scan(
		&revision.ID, &revision.DraftID, &revision.Revision,
		&revision.Operation, &revision.BaseRevision,
		&revision.refinementRequestHash, &outputRaw,
		&revision.OutputHash, &validationRaw, &warningsRaw,
		&revision.CreatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrDesignDraftRevisionConflict
		}
		return nil, err
	}
	if err := json.Unmarshal(outputRaw, &revision.Output); err != nil {
		return nil, fmt.Errorf("decode design revision output: %w", err)
	}
	if err := json.Unmarshal(validationRaw, &revision.Validation); err != nil {
		return nil, fmt.Errorf("decode design revision validation: %w", err)
	}
	if err := json.Unmarshal(warningsRaw, &revision.Warnings); err != nil {
		return nil, fmt.Errorf("decode design revision warnings: %w", err)
	}
	if revision.Output.UnresolvedVariables == nil {
		revision.Output.UnresolvedVariables = []string{}
	}
	if revision.Output.ReferenceTemplateIDs == nil {
		revision.Output.ReferenceTemplateIDs = []string{}
	}
	if revision.Output.Warnings == nil {
		revision.Output.Warnings = []string{}
	}
	if revision.Warnings == nil {
		revision.Warnings = []TemplateWarning{}
	}
	if revision.Validation.Checks == nil {
		revision.Validation.Checks = []DesignValidationCheck{}
	}
	return &revision, nil
}

func loadDesignRevision(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, draftID string,
	revision int,
	worker bool,
) (*DesignRevision, error) {
	tenantClause := "tenant_id = $1::uuid AND draft_id = $2::uuid AND revision = $3"
	args := []any{tenantID, draftID, revision}
	if worker {
		tenantClause = "draft_id = $1::uuid AND revision = $2"
		args = []any{draftID, revision}
	}
	return scanDesignRevision(tx.QueryRow(ctx, `
SELECT id::text, draft_id::text, revision, operation, base_revision,
       refinement_request_hash, output, output_hash, validation, warnings,
       created_at
  FROM campaign_template_design_revisions
 WHERE `+tenantClause, args...))
}

func (r *DesignDraftRepo) Create(
	ctx context.Context,
	record designDraftCreateRecord,
) (*DesignDraft, bool, error) {
	if r == nil || r.Pool == nil {
		return nil, false, errors.New("campaign template design store unavailable")
	}
	actor, err := normalizeReferenceReviewActor(record.Actor)
	if err != nil {
		return nil, false, err
	}
	record.Actor = actor
	requestRaw, err := json.Marshal(record.Input)
	if err != nil {
		return nil, false, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, record.TenantID)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row := tx.QueryRow(ctx, `
INSERT INTO campaign_template_design_drafts (
    tenant_id, mode, source_template_id, reference_template_ids,
    request_payload, request_hash, idempotency_key_hash, actor_type, actor_id
)
VALUES (
    $1::uuid, $2, NULLIF($3, '')::uuid, $4::uuid[],
    $5::jsonb, $6, $7, $8, $9
)
ON CONFLICT (tenant_id, idempotency_key_hash)
    WHERE idempotency_key_hash IS NOT NULL
DO NOTHING
RETURNING `+designDraftColumns,
		record.TenantID, record.Input.Mode, record.SourceTemplateID,
		record.ReferenceIDs, requestRaw, record.RequestHash,
		record.IdempotencyHash, record.Actor.Type, record.Actor.ID)
	draft, scanErr := scanDesignDraft(row)
	replayed := false
	if errors.Is(scanErr, ErrDesignDraftNotFound) {
		replayed = true
		var existingRequestHash []byte
		row = tx.QueryRow(ctx, `
SELECT `+designDraftColumns+`, request_hash
  FROM campaign_template_design_drafts
 WHERE tenant_id = $1::uuid
   AND idempotency_key_hash = $2
   AND actor_type = $3
   AND actor_id = $4
 FOR UPDATE`,
			record.TenantID, record.IdempotencyHash,
			record.Actor.Type, record.Actor.ID)
		var existing DesignDraft
		var referenceJSON, requestJSON, pendingJSON []byte
		var pendingBase *int
		if err := row.Scan(
			&existing.ID, &existing.tenantID, &existing.Mode, &existing.Status, &existing.SourceTemplateID,
			&referenceJSON, &requestJSON, &existing.CurrentRevision,
			&existing.pendingOperation, &pendingJSON, &pendingBase,
			&existing.AttemptCount, &existing.claimToken,
			&existing.LastErrorCode, &existing.LastErrorMessage,
			&existing.SavedTemplateID, &existing.SavedRevision,
			&existing.CreatedCampaignID, &existing.CampaignRevision,
			&existing.ExpiresAt, &existing.CreatedAt, &existing.UpdatedAt,
			&existingRequestHash,
		); errors.Is(err, pgx.ErrNoRows) {
			return nil, false, ErrDesignDraftNotFound
		} else if err != nil {
			return nil, false, err
		}
		if !bytes.Equal(existingRequestHash, record.RequestHash) {
			return nil, false, ErrDesignDraftIdempotencyConflict
		}
		if err := json.Unmarshal(referenceJSON, &existing.ReferenceTemplateIDs); err != nil {
			return nil, false, err
		}
		if err := json.Unmarshal(requestJSON, &existing.RequestPayload); err != nil {
			return nil, false, err
		}
		_ = json.Unmarshal(pendingJSON, &existing.pendingPayload)
		existing.pendingBaseRevision = pendingBase
		draft = &existing
		projectDesignDraft(draft)
	} else if scanErr != nil {
		return nil, false, scanErr
	}
	if draft.CurrentRevision > 0 {
		draft.Revision, err = loadDesignRevision(ctx, tx, record.TenantID, draft.ID, draft.CurrentRevision, false)
		if err != nil {
			return nil, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return draft, replayed, nil
}

func (r *DesignDraftRepo) Get(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
) (*DesignDraft, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("campaign template design store unavailable")
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	draft, err := scanDesignDraft(tx.QueryRow(ctx, `
SELECT `+designDraftColumns+`
  FROM campaign_template_design_drafts
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4`,
		tenantID, actor.Type, actor.ID, id))
	if err != nil {
		return nil, err
	}
	if draft.CurrentRevision > 0 {
		draft.Revision, err = loadDesignRevision(ctx, tx, tenantID, id, draft.CurrentRevision, false)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return draft, nil
}

func (r *DesignDraftRepo) ListRecoverable(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	limit int,
	cursor designDraftCursorPosition,
) ([]DesignDraftSummary, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("campaign template design store unavailable")
	}
	if limit < 1 || limit > maxDesignDraftListLimit+1 {
		return nil, ErrInvalidDesignDraftLimit
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	var cursorUpdatedAt any
	cursorID := ""
	if !cursor.UpdatedAt.IsZero() {
		cursorUpdatedAt = cursor.UpdatedAt.UTC()
		cursorID = cursor.DesignID
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+designDraftSummaryColumns+`
  FROM campaign_template_design_drafts
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND status <> 'archived'
   AND expires_at > now()
   AND (
       $4::timestamptz IS NULL
       OR (updated_at, id) <
          ($4::timestamptz, NULLIF($5, '')::uuid)
   )
 ORDER BY updated_at DESC, id DESC
 LIMIT $6`,
		tenantID, actor.Type, actor.ID, cursorUpdatedAt, cursorID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]DesignDraftSummary, 0, limit)
	for rows.Next() {
		item, scanErr := scanDesignDraftSummary(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return items, nil
}

func (r *DesignDraftRepo) ListRevisions(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
) ([]DesignRevision, error) {
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM campaign_template_design_drafts
     WHERE tenant_id = $1::uuid
       AND actor_type = $2
       AND actor_id = $3
       AND id::text = $4
)`, tenantID, actor.Type, actor.ID, id).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrDesignDraftNotFound
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, draft_id::text, revision, operation, base_revision,
       refinement_request_hash, output, output_hash, validation, warnings,
       created_at
  FROM campaign_template_design_revisions
 WHERE tenant_id = $1::uuid AND draft_id::text = $2
 ORDER BY revision DESC`, tenantID, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DesignRevision{}
	for rows.Next() {
		revision, scanErr := scanDesignRevision(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, *revision)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *DesignDraftRepo) QueueRefinement(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
	in RefineDesignDraftInput,
) (*DesignDraft, error) {
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(in)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status string
	var current int
	if err := tx.QueryRow(ctx, `
SELECT status, current_revision
  FROM campaign_template_design_drafts
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4
 FOR UPDATE`, tenantID, actor.Type, actor.ID, id).Scan(&status, &current); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrDesignDraftNotFound
		}
		return nil, err
	}
	if status == designDraftStatusQueued || status == designDraftStatusGenerating {
		return nil, ErrDesignDraftBusy
	}
	if status != designDraftStatusReady {
		return nil, ErrDesignDraftNotReady
	}
	if current != in.BaseRevision {
		return nil, ErrDesignDraftRevisionConflict
	}
	draft, err := scanDesignDraft(tx.QueryRow(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'queued',
       pending_operation = 'refine',
       pending_payload = $5::jsonb,
       pending_base_revision = $6,
       next_attempt_at = now(),
       claim_token = NULL,
       lease_expires_at = NULL,
       last_error_code = '',
       last_error_message = ''
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4
 RETURNING `+designDraftColumns,
		tenantID, actor.Type, actor.ID, id, raw, in.BaseRevision))
	if err != nil {
		return nil, err
	}
	if draft.CurrentRevision > 0 {
		draft.Revision, err = loadDesignRevision(ctx, tx, tenantID, id, draft.CurrentRevision, false)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return draft, nil
}

func (r *DesignDraftRepo) Retry(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
) (*DesignDraft, error) {
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	draft, err := scanDesignDraft(tx.QueryRow(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'queued',
       next_attempt_at = now(),
       claim_token = NULL,
       lease_expires_at = NULL,
       last_error_code = '',
       last_error_message = ''
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4
   AND status = 'failed'
 RETURNING `+designDraftColumns,
		tenantID, actor.Type, actor.ID, id))
	if errors.Is(err, ErrDesignDraftNotFound) {
		var status string
		lookupErr := tx.QueryRow(ctx, `
SELECT status FROM campaign_template_design_drafts
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4`,
			tenantID, actor.Type, actor.ID, id).Scan(&status)
		if errors.Is(lookupErr, pgx.ErrNoRows) {
			return nil, ErrDesignDraftNotFound
		}
		if lookupErr != nil {
			return nil, lookupErr
		}
		return nil, ErrDesignDraftRetryUnavailable
	}
	if err != nil {
		return nil, err
	}
	if draft.CurrentRevision > 0 {
		draft.Revision, err = loadDesignRevision(ctx, tx, tenantID, id, draft.CurrentRevision, false)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return draft, nil
}

func (r *DesignDraftRepo) Archive(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
) (*DesignDraft, error) {
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	draft, err := scanDesignDraft(tx.QueryRow(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'archived',
       claim_token = NULL,
       lease_expires_at = NULL
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4
   AND status NOT IN ('generating', 'archived')
 RETURNING `+designDraftColumns,
		tenantID, actor.Type, actor.ID, id))
	if errors.Is(err, ErrDesignDraftNotFound) {
		var status string
		lookupErr := tx.QueryRow(ctx, `
SELECT status FROM campaign_template_design_drafts
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4`,
			tenantID, actor.Type, actor.ID, id).Scan(&status)
		if errors.Is(lookupErr, pgx.ErrNoRows) {
			return nil, ErrDesignDraftNotFound
		}
		if lookupErr != nil {
			return nil, lookupErr
		}
		return nil, ErrDesignDraftBusy
	}
	if err != nil {
		return nil, err
	}
	if draft.CurrentRevision > 0 {
		draft.Revision, err = loadDesignRevision(ctx, tx, tenantID, id, draft.CurrentRevision, false)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return draft, nil
}

func (r *DesignDraftRepo) ClaimNext(ctx context.Context) (*claimedDesignDraft, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'failed',
       claim_token = NULL,
       lease_expires_at = NULL,
       last_error_code = 'design_expired',
       last_error_message = 'This design expired before generation completed.'
 WHERE status IN ('queued', 'generating')
   AND expires_at <= now()`); err != nil {
		return nil, err
	}
	// Never let a legacy/manual queued row at the hard attempt cap poison the
	// global picker: incrementing 20 would violate the table CHECK and roll
	// back the whole claim transaction on every worker pass.
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'failed',
       claim_token = NULL,
       lease_expires_at = NULL,
       last_error_code = 'attempt_limit_exhausted',
       last_error_message = 'This design reached the maximum generation attempts.'
 WHERE status = 'queued'
   AND attempt_count >= 20`); err != nil {
		return nil, err
	}
	// A process crash must not strand a generating row forever. The new claim
	// gets a different token, so a late worker cannot commit over it.
	if _, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'queued',
       claim_token = NULL,
       lease_expires_at = NULL,
       next_attempt_at = now(),
       last_error_code = 'worker_lease_expired',
       last_error_message = 'The previous worker stopped before completing this attempt.'
 WHERE status = 'generating'
   AND lease_expires_at < now()`); err != nil {
		return nil, err
	}
	draft, err := scanDesignDraft(tx.QueryRow(ctx, `
WITH picked AS (
    SELECT id
      FROM campaign_template_design_drafts
	     WHERE status = 'queued'
	       AND attempt_count < 20
	       AND next_attempt_at <= now()
       AND expires_at > now()
     ORDER BY next_attempt_at, created_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
)
UPDATE campaign_template_design_drafts AS draft
   SET status = 'generating',
       attempt_count = attempt_count + 1,
       claim_token = gen_random_uuid(),
       lease_expires_at = now() + interval '3 minutes'
  FROM picked
 WHERE draft.id = picked.id
 RETURNING
       draft.id::text, draft.tenant_id::text, draft.mode, draft.status,
       COALESCE(draft.source_template_id::text, ''),
       COALESCE(to_jsonb(draft.reference_template_ids), '[]'::jsonb),
       draft.request_payload, draft.current_revision, draft.pending_operation,
       draft.pending_payload, draft.pending_base_revision, draft.attempt_count,
       COALESCE(draft.claim_token::text, ''), draft.last_error_code,
       draft.last_error_message, COALESCE(draft.saved_template_id::text, ''),
       draft.saved_revision, COALESCE(draft.created_campaign_id::text, ''),
       draft.campaign_revision, draft.expires_at, draft.created_at,
       draft.updated_at`))
	if errors.Is(err, ErrDesignDraftNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if draft.CurrentRevision > 0 {
		draft.Revision, err = loadDesignRevision(ctx, tx, "", draft.ID, draft.CurrentRevision, true)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &claimedDesignDraft{Draft: *draft}, nil
}

func (r *DesignDraftRepo) Complete(
	ctx context.Context,
	claim claimedDesignDraft,
	output DesignResponse,
	validation DesignValidation,
	warnings []TemplateWarning,
) (*DesignDraft, error) {
	outputRaw, err := json.Marshal(output)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(outputRaw)
	outputHash := hex.EncodeToString(sum[:])
	validationRaw, _ := json.Marshal(validation)
	warningsRaw, _ := json.Marshal(warnings)
	var refinementRequestHash []byte
	if claim.Draft.pendingOperation == "refine" {
		sum := normalizedRefinementRequestHash(claim.Draft.pendingPayload)
		refinementRequestHash = sum[:]
	}

	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	nextRevision := claim.Draft.CurrentRevision + 1
	var revision DesignRevision
	var revisionOutput, revisionValidation, revisionWarnings []byte
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_template_design_revisions (
    tenant_id, draft_id, revision, operation, base_revision,
    refinement_request_hash, output, output_hash, validation, warnings
)
SELECT tenant_id, id, $3, pending_operation, pending_base_revision,
       $4, $5::jsonb, $6, $7::jsonb, $8::jsonb
  FROM campaign_template_design_drafts
 WHERE id = $1::uuid
   AND claim_token = $2::uuid
   AND status = 'generating'
   AND current_revision = $9
RETURNING id::text, draft_id::text, revision, operation, base_revision,
          refinement_request_hash, output, output_hash, validation, warnings,
          created_at`,
		claim.Draft.ID, claim.Draft.claimToken, nextRevision,
		refinementRequestHash, outputRaw, outputHash, validationRaw, warningsRaw,
		claim.Draft.CurrentRevision,
	).Scan(
		&revision.ID, &revision.DraftID, &revision.Revision,
		&revision.Operation, &revision.BaseRevision,
		&revision.refinementRequestHash, &revisionOutput,
		&revision.OutputHash, &revisionValidation, &revisionWarnings,
		&revision.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrDesignDraftClaimLost
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(revisionOutput, &revision.Output); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(revisionValidation, &revision.Validation); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(revisionWarnings, &revision.Warnings); err != nil {
		return nil, err
	}

	draft, err := scanDesignDraft(tx.QueryRow(ctx, `
UPDATE campaign_template_design_drafts
   SET status = 'ready',
       current_revision = $3,
       pending_operation = 'initial',
       pending_payload = '{}'::jsonb,
       pending_base_revision = NULL,
       claim_token = NULL,
       lease_expires_at = NULL,
       last_error_code = '',
       last_error_message = ''
 WHERE id = $1::uuid
   AND claim_token = $2::uuid
   AND status = 'generating'
 RETURNING `+designDraftColumns,
		claim.Draft.ID, claim.Draft.claimToken, nextRevision))
	if err != nil {
		return nil, ErrDesignDraftClaimLost
	}
	draft.Revision = &revision
	projectDesignDraft(draft)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return draft, nil
}

func (r *DesignDraftRepo) Fail(
	ctx context.Context,
	claim claimedDesignDraft,
	code, message string,
	retryable bool,
) error {
	message = boundedString(strings.TrimSpace(message), 2000)
	status := designDraftStatusFailed
	delaySeconds := 0
	if retryable && claim.Draft.AttemptCount < 3 {
		status = designDraftStatusQueued
		delaySeconds = 1 << min(claim.Draft.AttemptCount, 5)
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaign_template_design_drafts
   SET status = $3,
       next_attempt_at = now() + ($4 * interval '1 second'),
       claim_token = NULL,
       lease_expires_at = NULL,
       last_error_code = $5,
       last_error_message = $6
 WHERE id = $1::uuid
   AND claim_token = $2::uuid
   AND status = 'generating'`,
		claim.Draft.ID, claim.Draft.claimToken, status, delaySeconds, code, message)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrDesignDraftClaimLost
	}
	return tx.Commit(ctx)
}

func (r *DesignDraftRepo) MarkSaved(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
	revision int,
	templateID string,
) (*DesignDraft, error) {
	return r.markCommitted(
		ctx, tenantID, actor, id, revision, templateID, true,
	)
}

func (r *DesignDraftRepo) MarkCampaignCreated(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
	revision int,
	campaignID string,
) (*DesignDraft, error) {
	return r.markCommitted(
		ctx, tenantID, actor, id, revision, campaignID, false,
	)
}

func (r *DesignDraftRepo) markCommitted(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
	revision int,
	resourceID string,
	template bool,
) (*DesignDraft, error) {
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	setClause := `
       status = 'campaign_created',
       created_campaign_id = $6::uuid,
       campaign_revision = $5`
	if template {
		setClause = `
       status = 'saved',
       saved_template_id = $6::uuid,
       saved_revision = $5`
	}
	outcomeGuard := `
   AND (
       created_campaign_id IS NULL
       OR (
           created_campaign_id = $6::uuid
           AND campaign_revision = $5
       )
   )`
	if template {
		outcomeGuard = `
   AND (
       saved_template_id IS NULL
       OR (
           saved_template_id = $6::uuid
           AND saved_revision = $5
       )
   )`
	}
	draft, err := scanDesignDraft(tx.QueryRow(ctx, `
UPDATE campaign_template_design_drafts
   SET `+setClause+`
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4
   AND current_revision = $5
   AND status IN ('ready', 'saved', 'campaign_created')
   `+outcomeGuard+`
 RETURNING `+designDraftColumns,
		tenantID, actor.Type, actor.ID, id, revision, resourceID))
	if errors.Is(err, ErrDesignDraftNotFound) {
		var owned bool
		if lookupErr := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM campaign_template_design_drafts
     WHERE tenant_id = $1::uuid
       AND actor_type = $2
       AND actor_id = $3
       AND id::text = $4
)`, tenantID, actor.Type, actor.ID, id).Scan(&owned); lookupErr != nil {
			return nil, lookupErr
		}
		if !owned {
			return nil, ErrDesignDraftNotFound
		}
		return nil, ErrDesignDraftRevisionConflict
	}
	if err != nil {
		return nil, err
	}
	draft.Revision, err = loadDesignRevision(ctx, tx, tenantID, id, revision, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return draft, nil
}
