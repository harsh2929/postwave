// SPDX-License-Identifier: AGPL-3.0-only
//
// Tenant resolution helper. Implements the TenantResolver interface
// expected by Deps. Two lookup paths:
//
//  1. LookupTenantBySlug  — maps the inbound envelope's "replies-<slug>"
//     local-part back to the owning tenant via the tenants table.
//
//  2. LookupTenantBySubscriberEmail — maps the sender's email back to
//     the tenant whose subscriber list contains it. This bypasses RLS
//     intentionally (the inbound webhook hasn't yet established a
//     tenant context) so we use a SECURITY DEFINER lookup function or
//     the outbox-worker bypass. We choose the outbox-worker pattern
//     since the codebase's other inbound paths (deliverability,
//     feedback) already use it and operators expect a uniform shape.

package replies

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/replycorrelation"
)

// Repo is the canonical TenantResolver. Wraps the shared pgx pool.
type Repo struct {
	Pool *db.Pool
}

// LookupTenantByReplyCorrelation resolves the owning tenant for an exact
// opaque token commitment. The fixed SECURITY DEFINER function returns no
// campaign, delivery, recipient, or mailbox data and only considers accepted,
// unexpired v2 delivery rows. The tenant-bound matcher verifies the MAC and
// complete ledger binding before treating the result as strong correlation.
func (r *Repo) LookupTenantByReplyCorrelation(ctx context.Context, recipient string) (string, error) {
	if r == nil || r.Pool == nil {
		return "", errors.New("replies: repo not initialised")
	}
	parsed, err := replycorrelation.ParseAddress(recipient)
	if err != nil {
		return "", nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tenantID string
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(public.resolve_campaign_reply_correlation_tenant($1), '00000000-0000-0000-0000-000000000000'::uuid)::text`,
		parsed.TokenHash,
	).Scan(&tenantID)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	if tenantID == "00000000-0000-0000-0000-000000000000" {
		return "", nil
	}
	return tenantID, nil
}

// LookupTenantBySlug returns the tenant id for a "replies-<slug>"
// envelope. Empty slug or no match returns ("", nil) so the caller can
// fall through to the email-based branch.
func (r *Repo) LookupTenantBySlug(ctx context.Context, slug string) (string, error) {
	if r == nil || r.Pool == nil {
		return "", errors.New("replies: repo not initialised")
	}
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return "", nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return "", err
	}
	// Inbound reply routing runs pre-tenant: we don't yet know which
	// tenant owns the recipient slug. Bind app.tenant_resolver = 'true'
	// so migration 0333's narrow SELECT policy on `tenants` fires.
	// (The outbox-worker scope above is retained for any companion
	// tables this tx may touch on future expansions.)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_resolver', 'true', true)`); err != nil {
		return "", err
	}
	var id string
	err = tx.QueryRow(ctx,
		`SELECT id::text FROM tenants WHERE slug = $1 LIMIT 1`, slug).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", tx.Commit(ctx)
	}
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// LookupTenantBySubscriberEmail returns the tenant whose subscriber
// list contains the given email. Multiple tenants can technically own
// the same address (different lists, different products) — we return
// the most-recent match so a freshly-imported subscriber wins over a
// stale one.
func (r *Repo) LookupTenantBySubscriberEmail(ctx context.Context, email string) (string, error) {
	if r == nil || r.Pool == nil {
		return "", errors.New("replies: repo not initialised")
	}
	email = strings.TrimSpace(email)
	if email == "" {
		return "", nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return "", err
	}
	var id string
	err = tx.QueryRow(ctx, `
SELECT tenant_id::text
  FROM subscribers
 WHERE email = $1::citext
 ORDER BY created_at DESC
 LIMIT 1`, email).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", tx.Commit(ctx)
	}
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}
