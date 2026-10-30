// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// GetByIDOrSlug resolves one template the caller can see by its UUID or its
// slug. Slugs are the stable, human-readable names people and agents quote
// ("welcome-negative-promise"); requiring a UUID made every such reference
// fail with 404 even though the template was in the caller's own catalog.
//
// A slug can name at most two visible rows: the workspace's own template and
// the shared platform template (each set has its own unique index). The
// workspace's own active, usable template wins, so a team's edited copy
// shadows the starter it was derived from; archived or rejected rows are
// chosen only when nothing better carries the slug.
func (r *Repo) GetByIDOrSlug(ctx context.Context, tenantID, identifier string) (*Template, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return nil, ErrNotFound
	}
	if parsed, err := uuid.Parse(identifier); err == nil {
		return r.Get(ctx, tenantID, parsed.String())
	}
	slug := strings.ToLower(identifier)
	if validateSlug(slug) != nil {
		return nil, ErrNotFound
	}
	id, err := r.templateIDForSlug(ctx, tenantID, slug)
	if err != nil {
		return nil, err
	}
	return r.Get(ctx, tenantID, id)
}

func (r *Repo) templateIDForSlug(ctx context.Context, tenantID, slug string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
SELECT t.id::text
  FROM campaign_templates t
 WHERE t.slug = $1
   AND (t.tenant_id = $2::uuid OR t.tenant_id IS NULL)
 ORDER BY (t.archived_at IS NOT NULL),
          (t.review_status = 'rejected'),
          (t.tenant_id IS NULL),
          t.id
 LIMIT 1`, slug, tenantID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}
