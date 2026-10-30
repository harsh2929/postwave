// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// GetByDesignDraft returns the unique template committed from a durable design
// draft. It recovers the narrow crash window between template INSERT and the
// design job's saved marker.
func (r *Repo) GetByDesignDraft(
	ctx context.Context,
	tenantID, designDraftID string,
) (*Template, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var templateID string
	err = tx.QueryRow(ctx, `
SELECT id::text
  FROM campaign_templates
 WHERE tenant_id = $1::uuid
   AND generation_metadata ->> 'design_draft_id' = $2`,
		tenantID, designDraftID).Scan(&templateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.Get(ctx, tenantID, templateID)
}
