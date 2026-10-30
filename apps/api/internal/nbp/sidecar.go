// SPDX-License-Identifier: AGPL-3.0-only
//
// Reserved persistence model for a future vendor recommendation service.
//
// Migration 0347_sto_next_best_product.sql ships the
// nbp_sidecar_endpoints table that this file's SidecarRepo wraps.
//
// No HTTP route, adapter registry, or recommender dispatch is exposed in this
// release. Keeping the row projection isolated from runtime routing prevents a
// configured endpoint from implying that catalog sync or recommendations run.

package nbp

import (
	"context"
	"errors"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SidecarProvider mirrors the CHECK constraint on
// nbp_sidecar_endpoints.provider.
type SidecarProvider string

const (
	SidecarProviderPersonalize      SidecarProvider = "personalize"
	SidecarProviderRecombee         SidecarProvider = "recombee"
	SidecarProviderAlgoliaRecommend SidecarProvider = "algolia_recommend"
)

// SidecarStatus mirrors the CHECK constraint on
// nbp_sidecar_endpoints.status.
type SidecarStatus string

const (
	SidecarStatusPending  SidecarStatus = "pending"
	SidecarStatusActive   SidecarStatus = "active"
	SidecarStatusError    SidecarStatus = "error"
	SidecarStatusDisabled SidecarStatus = "disabled"
)

// SidecarEndpoint is one row of nbp_sidecar_endpoints.
type SidecarEndpoint struct {
	TenantID          string          `json:"tenant_id,omitempty"`
	Provider          SidecarProvider `json:"provider"`
	EndpointARN       string          `json:"endpoint_arn"`
	DatasetARN        string          `json:"dataset_arn,omitempty"`
	IAMRoleARN        string          `json:"iam_role_arn,omitempty"`
	Region            string          `json:"region"`
	Status            SidecarStatus   `json:"status"`
	LastError         string          `json:"last_error,omitempty"`
	LastSyncedAt      *time.Time      `json:"last_synced_at,omitempty"`
	LastSyncItemCount int             `json:"last_sync_item_count"`
	CreatedAt         time.Time       `json:"created_at,omitempty"`
	UpdatedAt         time.Time       `json:"updated_at,omitempty"`
}

// SidecarRepo wraps the nbp_sidecar_endpoints table.
type SidecarRepo struct {
	Pool *db.Pool
}

// NewSidecarRepo returns a ready-to-use repo.
func NewSidecarRepo(pool *db.Pool) *SidecarRepo { return &SidecarRepo{Pool: pool} }

// Get returns the endpoint row for (tenantID, provider). Returns
// (zero, ErrNotFound) when no row exists.
func (r *SidecarRepo) Get(ctx context.Context, tenantID string, provider SidecarProvider) (SidecarEndpoint, error) {
	if r == nil || r.Pool == nil {
		return SidecarEndpoint{}, errors.New("nbp: sidecar repo not initialised")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return SidecarEndpoint{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		ep     SidecarEndpoint
		status string
	)
	ep.TenantID = tenantID
	ep.Provider = provider
	err = tx.QueryRow(ctx, `
SELECT endpoint_arn, dataset_arn, iam_role_arn, region, status,
       last_error, last_synced_at, last_sync_item_count,
       created_at, updated_at
  FROM nbp_sidecar_endpoints
 WHERE tenant_id = $1::uuid AND provider = $2`, tenantID, string(provider)).Scan(
		&ep.EndpointARN, &ep.DatasetARN, &ep.IAMRoleARN, &ep.Region, &status,
		&ep.LastError, &ep.LastSyncedAt, &ep.LastSyncItemCount,
		&ep.CreatedAt, &ep.UpdatedAt,
	)
	if err != nil {
		return SidecarEndpoint{}, ErrNotFound
	}
	ep.Status = SidecarStatus(status)
	return ep, tx.Commit(ctx)
}

// Upsert inserts or updates an endpoint row.
func (r *SidecarRepo) Upsert(ctx context.Context, tenantID string, ep SidecarEndpoint) (SidecarEndpoint, error) {
	if r == nil || r.Pool == nil {
		return SidecarEndpoint{}, errors.New("nbp: sidecar repo not initialised")
	}
	if tenantID == "" {
		return SidecarEndpoint{}, errors.New("nbp: tenant_id required")
	}
	if ep.Provider == "" {
		ep.Provider = SidecarProviderPersonalize
	}
	if ep.Region == "" {
		ep.Region = "us-east-1"
	}
	if ep.Status == "" {
		ep.Status = SidecarStatusPending
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return ep, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		out    SidecarEndpoint
		status string
	)
	out.TenantID = tenantID
	out.Provider = ep.Provider
	err = tx.QueryRow(ctx, `
INSERT INTO nbp_sidecar_endpoints(
    tenant_id, provider, endpoint_arn, dataset_arn, iam_role_arn, region, status)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, provider) DO UPDATE SET
    endpoint_arn = EXCLUDED.endpoint_arn,
    dataset_arn  = EXCLUDED.dataset_arn,
    iam_role_arn = EXCLUDED.iam_role_arn,
    region       = EXCLUDED.region,
    status       = EXCLUDED.status,
    updated_at   = now()
RETURNING endpoint_arn, dataset_arn, iam_role_arn, region, status,
          last_error, last_synced_at, last_sync_item_count,
          created_at, updated_at`,
		tenantID, string(ep.Provider), ep.EndpointARN, ep.DatasetARN,
		ep.IAMRoleARN, ep.Region, string(ep.Status),
	).Scan(&out.EndpointARN, &out.DatasetARN, &out.IAMRoleARN, &out.Region, &status,
		&out.LastError, &out.LastSyncedAt, &out.LastSyncItemCount,
		&out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return ep, err
	}
	out.Status = SidecarStatus(status)
	return out, tx.Commit(ctx)
}

// MarkError records the most recent failure for an endpoint so the
// operator-facing settings panel can show "last failure at ... because ...".
// Best-effort: never blocks the caller's hot path.
func (r *SidecarRepo) MarkError(ctx context.Context, tenantID string, provider SidecarProvider, msg string) {
	if r == nil || r.Pool == nil {
		return
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE nbp_sidecar_endpoints
   SET status     = 'error',
       last_error = $3,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND provider = $2`,
		tenantID, string(provider), msg); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

// MarkSynced records a successful catalog sync.
func (r *SidecarRepo) MarkSynced(ctx context.Context, tenantID string, provider SidecarProvider, itemCount int) {
	if r == nil || r.Pool == nil {
		return
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE nbp_sidecar_endpoints
   SET status               = 'active',
       last_error           = '',
       last_synced_at       = now(),
       last_sync_item_count = $3,
       updated_at           = now()
 WHERE tenant_id = $1::uuid AND provider = $2`,
		tenantID, string(provider), itemCount); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}
