// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// ListSuppressions returns suppressions newest-first. The legacy
// `email` parameter does an exact-match filter (kept for back-compat
// with existing API clients). The new `q` parameter does a substring
// ILIKE on email — empty `q` means no filter. Both can be combined.
func (r *Repo) ListSuppressions(ctx context.Context, tenantID, email, reason, q string, page, perPage int) (*SuppressionPage, error) {
	page, perPage = normalizePage(page, perPage)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID}
	where := ` WHERE tenant_id = $1::uuid`
	if strings.TrimSpace(email) != "" {
		args = append(args, strings.ToLower(strings.TrimSpace(email)))
		where += fmt.Sprintf(` AND lower(email::text) = lower($%d)`, len(args))
	}
	if strings.TrimSpace(reason) != "" {
		args = append(args, strings.ToLower(strings.TrimSpace(reason)))
		where += fmt.Sprintf(` AND reason = $%d`, len(args))
	}
	if strings.TrimSpace(q) != "" {
		args = append(args, strings.TrimSpace(q))
		where += fmt.Sprintf(` AND email::text ILIKE '%%' || $%d || '%%'`, len(args))
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM email_suppressions`+where, args...).Scan(&total); err != nil {
		return nil, err
	}
	args = append(args, perPage, (page-1)*perPage)
	rows, err := tx.Query(ctx, suppressionSelectSQL+where+fmt.Sprintf(`
ORDER BY suppressed_at DESC
LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, err
	}
	items, err := scanSuppressions(rows)
	if err != nil {
		return nil, err
	}
	return &SuppressionPage{Items: items, Total: total, Page: page, PerPage: perPage}, tx.Commit(ctx)
}

func (r *Repo) CreateSuppression(ctx context.Context, tenantID string, in CreateSuppressionInput) (*Suppression, error) {
	out, _, err := r.createSuppression(ctx, tenantID, "", "", in, db.AuditMeta{})
	return out, err
}

// CreateSuppressionExact is the subscriber-profile write path. It locks the
// parent aggregate and compares the exact reviewed revision in the same
// transaction that creates both suppression projections and blocklists the
// subscriber. Generic provider/webhook suppression ingestion continues to use
// CreateSuppression because those callers do not begin from an operator-read
// subscriber snapshot.
func (r *Repo) CreateSuppressionExact(
	ctx context.Context,
	tenantID, subscriberID, ifMatchToken string,
	in CreateSuppressionInput,
	auditMeta db.AuditMeta,
) (*Suppression, string, error) {
	if strings.TrimSpace(subscriberID) == "" || strings.TrimSpace(ifMatchToken) == "" {
		return nil, "", ErrPreconditionFailed
	}
	return r.createSuppression(ctx, tenantID, subscriberID, ifMatchToken, in, auditMeta)
}

func (r *Repo) createSuppression(
	ctx context.Context,
	tenantID, subscriberID, ifMatchToken string,
	in CreateSuppressionInput,
	auditMeta db.AuditMeta,
) (*Suppression, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lockedSubscriberID := ""
	previousVersion := ""
	if subscriberID != "" {
		var lockedEmail string
		var lockedUpdatedAt time.Time
		err := tx.QueryRow(ctx, `
SELECT id::text, email::text, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 FOR UPDATE`, tenantID, subscriberID).Scan(
			&lockedSubscriberID, &lockedEmail, &lockedUpdatedAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", ErrNotFound
		}
		if err != nil {
			return nil, "", err
		}
		previousVersion = httpcache.ConcurrencyToken("subscriber", lockedSubscriberID, lockedUpdatedAt)
		if ifMatchToken != previousVersion {
			return nil, "", ErrPreconditionFailed
		}
		// Never trust a body/path email for this profile-scoped operation. The
		// locked canonical row is the exact identity being suppressed.
		in.Email = lockedEmail
	}
	metaRaw, _ := json.Marshal(nonNilMap(in.Metadata))
	row := tx.QueryRow(ctx, `
INSERT INTO email_suppressions (
    tenant_id, email, reason, source, provider_event_id, campaign_id, metadata, expires_at
)
VALUES (
    $1::uuid, $2, $3, $4, NULLIF($5, ''), NULLIF($6, '')::uuid, $7::jsonb, $8
)
ON CONFLICT (tenant_id, email, reason) DO UPDATE SET
    source = EXCLUDED.source,
    provider_event_id = COALESCE(EXCLUDED.provider_event_id, email_suppressions.provider_event_id),
    campaign_id = COALESCE(EXCLUDED.campaign_id, email_suppressions.campaign_id),
    metadata = email_suppressions.metadata || EXCLUDED.metadata,
    expires_at = EXCLUDED.expires_at,
    suppressed_at = now()
RETURNING `+suppressionColumns,
		tenantID, in.Email, in.Reason, defaulted(in.Source, "manual"), in.ProviderEventID,
		in.CampaignID, string(metaRaw), in.ExpiresAt)
	out, err := scanSuppression(row)
	if err != nil {
		return nil, "", err
	}
	// Keep the canonical send-time/admin store in lockstep with the legacy
	// email_suppressions row. Both writes share this transaction.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_suppressions (tenant_id, email, reason, source, metadata, expires_at)
VALUES ($1::uuid, $2,
        CASE $3
          WHEN 'hard_bounce' THEN 'hard_bounce'
          WHEN 'complaint' THEN 'spam_complaint'
          WHEN 'soft_bounce' THEN 'soft_bounce'
          WHEN 'list_unsub_header' THEN 'list_unsub_header'
          WHEN 'spamtrap' THEN 'spamtrap'
          WHEN 'role_account' THEN 'role_account'
          WHEN 'dns_failure' THEN 'dns_failure'
          WHEN 'invalid_address' THEN 'invalid_address'
          WHEN 'unsubscribe' THEN 'manual_unsubscribe'
          ELSE 'list_manual'
        END,
        'api', $4::jsonb, $5)
ON CONFLICT (tenant_id, email) DO UPDATE SET
        reason = EXCLUDED.reason, source = EXCLUDED.source,
        metadata = subscriber_suppressions.metadata || EXCLUDED.metadata,
        expires_at = EXCLUDED.expires_at`,
		tenantID, in.Email, in.Reason, string(metaRaw), in.ExpiresAt); err != nil {
		return nil, "", err
	}
	var affectedSubscriberID string
	var affectedSubscriberUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
UPDATE subscribers
   SET status = 'blocklisted',
       mailchimp_status = CASE
         WHEN $3 = 'unsubscribe' THEN 'unsubscribed'
         ELSE 'cleaned'
       END,
       updated_at = now()
 WHERE tenant_id = $1::uuid
	   AND lower(email::text) = lower($2)
	 RETURNING id::text, updated_at`, tenantID, in.Email, in.Reason).Scan(
		&affectedSubscriberID, &affectedSubscriberUpdatedAt,
	); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, "", err
	}
	if lockedSubscriberID != "" && affectedSubscriberID != lockedSubscriberID {
		return nil, "", ErrPreconditionFailed
	}
	if affectedSubscriberID != "" {
		if err := r.appendEngineSync(ctx, tx, tenantID, affectedSubscriberID, ""); err != nil {
			return nil, "", err
		}
	}
	freshVersion := ""
	if affectedSubscriberID != "" {
		freshVersion = httpcache.ConcurrencyToken("subscriber", affectedSubscriberID, affectedSubscriberUpdatedAt)
	}
	if lockedSubscriberID != "" {
		auditMeta.TenantID = tenantID
		if err := db.Audit(ctx, tx, auditMeta, "subscriber.suppressed", "subscriber", lockedSubscriberID, map[string]any{
			"reason":           in.Reason,
			"previous_version": previousVersion,
			"new_version":      freshVersion,
		}); err != nil {
			return nil, "", fmt.Errorf("audit subscriber suppression: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return out, freshVersion, nil
}

func (r *Repo) DeleteSuppression(ctx context.Context, tenantID, id string) error {
	err := (&suppressions.Repo{Pool: r.Pool}).RemoveLegacyByID(ctx, tenantID, id)
	switch {
	case errors.Is(err, suppressions.ErrLegacySuppressionNotFound):
		return ErrNotFound
	case errors.Is(err, suppressions.ErrIrreversibleSuppression):
		return ErrSuppressionNotReversible
	default:
		return err
	}
}
