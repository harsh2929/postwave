// SPDX-License-Identifier: AGPL-3.0-only

// Package subscriberidentitylock serializes writes that can create or move
// email-keyed operational state while a subscriber's canonical email changes.
package subscriberidentitylock

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// Execer is the narrow transaction surface needed by the lock. pgx.Tx and
// privacy's inventory-recording test executor both satisfy it.
type Execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// Tenant acquires the exclusive side of the one transaction-scoped
// canonical-email lock for a tenant. Callers that move or erase identity use
// this side; writers that only append email-keyed operational state use Shared.
// A single lock per tenant is intentionally conservative because a
// striped/per-address scheme cannot safely discover an alias's new canonical
// address without lock-order inversion. Different tenants remain independent.
func Tenant(ctx context.Context, tx Execer, tenantID string) error {
	return acquire(ctx, tx, tenantID, false)
}

// Shared holds canonical identity stable while a transaction evaluates and
// appends email-keyed operational state. Shared holders remain concurrent with
// one another, while an email rotation/merge/erasure waits for all of them.
func Shared(ctx context.Context, tx Execer, tenantID string) error {
	return acquire(ctx, tx, tenantID, true)
}

func acquire(ctx context.Context, tx Execer, tenantID string, shared bool) error {
	if tx == nil {
		return errors.New("subscriber identity lock: transaction is required")
	}
	tenantID = strings.TrimSpace(tenantID)
	if tenantID == "" {
		return errors.New("subscriber identity lock: tenant is required")
	}
	function := "pg_advisory_xact_lock"
	if shared {
		function = "pg_advisory_xact_lock_shared"
	}
	if _, err := tx.Exec(ctx, `
SELECT `+function+`(
    hashtext('subscriber-canonical-email/v1'), hashtext($1)
)`, tenantID); err != nil {
		return fmt.Errorf("subscriber identity lock: acquire tenant lock: %w", err)
	}
	return nil
}
