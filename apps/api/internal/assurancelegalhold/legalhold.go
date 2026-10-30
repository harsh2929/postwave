// SPDX-License-Identifier: AGPL-3.0-only

// Package assurancelegalhold places and releases legal holds over Campaign
// Assurance evidence.
//
// A hold suspends the retention sweeps that would otherwise delete raster and
// OCR evidence, raw model output, and seed MIME on schedule. The predicate
// itself lives in SQL — campaign_assurance_legal_hold_active(tenant, campaign)
// — so every sweep shares one definition rather than four copies that drift.
// This package owns the lifecycle around it.
package assurancelegalhold

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// MaxReasonCharacters is the shared HTTP/persistence ceiling for place and
// release reasons. PostgreSQL length(text) counts Unicode characters, so the
// Go boundary uses the same unit instead of rejecting valid multi-byte text
// that the database contract accepts. The separate 4 KiB HTTP body cap still
// bounds encoded memory and wire size.
const MaxReasonCharacters = 2000

var (
	// ErrReasonRequired is returned for a blank reason. A hold nobody can
	// explain later cannot answer the question it exists to answer.
	ErrReasonRequired = errors.New("assurancelegalhold: a hold requires a reason")

	// ErrAlreadyHeld is returned when an active hold already covers the scope.
	// Two would make release ambiguous — releasing the visible one would leave
	// the evidence held by one the operator cannot see.
	ErrAlreadyHeld = errors.New("assurancelegalhold: an active hold already covers this scope")

	// ErrNotHeld is returned when releasing a hold that is absent or already
	// released, so a double release is reported rather than silently accepted.
	ErrNotHeld = errors.New("assurancelegalhold: no active hold with that id")
)

// Hold is one placed hold. CampaignID is empty for a tenant-wide hold.
type Hold struct {
	ID         string
	TenantID   string
	CampaignID string
	Reason     string
	PlacedAt   time.Time
}

type PlaceInput struct {
	TenantID string
	// CampaignID empty places a tenant-wide hold, covering every campaign
	// including ones created after the hold.
	CampaignID     string
	Reason         string
	PlacedByUserID string
}

type ReleaseInput struct {
	TenantID         string
	HoldID           string
	Reason           string
	ReleasedByUserID string
}

func normalizeReason(reason string) (string, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return "", ErrReasonRequired
	}
	if utf8.RuneCountInString(reason) > MaxReasonCharacters {
		return "", fmt.Errorf("assurancelegalhold: reason exceeds %d characters", MaxReasonCharacters)
	}
	return reason, nil
}

func nullableUUID(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

// Place records a hold. The scope is the tenant when CampaignID is empty.
func Place(ctx context.Context, pool *db.Pool, input PlaceInput) (Hold, error) {
	reason, err := normalizeReason(input.Reason)
	if err != nil {
		return Hold{}, err
	}
	if _, err := uuid.Parse(strings.TrimSpace(input.TenantID)); err != nil {
		return Hold{}, fmt.Errorf("assurancelegalhold: place requires a tenant id")
	}
	tx, err := db.WithTenant(ctx, pool, input.TenantID)
	if err != nil {
		return Hold{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	hold := Hold{TenantID: input.TenantID, CampaignID: strings.TrimSpace(input.CampaignID), Reason: reason}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_legal_holds (
    tenant_id, campaign_id, reason, placed_by_user_id
) VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
RETURNING id, placed_at`,
		input.TenantID, nullableUUID(input.CampaignID), reason,
		nullableUUID(input.PlacedByUserID),
	).Scan(&hold.ID, &hold.PlacedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Hold{}, ErrAlreadyHeld
		}
		return Hold{}, fmt.Errorf("assurancelegalhold: place: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Hold{}, err
	}
	return hold, nil
}

// Release ends a hold. The row survives with its release recorded: deleting it
// would destroy the record that the evidence was ever preserved.
func Release(ctx context.Context, pool *db.Pool, input ReleaseInput) error {
	reason, err := normalizeReason(input.Reason)
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, pool, input.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
UPDATE campaign_assurance_legal_holds
   SET released_at = now(), release_reason = $3, released_by_user_id = $4::uuid
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND released_at IS NULL`,
		input.TenantID, input.HoldID, reason, nullableUUID(input.ReleasedByUserID))
	if err != nil {
		return fmt.Errorf("assurancelegalhold: release: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotHeld
	}
	return tx.Commit(ctx)
}

// Active reports whether evidence for the scope is under hold. Passing an empty
// campaign asks whether ANYTHING is held for the tenant, which is the only
// question content-addressed evidence (rasters, the OCR cache) can ask: it
// carries no campaign column, so a sweep cannot prove a row is unrelated to the
// held campaign.
func Active(ctx context.Context, pool *db.Pool, tenantID, campaignID string) (bool, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var held bool
	if err := tx.QueryRow(ctx,
		`SELECT campaign_assurance_legal_hold_active($1::uuid, $2::uuid)`,
		tenantID, nullableUUID(campaignID),
	).Scan(&held); err != nil {
		return false, fmt.Errorf("assurancelegalhold: active: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return held, nil
}

// List returns the tenant's holds, newest first, INCLUDING released ones.
//
// Showing only active holds would answer "what is held now" but not "was this
// evidence ever preserved", and the second question is the one an audit asks.
// Released rows carry their release reason, so the operator surface can show
// the whole history rather than a snapshot.
func List(ctx context.Context, pool *db.Pool, tenantID string) ([]Hold, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, COALESCE(campaign_id::text, ''), reason, placed_at
  FROM campaign_assurance_legal_holds
 WHERE tenant_id = $1::uuid
 ORDER BY placed_at DESC, id DESC`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("assurancelegalhold: list: %w", err)
	}
	defer rows.Close()

	holds := make([]Hold, 0, 8)
	for rows.Next() {
		hold := Hold{TenantID: tenantID}
		if err := rows.Scan(&hold.ID, &hold.CampaignID, &hold.Reason, &hold.PlacedAt); err != nil {
			return nil, fmt.Errorf("assurancelegalhold: scan hold: %w", err)
		}
		holds = append(holds, hold)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("assurancelegalhold: list: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return holds, nil
}

// Store binds the package functions to one pool so callers that need an
// interface (the HTTP surface) can hold a value rather than a package.
type Store struct{ Pool *db.Pool }

func (s *Store) Place(ctx context.Context, input PlaceInput) (Hold, error) {
	return Place(ctx, s.Pool, input)
}

func (s *Store) Release(ctx context.Context, input ReleaseInput) error {
	return Release(ctx, s.Pool, input)
}

func (s *Store) List(ctx context.Context, tenantID string) ([]Hold, error) {
	return List(ctx, s.Pool, tenantID)
}
