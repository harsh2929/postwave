// SPDX-License-Identifier: AGPL-3.0-only

// Package pushauthoritylock owns the advisory reader/writer lease shared by
// push sends, registry lists, Route43 mutations, and migration 1996 triggers.
package pushauthoritylock

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

const (
	globalKey       = "push-suppression-authority-domain:v1"
	tenantKeyPrefix = "push-suppression-registry:"
)

// ErrMutationDuringSendLease is returned before opening a writer transaction
// when code attempts to mutate device or suppression authority state from the
// synchronous provider callback protected by a shared send lease. Waiting for
// the matching exclusive lease there would self-deadlock. Provider feedback
// must be collected/enqueued during the callback and persisted after it
// returns.
var ErrMutationDuringSendLease = errors.New("push authority: mutation is not allowed inside a send eligibility lease")

// ErrReentrantSendLease prevents a synchronous provider callback from
// resolving/sending again with the marked callback context. Shared advisory
// locks are compatible, so allowing this would recurse through the provider
// boundary without establishing a new eligibility order or termination point.
var ErrReentrantSendLease = errors.New("push authority: re-entrant send eligibility lease is not allowed")

type sendLeaseCallbackContextKey struct{}

// SendLeaseCallbackContext marks the context passed to a provider callback
// while the tenant's shared eligibility lease is held. The marker is process
// local; out-of-process feedback handlers must independently obey the contract
// that provider responses cannot synchronously wait for an authority write.
func SendLeaseCallbackContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, sendLeaseCallbackContextKey{}, true)
}

// EnsureMutationAllowed fails fast for a synchronous mutation attempted from
// a send-lease callback instead of allowing an advisory-lock self-deadlock.
func EnsureMutationAllowed(ctx context.Context) error {
	if isSendLeaseCallback(ctx) {
		return ErrMutationDuringSendLease
	}
	return nil
}

// EnsureSendLeaseAllowed fails fast when a provider callback synchronously
// recurses into device resolution using the callback's marked context.
func EnsureSendLeaseAllowed(ctx context.Context) error {
	if isSendLeaseCallback(ctx) {
		return ErrReentrantSendLease
	}
	return nil
}

func isSendLeaseCallback(ctx context.Context) bool {
	marked, _ := ctx.Value(sendLeaseCallbackContextKey{}).(bool)
	return marked
}

// Shared permits concurrent sends/lists for one tenant while excluding every
// authority mutation. The global shared lease coordinates no-GUC maintenance.
func Shared(ctx context.Context, tx pgx.Tx, tenantID string) error {
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, globalKey,
	); err != nil {
		return fmt.Errorf("push authority: obtain global shared lease: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock_shared(hashtextextended($1 || $2::uuid::text, 0))`,
		tenantKeyPrefix, tenantID,
	); err != nil {
		return fmt.Errorf("push authority: obtain tenant shared lease: %w", err)
	}
	return nil
}

// Exclusive serializes all authority changes for a tenant and excludes sends
// and list snapshot capture until the mutation commits or rolls back.
func Exclusive(ctx context.Context, tx pgx.Tx, tenantID string) error {
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, globalKey,
	); err != nil {
		return fmt.Errorf("push authority: obtain global shared lease: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1 || $2::uuid::text, 0))`,
		tenantKeyPrefix, tenantID,
	); err != nil {
		return fmt.Errorf("push authority: obtain tenant exclusive lease: %w", err)
	}
	return nil
}
