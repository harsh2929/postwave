// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignassurancequeue provides the durable bridge between the
// tenant-scoped Campaign Assurance API and the cross-tenant leased worker.
// It carries identities only; MIME, prompts, model output, and recipient data
// never enter the command table.
package campaignassurancequeue

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceapi"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultLeaseTTL     = 2 * time.Minute
	defaultPollInterval = 2 * time.Second
	maxLeaseTTL         = 24 * time.Hour
	maxPollInterval     = time.Minute
)

var (
	ErrInvalidConfiguration = errors.New("campaign assurance queue: invalid configuration")
	ErrInvalidCommand       = errors.New("campaign assurance queue: invalid command")
	ErrCommandConflict      = errors.New("campaign assurance queue: command identity conflict")
	ErrLeaseLost            = errors.New("campaign assurance queue: delivery lease lost")
	ErrSchemaUnavailable    = errors.New("campaign assurance queue: schema unavailable")
)

// Queue is safe for concurrent use. OwnerID is one process/consumer identity,
// while the command's immutable DeliveryID fences every terminal mutation.
type Queue struct {
	Pool         *db.Pool
	OwnerID      string
	LeaseTTL     time.Duration
	PollInterval time.Duration
}

type normalizedQueue struct {
	pool         *db.Pool
	ownerID      string
	leaseTTL     time.Duration
	pollInterval time.Duration
}

// New returns a queue with bounded defaults. ValidateSchema performs the
// database readiness check and is intentionally separate so construction is
// side-effect free in tests and composition.
func New(pool *db.Pool, ownerID string) *Queue {
	return &Queue{Pool: pool, OwnerID: ownerID}
}

// ValidateSchema fails startup when the feature is enabled but migration 1925
// or the worker capability policy is unavailable.
func (q *Queue) ValidateSchema(ctx context.Context) error {
	normalized, err := q.normalized()
	if err != nil {
		return err
	}
	tx, err := workerTx(ctx, normalized.pool)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrSchemaUnavailable, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var available bool
	if err := tx.QueryRow(ctx, `
SELECT to_regclass('public.campaign_assurance_commands') IS NOT NULL
   AND to_regclass('public.campaign_assurance_runs') IS NOT NULL`).Scan(&available); err != nil {
		return fmt.Errorf("%w: inspect schema: %v", ErrSchemaUnavailable, err)
	}
	if !available {
		return fmt.Errorf("%w: migration 1925 is required", ErrSchemaUnavailable)
	}
	var securityContractReady bool
	if err := tx.QueryRow(ctx, `
SELECT
    has_table_privilege(
        'postwave_app', 'public.campaign_assurance_commands', 'SELECT'
    )
    AND has_table_privilege(
        'postwave_app', 'public.campaign_assurance_commands', 'INSERT'
    )
    AND has_table_privilege(
        'postwave_app', 'public.campaign_assurance_commands', 'UPDATE'
    )
    AND (
        SELECT relation.relrowsecurity AND relation.relforcerowsecurity
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'campaign_assurance_commands'
           AND relation.relkind = 'r'
    )
    AND (
        SELECT count(*) = 4
          FROM pg_catalog.pg_policies
         WHERE schemaname = 'public'
           AND tablename = 'campaign_assurance_commands'
           AND 'postwave_app' = ANY (roles)
           AND (
               (
                   policyname = 'campaign_assurance_commands_tenant_select'
                   AND cmd = 'SELECT'
                   AND position('app.tenant_id' IN COALESCE(qual, '')) > 0
               )
               OR (
                   policyname = 'campaign_assurance_commands_tenant_insert'
                   AND cmd = 'INSERT'
                   AND position('app.tenant_id' IN COALESCE(with_check, '')) > 0
               )
               OR (
                   policyname = 'campaign_assurance_commands_worker_select'
                   AND cmd = 'SELECT'
                   AND position('app.outbox_worker' IN COALESCE(qual, '')) > 0
                   AND position('app.campaign_assurance_worker' IN COALESCE(qual, '')) > 0
               )
               OR (
                   policyname = 'campaign_assurance_commands_worker_update'
                   AND cmd = 'UPDATE'
                   AND position('app.outbox_worker' IN COALESCE(qual, '')) > 0
                   AND position('app.campaign_assurance_worker' IN COALESCE(qual, '')) > 0
                   AND position('app.outbox_worker' IN COALESCE(with_check, '')) > 0
                   AND position('app.campaign_assurance_worker' IN COALESCE(with_check, '')) > 0
               )
           )
    )`).Scan(&securityContractReady); err != nil {
		return fmt.Errorf("%w: inspect command security contract: %v", ErrSchemaUnavailable, err)
	}
	if !securityContractReady {
		return fmt.Errorf("%w: command grants or RLS policies are incomplete", ErrSchemaUnavailable)
	}
	// Compile the production claim projection too; a table shell with missing
	// columns must not allow an enabled process to advertise a working API.
	if _, err := tx.Exec(ctx, `
SELECT id, tenant_id, campaign_id, run_id, request_id,
       available_at, lease_owner, lease_expires_at,
       delivery_attempt_count, completed_at
  FROM campaign_assurance_commands
 WHERE false`); err != nil {
		return fmt.Errorf("%w: command contract: %v", ErrSchemaUnavailable, err)
	}
	return tx.Commit(ctx)
}

// EnqueueCampaignAssurance implements campaignassuranceapi.Scheduler. It is
// idempotent only for the exact tenant/campaign/run/request tuple; any partial
// identity reuse fails closed.
func (q *Queue) EnqueueCampaignAssurance(ctx context.Context, raw campaignassuranceapi.DispatchCommand) error {
	if q == nil || q.Pool == nil {
		return ErrInvalidConfiguration
	}
	command, err := normalizeDispatch(raw)
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, q.Pool, command.TenantID)
	if err != nil {
		return fmt.Errorf("enqueue campaign assurance command: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var insertedID string
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_commands (
    tenant_id, campaign_id, run_id, request_id
)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
ON CONFLICT DO NOTHING
RETURNING id::text`, command.TenantID, command.CampaignID,
		command.RunID, command.RequestID).Scan(&insertedID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("enqueue campaign assurance command: %w", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		var campaignID, requestID string
		lookupErr := tx.QueryRow(ctx, `
SELECT campaign_id::text, request_id::text
  FROM campaign_assurance_commands
 WHERE tenant_id = $1::uuid
   AND run_id = $2::uuid`, command.TenantID, command.RunID).Scan(&campaignID, &requestID)
		if lookupErr != nil || campaignID != command.CampaignID || requestID != command.RequestID {
			if lookupErr != nil && !errors.Is(lookupErr, pgx.ErrNoRows) {
				return fmt.Errorf("inspect campaign assurance command replay: %w", lookupErr)
			}
			return ErrCommandConflict
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit campaign assurance command: %w", err)
	}
	return nil
}

// Receive blocks with a bounded poll interval until it acquires one visibility
// lease or the caller cancels. It never returns a cross-tenant batch.
func (q *Queue) Receive(ctx context.Context) (campaignassuranceworker.Command, error) {
	normalized, err := q.normalized()
	if err != nil {
		return campaignassuranceworker.Command{}, err
	}
	for {
		command, found, err := normalized.claimOnce(ctx)
		if err != nil {
			return campaignassuranceworker.Command{}, err
		}
		if found {
			return command, nil
		}
		timer := time.NewTimer(normalized.pollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return campaignassuranceworker.Command{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func (q normalizedQueue) claimOnce(ctx context.Context) (campaignassuranceworker.Command, bool, error) {
	tx, err := workerTx(ctx, q.pool)
	if err != nil {
		return campaignassuranceworker.Command{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var command campaignassuranceworker.Command
	err = tx.QueryRow(ctx, `
WITH picked AS (
    SELECT id
      FROM campaign_assurance_commands
     WHERE completed_at IS NULL
       AND available_at <= clock_timestamp()
       AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
     ORDER BY available_at ASC, created_at ASC, id ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1
)
UPDATE campaign_assurance_commands AS command
   SET lease_owner = $1::uuid,
       lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
       delivery_attempt_count = command.delivery_attempt_count + 1,
       last_delivered_at = clock_timestamp(),
       updated_at = clock_timestamp()
  FROM picked
 WHERE command.id = picked.id
RETURNING command.id::text, command.tenant_id::text, command.run_id::text`,
		q.ownerID, q.leaseTTL.Milliseconds()).Scan(
		&command.DeliveryID, &command.TenantID, &command.RunID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return campaignassuranceworker.Command{}, false, err
		}
		return campaignassuranceworker.Command{}, false, nil
	}
	if err != nil {
		return campaignassuranceworker.Command{}, false, fmt.Errorf("claim campaign assurance command: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return campaignassuranceworker.Command{}, false, fmt.Errorf("commit campaign assurance command claim: %w", err)
	}
	return command, true, nil
}

// Renew extends a live queue visibility lease. The worker orchestrator calls
// it independently of the assurance run lease heartbeat so a long artifact
// analysis cannot be acknowledged by a duplicate delivery and then stranded.
func (q *Queue) Renew(ctx context.Context, raw campaignassuranceworker.Command) error {
	normalized, err := q.normalized()
	if err != nil {
		return err
	}
	command, err := normalizeWorkerCommand(raw)
	if err != nil {
		return err
	}
	return normalized.mutateLease(ctx, command, `
UPDATE campaign_assurance_commands
   SET lease_expires_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
       updated_at = clock_timestamp()
 WHERE id = $1::uuid
   AND tenant_id = $2::uuid
   AND run_id = $3::uuid
   AND lease_owner = $4::uuid
   AND completed_at IS NULL
   AND lease_expires_at > clock_timestamp()`, normalized.leaseTTL.Milliseconds())
}

// Acknowledge marks the exact leased command terminal after a terminal/no-op
// assurance result.
func (q *Queue) Acknowledge(ctx context.Context, raw campaignassuranceworker.Command) error {
	normalized, err := q.normalized()
	if err != nil {
		return err
	}
	command, err := normalizeWorkerCommand(raw)
	if err != nil {
		return err
	}
	return normalized.mutateLease(ctx, command, `
UPDATE campaign_assurance_commands
   SET completed_at = clock_timestamp(),
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = clock_timestamp()
 WHERE id = $1::uuid
   AND tenant_id = $2::uuid
   AND run_id = $3::uuid
   AND lease_owner = $4::uuid
   AND completed_at IS NULL
   AND lease_expires_at > clock_timestamp()`)
}

// Release clears the exact lease and advances visibility to the durable run's
// retry timestamp. A past timestamp becomes immediately visible.
func (q *Queue) Release(ctx context.Context, raw campaignassuranceworker.Command, retryAt time.Time) error {
	normalized, err := q.normalized()
	if err != nil {
		return err
	}
	command, err := normalizeWorkerCommand(raw)
	if err != nil || retryAt.IsZero() {
		return ErrInvalidCommand
	}
	return normalized.mutateLease(ctx, command, `
UPDATE campaign_assurance_commands
   SET available_at = GREATEST($5::timestamptz, clock_timestamp()),
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = clock_timestamp()
 WHERE id = $1::uuid
   AND tenant_id = $2::uuid
   AND run_id = $3::uuid
   AND lease_owner = $4::uuid
   AND completed_at IS NULL
   AND lease_expires_at > clock_timestamp()`, retryAt.UTC())
}

func (q normalizedQueue) mutateLease(
	ctx context.Context,
	command campaignassuranceworker.Command,
	statement string,
	extra ...any,
) error {
	tx, err := workerTx(ctx, q.pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	arguments := []any{command.DeliveryID, command.TenantID, command.RunID, q.ownerID}
	arguments = append(arguments, extra...)
	tag, err := tx.Exec(ctx, statement, arguments...)
	if err != nil {
		return fmt.Errorf("mutate campaign assurance command lease: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit campaign assurance command lease: %w", err)
	}
	return nil
}

func (q *Queue) normalized() (normalizedQueue, error) {
	if q == nil || q.Pool == nil {
		return normalizedQueue{}, ErrInvalidConfiguration
	}
	ownerID, err := canonicalUUID(q.OwnerID)
	if err != nil {
		return normalizedQueue{}, ErrInvalidConfiguration
	}
	leaseTTL := q.LeaseTTL
	if leaseTTL == 0 {
		leaseTTL = defaultLeaseTTL
	}
	pollInterval := q.PollInterval
	if pollInterval == 0 {
		pollInterval = defaultPollInterval
	}
	if leaseTTL < time.Second || leaseTTL > maxLeaseTTL ||
		pollInterval < 10*time.Millisecond || pollInterval > maxPollInterval {
		return normalizedQueue{}, ErrInvalidConfiguration
	}
	return normalizedQueue{
		pool: q.Pool, ownerID: ownerID, leaseTTL: leaseTTL, pollInterval: pollInterval,
	}, nil
}

func normalizeDispatch(raw campaignassuranceapi.DispatchCommand) (campaignassuranceapi.DispatchCommand, error) {
	var err error
	if raw.TenantID, err = canonicalUUID(raw.TenantID); err != nil {
		return campaignassuranceapi.DispatchCommand{}, ErrInvalidCommand
	}
	if raw.CampaignID, err = canonicalUUID(raw.CampaignID); err != nil {
		return campaignassuranceapi.DispatchCommand{}, ErrInvalidCommand
	}
	if raw.RunID, err = canonicalUUID(raw.RunID); err != nil {
		return campaignassuranceapi.DispatchCommand{}, ErrInvalidCommand
	}
	if raw.RequestID, err = canonicalUUID(raw.RequestID); err != nil {
		return campaignassuranceapi.DispatchCommand{}, ErrInvalidCommand
	}
	return raw, nil
}

func normalizeWorkerCommand(raw campaignassuranceworker.Command) (campaignassuranceworker.Command, error) {
	var err error
	if raw.DeliveryID, err = canonicalUUID(raw.DeliveryID); err != nil {
		return campaignassuranceworker.Command{}, ErrInvalidCommand
	}
	if raw.TenantID, err = canonicalUUID(raw.TenantID); err != nil {
		return campaignassuranceworker.Command{}, ErrInvalidCommand
	}
	if raw.RunID, err = canonicalUUID(raw.RunID); err != nil {
		return campaignassuranceworker.Command{}, ErrInvalidCommand
	}
	return raw, nil
}

func canonicalUUID(value string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return parsed.String(), nil
}

func workerTx(ctx context.Context, pool *db.Pool) (pgx.Tx, error) {
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.campaign_assurance_worker', 'true', true)"); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("bind campaign assurance worker capability: %w", err)
	}
	return tx, nil
}

var (
	_ campaignassuranceapi.Scheduler              = (*Queue)(nil)
	_ campaignassuranceworker.CommandQueue        = (*Queue)(nil)
	_ campaignassuranceworker.CommandLeaseRenewer = (*Queue)(nil)
)
