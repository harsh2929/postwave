// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func (d *Deps) replayedDesignMutationDraft(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	draftID, operation string,
	payload any,
) (*DesignDraft, bool) {
	draft, err := d.FetchDesignDraft(ctx, tenantID, actor, draftID)
	if err != nil {
		return nil, false
	}
	switch operation {
	case "refine":
		input, ok := payload.(RefineDesignDraftInput)
		if !ok {
			return nil, false
		}
		if draft.CurrentRevision > input.BaseRevision {
			expectedHash := normalizedRefinementRequestHash(input)
			revisions, revisionsErr := d.FetchDesignDraftRevisions(
				ctx,
				tenantID,
				actor,
				draftID,
			)
			if revisionsErr != nil {
				return nil, false
			}
			for index := range revisions {
				revision := revisions[index]
				if revision.Operation == "refine" &&
					revision.BaseRevision != nil &&
					*revision.BaseRevision == input.BaseRevision &&
					bytes.Equal(
						revision.refinementRequestHash,
						expectedHash[:],
					) {
					return draft, true
				}
			}
			// Pre-1831 revisions and a different tab's refinement are
			// deliberately ambiguous. Fail closed instead of acknowledging
			// work this idempotency key did not produce.
			return nil, false
		}
		if draft.pendingOperation == "refine" &&
			draft.pendingBaseRevision != nil &&
			*draft.pendingBaseRevision == input.BaseRevision &&
			strings.TrimSpace(draft.pendingPayload.Instructions) ==
				strings.TrimSpace(input.Instructions) {
			return draft, true
		}
	case "retry":
		registeredAttemptCount, _ := payload.(*int)
		// Migration 1832 receipts are written atomically with failed -> queued.
		// Their existence, not a later mutable status, proves this exact key
		// won the retry transition. NULL legacy rows remain ambiguous.
		if registeredAttemptCount != nil &&
			draft.AttemptCount >= *registeredAttemptCount {
			return draft, true
		}
	case "archive":
		if draft.Status == designDraftStatusArchived {
			return draft, true
		}
	}
	return nil, false
}

func normalizedRefinementRequestHash(
	input RefineDesignDraftInput,
) [sha256.Size]byte {
	input.Instructions = strings.TrimSpace(input.Instructions)
	raw, _ := json.Marshal(input)
	return sha256.Sum256(raw)
}

type designMutationRegistration struct {
	Replayed               bool
	RegisteredAttemptCount *int
}

type designMutationRegistrar interface {
	RegisterDesignMutation(
		context.Context,
		string,
		ReferenceReviewActor,
		string,
		string,
		[]byte,
		[]byte,
	) (designMutationRegistration, error)
}

type designRetryMutationRegistrar interface {
	RetryDesignDraftWithMutation(
		context.Context,
		string,
		ReferenceReviewActor,
		string,
		[]byte,
		[]byte,
	) (*DesignDraft, designMutationRegistration, error)
}

// registerDesignMutation binds one printable client key to the exact draft,
// operation, and payload. Retry is deliberately excluded: its identity and
// failed-to-queued transition must commit atomically, so it uses
// RetryDesignDraftWithMutation below.
func (d *Deps) registerDesignMutation(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	draftID, operation, idempotencyKey string,
	payload any,
) (designMutationRegistration, error) {
	if idempotencyKey == "" {
		// Internal callers predating the retry-safe boundary remain supported.
		// HTTP always supplies a validated key; native MCP passes one explicitly.
		return designMutationRegistration{}, nil
	}
	registrar, ok := d.Designs.(designMutationRegistrar)
	if !ok {
		// In-memory test stores exercise the state machine without a database.
		return designMutationRegistration{}, nil
	}
	keyHash, requestHash, err := designMutationIdentityHashes(
		draftID,
		operation,
		idempotencyKey,
		payload,
	)
	if err != nil {
		return designMutationRegistration{}, err
	}
	return registrar.RegisterDesignMutation(
		ctx, tenantID, actor, draftID, operation, keyHash, requestHash,
	)
}

func designMutationIdentityHashes(
	draftID, operation, idempotencyKey string,
	payload any,
) ([]byte, []byte, error) {
	requestRaw, err := json.Marshal(struct {
		DraftID   string `json:"draft_id"`
		Operation string `json:"operation"`
		Payload   any    `json:"payload"`
	}{
		DraftID: draftID, Operation: operation, Payload: payload,
	})
	if err != nil {
		return nil, nil, err
	}
	keyHash := sha256.Sum256([]byte(idempotencyKey))
	requestHash := sha256.Sum256(requestRaw)
	return keyHash[:], requestHash[:], nil
}

func (r *DesignDraftRepo) RegisterDesignMutation(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	draftID, operation string,
	keyHash, requestHash []byte,
) (designMutationRegistration, error) {
	if r == nil || r.Pool == nil {
		return designMutationRegistration{}, errors.New("campaign template design store unavailable")
	}
	if operation == "retry" {
		return designMutationRegistration{}, errors.New(
			"campaign template design retry registration requires an atomic transition",
		)
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return designMutationRegistration{}, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return designMutationRegistration{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var owned bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM campaign_template_design_drafts
     WHERE tenant_id = $1::uuid
       AND actor_type = $2
       AND actor_id = $3
       AND id::text = $4
)`, tenantID, actor.Type, actor.ID, draftID).Scan(&owned); err != nil {
		return designMutationRegistration{}, err
	}
	if !owned {
		return designMutationRegistration{}, ErrDesignDraftNotFound
	}
	if err := lockDesignMutationKey(
		ctx,
		tx,
		tenantID,
		keyHash,
	); err != nil {
		return designMutationRegistration{}, err
	}

	var registeredAttemptCount *int
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_template_design_mutations (
    tenant_id, draft_id, operation, idempotency_key_hash, request_hash,
    registered_attempt_count
)
SELECT $1::uuid, draft.id, $5, $6, $7,
       CASE WHEN $5 = 'retry' THEN draft.attempt_count ELSE NULL END
  FROM campaign_template_design_drafts AS draft
 WHERE draft.tenant_id = $1::uuid
   AND draft.actor_type = $2
   AND draft.actor_id = $3
   AND draft.id::text = $4
ON CONFLICT (tenant_id, idempotency_key_hash) DO NOTHING
RETURNING registered_attempt_count`,
		tenantID, actor.Type, actor.ID, draftID, operation, keyHash, requestHash,
	).Scan(&registeredAttemptCount)
	registration := designMutationRegistration{
		RegisteredAttemptCount: registeredAttemptCount,
	}
	if errors.Is(err, pgx.ErrNoRows) {
		registration.Replayed = true
		var existingDraftID, existingOperation string
		var existingRequestHash []byte
		err = tx.QueryRow(ctx, `
SELECT draft_id::text, operation, request_hash, registered_attempt_count
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND idempotency_key_hash = $2`,
			tenantID, keyHash,
		).Scan(
			&existingDraftID,
			&existingOperation,
			&existingRequestHash,
			&registration.RegisteredAttemptCount,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return designMutationRegistration{}, ErrDesignDraftNotFound
		}
		if err != nil {
			return designMutationRegistration{}, err
		}
		if existingDraftID != draftID ||
			existingOperation != operation ||
			!bytes.Equal(existingRequestHash, requestHash) {
			return designMutationRegistration{}, ErrDesignDraftIdempotencyConflict
		}
	} else if err != nil {
		return designMutationRegistration{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return designMutationRegistration{}, err
	}
	return registration, nil
}

// RetryDesignDraftWithMutation serializes on the draft and commits the
// immutable mutation receipt in the same transaction as failed -> queued.
// Consequently a non-NULL registered_attempt_count proves that this exact key
// won a retry transition; another key can never register against its queued
// work and later claim that work as its own.
func (r *DesignDraftRepo) RetryDesignDraftWithMutation(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	draftID string,
	keyHash, requestHash []byte,
) (*DesignDraft, designMutationRegistration, error) {
	if r == nil || r.Pool == nil {
		return nil, designMutationRegistration{}, errors.New(
			"campaign template design store unavailable",
		)
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, designMutationRegistration{}, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, designMutationRegistration{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockDesignMutationKey(
		ctx,
		tx,
		tenantID,
		keyHash,
	); err != nil {
		return nil, designMutationRegistration{}, err
	}

	draft, err := scanDesignDraft(tx.QueryRow(ctx, `
SELECT `+designDraftColumns+`
  FROM campaign_template_design_drafts
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4
 FOR NO KEY UPDATE`, tenantID, actor.Type, actor.ID, draftID))
	if err != nil {
		return nil, designMutationRegistration{}, err
	}

	registration := designMutationRegistration{}
	var (
		existingDraftID      string
		existingOperation    string
		existingRequestHash  []byte
		registeredAttemptCnt *int
	)
	lookupErr := tx.QueryRow(ctx, `
SELECT draft_id::text, operation, request_hash, registered_attempt_count
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND idempotency_key_hash = $2`,
		tenantID, keyHash,
	).Scan(
		&existingDraftID,
		&existingOperation,
		&existingRequestHash,
		&registeredAttemptCnt,
	)
	if lookupErr == nil {
		if existingDraftID != draftID ||
			existingOperation != "retry" ||
			!bytes.Equal(existingRequestHash, requestHash) {
			return nil, designMutationRegistration{},
				ErrDesignDraftIdempotencyConflict
		}
		registration.Replayed = true
		registration.RegisteredAttemptCount = registeredAttemptCnt
		if registeredAttemptCnt == nil ||
			draft.AttemptCount < *registeredAttemptCnt {
			return nil, registration, ErrDesignDraftReplayAmbiguous
		}
		if draft.CurrentRevision > 0 {
			draft.Revision, err = loadDesignRevision(
				ctx,
				tx,
				tenantID,
				draftID,
				draft.CurrentRevision,
				false,
			)
			if err != nil {
				return nil, registration, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, registration, err
		}
		return draft, registration, nil
	}
	if !errors.Is(lookupErr, pgx.ErrNoRows) {
		return nil, designMutationRegistration{}, lookupErr
	}
	var unexpired bool
	if err := tx.QueryRow(ctx, `
SELECT expires_at > now()
  FROM campaign_template_design_drafts
 WHERE tenant_id = $1::uuid
   AND actor_type = $2
   AND actor_id = $3
   AND id::text = $4`,
		tenantID, actor.Type, actor.ID, draftID,
	).Scan(&unexpired); err != nil {
		return nil, designMutationRegistration{}, err
	}
	if draft.Status != designDraftStatusFailed ||
		draft.AttemptCount >= 20 ||
		!unexpired {
		return nil, designMutationRegistration{}, ErrDesignDraftRetryUnavailable
	}

	registeredAttemptCnt = new(int)
	*registeredAttemptCnt = draft.AttemptCount
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_template_design_mutations (
    tenant_id, draft_id, operation, idempotency_key_hash, request_hash,
    registered_attempt_count
) VALUES ($1::uuid, $2::uuid, 'retry', $3, $4, $5)
ON CONFLICT (tenant_id, idempotency_key_hash) DO NOTHING
RETURNING registered_attempt_count`,
		tenantID,
		draftID,
		keyHash,
		requestHash,
		*registeredAttemptCnt,
	).Scan(&registration.RegisteredAttemptCount)
	if errors.Is(err, pgx.ErrNoRows) {
		// The same tenant key can race on two different drafts, which do not
		// share the row lock above. Resolve the unique-key winner exactly.
		err = tx.QueryRow(ctx, `
SELECT draft_id::text, operation, request_hash, registered_attempt_count
  FROM campaign_template_design_mutations
 WHERE tenant_id = $1::uuid
   AND idempotency_key_hash = $2`,
			tenantID, keyHash,
		).Scan(
			&existingDraftID,
			&existingOperation,
			&existingRequestHash,
			&registration.RegisteredAttemptCount,
		)
		if err != nil {
			return nil, designMutationRegistration{}, err
		}
		if existingDraftID != draftID ||
			existingOperation != "retry" ||
			!bytes.Equal(existingRequestHash, requestHash) {
			return nil, designMutationRegistration{},
				ErrDesignDraftIdempotencyConflict
		}
		// Same-draft exact requests serialize on the draft lock and are
		// handled above, but retain a fail-closed branch for completeness.
		return nil, designMutationRegistration{Replayed: true},
			ErrDesignDraftReplayAmbiguous
	}
	if err != nil {
		return nil, designMutationRegistration{}, err
	}
	if _, err := tx.Exec(ctx, `
SELECT set_config(
    'app.campaign_template_design_retry_key_hash',
    encode($1::bytea, 'hex'),
    true
)`, keyHash); err != nil {
		return nil, designMutationRegistration{}, err
	}

	draft, err = scanDesignDraft(tx.QueryRow(ctx, `
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
   AND attempt_count = $5
   AND attempt_count < 20
   AND expires_at > now()
 RETURNING `+designDraftColumns,
		tenantID,
		actor.Type,
		actor.ID,
		draftID,
		*registeredAttemptCnt,
	))
	if errors.Is(err, ErrDesignDraftNotFound) {
		return nil, designMutationRegistration{}, ErrDesignDraftRetryUnavailable
	}
	if err != nil {
		return nil, designMutationRegistration{}, err
	}
	if draft.CurrentRevision > 0 {
		draft.Revision, err = loadDesignRevision(
			ctx,
			tx,
			tenantID,
			draftID,
			draft.CurrentRevision,
			false,
		)
		if err != nil {
			return nil, designMutationRegistration{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, designMutationRegistration{}, err
	}
	return draft, registration, nil
}

func lockDesignMutationKey(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	keyHash []byte,
) error {
	sum := sha256.New()
	_, _ = sum.Write([]byte(tenantID))
	_, _ = sum.Write([]byte{0})
	_, _ = sum.Write(keyHash)
	lockHash := sum.Sum(nil)
	lockID := int64(binary.BigEndian.Uint64(lockHash[:8]))
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockID)
	return err
}
