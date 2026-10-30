package orchestrator

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/postwave/migrate/canonical"
)

const (
	maxVerifierRetentionSweepRowsPerTenant = 10000
	verifierRetentionTenantTimeout         = 5 * time.Second
	verifierRetentionSweepConcurrency      = 8
)

// SweepExpiredSubscriberVerifierObservations physically erases expired raw
// subscriber evidence across tenants. Per-job loads also delete expired rows,
// but this fleet sweep closes the crash window in which a worker commits a
// terminal job status and exits before its terminal cleanup runs.
//
// The application role does not bypass FORCE RLS. Enumerate tenant identities,
// then delete each tenant's rows in a transaction whose app.tenant_id is set;
// this keeps the retention worker inside the same isolation boundary as every
// other verifier query.
// limit is a per-tenant pass ceiling, not a fleet-wide ceiling. Giving every
// tenant its own quota prevents a large early-sorting tenant from consuming all
// deletion capacity and starving later tenants indefinitely. A bounded failure
// for one tenant is collected while the sweep continues through the rest of the
// fleet. A bounded worker pool prevents one slow tenant from serially delaying
// every later tenant, and the per-pass seed rotates enumeration order so even
// repeated process restarts do not always begin with the same tenant UUIDs.
func SweepExpiredSubscriberVerifierObservations(ctx context.Context, db *sql.DB, limit int) (int, error) {
	if db == nil {
		return 0, nil
	}
	if limit <= 0 || limit > maxVerifierRetentionSweepRowsPerTenant {
		limit = maxVerifierRetentionSweepRowsPerTenant
	}
	tenantTx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, err
	}
	if _, err := tenantTx.ExecContext(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		_ = tenantTx.Rollback()
		return 0, err
	}
	rotationSeed := time.Now().UTC().Format(time.RFC3339Nano)
	rows, err := tenantTx.QueryContext(ctx, `
		SELECT id::text FROM tenants
		 ORDER BY md5(id::text || $1), id
	`, rotationSeed)
	if err != nil {
		_ = tenantTx.Rollback()
		return 0, fmt.Errorf("list verifier-retention tenants: %w", err)
	}
	tenantIDs := make([]string, 0)
	for rows.Next() {
		var tenantID string
		if err := rows.Scan(&tenantID); err != nil {
			_ = rows.Close()
			_ = tenantTx.Rollback()
			return 0, err
		}
		tenantIDs = append(tenantIDs, tenantID)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		_ = tenantTx.Rollback()
		return 0, err
	}
	if err := rows.Close(); err != nil {
		_ = tenantTx.Rollback()
		return 0, err
	}
	if err := tenantTx.Commit(); err != nil {
		return 0, err
	}

	deleted := 0
	failedTenants := 0
	var firstTenantErr error
	var resultMu sync.Mutex
	jobs := make(chan string)
	workerCount := verifierRetentionSweepConcurrency
	if workerCount > len(tenantIDs) {
		workerCount = len(tenantIDs)
	}
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for tenantID := range jobs {
				affected, err := sweepExpiredSubscriberVerifierObservationsForTenant(ctx, db, tenantID, limit)
				resultMu.Lock()
				deleted += affected
				if err != nil {
					failedTenants++
					if firstTenantErr == nil {
						firstTenantErr = err
					}
				}
				resultMu.Unlock()
			}
		}()
	}
	for _, tenantID := range tenantIDs {
		select {
		case jobs <- tenantID:
		case <-ctx.Done():
			close(jobs)
			workers.Wait()
			return deleted, ctx.Err()
		}
	}
	close(jobs)
	workers.Wait()
	if failedTenants > 0 {
		return deleted, fmt.Errorf("subscriber verifier retention failed for %d tenant(s); first failure: %w", failedTenants, firstTenantErr)
	}
	return deleted, nil
}

func sweepExpiredSubscriberVerifierObservationsForTenant(ctx context.Context, db *sql.DB, tenantID string, limit int) (int, error) {
	tenantCtx, cancel := context.WithTimeout(ctx, verifierRetentionTenantTimeout)
	defer cancel()
	tx, err := db.BeginTx(tenantCtx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin tenant %s retention sweep: %w", tenantID, err)
	}
	if _, err := tx.ExecContext(tenantCtx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback()
		return 0, fmt.Errorf("scope tenant %s retention sweep: %w", tenantID, err)
	}
	result, err := tx.ExecContext(tenantCtx, `
		WITH expired AS (
			SELECT ctid
			  FROM migration_verifier_subscriber_observations
			 WHERE tenant_id = $1::uuid AND expires_at <= now()
			 ORDER BY expires_at, job_id, observation_key
			 LIMIT $2
		)
		DELETE FROM migration_verifier_subscriber_observations AS observation
		 USING expired
		 WHERE observation.tenant_id = $1::uuid
		   AND observation.ctid = expired.ctid
	`, tenantID, limit)
	if err != nil {
		_ = tx.Rollback()
		return 0, fmt.Errorf("sweep expired subscriber verifier observations for tenant %s: %w", tenantID, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return 0, fmt.Errorf("count erased subscriber verifier observations for tenant %s: %w", tenantID, err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit tenant %s retention sweep: %w", tenantID, err)
	}
	return int(affected), nil
}

// ClearSubscriberVerifierObservations starts a new verification epoch for a
// deliberate fresh dry-run/import. Recovery retries must not call it: their
// durable observations are what make a resumed page exact.
func ClearSubscriberVerifierObservations(ctx context.Context, db *sql.DB, tenantID, jobID string) (err error) {
	if db == nil {
		return nil
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return fmt.Errorf("clear subscriber verifier observations: tenant and job are required")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer finishVerifierTx(tx, &err)
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM migration_verifier_subscriber_observations
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
	`, tenantID, jobID); err != nil {
		return fmt.Errorf("clear subscriber verifier observations: %w", err)
	}
	return nil
}

func (o *Orchestrator) recordSubscriberVerifierObservations(ctx context.Context, job *canonical.MigrationJob, subscribers []canonical.Subscriber) (out []canonical.Subscriber, err error) {
	if o.DB == nil || o.TenantID == "" || job == nil {
		return subscribers, nil
	}
	tx, err := o.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer finishVerifierTx(tx, &err)
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, o.TenantID); err != nil {
		return nil, err
	}
	for _, subscriber := range subscribers {
		raw, err := json.Marshal(subscriber)
		if err != nil {
			return nil, err
		}
		identity := subscriberObservationIdentity(subscriber, raw)
		var inserted int
		err = tx.QueryRowContext(ctx, `
			INSERT INTO migration_verifier_subscriber_observations
				(tenant_id, job_id, observation_key, email, subscriber)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
			ON CONFLICT (tenant_id, job_id, observation_key) DO NOTHING
			RETURNING 1
		`, o.TenantID, job.ID, identity, strings.ToLower(strings.TrimSpace(subscriber.Email)), string(raw)).Scan(&inserted)
		if err == sql.ErrNoRows {
			var previousRaw []byte
			if loadErr := tx.QueryRowContext(ctx, `
				SELECT subscriber
				  FROM migration_verifier_subscriber_observations
				 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND observation_key = $3
			`, o.TenantID, job.ID, identity).Scan(&previousRaw); loadErr != nil {
				return nil, fmt.Errorf("load conflicting subscriber verifier observation: %w", loadErr)
			}
			if !sameSubscriberVerifierObservation(previousRaw, raw) {
				return nil, fmt.Errorf("source subscriber identity changed within one verification traversal; refusing an inconsistent snapshot")
			}
			continue
		}
		if err != nil {
			return nil, err
		}
		out = append(out, subscriber)
	}
	return out, nil
}

func sameSubscriberVerifierObservation(left, right []byte) bool {
	var a, b canonical.Subscriber
	if json.Unmarshal(left, &a) != nil || json.Unmarshal(right, &b) != nil {
		return false
	}
	return reflect.DeepEqual(a, b)
}

func (o *Orchestrator) loadSubscriberVerifierObservations(ctx context.Context, job *canonical.MigrationJob) (err error) {
	if o.DB == nil || o.TenantID == "" || job == nil {
		return nil
	}
	tx, err := o.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer finishVerifierTx(tx, &err)
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, o.TenantID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM migration_verifier_subscriber_observations
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND expires_at <= now()
	`, o.TenantID, job.ID); err != nil {
		return fmt.Errorf("delete expired subscriber verifier observations: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT subscriber
		  FROM migration_verifier_subscriber_observations
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND expires_at > now()
		 ORDER BY created_at, observation_key
	`, o.TenantID, job.ID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		var subscriber canonical.Subscriber
		if err := json.Unmarshal(raw, &subscriber); err != nil {
			return fmt.Errorf("decode subscriber verifier observation: %w", err)
		}
		o.verifier.ObserveSubscriber(subscriber)
	}
	return rows.Err()
}

func subscriberObservationIdentity(subscriber canonical.Subscriber, raw []byte) string {
	if sourceID := strings.TrimSpace(subscriber.SourceID); sourceID != "" {
		return strings.ToLower(string(subscriber.SourcePlatform)) + ":" + sourceID
	}
	sum := sha256.Sum256(raw)
	return strings.ToLower(strings.TrimSpace(subscriber.Email)) + ":sha256:" + hex.EncodeToString(sum[:])
}

func finishVerifierTx(tx *sql.Tx, err *error) {
	if *err != nil {
		_ = tx.Rollback()
		return
	}
	*err = tx.Commit()
}
