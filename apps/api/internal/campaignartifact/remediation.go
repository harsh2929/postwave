// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const (
	typedPatchSchemaV1     = 1
	patchSetSemanticField  = "set_semantic_field"
	patchHeadingLevelField = "content.heading.level"
	maxCampaignETagBytes   = 512
	stalePlanFailureCode   = "SOURCE_REVISION_STALE"
)

type typedPatchV1 struct {
	SchemaVersion int    `json:"schema_version"`
	Operation     string `json:"operation"`
	NodeID        string `json:"node_id"`
	Field         string `json:"field,omitempty"`
	Value         string `json:"value,omitempty"`
}

type patchRequestIdentity struct {
	CampaignID   string `json:"campaign_id"`
	RunID        string `json:"run_id"`
	FindingID    string `json:"finding_id"`
	ActorID      string `json:"actor_id"`
	IfMatchToken string `json:"if_match_token"`
}

const patchApplicationColumns = `
id::text, campaign_id::text, run_id::text, attempt_count,
finding_id::text, request_id::text, request_hash, finding_receipt_hash,
typed_patch_hash, typed_patch_schema_version,
base_content_revision_id::text, created_content_revision_id::text,
actor_id::text, campaign_updated_at, created_at`

func scanPatchApplication(row pgx.Row) (PatchApplication, error) {
	var value PatchApplication
	err := row.Scan(
		&value.ID, &value.CampaignID, &value.RunID, &value.AttemptCount,
		&value.FindingID, &value.RequestID, &value.RequestHash,
		&value.FindingReceiptHash, &value.TypedPatchHash,
		&value.TypedPatchSchemaVersion, &value.BaseContentRevisionID,
		&value.CreatedContentRevisionID, &value.ActorID,
		&value.CampaignUpdatedAt, &value.CreatedAt,
	)
	return value, err
}

func normalizePatchApplicationInput(input ApplyAssuranceFindingInput) (ApplyAssuranceFindingInput, string, error) {
	identities := []*string{
		&input.CampaignID, &input.RunID, &input.FindingID,
		&input.RequestID, &input.ActorID,
	}
	for _, identity := range identities {
		parsed, err := uuid.Parse(strings.TrimSpace(*identity))
		if err != nil {
			return ApplyAssuranceFindingInput{}, "", ErrInvalidInput
		}
		*identity = parsed.String()
	}
	input.IfMatchToken = strings.TrimSpace(input.IfMatchToken)
	if !validStrongCampaignETag(input.IfMatchToken) {
		return ApplyAssuranceFindingInput{}, "", ErrInvalidInput
	}
	requestHash, err := digestJSON(patchRequestIdentity{
		CampaignID: input.CampaignID, RunID: input.RunID,
		FindingID: input.FindingID, ActorID: input.ActorID,
		IfMatchToken: input.IfMatchToken,
	})
	return input, requestHash, err
}

func validStrongCampaignETag(value string) bool {
	if len(value) < 3 || len(value) > maxCampaignETagBytes ||
		value == "*" || strings.HasPrefix(value, "W/") ||
		value[0] != '"' || value[len(value)-1] != '"' ||
		strings.Contains(value, ",") || !utf8.ValidString(value) {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

// applyTypedPatchV1 accepts only operations the deterministic analyzer emits
// and the server can prove safe. Version 1 currently has one such mutation: an
// exact heading level replacement on a named semantic node. It intentionally
// does not execute generic JSON Patch, URLs, HTML, or model-authored content.
func applyTypedPatchV1(
	rawTree json.RawMessage,
	schemaVersion int,
	rawPatch json.RawMessage,
) (json.RawMessage, error) {
	canonicalPatch, err := canonicalJSON(rawPatch, "object")
	if err != nil {
		return nil, fmt.Errorf("%w: invalid typed patch", ErrPatchUnsupported)
	}
	decoder := json.NewDecoder(bytes.NewReader(canonicalPatch))
	decoder.DisallowUnknownFields()
	var patch typedPatchV1
	if err := decoder.Decode(&patch); err != nil {
		return nil, fmt.Errorf("%w: invalid typed patch", ErrPatchUnsupported)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: typed patch has trailing data", ErrPatchUnsupported)
	}
	if patch.SchemaVersion != typedPatchSchemaV1 ||
		patch.Operation != patchSetSemanticField ||
		patch.Field != patchHeadingLevelField ||
		strings.TrimSpace(patch.NodeID) == "" {
		return nil, ErrPatchUnsupported
	}
	level, err := strconv.Atoi(patch.Value)
	if err != nil || level < 1 || level > 6 || strconv.Itoa(level) != patch.Value {
		return nil, ErrPatchUnsupported
	}

	normalized, _, err := NormalizeSemanticTreeV2(rawTree, schemaVersion)
	if err != nil {
		return nil, err
	}
	var nodes []semanticemail.Node
	if err := json.Unmarshal(normalized, &nodes); err != nil {
		return nil, fmt.Errorf("%w: semantic tree could not be decoded", ErrPatchUnsupported)
	}
	found := false
	for index := range nodes {
		if string(nodes[index].ID) != patch.NodeID {
			continue
		}
		if found || nodes[index].Type != semanticemail.NodeHeading ||
			nodes[index].Content.Heading == nil {
			return nil, ErrPatchUnsupported
		}
		if nodes[index].Content.Heading.Level == level {
			return nil, ErrPatchNoop
		}
		nodes[index].Content.Heading.Level = level
		found = true
	}
	if !found {
		return nil, ErrPatchUnsupported
	}
	encoded, err := json.Marshal(nodes)
	if err != nil {
		return nil, err
	}
	patched, _, err := NormalizeSemanticTreeV2(encoded, schemaVersion)
	return patched, err
}

func loadPatchApplicationReplay(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, requestID, requestHash string,
) (*ApplyAssuranceFindingResult, error) {
	application, err := scanPatchApplication(tx.QueryRow(ctx, `
SELECT `+patchApplicationColumns+`
  FROM campaign_assurance_patch_applications
 WHERE tenant_id = $1::uuid AND request_id = $2::uuid`, tenantID, requestID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if application.RequestHash != requestHash {
		return nil, ErrIdempotencyConflict
	}
	revision, err := scanRevision(tx.QueryRow(ctx, `
SELECT `+revisionColumns+`
  FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND id = $3::uuid`, tenantID, application.CampaignID,
		application.CreatedContentRevisionID))
	if err != nil {
		return nil, err
	}
	return &ApplyAssuranceFindingResult{
		Application: application, Revision: revision,
		CampaignETag: httpcache.ConcurrencyToken(
			"campaign", application.CampaignID, application.CampaignUpdatedAt,
		),
		OriginatingRunState: "stale", RerunRequired: true,
	}, nil
}

// ApplyAssuranceFinding applies one exact deterministic patch and freezes the
// resulting semantic source in a single tenant/user-scoped transaction. The
// finding, run evidence, old revision, and artifacts are never rewritten.
func (r *Repo) ApplyAssuranceFinding(
	ctx context.Context,
	tenantID string,
	rawInput ApplyAssuranceFindingInput,
) (_ *ApplyAssuranceFindingResult, resultErr error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	tenant, err := uuid.Parse(strings.TrimSpace(tenantID))
	if err != nil {
		return nil, ErrInvalidInput
	}
	tenantID = tenant.String()
	input, requestHash, err := normalizePatchApplicationInput(rawInput)
	if err != nil {
		return nil, err
	}

	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, mapPatchDatabaseError(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.user_id', $1, true)`, input.ActorID); err != nil {
		return nil, mapPatchDatabaseError(err)
	}

	if replay, err := loadPatchApplicationReplay(ctx, tx, tenantID, input.RequestID, requestHash); err != nil || replay != nil {
		return replay, err
	}

	locked, err := loadLockedRevisionSource(ctx, tx, tenantID, input.CampaignID)
	if err != nil {
		return nil, err
	}
	// A concurrent identical request can have committed while this transaction
	// waited on the campaign lock. Check replay again before evaluating the old
	// ETag, otherwise a safe retry would be misreported as stale.
	if replay, err := loadPatchApplicationReplay(ctx, tx, tenantID, input.RequestID, requestHash); err != nil || replay != nil {
		return replay, err
	}
	var findingAlreadyApplied bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM campaign_assurance_patch_applications
     WHERE tenant_id = $1::uuid AND finding_id = $2::uuid
)`, tenantID, input.FindingID).Scan(&findingAlreadyApplied); err != nil {
		return nil, err
	}
	if findingAlreadyApplied {
		return nil, ErrPatchAlreadyApplied
	}
	if input.IfMatchToken != httpcache.ConcurrencyToken("campaign", input.CampaignID, locked.UpdatedAt) {
		return nil, ErrPreconditionFailed
	}
	if locked.Dispatched {
		return nil, ErrCampaignDispatched
	}
	var activeLease bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM campaign_edit_leases
     WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
       AND expires_at > now() AND holder_id <> $3
)`, tenantID, input.CampaignID, input.ActorID).Scan(&activeLease); err != nil {
		return nil, err
	}
	if activeLease {
		return nil, ErrCampaignLocked
	}
	var actorCanEdit bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM users
     WHERE tenant_id = $1::uuid AND id = $2::uuid
       AND role IN ('owner', 'admin', 'editor')
)`, tenantID, input.ActorID).Scan(&actorCanEdit); err != nil {
		return nil, err
	}
	if !actorCanEdit {
		return nil, ErrUnauthorized
	}

	var (
		runState, baseRevisionID, sourceClass, findingReceiptHash string
		typedPatchHash                                            string
		runAttempt, findingAttempt                                int
		typedPatch                                                []byte
		patchSchema                                               pgtype.Int4
	)
	err = tx.QueryRow(ctx, `
SELECT runs.state,
       runs.content_revision_id::text,
       runs.attempt_count,
       findings.attempt_count,
       findings.source_class,
       findings.receipt_hash,
       findings.typed_patch,
       findings.typed_patch_schema_version,
       findings.typed_patch_hash
  FROM campaign_assurance_runs AS runs
  JOIN campaign_assurance_findings AS findings
    ON findings.tenant_id = runs.tenant_id
   AND findings.campaign_id = runs.campaign_id
   AND findings.run_id = runs.id
   AND findings.attempt_count = runs.attempt_count
   AND findings.id = $4::uuid
 WHERE runs.tenant_id = $1::uuid
   AND runs.campaign_id = $2::uuid
   AND runs.id = $3::uuid
 FOR UPDATE OF runs`, tenantID, input.CampaignID, input.RunID, input.FindingID).Scan(
		&runState, &baseRevisionID, &runAttempt, &findingAttempt,
		&sourceClass, &findingReceiptHash, &typedPatch, &patchSchema,
		&typedPatchHash,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if (runState != "complete" && runState != "incomplete") ||
		runAttempt < 1 || findingAttempt != runAttempt {
		return nil, ErrRunNotActionable
	}
	if sourceClass != "deterministic" || len(typedPatch) == 0 ||
		!patchSchema.Valid || int(patchSchema.Int32) != typedPatchSchemaV1 ||
		!validHash(typedPatchHash) {
		return nil, ErrPatchUnavailable
	}
	canonicalPatch, err := canonicalJSON(typedPatch, "object")
	if err != nil {
		return nil, ErrPatchUnsupported
	}
	computedPatchHash, err := digestJSON(json.RawMessage(canonicalPatch))
	if err != nil {
		return nil, err
	}
	if computedPatchHash != typedPatchHash {
		return nil, ErrPatchUnavailable
	}

	// The parent campaign row is already locked and revisions are append-only.
	// A row-locking SELECT here would additionally require UPDATE privilege on
	// the immutable revision table, which the production role intentionally does
	// not have.
	baseRevision, err := scanRevision(tx.QueryRow(ctx, `
SELECT `+revisionColumns+`
 FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND id = $3::uuid`, tenantID, input.CampaignID, baseRevisionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if locked.SourceHash != baseRevision.SourceHash {
		return nil, ErrRevisionStale
	}
	if locked.Source.SourceMode != SourceModeSemantic {
		return nil, ErrPatchUnsupported
	}
	patchedTree, err := applyTypedPatchV1(
		locked.Source.SemanticTree, locked.Source.ContentSchemaVersion, canonicalPatch,
	)
	if err != nil {
		return nil, err
	}
	newSource := locked.Source
	newSource.SemanticTree = patchedTree
	newSourceHash, err := digestJSON(newSource)
	if err != nil {
		return nil, err
	}
	if newSourceHash == baseRevision.SourceHash {
		return nil, ErrPatchNoop
	}

	var updatedAt time.Time
	err = tx.QueryRow(ctx, `
UPDATE campaigns
   SET content_blocks = $3::jsonb,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND updated_at = $4::timestamptz
   AND started_at IS NULL
   AND status NOT IN ('sending', 'sent')
RETURNING updated_at`, tenantID, input.CampaignID, []byte(patchedTree), locked.UpdatedAt).Scan(&updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPreconditionFailed
	}
	if err != nil {
		return nil, err
	}

	createdRevision, err := insertRevisionSourceTx(
		ctx, tx, tenantID, input.CampaignID, input.ActorID, newSource, newSourceHash,
	)
	if err != nil {
		return nil, err
	}
	if createdRevision.ID == baseRevision.ID {
		return nil, ErrPatchNoop
	}

	if _, err := tx.Exec(ctx, `
UPDATE campaign_send_plans
   SET state = 'stale', stale_at = now()
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND content_revision_id = $3::uuid
   AND state IN ('ready', 'certified')`, tenantID, input.CampaignID, baseRevision.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_send_plans
   SET state = 'failed', failure_code = $4, failed_at = now()
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND content_revision_id = $3::uuid
   AND state = 'preparing'`, tenantID, input.CampaignID, baseRevision.ID,
		stalePlanFailureCode); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_assurance_runs
   SET state = 'stale', claim_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, heartbeat_at = NULL, retry_not_before = NULL,
       completed_at = COALESCE(completed_at, now()), stale_at = now()
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND content_revision_id = $3::uuid
   AND state IN ('queued', 'running', 'complete', 'incomplete')`,
		tenantID, input.CampaignID, baseRevision.ID); err != nil {
		return nil, err
	}

	application, err := scanPatchApplication(tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_patch_applications (
    tenant_id, campaign_id, run_id, attempt_count, finding_id,
    request_id, request_hash, finding_receipt_hash, typed_patch_hash,
    typed_patch_schema_version, base_content_revision_id,
    created_content_revision_id, actor_id, campaign_updated_at
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
    $6::uuid, $7, $8, $9,
    $10, $11::uuid,
    $12::uuid, $13::uuid, $14::timestamptz
)
RETURNING `+patchApplicationColumns,
		tenantID, input.CampaignID, input.RunID, runAttempt, input.FindingID,
		input.RequestID, requestHash, findingReceiptHash, typedPatchHash,
		typedPatchSchemaV1, baseRevision.ID, createdRevision.ID, input.ActorID,
		updatedAt,
	))
	if err != nil {
		return nil, mapPatchDatabaseError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapPatchDatabaseError(err)
	}
	return &ApplyAssuranceFindingResult{
		Application: application, Revision: createdRevision,
		CampaignETag:        httpcache.ConcurrencyToken("campaign", input.CampaignID, updatedAt),
		OriginatingRunState: "stale", RerunRequired: true,
	}, nil
}

func insertRevisionSourceTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID, actorID string,
	source revisionSourceHashInput,
	sourceHash string,
) (Revision, error) {
	var nextRevision int64
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(max(revision_no), 0) + 1
  FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		tenantID, campaignID).Scan(&nextRevision); err != nil {
		return Revision{}, err
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
    $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::jsonb, $16::uuid
)
ON CONFLICT (tenant_id, campaign_id, source_hash) DO NOTHING
RETURNING `+revisionColumns,
		tenantID, campaignID, nextRevision, source.SourceMode,
		source.ContentSchemaVersion, source.Subject, source.PreviewText,
		[]byte(source.SemanticTree), source.LegacyHTML, source.ReviewedPlainText,
		[]byte(source.FactContract), []byte(source.Variants), []byte(source.Locales),
		sourceHash, []byte(source.TrackingSettings), actorID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		revision, err = scanRevision(tx.QueryRow(ctx, `
SELECT `+revisionColumns+`
  FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND source_hash = $3`, tenantID, campaignID, sourceHash))
	}
	return revision, err
}

func mapPatchDatabaseError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) {
		return err
	}
	switch postgresError.Code {
	case "40001", "40P01":
		return fmt.Errorf("%w: %v", ErrConcurrentMutation, err)
	case "23505":
		if strings.Contains(postgresError.ConstraintName, "request_id") {
			return fmt.Errorf("%w: %v", ErrIdempotencyConflict, err)
		}
		if strings.Contains(postgresError.ConstraintName, "finding_id") {
			return fmt.Errorf("%w: %v", ErrPatchAlreadyApplied, err)
		}
	}
	return err
}
