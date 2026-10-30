// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
)

const seedDeliveryColumns = `
id::text, tenant_id::text, test_id::text, command_id::text, mailbox_id, provider,
COALESCE(seed_registry_version_id::text, ''), capability_snapshot::text,
artifact_mime_hash, dispatched_mime_hash, COALESCE(source_message_id_sha256, ''), state,
attempt_count, max_attempts, available_at, COALESCE(dispatch_token::text, ''),
dispatch_started_at, COALESCE(failure_code, '')`

// PostgresExecutionStore persists the exact, address-free provider fanout.
// Seed addresses and credentials remain exclusively in the secret registry.
type PostgresExecutionStore struct{ Pool *pgxpool.Pool }

func NewPostgresExecutionStore(pool *pgxpool.Pool) *PostgresExecutionStore {
	if pool == nil {
		return nil
	}
	return &PostgresExecutionStore{Pool: pool}
}

func (s *PostgresExecutionStore) Prepare(
	ctx context.Context,
	request inboxrealitycontract.DispatchRequest,
	seeds []Seed,
	snapshot inboxrealitycontract.CapabilitySnapshot,
	dispatchedHash string,
) ([]SeedDelivery, error) {
	if s == nil || s.Pool == nil || !isSHA256(dispatchedHash) {
		return nil, ErrInvalidRequest
	}
	tx, err := s.workerTx(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Locking the command makes concurrent HTTP retries converge on one frozen
	// seed set. The current gateway lease token proves the caller is executing
	// the command that the gateway most recently fenced.
	var command struct {
		tenantID, testID, requestHash, campaignID, revisionID   string
		planID, artifactID, scenarioID, mimeHash, structureHash string
		capabilitiesText, state, leaseToken, headerToken        string
		leaseExpires, testExpires                               time.Time
		testStatus                                              string
	}
	err = tx.QueryRow(ctx, `
SELECT c.tenant_id::text, c.test_id::text, c.request_hash,
       c.campaign_id::text, c.content_revision_id::text, c.send_plan_id::text,
       c.artifact_id::text, c.scenario_id, c.artifact_mime_hash,
       c.artifact_structure_hash, c.requested_capabilities::text, c.state,
       COALESCE(c.lease_token::text, ''), c.lease_expires_at,
       t.header_token, t.expires_at, t.status
  FROM inbox_reality_dispatch_commands c
  JOIN inbox_reality_tests t ON t.tenant_id = c.tenant_id AND t.id = c.test_id
 WHERE c.id = $1::uuid
 FOR UPDATE OF c`, request.CommandID).Scan(
		&command.tenantID, &command.testID, &command.requestHash,
		&command.campaignID, &command.revisionID, &command.planID,
		&command.artifactID, &command.scenarioID, &command.mimeHash,
		&command.structureHash, &command.capabilitiesText, &command.state,
		&command.leaseToken, &command.leaseExpires, &command.headerToken,
		&command.testExpires, &command.testStatus,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrCommandConflict
	}
	if err != nil {
		return nil, fmt.Errorf("load Inbox Reality execution command: %w", err)
	}
	requestedJSON, _ := json.Marshal(request.RequestedCapabilities)
	var storedCapabilities, receivedCapabilities any
	if json.Unmarshal([]byte(command.capabilitiesText), &storedCapabilities) != nil ||
		json.Unmarshal(requestedJSON, &receivedCapabilities) != nil {
		return nil, ErrCommandConflict
	}
	now := time.Now().UTC()
	if command.tenantID != request.TenantID || command.testID != request.TestID ||
		command.requestHash != request.RequestHash || command.campaignID != request.CampaignID ||
		command.revisionID != request.ContentRevisionID || command.planID != request.SendPlanID ||
		command.artifactID != request.ArtifactID || command.scenarioID != request.ScenarioID ||
		command.mimeHash != request.ArtifactMIMEHash || command.structureHash != request.ArtifactStructureHash ||
		"irt_"+command.headerToken != request.HeaderValue || command.state != "leased" ||
		command.leaseToken != request.LeaseToken || !now.Before(command.leaseExpires) ||
		!request.ExpiresAt.Equal(command.testExpires) || !now.Before(command.testExpires) ||
		(command.testStatus != "awaiting_delivery" && command.testStatus != "classifying") ||
		!jsonValuesEqual(storedCapabilities, receivedCapabilities) {
		return nil, ErrCommandConflict
	}

	rows, err := listSeedsTx(ctx, tx, request.CommandID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		sourceMessageIDHash := normalizedRFCMessageIDHash(request.RawMIME)
		snapshotJSON, err := json.Marshal(snapshot)
		if err != nil {
			return nil, ErrInvalidRequest
		}
		ordered := append([]Seed(nil), seeds...)
		sort.Slice(ordered, func(i, j int) bool { return ordered[i].MailboxID < ordered[j].MailboxID })
		for _, seed := range ordered {
			if _, err := tx.Exec(ctx, `
INSERT INTO inbox_reality_seed_dispatches (
    tenant_id, test_id, command_id, mailbox_id, provider, seed_registry_version_id,
    capability_snapshot, artifact_mime_hash, dispatched_mime_hash, source_message_id_sha256
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, NULLIF($6, '')::uuid,
          $7::jsonb, $8, $9, NULLIF($10, ''))`,
				request.TenantID, request.TestID, request.CommandID, seed.MailboxID,
				seed.Provider, seed.RegistryVersionID, string(snapshotJSON), request.ArtifactMIMEHash,
				dispatchedHash, sourceMessageIDHash); err != nil {
				return nil, fmt.Errorf("prepare Inbox Reality seed dispatch: %w", err)
			}
		}
		rows, err = listSeedsTx(ctx, tx, request.CommandID)
		if err != nil {
			return nil, err
		}
	} else {
		// A retried command may carry a new lease token, but the exact MIME and
		// first frozen dispatch identities may never drift.
		for _, row := range rows {
			if row.TenantID != request.TenantID || row.TestID != request.TestID ||
				row.ArtifactMIMEHash != request.ArtifactMIMEHash || row.DispatchedMIMEHash != dispatchedHash ||
				(row.SourceMessageIDHash != "" && row.SourceMessageIDHash != normalizedRFCMessageIDHash(request.RawMIME)) {
				return nil, ErrCommandConflict
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit Inbox Reality seed preparation: %w", err)
	}
	return rows, nil
}

func (s *PostgresExecutionStore) MarkStaleDispatchesIndeterminate(ctx context.Context, commandID string, before time.Time) error {
	if !isUUID(commandID) || before.IsZero() {
		return ErrInvalidRequest
	}
	return s.execWorker(ctx, `
UPDATE inbox_reality_seed_dispatches
   SET state = 'indeterminate', dispatch_token = NULL,
       failure_code = 'PROVIDER_CALL_OUTCOME_UNKNOWN',
       completed_at = clock_timestamp(), updated_at = clock_timestamp()
 WHERE command_id = $1::uuid AND state = 'dispatching'
   AND dispatch_started_at <= $2`, commandID, before.UTC())
}

func (s *PostgresExecutionStore) ClaimSeed(ctx context.Context, commandID, mailboxID string) (SeedDelivery, error) {
	if !isUUID(commandID) || strings.TrimSpace(mailboxID) == "" {
		return SeedDelivery{}, ErrInvalidRequest
	}
	tx, err := s.workerTx(ctx)
	if err != nil {
		return SeedDelivery{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := scanSeedDelivery(tx.QueryRow(ctx, `
UPDATE inbox_reality_seed_dispatches
   SET state = 'dispatching', attempt_count = attempt_count + 1,
       dispatch_token = gen_random_uuid(), dispatch_started_at = clock_timestamp(),
       updated_at = clock_timestamp(), failure_code = NULL
 WHERE command_id = $1::uuid AND mailbox_id = $2
   AND state IN ('prepared', 'retry_wait') AND available_at <= clock_timestamp()
RETURNING `+seedDeliveryColumns, commandID, mailboxID))
	if errors.Is(err, pgx.ErrNoRows) {
		return SeedDelivery{}, ErrExecutionLeaseLost
	}
	if err != nil {
		return SeedDelivery{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SeedDelivery{}, err
	}
	return row, nil
}

func (s *PostgresExecutionStore) AcceptSeed(ctx context.Context, delivery SeedDelivery, providerMessageID string) error {
	providerMessageID = strings.TrimSpace(providerMessageID)
	if providerMessageID == "" {
		return ErrInvalidRequest
	}
	sum := sha256.Sum256([]byte(providerMessageID))
	return s.finishSeed(ctx, delivery, `
UPDATE inbox_reality_seed_dispatches
   SET state = 'accepted', provider_message_id_sha256 = $4,
       dispatch_token = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp(),
       failure_code = NULL
 WHERE id = $1::uuid AND command_id = $2::uuid AND dispatch_token = $3::uuid
   AND state = 'dispatching'`, hex.EncodeToString(sum[:]))
}

func (s *PostgresExecutionStore) RetrySeed(ctx context.Context, delivery SeedDelivery, retryAt time.Time, code string) error {
	if retryAt.IsZero() {
		return ErrInvalidRequest
	}
	if delivery.AttemptCount >= delivery.MaxAttempts {
		return s.RejectSeed(ctx, delivery, "PROVIDER_RETRIES_EXHAUSTED")
	}
	return s.finishSeed(ctx, delivery, `
UPDATE inbox_reality_seed_dispatches
   SET state = 'retry_wait', available_at = GREATEST($4::timestamptz, clock_timestamp()),
       dispatch_token = NULL, dispatch_started_at = NULL, updated_at = clock_timestamp(),
       failure_code = $5
 WHERE id = $1::uuid AND command_id = $2::uuid AND dispatch_token = $3::uuid
   AND state = 'dispatching'`, retryAt.UTC(), normalizeCode(code, "PROVIDER_RETRY"))
}

func (s *PostgresExecutionStore) RejectSeed(ctx context.Context, delivery SeedDelivery, code string) error {
	return s.finishSeed(ctx, delivery, `
UPDATE inbox_reality_seed_dispatches
   SET state = 'rejected', dispatch_token = NULL, completed_at = clock_timestamp(),
       updated_at = clock_timestamp(), failure_code = $4
 WHERE id = $1::uuid AND command_id = $2::uuid AND dispatch_token = $3::uuid
   AND state = 'dispatching'`, normalizeCode(code, "PROVIDER_REJECTED"))
}

func (s *PostgresExecutionStore) MarkSeedIndeterminate(ctx context.Context, delivery SeedDelivery, code string) error {
	return s.finishSeed(ctx, delivery, `
UPDATE inbox_reality_seed_dispatches
   SET state = 'indeterminate', dispatch_token = NULL, completed_at = clock_timestamp(),
       updated_at = clock_timestamp(), failure_code = $4
 WHERE id = $1::uuid AND command_id = $2::uuid AND dispatch_token = $3::uuid
   AND state = 'dispatching'`, normalizeCode(code, "PROVIDER_RESULT_INDETERMINATE"))
}

func (s *PostgresExecutionStore) ListSeeds(ctx context.Context, commandID string) ([]SeedDelivery, error) {
	if s == nil || s.Pool == nil || !isUUID(commandID) {
		return nil, ErrInvalidRequest
	}
	tx, err := s.workerTx(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := listSeedsTx(ctx, tx, commandID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *PostgresExecutionStore) finishSeed(ctx context.Context, delivery SeedDelivery, query string, extra ...any) error {
	if s == nil || s.Pool == nil || !isUUID(delivery.ID) || !isUUID(delivery.CommandID) || !isUUID(delivery.DispatchToken) {
		return ErrInvalidRequest
	}
	args := []any{delivery.ID, delivery.CommandID, delivery.DispatchToken}
	args = append(args, extra...)
	tx, err := s.workerTx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrExecutionLeaseLost
	}
	return tx.Commit(ctx)
}

func (s *PostgresExecutionStore) execWorker(ctx context.Context, query string, args ...any) error {
	if s == nil || s.Pool == nil {
		return ErrInvalidRequest
	}
	tx, err := s.workerTx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresExecutionStore) workerTx(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.Pool.Begin(ctx)
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

func listSeedsTx(ctx context.Context, tx pgx.Tx, commandID string) ([]SeedDelivery, error) {
	rows, err := tx.Query(ctx, `SELECT `+seedDeliveryColumns+`
FROM inbox_reality_seed_dispatches WHERE command_id = $1::uuid ORDER BY mailbox_id`, commandID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]SeedDelivery, 0)
	for rows.Next() {
		row, err := scanSeedDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func scanSeedDelivery(row pgx.Row) (SeedDelivery, error) {
	var delivery SeedDelivery
	var capabilities string
	err := row.Scan(&delivery.ID, &delivery.TenantID, &delivery.TestID, &delivery.CommandID,
		&delivery.MailboxID, &delivery.Provider, &delivery.RegistryVersionID, &capabilities,
		&delivery.ArtifactMIMEHash, &delivery.DispatchedMIMEHash, &delivery.SourceMessageIDHash,
		&delivery.State, &delivery.AttemptCount,
		&delivery.MaxAttempts, &delivery.AvailableAt, &delivery.DispatchToken,
		&delivery.DispatchStartedAt, &delivery.FailureCode)
	if err != nil {
		return SeedDelivery{}, err
	}
	delivery.CapabilitySnapshot = []byte(capabilities)
	return delivery, nil
}

func jsonValuesEqual(left, right any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}
