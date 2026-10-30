// SPDX-License-Identifier: AGPL-3.0-only
//
// repo.go — tenant-scoped storage for browser push subscriptions.

package webpush

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type storedSubscription struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// upsertSubscription stores (or refreshes) a browser subscription, keyed by
// (tenant, endpoint) so a re-subscribe from the same browser updates in place.
func (d *Deps) upsertSubscription(ctx context.Context, tenantID, userID, endpoint, p256dh, auth string) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Conflict on (tenant_id, user_id, endpoint): a re-subscribe by the SAME
	// user refreshes their row; it never silently transfers another user's
	// registration (two users sharing a browser keep separate rows).
	if _, err := tx.Exec(ctx, `
		INSERT INTO web_push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		ON CONFLICT (tenant_id, user_id, endpoint)
		DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, last_used_at = now()`,
		tenantID, userID, endpoint, p256dh, auth); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// deleteSubscription removes the CALLER's own subscription only (scoped by
// user_id), so a user can't unsubscribe another user's browser.
func (d *Deps) deleteSubscription(ctx context.Context, tenantID, userID, endpoint string) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`DELETE FROM web_push_subscriptions WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND endpoint = $3`,
		tenantID, userID, endpoint); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (d *Deps) listForUser(ctx context.Context, tenantID, userID string) ([]storedSubscription, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx,
		`SELECT endpoint, p256dh, auth FROM web_push_subscriptions
		  WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
		tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []storedSubscription
	for rows.Next() {
		var s storedSubscription
		if err := rows.Scan(&s.Endpoint, &s.P256dh, &s.Auth); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
