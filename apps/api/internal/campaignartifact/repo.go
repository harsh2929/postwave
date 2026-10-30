// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type Repo struct{ Pool *db.Pool }

func NewRepo(pool *db.Pool) *Repo { return &Repo{Pool: pool} }

type revisionSourceHashInput struct {
	SourceMode           string          `json:"source_mode"`
	ContentSchemaVersion int             `json:"content_schema_version"`
	Subject              string          `json:"subject"`
	PreviewText          *string         `json:"preview_text"`
	SemanticTree         json.RawMessage `json:"semantic_tree"`
	LegacyHTML           *string         `json:"legacy_html"`
	ReviewedPlainText    *string         `json:"reviewed_plain_text"`
	FactContract         json.RawMessage `json:"fact_contract"`
	Variants             json.RawMessage `json:"variants"`
	Locales              json.RawMessage `json:"locales"`
	TrackingSettings     json.RawMessage `json:"tracking_settings"`
}

const revisionColumns = `
id::text, tenant_id::text, campaign_id::text, revision_no, source_mode,
content_schema_version, subject, preview_text, semantic_tree, legacy_html,
reviewed_plain_text, fact_contract, variants, locales, source_hash,
tracking_settings, NULLIF(created_by::text, ''), created_at`

const revisionSummaryColumns = `
id::text, campaign_id::text, revision_no, source_mode,
content_schema_version, subject, source_hash,
NULLIF(created_by::text, ''), created_at`

func scanRevision(row pgx.Row) (Revision, error) {
	var revision Revision
	if err := row.Scan(
		&revision.ID, &revision.TenantID, &revision.CampaignID,
		&revision.RevisionNo, &revision.SourceMode,
		&revision.ContentSchemaVersion, &revision.Subject,
		&revision.PreviewText, &revision.SemanticTree, &revision.LegacyHTML,
		&revision.ReviewedPlainText, &revision.FactContract,
		&revision.Variants, &revision.Locales, &revision.SourceHash,
		&revision.TrackingSettings,
		&revision.CreatedBy, &revision.CreatedAt,
	); err != nil {
		return Revision{}, err
	}
	return revision, nil
}

func scanRevisionSummary(row pgx.Row) (RevisionSummary, error) {
	var revision RevisionSummary
	if err := row.Scan(
		&revision.ID, &revision.CampaignID, &revision.RevisionNo,
		&revision.SourceMode, &revision.ContentSchemaVersion,
		&revision.Subject, &revision.SourceHash, &revision.CreatedBy,
		&revision.CreatedAt,
	); err != nil {
		return RevisionSummary{}, err
	}
	return revision, nil
}

// lockedRevisionSource is the canonical mutable authoring state captured while
// the campaigns row is locked. Both an ordinary freeze and a governed finding
// application use this exact loader, so their source hashes cannot drift due
// to duplicated normalization rules.
type lockedRevisionSource struct {
	Source     revisionSourceHashInput
	SourceHash string
	UpdatedAt  time.Time
	Status     string
	Dispatched bool
}

func loadLockedRevisionSource(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID string,
) (lockedRevisionSource, error) {
	var (
		sourceMode, subject, status                string
		schemaVersion                              int
		preview, html, plain                       pgtype.Text
		semanticTree, factContract, inlineVariants []byte
		locales, trackingSettings                  []byte
		updatedAt                                  time.Time
		dispatched                                 bool
	)
	err := tx.QueryRow(ctx, `
SELECT source_mode,
       content_schema_version,
       subject,
       preview_text,
       content_blocks,
       body_html,
       plain_text,
       fact_contract,
       variants,
       CASE
           WHEN jsonb_typeof(delivery_settings->'locales') = 'array'
               THEN delivery_settings->'locales'
           ELSE '[]'::jsonb
       END,
	   tracking_settings,
       updated_at,
       status,
       started_at IS NOT NULL OR status IN ('sending', 'sent')
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
 FOR UPDATE`, tenantID, campaignID).Scan(
		&sourceMode, &schemaVersion, &subject, &preview, &semanticTree,
		&html, &plain, &factContract, &inlineVariants, &locales,
		&trackingSettings,
		&updatedAt, &status, &dispatched,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedRevisionSource{}, ErrNotFound
	}
	if err != nil {
		return lockedRevisionSource{}, err
	}

	semanticTree, err = canonicalJSON(semanticTree, "array")
	if err != nil {
		return lockedRevisionSource{}, fmt.Errorf("semantic_tree: %w", err)
	}
	sourceMode = strings.TrimSpace(sourceMode)
	switch sourceMode {
	case SourceModeSemantic:
		if string(semanticTree) == "[]" {
			return lockedRevisionSource{}, fmt.Errorf("%w: semantic campaign has no nodes", ErrSourceIncomplete)
		}
		semanticTree, _, err = NormalizeSemanticTreeV2(semanticTree, schemaVersion)
		if err != nil {
			return lockedRevisionSource{}, fmt.Errorf("semantic_tree: %w", err)
		}
	case SourceModeLegacyHTML:
		if schemaVersion != 1 {
			return lockedRevisionSource{}, fmt.Errorf("%w: legacy_html source requires content_schema_version 1", ErrInvalidInput)
		}
		if !html.Valid || strings.TrimSpace(html.String) == "" {
			return lockedRevisionSource{}, fmt.Errorf("%w: legacy campaign has no HTML", ErrSourceIncomplete)
		}
	default:
		return lockedRevisionSource{}, fmt.Errorf("%w: unsupported source_mode", ErrInvalidInput)
	}
	factContract, err = normalizeFactContract(factContract, sourceMode, semanticTree)
	if err != nil {
		return lockedRevisionSource{}, fmt.Errorf("fact_contract: %w", err)
	}
	inlineVariants, err = canonicalJSON(inlineVariants, "array")
	if err != nil {
		return lockedRevisionSource{}, fmt.Errorf("variants: %w", err)
	}
	locales, err = canonicalJSON(locales, "array")
	if err != nil {
		return lockedRevisionSource{}, fmt.Errorf("locales: %w", err)
	}
	trackingSettings, err = canonicalJSON(trackingSettings, "object")
	if err != nil {
		return lockedRevisionSource{}, fmt.Errorf("tracking_settings: %w", err)
	}

	// The normalized campaign_variants table is authoritative when populated;
	// retain the legacy inline array only for campaigns not yet migrated.
	variantRows, err := tx.Query(ctx, `
SELECT jsonb_build_object(
           'id', id::text,
           'variant_label', variant_label,
           'subject', subject,
           'from_name', from_name,
           'body_mjml', body_mjml,
           'body_html', body_html,
           'weight', weight
       )
  FROM campaign_variants
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
 ORDER BY variant_label, id`, tenantID, campaignID)
	if err != nil {
		return lockedRevisionSource{}, err
	}
	var normalizedVariants []json.RawMessage
	for variantRows.Next() {
		var value json.RawMessage
		if err := variantRows.Scan(&value); err != nil {
			variantRows.Close()
			return lockedRevisionSource{}, err
		}
		normalizedVariants = append(normalizedVariants, value)
	}
	if err := variantRows.Err(); err != nil {
		variantRows.Close()
		return lockedRevisionSource{}, err
	}
	variantRows.Close()
	if len(normalizedVariants) > 0 {
		inlineVariants, err = json.Marshal(normalizedVariants)
		if err != nil {
			return lockedRevisionSource{}, err
		}
		inlineVariants, err = canonicalJSON(inlineVariants, "array")
		if err != nil {
			return lockedRevisionSource{}, err
		}
	}

	source := revisionSourceHashInput{
		SourceMode: sourceMode, ContentSchemaVersion: schemaVersion,
		Subject: subject, PreviewText: nullableString(preview),
		SemanticTree: semanticTree, LegacyHTML: nullableString(html),
		ReviewedPlainText: nullableString(plain), FactContract: factContract,
		Variants: inlineVariants, Locales: locales,
		TrackingSettings: trackingSettings,
	}
	sourceHash, err := digestJSON(source)
	if err != nil {
		return lockedRevisionSource{}, err
	}
	return lockedRevisionSource{
		Source: source, SourceHash: sourceHash, UpdatedAt: updatedAt,
		Status: status, Dispatched: dispatched,
	}, nil
}

// FreezeCurrent snapshots the mutable campaign and its normalized A/B rows in
// one tenant-scoped serializable transaction. Locking the campaign row makes
// revision numbering and source capture atomic with concurrent editor writes.
// An unchanged source reuses its existing content-addressed revision.
func (r *Repo) FreezeCurrent(
	ctx context.Context,
	tenantID, campaignID, actorID string,
) (*Revision, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(campaignID); err != nil {
		return nil, fmt.Errorf("%w: invalid campaign_id", ErrInvalidInput)
	}
	var actor any
	if strings.TrimSpace(actorID) != "" {
		parsed, err := uuid.Parse(actorID)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid actor_id", ErrInvalidInput)
		}
		actor = parsed
	}

	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel: pgx.Serializable,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	locked, err := loadLockedRevisionSource(ctx, tx, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	source, sourceHash := locked.Source, locked.SourceHash

	var nextRevision int64
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(max(revision_no), 0) + 1
  FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid`, tenantID, campaignID).Scan(&nextRevision); err != nil {
		return nil, err
	}
	revision, err := scanRevision(tx.QueryRow(ctx, `
INSERT INTO campaign_content_revisions (
    tenant_id, campaign_id, revision_no, source_mode, content_schema_version,
    subject, preview_text, semantic_tree, legacy_html, reviewed_plain_text,
    fact_contract, variants, locales, source_hash, tracking_settings, created_by
)
VALUES (
    $1::uuid, $2::uuid, $3, $4, $5,
    $6, $7, $8::jsonb, $9, $10,
    $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::jsonb, $16
)
ON CONFLICT (tenant_id, campaign_id, source_hash) DO NOTHING
RETURNING `+revisionColumns,
		tenantID, campaignID, nextRevision, source.SourceMode,
		source.ContentSchemaVersion, source.Subject, source.PreviewText,
		[]byte(source.SemanticTree), source.LegacyHTML, source.ReviewedPlainText,
		[]byte(source.FactContract), []byte(source.Variants), []byte(source.Locales),
		sourceHash, []byte(source.TrackingSettings), actor,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		revision, err = scanRevision(tx.QueryRow(ctx, `
SELECT `+revisionColumns+`
  FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND source_hash = $3`, tenantID, campaignID, sourceHash))
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &revision, nil
}

func nullableString(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	copy := value.String
	return &copy
}

// ListRevisions returns immutable campaign revisions newest first. A campaign
// with no saved revision returns an empty slice; a campaign belonging to
// another tenant is indistinguishable from a missing campaign under RLS.
func (r *Repo) ListRevisions(
	ctx context.Context,
	tenantID, campaignID string,
	limit int,
) ([]RevisionSummary, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(campaignID); err != nil {
		return nil, fmt.Errorf("%w: invalid campaign_id", ErrInvalidInput)
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var campaignExists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM campaigns
     WHERE tenant_id = $1::uuid AND id = $2::uuid
)`, tenantID, campaignID).Scan(&campaignExists); err != nil {
		return nil, err
	}
	if !campaignExists {
		return nil, ErrNotFound
	}
	rows, err := tx.Query(ctx, `
SELECT `+revisionSummaryColumns+`
  FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
 ORDER BY revision_no DESC, id DESC
 LIMIT $3`, tenantID, campaignID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	revisions := make([]RevisionSummary, 0)
	for rows.Next() {
		revision, scanErr := scanRevisionSummary(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return revisions, nil
}

// GetRevision reads one immutable revision while proving that it belongs to
// both the requested campaign and tenant.
func (r *Repo) GetRevision(
	ctx context.Context,
	tenantID, campaignID, revisionID string,
) (*Revision, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(campaignID); err != nil {
		return nil, fmt.Errorf("%w: invalid campaign_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(revisionID); err != nil {
		return nil, fmt.Errorf("%w: invalid revision_id", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	revision, err := scanRevision(tx.QueryRow(ctx, `
SELECT `+revisionColumns+`
  FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND id = $3::uuid`, tenantID, campaignID, revisionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &revision, nil
}

type planRequestHashInput struct {
	CampaignID        string          `json:"campaign_id"`
	ContentRevisionID string          `json:"content_revision_id"`
	RendererVersion   string          `json:"renderer_version"`
	CompilerVersion   string          `json:"compiler_version"`
	TransformManifest json.RawMessage `json:"transform_manifest"`
	CoverageManifest  json.RawMessage `json:"coverage_manifest"`
	FixtureSetVersion string          `json:"fixture_set_version"`
	PolicyVersion     string          `json:"policy_version"`
}

const planColumns = `
id::text, tenant_id::text, campaign_id::text, content_revision_id::text,
plan_no, NULLIF(request_id::text, ''), request_hash, renderer_version,
compiler_version, transform_manifest, coverage_manifest, fixture_set_version,
policy_version, plan_hash, state, failure_code, NULLIF(created_by::text, ''),
created_at, ready_at, certified_at, stale_at, superseded_at, failed_at`

func scanPlan(row pgx.Row) (Plan, error) {
	var plan Plan
	if err := row.Scan(
		&plan.ID, &plan.TenantID, &plan.CampaignID,
		&plan.ContentRevisionID, &plan.PlanNo, &plan.RequestID,
		&plan.RequestHash, &plan.RendererVersion, &plan.CompilerVersion,
		&plan.TransformManifest, &plan.CoverageManifest,
		&plan.FixtureSetVersion, &plan.PolicyVersion, &plan.PlanHash,
		&plan.State, &plan.FailureCode, &plan.CreatedBy, &plan.CreatedAt,
		&plan.ReadyAt, &plan.CertifiedAt, &plan.StaleAt,
		&plan.SupersededAt, &plan.FailedAt,
	); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

// CreatePlan is idempotent by request ID plus a canonical request hash. Reusing
// an ID for different compiler/coverage input fails visibly.
func (r *Repo) CreatePlan(ctx context.Context, tenantID string, in PlanInput) (*Plan, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(in.CampaignID); err != nil {
		return nil, fmt.Errorf("%w: invalid campaign_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(in.ContentRevisionID); err != nil {
		return nil, fmt.Errorf("%w: invalid content_revision_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(in.RequestID); err != nil {
		return nil, fmt.Errorf("%w: invalid request_id", ErrInvalidInput)
	}
	if !validVersion(in.RendererVersion) || !validVersion(in.CompilerVersion) ||
		!validVersion(in.FixtureSetVersion) || !validVersion(in.PolicyVersion) {
		return nil, fmt.Errorf("%w: invalid plan version identity", ErrInvalidInput)
	}
	var err error
	in.TransformManifest, err = canonicalJSON(in.TransformManifest, "object")
	if err != nil {
		return nil, fmt.Errorf("transform_manifest: %w", err)
	}
	in.CoverageManifest, err = canonicalJSON(in.CoverageManifest, "object")
	if err != nil {
		return nil, fmt.Errorf("coverage_manifest: %w", err)
	}
	var actor any
	if strings.TrimSpace(in.CreatedBy) != "" {
		parsed, parseErr := uuid.Parse(in.CreatedBy)
		if parseErr != nil {
			return nil, fmt.Errorf("%w: invalid actor_id", ErrInvalidInput)
		}
		actor = parsed
	}
	requestHash, err := digestJSON(planRequestHashInput{
		CampaignID:        in.CampaignID,
		ContentRevisionID: in.ContentRevisionID,
		RendererVersion:   strings.TrimSpace(in.RendererVersion),
		CompilerVersion:   strings.TrimSpace(in.CompilerVersion),
		TransformManifest: in.TransformManifest,
		CoverageManifest:  in.CoverageManifest,
		FixtureSetVersion: strings.TrimSpace(in.FixtureSetVersion),
		PolicyVersion:     strings.TrimSpace(in.PolicyVersion),
	})
	if err != nil {
		return nil, err
	}

	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT 1
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, in.CampaignID); err != nil {
		return nil, err
	}
	if existing, existingErr := scanPlan(tx.QueryRow(ctx, `
SELECT `+planColumns+`
  FROM campaign_send_plans
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND request_id = $3::uuid`, tenantID, in.CampaignID, in.RequestID)); existingErr == nil {
		if existing.RequestHash != requestHash {
			return nil, ErrIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &existing, nil
	} else if !errors.Is(existingErr, pgx.ErrNoRows) {
		return nil, existingErr
	}

	var revisionExists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM campaign_content_revisions
     WHERE tenant_id = $1::uuid
       AND campaign_id = $2::uuid
       AND id = $3::uuid
)`, tenantID, in.CampaignID, in.ContentRevisionID).Scan(&revisionExists); err != nil {
		return nil, err
	}
	if !revisionExists {
		return nil, ErrNotFound
	}
	var planNo int64
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(max(plan_no), 0) + 1
  FROM campaign_send_plans
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid`, tenantID, in.CampaignID).Scan(&planNo); err != nil {
		return nil, err
	}
	plan, err := scanPlan(tx.QueryRow(ctx, `
INSERT INTO campaign_send_plans (
    tenant_id, campaign_id, content_revision_id, plan_no, request_id,
    request_hash, renderer_version, compiler_version, transform_manifest,
    coverage_manifest, fixture_set_version, policy_version, created_by
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
    $6, $7, $8, $9::jsonb,
    $10::jsonb, $11, $12, $13
)
RETURNING `+planColumns,
		tenantID, in.CampaignID, in.ContentRevisionID, planNo, in.RequestID,
		requestHash, strings.TrimSpace(in.RendererVersion),
		strings.TrimSpace(in.CompilerVersion), []byte(in.TransformManifest),
		[]byte(in.CoverageManifest), strings.TrimSpace(in.FixtureSetVersion),
		strings.TrimSpace(in.PolicyVersion), actor,
	))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &plan, nil
}

// FinalizePlan atomically inserts the complete scenario artifact set and moves
// a plan to ready. No caller can expose a partially populated ready plan.
func (r *Repo) FinalizePlan(
	ctx context.Context,
	tenantID, planID string,
	inputs []ArtifactInput,
) (*Plan, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(planID); err != nil {
		return nil, fmt.Errorf("%w: invalid plan_id", ErrInvalidInput)
	}
	normalized, err := normalizeArtifactInputs(inputs)
	if err != nil {
		return nil, err
	}

	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	plan, err := scanPlan(tx.QueryRow(ctx, `
SELECT `+planColumns+`
  FROM campaign_send_plans
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, planID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	planHash, err := computePlanHash(plan.RequestHash, normalized)
	if err != nil {
		return nil, err
	}
	if plan.State != PlanPreparing {
		if (plan.State == PlanReady || plan.State == PlanCertified) &&
			plan.PlanHash != nil && *plan.PlanHash == planHash {
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			return &plan, nil
		}
		return nil, ErrPlanNotPreparing
	}

	for _, artifact := range normalized {
		var variant any
		if artifact.VariantID != "" {
			parsed, parseErr := uuid.Parse(artifact.VariantID)
			if parseErr != nil {
				return nil, fmt.Errorf("%w: invalid variant_id", ErrInvalidInput)
			}
			variant = parsed
		}
		var structuredHash any
		if artifact.StructuredDataHash != "" {
			structuredHash = artifact.StructuredDataHash
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_render_artifacts (
    tenant_id, campaign_id, send_plan_id, scenario_id, variant_id, locale, branch_key,
    fixture_id, source_hash, html_hash, text_hash, structured_data_hash,
    mime_structure_hash, outbound_mime_hash, html_object_ref, text_object_ref,
    mime_object_ref, compiler_receipt, representation_manifest, expires_at
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
    $8, $9, $10, $11, $12,
    $13, $14, NULLIF($15, ''), NULLIF($16, ''),
    NULLIF($17, ''), $18::jsonb, $19::jsonb, $20
)`, tenantID, plan.CampaignID, planID, artifact.ScenarioID, variant,
			artifact.Locale, artifact.BranchKey, artifact.FixtureID,
			artifact.SourceHash, artifact.HTMLHash, artifact.TextHash,
			structuredHash, artifact.MIMEStructureHash, artifact.OutboundMIMEHash,
			artifact.HTMLObjectRef, artifact.TextObjectRef, artifact.MIMEObjectRef,
			[]byte(artifact.CompilerReceipt), []byte(artifact.RepresentationManifest), artifact.ExpiresAt,
		); err != nil {
			return nil, err
		}
	}
	plan, err = scanPlan(tx.QueryRow(ctx, `
UPDATE campaign_send_plans
   SET state = 'ready',
       plan_hash = $3,
       ready_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND state = 'preparing'
RETURNING `+planColumns, tenantID, planID, planHash))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &plan, nil
}

// Transition advances only lifecycle metadata. Database constraints and the
// trigger remain the final authority against invalid or terminal mutations.
func (r *Repo) Transition(
	ctx context.Context,
	tenantID, planID, target, failureCode string,
) (*Plan, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(planID); err != nil {
		return nil, fmt.Errorf("%w: invalid plan_id", ErrInvalidInput)
	}
	if target != PlanCertified && target != PlanStale &&
		target != PlanSuperseded && target != PlanFailed {
		return nil, ErrInvalidTransition
	}
	if target == PlanFailed {
		failureCode = strings.TrimSpace(failureCode)
		if !failureCodePattern.MatchString(failureCode) {
			return nil, fmt.Errorf("%w: failure_code must match [A-Z][A-Z0-9_]{0,95}", ErrInvalidInput)
		}
	} else if strings.TrimSpace(failureCode) != "" {
		return nil, fmt.Errorf("%w: failure_code is valid only for failed plans", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := scanPlan(tx.QueryRow(ctx, `
SELECT `+planColumns+`
  FROM campaign_send_plans
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
 FOR UPDATE`, tenantID, planID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// Lifecycle calls are retry-safe. Repeating the exact terminal decision
	// returns the frozen row; trying to relabel a failure is a conflicting
	// decision rather than a timestamp rewrite.
	if current.State == target {
		if target == PlanFailed && (current.FailureCode == nil || *current.FailureCode != failureCode) {
			return nil, ErrIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &current, nil
	}
	if !validPlanTransition(current.State, target) {
		return nil, ErrInvalidTransition
	}
	plan, err := scanPlan(tx.QueryRow(ctx, `
UPDATE campaign_send_plans
   SET state = $3,
       failure_code = CASE WHEN $3 = 'failed' THEN $4 ELSE NULL END,
       certified_at = CASE WHEN $3 = 'certified' THEN now() ELSE certified_at END,
       stale_at = CASE WHEN $3 = 'stale' THEN now() ELSE stale_at END,
       superseded_at = CASE WHEN $3 = 'superseded' THEN now() ELSE superseded_at END,
       failed_at = CASE WHEN $3 = 'failed' THEN now() ELSE failed_at END
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
RETURNING `+planColumns, tenantID, planID, target, failureCode))
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

func validPlanTransition(current, target string) bool {
	switch current {
	case PlanPreparing:
		return target == PlanFailed
	case PlanReady:
		return target == PlanCertified || target == PlanStale ||
			target == PlanSuperseded || target == PlanFailed
	case PlanCertified:
		return target == PlanStale || target == PlanSuperseded
	case PlanStale:
		return target == PlanSuperseded
	default:
		return false
	}
}
