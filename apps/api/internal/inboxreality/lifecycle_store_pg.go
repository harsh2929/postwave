// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const dispatchCommandColumns = `
id::text, tenant_id::text, test_id::text, idempotency_key, request_hash,
campaign_id::text, content_revision_id::text, send_plan_id::text,
artifact_id::text, scenario_id, artifact_mime_object_ref,
artifact_mime_hash, artifact_structure_hash, requested_capabilities::text,
state, available_at, attempt_count, max_attempts,
COALESCE(lease_owner::text, ''), COALESCE(lease_token::text, ''),
lease_expires_at, execution_receipt::text, COALESCE(last_error_code, ''),
COALESCE(failure_code, ''), created_at, updated_at, completed_at`

const leasedDispatchCommandColumns = `
c.id::text, c.tenant_id::text, c.test_id::text, c.idempotency_key, c.request_hash,
c.campaign_id::text, c.content_revision_id::text, c.send_plan_id::text,
c.artifact_id::text, c.scenario_id, c.artifact_mime_object_ref,
c.artifact_mime_hash, c.artifact_structure_hash, c.requested_capabilities::text,
c.state, c.available_at, c.attempt_count, c.max_attempts,
COALESCE(c.lease_owner::text, ''), COALESCE(c.lease_token::text, ''),
c.lease_expires_at, c.execution_receipt::text, COALESCE(c.last_error_code, ''),
COALESCE(c.failure_code, ''), c.created_at, c.updated_at, c.completed_at`

func (s *pgStore) CreateExactTest(ctx context.Context, params ExactCreateParams) (ExactCreateResult, error) {
	if s == nil || s.pool == nil {
		return ExactCreateResult{}, ErrInvalidLifecycle
	}
	if err := validateExactCreate(params); err != nil {
		return ExactCreateResult{}, err
	}
	requirements, err := params.RequestedCapabilities.normalized()
	if err != nil {
		return ExactCreateResult{}, err
	}
	requirementsJSON, _ := json.Marshal(requirements)

	tx, err := db.WithTenant(ctx, s.pool, params.TenantID)
	if err != nil {
		return ExactCreateResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Serialize one tenant/idempotency identity. This avoids creating an
	// orphan test row when two API replicas race the same first request.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		params.TenantID+params.IdempotencyKey); err != nil {
		return ExactCreateResult{}, fmt.Errorf("lock Inbox Reality idempotency identity: %w", err)
	}

	if existing, found, err := lookupCommandByIdempotency(ctx, tx, params.TenantID, params.IdempotencyKey); err != nil {
		return ExactCreateResult{}, err
	} else if found {
		if existing.RequestHash != params.RequestHash || existing.ArtifactID != params.ArtifactID ||
			existing.ScenarioID != params.ScenarioID || !capabilitiesEqual(existing.RequestedCapabilities, requirements) {
			return ExactCreateResult{}, ErrIdempotencyConflict
		}
		test, err := scanOneTest(ctx, tx, `SELECT `+testColumns+` FROM inbox_reality_tests
			WHERE tenant_id = $1::uuid AND id = $2::uuid`, params.TenantID, existing.TestID)
		if err != nil {
			return ExactCreateResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return ExactCreateResult{}, err
		}
		return ExactCreateResult{Test: test, Command: existing, Replay: true}, nil
	}

	var artifact struct {
		campaignID, revisionID, planID, scenarioID string
		mimeRef, mimeHash, structureHash, subject  string
		expiresAt                                  *time.Time
		planState                                  string
	}
	err = tx.QueryRow(ctx, `
SELECT a.campaign_id::text, p.content_revision_id::text, a.send_plan_id::text,
       a.scenario_id, COALESCE(a.mime_object_ref, ''), a.outbound_mime_hash,
       a.mime_structure_hash, r.subject, a.expires_at, p.state
  FROM campaign_render_artifacts a
  JOIN campaign_send_plans p
    ON p.tenant_id = a.tenant_id AND p.id = a.send_plan_id
  JOIN campaign_content_revisions r
    ON r.tenant_id = p.tenant_id AND r.id = p.content_revision_id
 WHERE a.tenant_id = $1::uuid AND a.id = $2::uuid`,
		params.TenantID, params.ArtifactID).Scan(
		&artifact.campaignID, &artifact.revisionID, &artifact.planID,
		&artifact.scenarioID, &artifact.mimeRef, &artifact.mimeHash,
		&artifact.structureHash, &artifact.subject, &artifact.expiresAt,
		&artifact.planState,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ExactCreateResult{}, ErrArtifactUnavailable
	}
	if err != nil {
		return ExactCreateResult{}, fmt.Errorf("load Inbox Reality artifact: %w", err)
	}
	if artifact.scenarioID != params.ScenarioID || artifact.mimeRef == "" ||
		(artifact.planState != "ready" && artifact.planState != "certified") ||
		(artifact.expiresAt != nil && !artifact.expiresAt.After(params.ExpiresAt)) {
		return ExactCreateResult{}, ErrArtifactUnavailable
	}

	var test Test
	var completedAt *time.Time
	var metaText string
	err = tx.QueryRow(ctx, `
INSERT INTO inbox_reality_tests (
    tenant_id, header_token, kind, subject, status, expires_at, meta,
    campaign_id, content_revision_id, send_plan_id, artifact_id, scenario_id,
    outbound_mime_hash, outbound_mime_structure_hash, requested_capabilities
) VALUES (
    $1::uuid, $2, 'campaign_assurance', $3, 'awaiting_delivery', $4, '{}'::jsonb,
    $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9, $10, $11, $12::jsonb
)
RETURNING `+testColumns,
		params.TenantID, params.HeaderToken, artifact.subject, params.ExpiresAt,
		artifact.campaignID, artifact.revisionID, artifact.planID, params.ArtifactID,
		artifact.scenarioID, artifact.mimeHash, artifact.structureHash,
		string(requirementsJSON)).Scan(
		&test.ID, &test.TenantID, &test.HeaderToken, (*string)(&test.Kind),
		&test.Subject, &test.FromAddress, (*string)(&test.Status),
		&test.CampaignID, &test.ContentRevisionID, &test.SendPlanID, &test.ArtifactID,
		&test.ScenarioID, &test.OutboundMIMEHash, &test.OutboundMIMEStructureHash,
		&test.RequestedCapabilities, &test.CreatedAt, &test.UpdatedAt,
		&completedAt, &test.ExpiresAt, &metaText,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ExactCreateResult{}, ErrTokenCollision
		}
		return ExactCreateResult{}, fmt.Errorf("insert exact Inbox Reality test: %w", err)
	}
	test.CompletedAt = completedAt
	test.Meta = json.RawMessage(metaText)

	command, err := scanDispatchCommand(tx.QueryRow(ctx, `
INSERT INTO inbox_reality_dispatch_commands (
    tenant_id, test_id, idempotency_key, request_hash, campaign_id,
    content_revision_id, send_plan_id, artifact_id, scenario_id,
    artifact_mime_object_ref, artifact_mime_hash, artifact_structure_hash,
    requested_capabilities
) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid,
    $9, $10, $11, $12, $13::jsonb
)
RETURNING `+dispatchCommandColumns,
		params.TenantID, test.ID, params.IdempotencyKey, params.RequestHash,
		artifact.campaignID, artifact.revisionID, artifact.planID, params.ArtifactID,
		artifact.scenarioID, artifact.mimeRef, artifact.mimeHash,
		artifact.structureHash, string(requirementsJSON)))
	if err != nil {
		return ExactCreateResult{}, fmt.Errorf("insert Inbox Reality dispatch command: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ExactCreateResult{}, fmt.Errorf("commit exact Inbox Reality test: %w", err)
	}
	return ExactCreateResult{Test: test, Command: command}, nil
}

func (s *pgStore) GetDispatch(ctx context.Context, tenantID, testID string) (DispatchCommand, error) {
	if !validUUID(tenantID) || !validUUID(testID) {
		return DispatchCommand{}, ErrInvalidLifecycle
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return DispatchCommand{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	command, err := scanDispatchCommand(tx.QueryRow(ctx, `SELECT `+dispatchCommandColumns+`
FROM inbox_reality_dispatch_commands
WHERE tenant_id = $1::uuid AND test_id = $2::uuid`, tenantID, testID))
	if errors.Is(err, pgx.ErrNoRows) {
		return DispatchCommand{}, ErrNotFound
	}
	if err != nil {
		return DispatchCommand{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DispatchCommand{}, err
	}
	return command, nil
}

func (s *pgStore) ClaimDispatch(ctx context.Context, ownerID string, leaseTTL time.Duration) (DispatchCommand, error) {
	if !validUUID(ownerID) || leaseTTL < time.Second || leaseTTL > time.Hour {
		return DispatchCommand{}, ErrInvalidLifecycle
	}
	tx, err := inboxRealityDispatchWorkerTx(ctx, s.pool)
	if err != nil {
		return DispatchCommand{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Expiry closes commands before selection so a stale queued row can never
	// be leased merely because a worker was down around the deadline.
	if _, err := tx.Exec(ctx, `
UPDATE inbox_reality_dispatch_commands c
   SET state = 'expired', completed_at = clock_timestamp(), updated_at = clock_timestamp(),
       lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
       last_error_code = 'TEST_EXPIRED'
  FROM inbox_reality_tests t
 WHERE t.id = c.test_id AND t.expires_at <= clock_timestamp()
   AND c.state IN ('queued', 'retry_wait', 'leased')`); err != nil {
		return DispatchCommand{}, fmt.Errorf("expire Inbox Reality commands before claim: %w", err)
	}
	command, err := scanDispatchCommand(tx.QueryRow(ctx, `
WITH picked AS (
    SELECT c.id
      FROM inbox_reality_dispatch_commands c
      JOIN inbox_reality_tests t ON t.id = c.test_id
     WHERE c.available_at <= clock_timestamp()
       AND t.status IN ('awaiting_delivery', 'classifying')
       AND t.expires_at > clock_timestamp()
       AND (
           c.state IN ('queued', 'retry_wait')
           OR (c.state = 'leased' AND c.lease_expires_at <= clock_timestamp())
       )
     ORDER BY c.available_at, c.created_at, c.id
     FOR UPDATE OF c SKIP LOCKED
     LIMIT 1
)
UPDATE inbox_reality_dispatch_commands c
   SET state = 'leased', lease_owner = $1::uuid, lease_token = gen_random_uuid(),
       lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
       attempt_count = c.attempt_count + 1, updated_at = clock_timestamp(),
       last_error_code = NULL
  FROM picked
 WHERE c.id = picked.id
RETURNING `+leasedDispatchCommandColumns, ownerID, leaseTTL.Milliseconds()))
	if errors.Is(err, pgx.ErrNoRows) {
		return DispatchCommand{}, ErrNoDispatchCommand
	}
	if err != nil {
		return DispatchCommand{}, fmt.Errorf("claim Inbox Reality dispatch: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return DispatchCommand{}, err
	}
	return command, nil
}

func (s *pgStore) CompleteDispatch(ctx context.Context, command DispatchCommand, receipt json.RawMessage) error {
	var object map[string]any
	if len(receipt) == 0 || json.Unmarshal(receipt, &object) != nil || object == nil {
		return ErrInvalidLifecycle
	}
	return s.finishLeasedCommand(ctx, command, `
UPDATE inbox_reality_dispatch_commands
   SET state = 'dispatched', execution_receipt = $6::jsonb,
       completed_at = clock_timestamp(), updated_at = clock_timestamp(),
       lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
       last_error_code = NULL, failure_code = NULL
 WHERE id = $1::uuid AND tenant_id = $2::uuid AND test_id = $3::uuid
   AND lease_owner = $4::uuid AND lease_token = $5::uuid
   AND state = 'leased' AND lease_expires_at > clock_timestamp()`, string(receipt))
}

func (s *pgStore) RetryDispatch(ctx context.Context, command DispatchCommand, retryAt time.Time, errorCode string) error {
	errorCode = normalizeLifecycleCode(errorCode, "DELIVERABILITY_RETRY")
	if retryAt.IsZero() {
		return ErrInvalidLifecycle
	}
	if command.AttemptCount >= command.MaxAttempts {
		return s.FailDispatch(ctx, command, "DELIVERABILITY_RETRIES_EXHAUSTED")
	}
	return s.finishLeasedCommand(ctx, command, `
UPDATE inbox_reality_dispatch_commands
   SET state = 'retry_wait', available_at = GREATEST($6::timestamptz, clock_timestamp()),
       updated_at = clock_timestamp(), lease_owner = NULL, lease_token = NULL,
       lease_expires_at = NULL, last_error_code = $7, failure_code = NULL
 WHERE id = $1::uuid AND tenant_id = $2::uuid AND test_id = $3::uuid
   AND lease_owner = $4::uuid AND lease_token = $5::uuid
   AND state = 'leased' AND lease_expires_at > clock_timestamp()`, retryAt.UTC(), errorCode)
}

func (s *pgStore) FailDispatch(ctx context.Context, command DispatchCommand, failureCode string) error {
	failureCode = normalizeLifecycleCode(failureCode, "DELIVERABILITY_FAILED")
	return s.finishLeasedCommand(ctx, command, `
UPDATE inbox_reality_dispatch_commands
   SET state = 'failed', failure_code = $6, last_error_code = $6,
       completed_at = clock_timestamp(), updated_at = clock_timestamp(),
       lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
 WHERE id = $1::uuid AND tenant_id = $2::uuid AND test_id = $3::uuid
   AND lease_owner = $4::uuid AND lease_token = $5::uuid
   AND state = 'leased' AND lease_expires_at > clock_timestamp()`, failureCode)
}

func (s *pgStore) finishLeasedCommand(ctx context.Context, command DispatchCommand, query string, extra ...any) error {
	if !validUUID(command.ID) || !validUUID(command.TenantID) || !validUUID(command.TestID) ||
		!validUUID(command.LeaseOwner) || !validUUID(command.LeaseToken) {
		return ErrInvalidLifecycle
	}
	tx, err := inboxRealityDispatchWorkerTx(ctx, s.pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{command.ID, command.TenantID, command.TestID, command.LeaseOwner, command.LeaseToken}
	args = append(args, extra...)
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("finish Inbox Reality dispatch: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func (s *pgStore) CancelTest(ctx context.Context, tenantID, testID string, at time.Time) error {
	if !validUUID(tenantID) || !validUUID(testID) {
		return ErrInvalidLifecycle
	}
	if at.IsZero() {
		at = time.Now().UTC()
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status TestStatus
	if err := tx.QueryRow(ctx, `SELECT status FROM inbox_reality_tests
		WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`, tenantID, testID).Scan((*string)(&status)); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if status == StatusComplete || status == StatusExpired || status == StatusCancelled {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `
UPDATE inbox_reality_seed_dispatches
   SET state = 'cancelled', completed_at = $3, updated_at = $3,
       dispatch_token = NULL, dispatch_started_at = NULL,
       failure_code = 'TEST_CANCELLED'
 WHERE tenant_id = $1::uuid AND test_id = $2::uuid
   AND state IN ('prepared', 'retry_wait')`, tenantID, testID, at.UTC()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE inbox_reality_dispatch_commands
   SET state = 'cancelled', completed_at = $3, updated_at = $3,
       lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
       last_error_code = 'TEST_CANCELLED'
 WHERE tenant_id = $1::uuid AND test_id = $2::uuid
   AND state IN ('queued', 'retry_wait', 'leased')`, tenantID, testID, at.UTC()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE inbox_reality_tests
		SET status = 'cancelled', completed_at = $3
		WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, testID, at.UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *pgStore) ExpireDue(ctx context.Context, limit int, at time.Time) (int, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	if at.IsZero() {
		at = time.Now().UTC()
	}
	tx, err := inboxRealityDispatchWorkerTx(ctx, s.pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM inbox_reality_tests
 WHERE status IN ('awaiting_delivery', 'classifying') AND expires_at <= $1
 ORDER BY expires_at, id
 FOR UPDATE SKIP LOCKED LIMIT $2`, at.UTC(), limit)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	for _, testID := range ids {
		if _, err := tx.Exec(ctx, `
UPDATE inbox_reality_seed_dispatches
   SET state = 'expired', completed_at = $2, updated_at = $2,
       dispatch_token = NULL, dispatch_started_at = NULL,
       failure_code = 'TEST_EXPIRED'
 WHERE test_id = $1::uuid AND state IN ('prepared', 'retry_wait')`, testID, at.UTC()); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `
UPDATE inbox_reality_dispatch_commands
   SET state = 'expired', completed_at = $2, updated_at = $2,
       lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
       last_error_code = 'TEST_EXPIRED'
 WHERE test_id = $1::uuid AND state IN ('queued', 'retry_wait', 'leased')`, testID, at.UTC()); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `
UPDATE inbox_reality_tests t
   SET status = CASE WHEN EXISTS (
           SELECT 1 FROM inbox_reality_test_results r WHERE r.test_id = t.id
       ) THEN 'complete' ELSE 'expired' END,
       completed_at = $2
 WHERE t.id = $1::uuid`, testID, at.UTC()); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(ids), nil
}

func (s *pgStore) RecordObservation(ctx context.Context, receipt ObservationReceipt) (Result, error) {
	if err := validateObservationReceipt(receipt); err != nil {
		return Result{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.inbox_reality_resolver', 'true', true)`); err != nil {
		return Result{}, err
	}
	var tenantID, artifactID, scenarioID string
	var status TestStatus
	var expiresAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT tenant_id::text, COALESCE(artifact_id::text, ''), COALESCE(scenario_id, ''), status, expires_at
  FROM inbox_reality_tests WHERE id = $1::uuid`, receipt.TestID).Scan(
		&tenantID, &artifactID, &scenarioID, (*string)(&status), &expiresAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return Result{}, ErrNotFound
	} else if err != nil {
		return Result{}, err
	}
	if tenantID != receipt.TenantID || artifactID != receipt.ArtifactID || scenarioID != receipt.ScenarioID {
		return Result{}, ErrInvalidLifecycle
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return Result{}, err
	}
	var dispatched bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
        SELECT 1 FROM inbox_reality_seed_dispatches
         WHERE tenant_id=$1::uuid AND test_id=$2::uuid
           AND mailbox_id=$3 AND provider=$4
           AND state IN ('accepted', 'indeterminate')
    )`, tenantID, receipt.TestID, receipt.MailboxID, string(receipt.Provider)).Scan(&dispatched); err != nil {
		return Result{}, err
	}
	if !dispatched {
		return Result{}, ErrInvalidLifecycle
	}

	var result Result
	var rawHeaders, capabilities string
	var capturedAt *time.Time
	err = tx.QueryRow(ctx, `
WITH written AS (
    INSERT INTO inbox_reality_test_results (
        test_id, mailbox_id, provider, placement, folder_name, raw_headers,
        observation_key, artifact_id, scenario_id, capability_snapshot,
        raw_mime_status, received_mime_sha256, received_mime_structure_hash,
        structure_comparison, observation_captured_at, classified_at
    ) VALUES (
        $1::uuid, $2, $3, $4, $5, NULL, $6, $7::uuid, $8, $9::jsonb,
        $10, NULLIF($11, ''), NULLIF($12, ''), $13, $14, $14
    )
    ON CONFLICT (test_id, mailbox_id) DO UPDATE SET
        provider = EXCLUDED.provider,
        placement = EXCLUDED.placement,
        folder_name = EXCLUDED.folder_name,
        raw_headers = NULL,
        observation_key = EXCLUDED.observation_key,
        artifact_id = EXCLUDED.artifact_id,
        scenario_id = EXCLUDED.scenario_id,
        capability_snapshot = EXCLUDED.capability_snapshot,
        raw_mime_status = EXCLUDED.raw_mime_status,
        received_mime_sha256 = EXCLUDED.received_mime_sha256,
        received_mime_structure_hash = EXCLUDED.received_mime_structure_hash,
        structure_comparison = EXCLUDED.structure_comparison,
        observation_captured_at = EXCLUDED.observation_captured_at,
        classified_at = EXCLUDED.classified_at
    WHERE inbox_reality_test_results.observation_key IS DISTINCT FROM EXCLUDED.observation_key
      AND inbox_reality_test_results.observation_captured_at <= EXCLUDED.observation_captured_at
    RETURNING *
)
SELECT id::text, test_id::text, mailbox_id, provider, placement,
       COALESCE(folder_name, ''), classified_at, COALESCE(raw_headers::text, ''),
       COALESCE(observation_key, ''), COALESCE(artifact_id::text, ''),
       COALESCE(scenario_id, ''), capability_snapshot::text,
       COALESCE(raw_mime_status, ''), COALESCE(received_mime_sha256, ''),
       COALESCE(received_mime_structure_hash, ''), COALESCE(structure_comparison, ''),
       observation_captured_at
  FROM written
UNION ALL
SELECT id::text, test_id::text, mailbox_id, provider, placement,
       COALESCE(folder_name, ''), classified_at, COALESCE(raw_headers::text, ''),
       COALESCE(observation_key, ''), COALESCE(artifact_id::text, ''),
       COALESCE(scenario_id, ''), capability_snapshot::text,
       COALESCE(raw_mime_status, ''), COALESCE(received_mime_sha256, ''),
       COALESCE(received_mime_structure_hash, ''), COALESCE(structure_comparison, ''),
       observation_captured_at
  FROM inbox_reality_test_results
 WHERE test_id = $1::uuid AND mailbox_id = $2
   AND NOT EXISTS (SELECT 1 FROM written)
 LIMIT 1`, receipt.TestID, receipt.MailboxID, string(receipt.Provider), string(receipt.Placement),
		receipt.Folder, receipt.ObservationKey, receipt.ArtifactID, receipt.ScenarioID,
		string(receipt.CapabilitySnapshot), receipt.RawMIMEStatus,
		receipt.ReceivedMIMESHA256, receipt.ReceivedStructureSHA256,
		receipt.StructureComparison, receipt.CapturedAt.UTC()).Scan(
		&result.ID, &result.TestID, &result.MailboxID, (*string)(&result.Provider),
		(*string)(&result.Placement), &result.FolderName, &result.ClassifiedAt,
		&rawHeaders, &result.ObservationKey, &result.ArtifactID, &result.ScenarioID,
		&capabilities, &result.RawMIMEStatus, &result.ReceivedMIMESHA256,
		&result.ReceivedStructureSHA256, &result.StructureComparison, &capturedAt,
	)
	if err != nil {
		return Result{}, fmt.Errorf("converge Inbox Reality observation: %w", err)
	}
	result.ProviderLabel = result.Provider.DisplayName()
	if rawHeaders != "" {
		result.RawHeaders = json.RawMessage(rawHeaders)
	}
	result.CapabilitySnapshot = json.RawMessage(capabilities)
	result.ObservationCapturedAt = capturedAt

	if status != StatusComplete && status != StatusExpired && status != StatusCancelled {
		var expected, observed int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM inbox_reality_seed_dispatches
			WHERE tenant_id = $1::uuid AND test_id = $2::uuid
			  AND state IN ('accepted', 'indeterminate')`,
			tenantID, receipt.TestID).Scan(&expected); err != nil {
			return Result{}, err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM inbox_reality_test_results
			WHERE test_id = $1::uuid AND observation_key IS NOT NULL`, receipt.TestID).Scan(&observed); err != nil {
			return Result{}, err
		}
		next := StatusClassifying
		completedAt := any(nil)
		if expected > 0 && observed >= expected {
			next = StatusComplete
			completedAt = receipt.CapturedAt.UTC()
		} else if !receipt.CapturedAt.Before(expiresAt) {
			next = StatusComplete
			completedAt = receipt.CapturedAt.UTC()
		}
		if _, err := tx.Exec(ctx, `UPDATE inbox_reality_tests
			SET status = $3, completed_at = $4
			WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, receipt.TestID,
			string(next), completedAt); err != nil {
			return Result{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return result, nil
}

func lookupCommandByIdempotency(ctx context.Context, tx pgx.Tx, tenantID, key string) (DispatchCommand, bool, error) {
	command, err := scanDispatchCommand(tx.QueryRow(ctx, `SELECT `+dispatchCommandColumns+`
FROM inbox_reality_dispatch_commands
WHERE tenant_id = $1::uuid AND idempotency_key = $2`, tenantID, key))
	if errors.Is(err, pgx.ErrNoRows) {
		return DispatchCommand{}, false, nil
	}
	return command, err == nil, err
}

func scanDispatchCommand(row pgx.Row) (DispatchCommand, error) {
	var command DispatchCommand
	var capabilities, receipt string
	if err := row.Scan(
		&command.ID, &command.TenantID, &command.TestID, &command.IdempotencyKey,
		&command.RequestHash, &command.CampaignID, &command.ContentRevisionID,
		&command.SendPlanID, &command.ArtifactID, &command.ScenarioID,
		&command.ArtifactMIMEObjectRef, &command.ArtifactMIMEHash,
		&command.ArtifactStructureHash, &capabilities, (*string)(&command.State),
		&command.AvailableAt, &command.AttemptCount, &command.MaxAttempts,
		&command.LeaseOwner, &command.LeaseToken, &command.LeaseExpiresAt,
		&receipt, &command.LastErrorCode, &command.FailureCode,
		&command.CreatedAt, &command.UpdatedAt, &command.CompletedAt,
	); err != nil {
		return DispatchCommand{}, err
	}
	if err := json.Unmarshal([]byte(capabilities), &command.RequestedCapabilities); err != nil {
		return DispatchCommand{}, fmt.Errorf("decode dispatch capability request: %w", err)
	}
	if receipt != "{}" {
		command.ExecutionReceipt = json.RawMessage(receipt)
	}
	return command, nil
}

func inboxRealityDispatchWorkerTx(ctx context.Context, pool *db.Pool) (pgx.Tx, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT
		set_config('app.outbox_worker', 'true', true),
		set_config('app.inbox_reality_dispatch_worker', 'true', true),
		set_config('app.inbox_reality_execution_worker', 'true', true)`); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func validateExactCreate(params ExactCreateParams) error {
	if !validUUID(params.TenantID) || !validUUID(params.ArtifactID) ||
		strings.TrimSpace(params.ScenarioID) == "" || len(params.ScenarioID) > 200 ||
		!validInboxRealityToken(params.HeaderToken) ||
		strings.TrimSpace(params.IdempotencyKey) == "" || len(params.IdempotencyKey) > 200 ||
		strings.IndexFunc(params.IdempotencyKey, unicode.IsControl) >= 0 ||
		!validLowerSHA256(params.RequestHash) || params.ExpiresAt.IsZero() ||
		!params.ExpiresAt.After(time.Now().UTC()) {
		return ErrInvalidLifecycle
	}
	return nil
}

func validateObservationReceipt(receipt ObservationReceipt) error {
	var capabilityObject map[string]any
	if !validUUID(receipt.TenantID) || !validUUID(receipt.TestID) || !validUUID(receipt.ArtifactID) ||
		strings.TrimSpace(receipt.ScenarioID) == "" || !validLowerSHA256(receipt.ObservationKey) ||
		strings.TrimSpace(receipt.MailboxID) == "" || len(receipt.MailboxID) > 200 ||
		!receipt.Provider.IsKnown() || !receipt.Placement.IsKnown() ||
		strings.TrimSpace(receipt.Folder) == "" || len(receipt.Folder) > 500 ||
		json.Unmarshal(receipt.CapabilitySnapshot, &capabilityObject) != nil || capabilityObject == nil ||
		receipt.CapturedAt.IsZero() {
		return ErrInvalidLifecycle
	}
	switch receipt.RawMIMEStatus {
	case "complete", "truncated", "failed", "unavailable":
	default:
		return ErrInvalidLifecycle
	}
	if receipt.ReceivedMIMESHA256 != "" && !validLowerSHA256(receipt.ReceivedMIMESHA256) {
		return ErrInvalidLifecycle
	}
	if (receipt.RawMIMEStatus == "complete" || receipt.RawMIMEStatus == "truncated") !=
		(receipt.ReceivedMIMESHA256 != "") {
		return ErrInvalidLifecycle
	}
	if receipt.ReceivedStructureSHA256 != "" && !validLowerSHA256(receipt.ReceivedStructureSHA256) {
		return ErrInvalidLifecycle
	}
	switch receipt.StructureComparison {
	case "match", "mismatch", "unavailable":
	default:
		return ErrInvalidLifecycle
	}
	if (receipt.StructureComparison == "match" || receipt.StructureComparison == "mismatch") &&
		receipt.ReceivedStructureSHA256 == "" {
		return ErrInvalidLifecycle
	}
	return nil
}

func capabilitiesEqual(left, right CapabilityRequirements) bool { return left == right }

func validUUID(value string) bool { _, err := uuid.Parse(strings.TrimSpace(value)); return err == nil }

func validLowerSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func validInboxRealityToken(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func normalizeLifecycleCode(value, fallback string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if value == "" || len(value) > 96 {
		return fallback
	}
	for index, character := range value {
		if index == 0 && (character < 'A' || character > 'Z') {
			return fallback
		}
		if index > 0 && !((character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '_') {
			return fallback
		}
	}
	return value
}
