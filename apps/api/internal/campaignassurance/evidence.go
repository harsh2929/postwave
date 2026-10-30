// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// RecordFinding persists one stable, immutable finding under the exact target
// and fenced attempt. FindingKey deduplicates semantic identity; ReceiptHash
// additionally proves explanation/remediation bytes.
func (r *Repo) RecordFinding(ctx context.Context, tenantID, runID, claimToken string, attempt int, rawInput FindingInput) (*Finding, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, time.Second)
	if !ok {
		return nil, ErrInvalidLease
	}
	input, findingKey, err := normalizeFindingInput(rawInput)
	if err != nil {
		return nil, err
	}
	tx, err := withWorkerTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := lockActiveAttemptTx(ctx, tx, tenantID, runID, claimToken, attempt, "SHARE")
	if err != nil {
		return nil, err
	}
	var sourceClass, configurationHash, outboundMIMEHash string
	if err := tx.QueryRow(ctx, `
SELECT source_class, configuration_hash, outbound_mime_hash
  FROM campaign_assurance_run_targets
 WHERE tenant_id = $1::uuid AND run_id = $2::uuid
   AND artifact_id = $3::uuid AND configuration_id = $4`,
		tenantID, runID, input.ArtifactID, input.ConfigurationID).Scan(
		&sourceClass, &configurationHash, &outboundMIMEHash,
	); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidReceipt
	} else if err != nil {
		return nil, err
	}
	if sourceClass != input.SourceClass {
		return nil, fmt.Errorf("%w: finding source differs from frozen configuration", ErrInvalidReceipt)
	}
	receiptHash, typedPatchHash, err := findingReceiptHash(
		input, findingKey, configurationHash, outboundMIMEHash,
	)
	if err != nil {
		return nil, err
	}
	finding, err := scanFinding(tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_findings (
    tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
    configuration_id, source_class, configuration_hash, outbound_mime_hash,
    attempt_count, claim_token, extraction_id, finding_key, receipt_hash,
    code, severity, blocking, overridable, dimension,
    block_references, evidence_references, expected_value, observed_value,
    explanation, remediation, typed_patch, typed_patch_schema_version,
    typed_patch_hash, detector_version, policy_version
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
    $6, $7, $8, $9,
    $10, $11::uuid, NULLIF($12, '')::uuid, $13, $14,
    $15, $16, $17, $18, $19,
    $20::jsonb, $21::jsonb, $22::jsonb, $23::jsonb,
    $24, $25::jsonb, $26::jsonb, $27,
    $28, $29, $30
)
ON CONFLICT (tenant_id, run_id, attempt_count, finding_key) DO NOTHING
RETURNING `+workerEvidenceJSON("campaign_assurance_findings"),
		tenantID, run.CampaignID, runID, run.SendPlanID, input.ArtifactID,
		input.ConfigurationID, sourceClass, configurationHash, outboundMIMEHash,
		attempt, claimToken, input.ExtractionID, findingKey, receiptHash,
		input.Code, input.Severity, input.Blocking, input.Overridable,
		input.Dimension, string(input.BlockReferences), string(input.EvidenceReferences),
		nullJSON(input.ExpectedValue), nullJSON(input.ObservedValue),
		input.Explanation, string(input.Remediation), nullJSON(input.TypedPatch),
		input.TypedPatchSchemaVersion, nullString(typedPatchHash),
		input.DetectorVersion, input.PolicyVersion,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		finding, err = scanFinding(tx.QueryRow(ctx, `
SELECT `+workerEvidenceJSON("findings")+`
  FROM campaign_assurance_findings AS findings
 WHERE findings.tenant_id = $1::uuid AND findings.run_id = $2::uuid
   AND findings.attempt_count = $3 AND findings.finding_key = $4`,
			tenantID, runID, attempt, findingKey))
		if err != nil {
			return nil, err
		}
		if finding.ReceiptHash != receiptHash {
			return nil, ErrIdempotencyConflict
		}
	}
	if err != nil {
		return nil, mapInvariantError(err, ErrInvalidReceipt)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &finding, nil
}

func (r *Repo) ListExtractions(ctx context.Context, tenantID, runID string) ([]Extraction, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok {
		return nil, ErrInvalidInput
	}
	tx, err := dbTenant(ctx, r, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+workerEvidenceJSON("extractions")+`
  FROM campaign_assurance_extractions AS extractions
 WHERE extractions.tenant_id = $1::uuid AND extractions.run_id = $2::uuid
 ORDER BY extractions.attempt_count, extractions.created_at, extractions.id`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make([]Extraction, 0)
	for rows.Next() {
		value, err := scanExtraction(rows)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return values, nil
}

func (r *Repo) ListFindings(ctx context.Context, tenantID, runID string) ([]Finding, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok {
		return nil, ErrInvalidInput
	}
	tx, err := dbTenant(ctx, r, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+workerEvidenceJSON("findings")+`
  FROM campaign_assurance_findings AS findings
 WHERE findings.tenant_id = $1::uuid AND findings.run_id = $2::uuid
 ORDER BY findings.attempt_count, findings.created_at, findings.id`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make([]Finding, 0)
	for rows.Next() {
		value, err := scanFinding(rows)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return values, nil
}
