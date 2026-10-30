// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// PreflightUpsert checks the durable local preconditions that must be known
// before any external delivery-engine mutation: a prior GDPR erasure block and
// an explicit full merge_fields replacement.
//
// The validation is delegated to the same merge_field_schema rows and
// validate_declared_merge_field_value database function used by the canonical
// write trigger. That keeps Mailchimp-style audience fields independent from
// tenant_custom_fields and prevents application/database type drift.
func (r *Repo) PreflightUpsert(
	ctx context.Context,
	tenantID, email string,
	after map[string]any,
) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = rejectErasedAddress(ctx, tx, tenantID, email); err != nil {
		return err
	}
	var existingSubscriberID string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE((
    SELECT id::text
      FROM subscribers
     WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
     LIMIT 1
), '')`, tenantID, email).Scan(&existingSubscriberID); err != nil {
		return err
	}
	if err := rejectEmailOwnedByAnotherProfile(ctx, tx, tenantID, email, existingSubscriberID); err != nil {
		return err
	}
	if after == nil {
		return tx.Commit(ctx)
	}
	afterRaw, err := json.Marshal(after)
	if err != nil {
		return err
	}

	// Validate only declared keys whose effective value changes. On a new row,
	// an absent required field remains unset (the database trigger's existing
	// contract); removing a required value from an existing row is validated as
	// an empty value and rejected.
	rows, err := tx.Query(ctx, `
WITH existing AS (
    SELECT COALESCE(subscriber.merge_fields, '{}'::jsonb) AS fields
      FROM subscribers subscriber
     WHERE subscriber.tenant_id = $1::uuid
       AND lower(subscriber.email::text) = lower($2)
     LIMIT 1
), candidate AS (
    SELECT $3::jsonb AS fields
)
SELECT validate_declared_merge_field_value(
           schema.key,
           schema.type,
           schema.required,
           candidate.fields -> schema.key
       )
  FROM merge_field_schema schema
 CROSS JOIN candidate
  LEFT JOIN existing ON true
 WHERE schema.tenant_id = $1::uuid
   AND (COALESCE(existing.fields, '{}'::jsonb) -> schema.key)
       IS DISTINCT FROM (candidate.fields -> schema.key)`,
		tenantID, email, string(afterRaw))
	if err != nil {
		return err
	}
	for rows.Next() {
		var ignored string
		if err := rows.Scan(&ignored); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	return tx.Commit(ctx)
}

// PreflightUpdate is the PATCH counterpart. The caller has already loaded the
// current subscriber, so passing both documents avoids a second subscriber
// lookup while retaining the exact changed-key semantics of the database
// trigger. targetEmail is the effective post-patch address.
func (r *Repo) PreflightUpdate(
	ctx context.Context,
	tenantID, currentSubscriberID, targetEmail string,
	before, after map[string]any,
) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = rejectErasedAddress(ctx, tx, tenantID, targetEmail); err != nil {
		return err
	}
	if err := rejectEmailOwnedByAnotherProfile(ctx, tx, tenantID, targetEmail, currentSubscriberID); err != nil {
		return err
	}
	if after == nil {
		return tx.Commit(ctx)
	}
	beforeRaw, err := json.Marshal(nonNilMap(before))
	if err != nil {
		return err
	}
	afterRaw, err := json.Marshal(after)
	if err != nil {
		return err
	}

	rows, err := tx.Query(ctx, `
WITH documents AS (
    SELECT $2::jsonb AS before_fields, $3::jsonb AS after_fields
)
SELECT validate_declared_merge_field_value(
           schema.key,
           schema.type,
           schema.required,
           documents.after_fields -> schema.key
       )
  FROM merge_field_schema schema
 CROSS JOIN documents
 WHERE schema.tenant_id = $1::uuid
   AND (documents.before_fields -> schema.key)
       IS DISTINCT FROM (documents.after_fields -> schema.key)`,
		tenantID, string(beforeRaw), string(afterRaw))
	if err != nil {
		return err
	}
	for rows.Next() {
		var ignored string
		if err := rows.Scan(&ignored); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	return tx.Commit(ctx)
}

func rejectEmailOwnedByAnotherProfile(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, email, allowedSubscriberID string,
) error {
	var occupied bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM subscriber_emails
     WHERE tenant_id = $1::uuid
       AND lower(email::text) = lower($2)
       AND ($3 = '' OR subscriber_id::text <> $3)
)`, tenantID, email, allowedSubscriberID).Scan(&occupied); err != nil {
		return err
	}
	if occupied {
		return ErrEmailTaken
	}
	return nil
}
