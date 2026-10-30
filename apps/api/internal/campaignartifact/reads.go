// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const artifactColumns = `
id::text, tenant_id::text, send_plan_id::text, scenario_id,
COALESCE(variant_id::text, ''), locale, branch_key, fixture_id,
source_hash, html_hash, text_hash, COALESCE(structured_data_hash, ''),
mime_structure_hash, outbound_mime_hash, COALESCE(html_object_ref, ''),
COALESCE(text_object_ref, ''), COALESCE(mime_object_ref, ''),
compiler_receipt, representation_manifest, expires_at, created_at`

func scanArtifact(row pgx.Row) (Artifact, error) {
	var artifact Artifact
	if err := row.Scan(
		&artifact.ID, &artifact.TenantID, &artifact.SendPlanID,
		&artifact.ScenarioID, &artifact.VariantID, &artifact.Locale,
		&artifact.BranchKey, &artifact.FixtureID, &artifact.SourceHash,
		&artifact.HTMLHash, &artifact.TextHash, &artifact.StructuredDataHash,
		&artifact.MIMEStructureHash, &artifact.OutboundMIMEHash,
		&artifact.HTMLObjectRef, &artifact.TextObjectRef, &artifact.MIMEObjectRef,
		&artifact.CompilerReceipt, &artifact.RepresentationManifest,
		&artifact.ExpiresAt, &artifact.CreatedAt,
	); err != nil {
		return Artifact{}, err
	}
	artifact.CompilerReceipt = append([]byte(nil), artifact.CompilerReceipt...)
	artifact.RepresentationManifest = append([]byte(nil), artifact.RepresentationManifest...)
	return artifact, nil
}

func validateReadIdentities(tenantID, campaignID string, additional ...string) error {
	for _, identity := range append([]string{tenantID, campaignID}, additional...) {
		if _, err := uuid.Parse(identity); err != nil {
			return fmt.Errorf("%w: invalid UUID identity", ErrInvalidInput)
		}
	}
	return nil
}

// GetPlan returns one tenant/campaign-bound immutable plan. Keeping campaignID
// in the lookup prevents a caller from using a same-tenant plan as an oracle
// for another campaign.
func (r *Repo) GetPlan(ctx context.Context, tenantID, campaignID, planID string) (*Plan, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if err := validateReadIdentities(tenantID, campaignID, planID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	plan, err := scanPlan(tx.QueryRow(ctx, `
SELECT `+planColumns+` FROM campaign_send_plans
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND id = $3::uuid`,
		tenantID, campaignID, planID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &plan, nil
}

// ListPlans returns bounded plan receipts newest first. It never embeds
// artifact bodies; callers fetch the exact artifact manifest separately.
func (r *Repo) ListPlans(ctx context.Context, tenantID, campaignID string, limit int) ([]Plan, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if err := validateReadIdentities(tenantID, campaignID); err != nil {
		return nil, err
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
SELECT `+planColumns+` FROM campaign_send_plans
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
 ORDER BY plan_no DESC, id DESC LIMIT $3`, tenantID, campaignID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	plans := make([]Plan, 0)
	for rows.Next() {
		plan, scanErr := scanPlan(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		plans = append(plans, plan)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return plans, nil
}

// ListArtifacts returns the complete persisted scenario set for an exact
// tenant/campaign/plan identity in stable scenario order.
func (r *Repo) ListArtifacts(ctx context.Context, tenantID, campaignID, planID string) ([]Artifact, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if err := validateReadIdentities(tenantID, campaignID, planID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var planExists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM campaign_send_plans
     WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND id = $3::uuid
)`, tenantID, campaignID, planID).Scan(&planExists); err != nil {
		return nil, err
	}
	if !planExists {
		return nil, ErrNotFound
	}
	rows, err := tx.Query(ctx, `
SELECT `+artifactColumns+` FROM campaign_render_artifacts
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND send_plan_id = $3::uuid
 ORDER BY scenario_id, id`, tenantID, campaignID, planID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	artifacts := make([]Artifact, 0)
	for rows.Next() {
		artifact, scanErr := scanArtifact(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		artifacts = append(artifacts, artifact)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return artifacts, nil
}

// GetArtifact proves all four ownership coordinates before exposing encrypted
// object references to an authorized worker.
func (r *Repo) GetArtifact(
	ctx context.Context,
	tenantID, campaignID, planID, artifactID string,
) (*Artifact, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if err := validateReadIdentities(tenantID, campaignID, planID, artifactID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	artifact, err := scanArtifact(tx.QueryRow(ctx, `
SELECT `+artifactColumns+` FROM campaign_render_artifacts
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND send_plan_id = $3::uuid AND id = $4::uuid`,
		tenantID, campaignID, planID, artifactID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &artifact, nil
}
