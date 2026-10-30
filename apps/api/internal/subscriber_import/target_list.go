// SPDX-License-Identifier: AGPL-3.0-only
//
// target_list.go — the list a CSV import adds its contacts to.
//
// The wizard's optional "Add to list" choice lands in
// subscriber_imports.target_list_id (migration 2064). Every chunk that wrote
// rows then makes those contacts members of that list, inside the SAME
// serializable tenant transaction as the subscriber upsert: an import can never
// report contacts it did not also place on the list it was told to.
//
// THE ROW is written exactly the way the bulk add-to-list verb writes one
// (subscribers/bulk_add_to_list.go): the engine id and address are denormalised
// so the subscriber's Lists panel can name the list, a tombstoned membership is
// revived rather than left for dead, and a row in the membership ledger
// (list_subscriber_sources) records WHO claimed the membership — here the
// import — so a CRM sync that later drops the contact cannot silently undo it.
//
// WHICH CONTACTS. Every contact the chunk was allowed to write, not only the
// ones the upsert created. With on_existing=skip a contact who already exists
// is deliberately left untouched as a subscriber — but the operator still named
// this file's audience as the list's members, and joining a list overwrites
// nothing. Rows that failed validation, and addresses an erasure tombstone
// protects, are not in this set: they were never imported.

package subscriber_import

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/lists"
)

// The membership source + ledger owner an import writes. 'csv' is the
// list_subscribers.source value migration 0249 reserved for exactly this, so
// list growth and source-mix analytics attribute an imported audience to the
// import instead of burying it under an operator's manual adds.
const (
	importListSource   = "csv"
	importListOwnerKey = "source:csv"
)

// addImportedToTargetList makes every address in emails an active member of the
// import's target list. A no-op when the import names no list, or when the
// chunk wrote nothing.
//
// Returns an error wrapping lists.ErrListIDNotMapped when the list was deleted
// after the import was confirmed; importJobFailureCode turns that into the
// `target_list_missing` terminal failure so the operator is told which half of
// the job could not be honoured.
func addImportedToTargetList(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, targetListID string,
	emails []string,
) error {
	if targetListID == "" || len(emails) == 0 {
		return nil
	}
	// Resolved in the writing transaction, FOR KEY SHARE (ResolveListIdentityTx):
	// a list deleted since Confirm is refused here, and a deletion starting now
	// waits and then removes these rows with the rest of the list.
	list, err := lists.ResolveListIdentityTx(ctx, tx, tenantID, targetListID)
	if err != nil {
		return fmt.Errorf("subscriber import: resolve target list: %w", err)
	}
	if _, err := tx.Exec(ctx, `
WITH candidate AS (
    SELECT s.id, s.email
      FROM subscribers s
     WHERE s.tenant_id = $1::uuid
       AND s.email = ANY($3::citext[])
),
membership AS (
    INSERT INTO list_subscribers
        (tenant_id, list_id, subscriber_id, listmonk_list_id, email, source, added_at, removed_at)
    SELECT $1::uuid, $2::uuid, c.id, $4, c.email, $5, now(), NULL
      FROM candidate c
    ON CONFLICT (tenant_id, list_id, subscriber_id) DO UPDATE
       SET removed_at       = NULL,
           added_at         = EXCLUDED.added_at,
           source           = EXCLUDED.source,
           email            = COALESCE(EXCLUDED.email, list_subscribers.email),
           listmonk_list_id = COALESCE(EXCLUDED.listmonk_list_id, list_subscribers.listmonk_list_id)
     WHERE list_subscribers.removed_at IS NOT NULL
    RETURNING subscriber_id, email, added_at
)
INSERT INTO list_subscriber_sources
    (tenant_id, list_id, subscriber_id, email, source, owner_key,
     first_seen_at, last_seen_at, removed_at, metadata)
SELECT $1::uuid, $2::uuid, m.subscriber_id, m.email, $5, $6,
       m.added_at, m.added_at, NULL, '{"owner":"subscriber_import"}'::jsonb
  FROM membership m
ON CONFLICT (tenant_id, list_id, subscriber_id, owner_key) DO UPDATE
   SET email        = EXCLUDED.email,
       last_seen_at = EXCLUDED.last_seen_at,
       removed_at   = NULL`,
		tenantID, list.UUID, emails, list.EngineID, importListSource, importListOwnerKey,
	); err != nil {
		return fmt.Errorf("subscriber import: add imported contacts to list: %w", err)
	}
	return nil
}
