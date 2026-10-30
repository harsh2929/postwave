// SPDX-License-Identifier: AGPL-3.0-only
package blacklist

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// withWorkerScope binds the cross-tenant blacklist worker privilege to the
// same transaction that performs the dependent query or write. PostgreSQL
// clears set_config(..., true) after a standalone auto-commit statement, so a
// raw pooled connection cannot safely establish this scope for later calls.
func withWorkerScope(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, error) {
	if pool == nil {
		return nil, errors.New("blacklist worker scope: nil pool")
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin blacklist worker transaction: %w", err)
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("set blacklist worker scope: %w", err)
	}
	return tx, nil
}
