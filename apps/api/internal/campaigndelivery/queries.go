// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func (r *Repo) Get(ctx context.Context, tenantID, attemptID string) (*Attempt, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(strings.TrimSpace(tenantID)); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(strings.TrimSpace(attemptID)); err != nil {
		return nil, fmt.Errorf("%w: invalid attempt_id", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	attempt, err := scanAttempt(tx.QueryRow(ctx, `
SELECT `+attemptColumns+` FROM campaign_send_deliveries
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, attemptID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &attempt, nil
}

func (r *Repo) ListCampaign(ctx context.Context, tenantID, campaignID string, limit int) ([]Attempt, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(strings.TrimSpace(tenantID)); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(strings.TrimSpace(campaignID)); err != nil {
		return nil, fmt.Errorf("%w: invalid campaign_id", ErrInvalidInput)
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+attemptColumns+` FROM campaign_send_deliveries
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
 ORDER BY created_at DESC, id DESC LIMIT $3`, tenantID, campaignID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	attempts := make([]Attempt, 0)
	for rows.Next() {
		attempt, scanErr := scanAttempt(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		attempts = append(attempts, attempt)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return attempts, nil
}
