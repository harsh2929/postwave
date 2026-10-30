// SPDX-License-Identifier: AGPL-3.0-only
package idempotency

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo is the pgx-backed Store implementation.
type Repo struct {
	Pool *db.Pool
}

// Get reads a record by (tenant_id, key). Returns ErrNotFound on miss.
func (r *Repo) Get(ctx context.Context, tenantID, key string) (*Record, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var rec Record
	var headersJSON []byte
	row := tx.QueryRow(ctx, `
SELECT key, tenant_id::text, route, request_hash,
       response_status, response_body, response_headers, created_at, expires_at
FROM idempotency_records
WHERE tenant_id = $1::uuid AND key = $2 AND expires_at > now()`,
		tenantID, key)
	var status *int
	if err := row.Scan(&rec.Key, &rec.TenantID, &rec.Route, &rec.RequestHash,
		&status, &rec.ResponseBody, &headersJSON, &rec.CreatedAt, &rec.ExpiresAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if status != nil {
		rec.ResponseStatus = *status
	}
	if len(headersJSON) > 0 {
		var h http.Header
		if err := json.Unmarshal(headersJSON, &h); err != nil {
			// Bad JSON in storage shouldn't kill replay — fall back to nil
			// headers, which triggers the legacy default-Content-Type path.
			rec.ResponseHeaders = nil
		} else {
			rec.ResponseHeaders = h
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &rec, nil
}

// Claim inserts a pending row before the handler executes. A false return means
// another request already owns the same key.
func (r *Repo) Claim(ctx context.Context, rec *Record) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, rec.TenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
	DELETE FROM idempotency_records
	 WHERE tenant_id = $1::uuid AND key = $2 AND expires_at <= now()`,
		rec.TenantID, rec.Key); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `
	INSERT INTO idempotency_records
	    (key, tenant_id, route, request_hash, expires_at)
	VALUES
	    ($1, $2::uuid, $3, $4, $5)
	ON CONFLICT (tenant_id, key) DO NOTHING`,
		rec.Key, rec.TenantID, rec.Route, rec.RequestHash, rec.ExpiresAt)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Complete stores the successful response bytes + headers for replay.
func (r *Repo) Complete(ctx context.Context, rec *Record) error {
	tx, err := db.WithTenant(ctx, r.Pool, rec.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var headersJSON []byte
	if len(rec.ResponseHeaders) > 0 {
		headersJSON, err = json.Marshal(rec.ResponseHeaders)
		if err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, `
		UPDATE idempotency_records
		   SET response_status = $3, response_body = $4, response_headers = $5
		 WHERE tenant_id = $1::uuid AND key = $2`,
		rec.TenantID, rec.Key, rec.ResponseStatus, rec.ResponseBody, headersJSON)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// CompletePendingInTx records the exact replay response inside a caller-owned
// transaction that also contains the durable side effect. This closes the
// commit-acknowledgement ambiguity that exists when a handler commits its
// domain row first and Process completes the replay row afterward: a lost
// COMMIT response can no longer leave a committed effect behind a deletable
// pending claim.
//
// The generic Process middleware must already have claimed rec.Key before the
// handler opens tx. The guarded UPDATE deliberately accepts only that exact
// tenant, request hash, and still-pending row. If the surrounding transaction
// commits, the effect and replay receipt become visible together. If it rolls
// back, both this UPDATE and the effect disappear, so Process may safely delete
// the original pending claim after the handler's 5xx response.
func CompletePendingInTx(ctx context.Context, tx pgx.Tx, rec *Record) error {
	if tx == nil || rec == nil {
		return errors.New("idempotency: pending completion requires a transaction and record")
	}
	var headersJSON []byte
	var err error
	if len(rec.ResponseHeaders) > 0 {
		headersJSON, err = json.Marshal(rec.ResponseHeaders)
		if err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, `
		UPDATE idempotency_records
		   SET response_status = $4, response_body = $5, response_headers = $6
		 WHERE tenant_id = $1::uuid
		   AND key = $2
		   AND request_hash = $3
		   AND response_status IS NULL
		   AND expires_at > now()`,
		rec.TenantID, rec.Key, rec.RequestHash, rec.ResponseStatus,
		rec.ResponseBody, headersJSON)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// DeletePending removes an uncompleted claim only when execution is known safe
// to retry (for example, a pre-side-effect 5xx or an explicit revalidation
// response). If a caller transaction is concurrently resolving an atomic
// CompletePendingInTx, PostgreSQL waits for that row lock and rechecks this
// response_status predicate: a committed receipt survives, while a rolled-back
// receipt leaves the original pending row eligible for deletion. If response
// completion itself failed, Process intentionally leaves the pending claim for
// expiry or explicit operator reconciliation.
func (r *Repo) DeletePending(ctx context.Context, tenantID, key string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
	DELETE FROM idempotency_records
	 WHERE tenant_id = $1::uuid AND key = $2 AND response_status IS NULL`,
		tenantID, key)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// StartJanitor launches a goroutine that sweeps expired rows once per
// `interval`. Cancel ctx to stop it. The sweep runs without a tenant context
// against the permissive `idempotency_sweeper` policy.
func (r *Repo) StartJanitor(ctx context.Context, interval time.Duration, logger *slog.Logger) {
	if interval <= 0 {
		interval = time.Hour
	}
	go func() {
		// Panic recovery: without this a panic in the DELETE path
		// (pgx connection-pool failure mode, OOM, etc) would silently
		// kill the janitor and let idempotency_records bloat forever.
		// Worker audit HIGH #9.
		defer func() {
			if rec := recover(); rec != nil && logger != nil {
				logger.Error("idempotency janitor panic recovered",
					"panic", fmt.Sprintf("%v", rec))
			}
		}()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				conn, err := r.Pool.Acquire(ctx)
				if err != nil {
					if logger != nil {
						logger.Warn("idempotency janitor: acquire", "err", err.Error())
					}
					continue
				}
				tag, err := conn.Exec(ctx,
					`DELETE FROM idempotency_records WHERE expires_at < now()`)
				conn.Release()
				if err != nil && logger != nil {
					logger.Warn("idempotency janitor: delete", "err", err.Error())
				} else if logger != nil {
					logger.Debug("idempotency janitor: swept", "rows", tag.RowsAffected())
				}
			}
		}
	}()
}
