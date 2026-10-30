// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const maxLeaseTTL = 24 * time.Hour

const maxCreateAttempts = 4

type Repo struct{ Pool *db.Pool }

func NewRepo(pool *db.Pool) *Repo { return &Repo{Pool: pool} }

func (r *Repo) validate() error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	return nil
}

func scanRun(row pgx.Row) (Run, error) {
	var run Run
	var raw []byte
	if err := row.Scan(&run.TenantID, &run.ClaimToken, &raw); err != nil {
		return Run{}, err
	}
	if err := json.Unmarshal(raw, &run); err != nil {
		return Run{}, err
	}
	return run, nil
}

func scanArtifact(row pgx.Row) (RunArtifact, error) {
	var value RunArtifact
	var raw []byte
	if err := row.Scan(&value.TenantID, &raw); err != nil {
		return RunArtifact{}, err
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return RunArtifact{}, err
	}
	return value, nil
}

func scanConfiguration(row pgx.Row) (RunConfiguration, error) {
	var value RunConfiguration
	var raw []byte
	if err := row.Scan(&value.TenantID, &raw); err != nil {
		return RunConfiguration{}, err
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return RunConfiguration{}, err
	}
	return value, nil
}

func scanTarget(row pgx.Row) (RunTarget, error) {
	var value RunTarget
	var raw []byte
	if err := row.Scan(&value.TenantID, &raw); err != nil {
		return RunTarget{}, err
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return RunTarget{}, err
	}
	return value, nil
}

func scanExtraction(row pgx.Row) (Extraction, error) {
	var value Extraction
	var raw []byte
	if err := row.Scan(&value.TenantID, &value.ClaimToken, &raw); err != nil {
		return Extraction{}, err
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return Extraction{}, err
	}
	return value, nil
}

func scanFinding(row pgx.Row) (Finding, error) {
	var value Finding
	var raw []byte
	if err := row.Scan(&value.TenantID, &value.ClaimToken, &raw); err != nil {
		return Finding{}, err
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return Finding{}, err
	}
	return value, nil
}

func scanOverride(row pgx.Row) (Override, error) {
	var value Override
	var raw []byte
	if err := row.Scan(&value.TenantID, &raw); err != nil {
		return Override{}, err
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return Override{}, err
	}
	return value, nil
}

func runJSON(alias string) string {
	return alias + `.tenant_id::text,
NULLIF(` + alias + `.claim_token::text, ''),
(to_jsonb(` + alias + `) - ARRAY['tenant_id', 'claim_token'])`
}

func tenantJSON(alias string) string {
	return alias + `.tenant_id::text, (to_jsonb(` + alias + `) - 'tenant_id')`
}

func workerEvidenceJSON(alias string) string {
	return alias + `.tenant_id::text, ` + alias + `.claim_token::text,
(to_jsonb(` + alias + `) - ARRAY['tenant_id', 'claim_token'])`
}

func withWorkerTenant(ctx context.Context, pool *db.Pool, tenantID string) (pgx.Tx, error) {
	var err error
	tenantID, err = canonicalUUID(tenantID)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid tenant identity", ErrInvalidInput)
	}
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("campaign assurance: bind worker tenant: %w", err)
	}
	return tx, nil
}

func dbTenant(ctx context.Context, r *Repo, tenantID string) (pgx.Tx, error) {
	return db.WithTenant(ctx, r.Pool, tenantID)
}

func canonicalUUIDPair(first, second string) (string, string, bool) {
	var err error
	if first, err = canonicalUUID(first); err != nil {
		return "", "", false
	}
	if second, err = canonicalUUID(second); err != nil {
		return "", "", false
	}
	return first, second, true
}

func canonicalLeaseIdentity(tenantID, runID, claimToken string, attempt int, leaseTTL time.Duration) (string, string, string, bool) {
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok {
		return "", "", "", false
	}
	var err error
	claimToken, err = canonicalUUID(claimToken)
	if err != nil || attempt < 1 || leaseTTL < time.Millisecond || leaseTTL > maxLeaseTTL {
		return "", "", "", false
	}
	return tenantID, runID, claimToken, true
}

type frozenPlan struct {
	State             string
	SourceHash        string
	PlanHash          string
	RendererVersion   string
	CompilerVersion   string
	FixtureSetVersion string
	PlanPolicyVersion string
	CoverageManifest  json.RawMessage
	CoverageHash      string
}

type baseArtifact struct {
	ID                string
	ScenarioID        string
	OutboundMIMEHash  string
	MIMEStructureHash string
}

type createRequestIdentity struct {
	CampaignID               string               `json:"campaign_id"`
	ContentRevisionID        string               `json:"content_revision_id"`
	SendPlanID               string               `json:"send_plan_id"`
	TriggerKind              string               `json:"trigger_kind"`
	Profile                  string               `json:"profile"`
	SourceHash               string               `json:"source_hash"`
	PlanHash                 string               `json:"plan_hash"`
	CoverageHash             string               `json:"coverage_manifest_hash"`
	RendererVersion          string               `json:"renderer_version"`
	CompilerVersion          string               `json:"compiler_version"`
	FixtureSetVersion        string               `json:"fixture_set_version"`
	PlanPolicyVersion        string               `json:"plan_policy_version"`
	AnalyzerSuiteVersion     string               `json:"analyzer_suite_version"`
	ModelSuiteVersion        string               `json:"model_suite_version"`
	PromptSuiteVersion       string               `json:"prompt_suite_version"`
	PromptSuiteHash          string               `json:"prompt_suite_hash"`
	NormalizationVersion     string               `json:"normalization_version"`
	ScoringVersion           string               `json:"scoring_version"`
	GatePolicyVersion        string               `json:"gate_policy_version"`
	MethodologyVersion       string               `json:"methodology_version"`
	Configurations           []ConfigurationInput `json:"configurations"`
	Targets                  []TargetInput        `json:"targets"`
	Artifacts                []baseArtifact       `json:"artifacts"`
	MaxAttempts              int                  `json:"max_attempts"`
	MaxModeledCostMicrounits int64                `json:"max_modeled_cost_microunits"`
}

func loadFrozenPlanTx(ctx context.Context, tx pgx.Tx, tenantID string, input CreateRunInput) (frozenPlan, error) {
	var plan frozenPlan
	var planHash pgtype.Text
	var coverage []byte
	err := tx.QueryRow(ctx, `
SELECT plans.state,
       revisions.source_hash,
       plans.plan_hash,
       plans.renderer_version,
       plans.compiler_version,
       plans.fixture_set_version,
       plans.policy_version,
       plans.coverage_manifest
  FROM campaign_send_plans AS plans
  JOIN campaign_content_revisions AS revisions
    ON revisions.tenant_id = plans.tenant_id
   AND revisions.campaign_id = plans.campaign_id
   AND revisions.id = plans.content_revision_id
 WHERE plans.tenant_id = $1::uuid
   AND plans.campaign_id = $2::uuid
   AND plans.content_revision_id = $3::uuid
   AND plans.id = $4::uuid
	-- Content revisions are append-only, so locking that joined row adds no
	-- consistency. PostgreSQL also requires UPDATE privilege for a row-locking
	-- clause; the restricted application role intentionally has only
	-- SELECT/INSERT on immutable revisions. Lock the mutable plan only.
 FOR SHARE OF plans`, tenantID, input.CampaignID,
		input.ContentRevisionID, input.SendPlanID).Scan(
		&plan.State, &plan.SourceHash, &planHash, &plan.RendererVersion,
		&plan.CompilerVersion, &plan.FixtureSetVersion, &plan.PlanPolicyVersion,
		&coverage,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return frozenPlan{}, ErrNotFound
	}
	if err != nil {
		return frozenPlan{}, err
	}
	if (plan.State != "ready" && plan.State != "certified") || !planHash.Valid ||
		!hashPattern.MatchString(planHash.String) {
		return frozenPlan{}, ErrPlanNotReady
	}
	plan.PlanHash = planHash.String
	canonicalCoverage, err := canonicalJSON(coverage, "object", maxJSONReceiptSize)
	if err != nil {
		return frozenPlan{}, fmt.Errorf("coverage manifest: %w", err)
	}
	plan.CoverageManifest = canonicalCoverage
	plan.CoverageHash, err = digest(json.RawMessage(canonicalCoverage))
	return plan, err
}

func loadBaseArtifactsTx(ctx context.Context, tx pgx.Tx, tenantID string, input CreateRunInput) ([]baseArtifact, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, scenario_id, outbound_mime_hash, mime_structure_hash
  FROM campaign_render_artifacts
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND send_plan_id = $3::uuid
 ORDER BY scenario_id, id`, tenantID, input.CampaignID, input.SendPlanID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	artifacts := make([]baseArtifact, 0)
	for rows.Next() {
		var artifact baseArtifact
		if err := rows.Scan(&artifact.ID, &artifact.ScenarioID,
			&artifact.OutboundMIMEHash, &artifact.MIMEStructureHash); err != nil {
			return nil, err
		}
		artifacts = append(artifacts, artifact)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(artifacts) == 0 {
		return nil, ErrSnapshotIncomplete
	}
	return artifacts, nil
}

type resolvedTarget struct {
	Artifact          baseArtifact
	Configuration     ConfigurationInput
	ConfigurationHash string
}

func resolveTargets(input CreateRunInput, configurationHashes []string, artifacts []baseArtifact) ([]resolvedTarget, error) {
	artifactByID := make(map[string]baseArtifact, len(artifacts))
	for _, artifact := range artifacts {
		artifactByID[artifact.ID] = artifact
	}
	type configWithHash struct {
		input ConfigurationInput
		hash  string
	}
	configurationByID := make(map[string]configWithHash, len(input.Configurations))
	for index, configuration := range input.Configurations {
		configurationByID[configuration.ID] = configWithHash{configuration, configurationHashes[index]}
	}
	targetInputs := input.Targets
	if len(targetInputs) == 0 {
		targetInputs = make([]TargetInput, 0, len(artifacts)*len(input.Configurations))
		for _, artifact := range artifacts {
			for _, configuration := range input.Configurations {
				targetInputs = append(targetInputs, TargetInput{
					ArtifactID: artifact.ID, ConfigurationID: configuration.ID,
				})
			}
		}
	}
	if len(targetInputs) == 0 || len(targetInputs) > 100000 {
		return nil, ErrSnapshotIncomplete
	}
	resolved := make([]resolvedTarget, 0, len(targetInputs))
	seenArtifacts := make(map[string]bool, len(artifacts))
	seenConfigurations := make(map[string]bool, len(input.Configurations))
	for _, target := range targetInputs {
		artifact, artifactExists := artifactByID[target.ArtifactID]
		configuration, configurationExists := configurationByID[target.ConfigurationID]
		if !artifactExists || !configurationExists {
			return nil, fmt.Errorf("%w: target is outside frozen artifact/configuration manifests", ErrInvalidInput)
		}
		seenArtifacts[target.ArtifactID] = true
		seenConfigurations[target.ConfigurationID] = true
		resolved = append(resolved, resolvedTarget{
			Artifact: artifact, Configuration: configuration.input,
			ConfigurationHash: configuration.hash,
		})
	}
	if len(seenArtifacts) != len(artifacts) || len(seenConfigurations) != len(input.Configurations) {
		return nil, fmt.Errorf("%w: every frozen artifact and configuration needs a target", ErrSnapshotIncomplete)
	}
	return resolved, nil
}

func modeledRunCostCeiling(targets []resolvedTarget, maxAttempts int) (int64, error) {
	var perAttempt int64
	for _, target := range targets {
		if target.Configuration.SourceClass != SourceModeled {
			continue
		}
		var cost struct {
			MaximumCostMicrounits *int64 `json:"maximum_cost_microunits"`
		}
		if err := json.Unmarshal(target.Configuration.Configuration, &cost); err != nil {
			return 0, fmt.Errorf("%w: invalid modeled cost ceiling", ErrInvalidInput)
		}
		// A missing zero ceiling describes a frozen unavailable adapter. An
		// executable modeled configuration is validated again by its worker.
		if cost.MaximumCostMicrounits == nil || *cost.MaximumCostMicrounits == 0 {
			continue
		}
		if *cost.MaximumCostMicrounits < 0 ||
			*cost.MaximumCostMicrounits > MaximumModeledInvocationCostMicrounits ||
			perAttempt > math.MaxInt64-*cost.MaximumCostMicrounits {
			return 0, fmt.Errorf("%w: modeled cost ceiling is out of range", ErrInvalidInput)
		}
		perAttempt += *cost.MaximumCostMicrounits
	}
	if maxAttempts < 1 || (perAttempt != 0 && int64(maxAttempts) > math.MaxInt64/perAttempt) {
		return 0, fmt.Errorf("%w: aggregate modeled cost ceiling overflows", ErrInvalidInput)
	}
	return perAttempt * int64(maxAttempts), nil
}

func isConstraint(err error, name string) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505" &&
		postgresError.ConstraintName == name
}

func postgresError(err error) *pgconn.PgError {
	var value *pgconn.PgError
	if errors.As(err, &value) {
		return value
	}
	return nil
}

func retryableCreateError(err error) bool {
	value := postgresError(err)
	if value == nil {
		return false
	}
	return value.Code == "40001" || value.Code == "40P01" ||
		(value.Code == "23505" && value.ConstraintName == "campaign_assurance_runs_tenant_id_campaign_id_run_no_key")
}

func mapCreateError(err error) error {
	value := postgresError(err)
	if value == nil {
		return err
	}
	switch value.Code {
	case "23505":
		if value.ConstraintName == "campaign_assurance_runs_one_active_artifact_profile_uidx" {
			return ErrRunInFlight
		}
		if value.ConstraintName == "campaign_assurance_runs_tenant_id_campaign_id_request_id_key" {
			return ErrIdempotencyConflict
		}
		return fmt.Errorf("%w: uniqueness invariant %s", ErrInvalidInput, value.ConstraintName)
	case "23503":
		return fmt.Errorf("%w: frozen parent identity changed", ErrSnapshotIncomplete)
	case "23502", "23514", "22P02":
		return fmt.Errorf("%w: database input invariant %s", ErrInvalidInput, value.ConstraintName)
	case "55000":
		return fmt.Errorf("%w: database lifecycle rejected snapshot", ErrInvalidTransition)
	default:
		return err
	}
}

func mapInvariantError(err, domain error) error {
	value := postgresError(err)
	if value == nil {
		return err
	}
	switch value.Code {
	case "42501":
		return ErrUnauthorized
	case "23503", "23514", "55000":
		return fmt.Errorf("%w: durable database invariant rejected the command", domain)
	case "23505":
		return ErrIdempotencyConflict
	default:
		return err
	}
}

// CreateRun atomically snapshots exact artifacts, analyzer configurations, and
// the sparse required target matrix. The database computes canonical manifest
// hashes while freezing the snapshot; callers cannot supply them.
func (r *Repo) CreateRun(ctx context.Context, tenantID string, rawInput CreateRunInput) (*Run, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var err error
	tenantID, err = canonicalUUID(tenantID)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid tenant identity", ErrInvalidInput)
	}
	input, configurationHashes, _, err := normalizeCreateInput(rawInput)
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < maxCreateAttempts; attempt++ {
		run, createErr := r.createRunAttempt(ctx, tenantID, input, configurationHashes)
		if createErr == nil {
			return run, nil
		}
		if !retryableCreateError(createErr) {
			return nil, mapCreateError(createErr)
		}
		if attempt == maxCreateAttempts-1 {
			return nil, fmt.Errorf("%w: %v", ErrConcurrentMutation, createErr)
		}
		delay := time.Duration(1<<attempt) * time.Millisecond
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, ErrConcurrentMutation
}

func (r *Repo) createRunAttempt(ctx context.Context, tenantID string, input CreateRunInput, configurationHashes []string) (*Run, error) {
	// The campaign row lock below is the narrow serialization point for run_no,
	// request replay, and the active-run constraint. Database-wide serializable
	// predicate locks made unrelated tenants abort one another while providing
	// no additional same-campaign protection.
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var campaignExists bool
	if err := tx.QueryRow(ctx, `
SELECT true
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, input.CampaignID).Scan(&campaignExists); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	plan, err := loadFrozenPlanTx(ctx, tx, tenantID, input)
	if err != nil {
		return nil, err
	}
	artifacts, err := loadBaseArtifactsTx(ctx, tx, tenantID, input)
	if err != nil {
		return nil, err
	}
	targets, err := resolveTargets(input, configurationHashes, artifacts)
	if err != nil {
		return nil, err
	}
	maxModeledCostMicrounits, err := modeledRunCostCeiling(targets, input.MaxAttempts)
	if err != nil {
		return nil, err
	}

	requestArtifacts := append([]baseArtifact(nil), artifacts...)
	requestTargets := input.Targets
	if len(requestTargets) == 0 {
		requestTargets = make([]TargetInput, len(targets))
		for index, target := range targets {
			requestTargets[index] = TargetInput{
				ArtifactID: target.Artifact.ID, ConfigurationID: target.Configuration.ID,
			}
		}
	}
	requestHash, err := digest(createRequestIdentity{
		CampaignID: input.CampaignID, ContentRevisionID: input.ContentRevisionID,
		SendPlanID: input.SendPlanID, TriggerKind: input.TriggerKind, Profile: input.Profile,
		SourceHash: plan.SourceHash, PlanHash: plan.PlanHash, CoverageHash: plan.CoverageHash,
		RendererVersion: plan.RendererVersion, CompilerVersion: plan.CompilerVersion,
		FixtureSetVersion: plan.FixtureSetVersion, PlanPolicyVersion: plan.PlanPolicyVersion,
		AnalyzerSuiteVersion: input.AnalyzerSuiteVersion, ModelSuiteVersion: input.ModelSuiteVersion,
		PromptSuiteVersion: input.PromptSuiteVersion, PromptSuiteHash: input.PromptSuiteHash,
		NormalizationVersion: input.NormalizationVersion, ScoringVersion: input.ScoringVersion,
		GatePolicyVersion: input.GatePolicyVersion, MethodologyVersion: input.MethodologyVersion,
		Configurations: input.Configurations, Targets: requestTargets,
		Artifacts: requestArtifacts, MaxAttempts: input.MaxAttempts,
		MaxModeledCostMicrounits: maxModeledCostMicrounits,
	})
	if err != nil {
		return nil, err
	}
	var nextRunNo int64
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(max(run_no), 0) + 1
  FROM campaign_assurance_runs
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		tenantID, input.CampaignID).Scan(&nextRunNo); err != nil {
		return nil, err
	}
	run, err := scanRun(tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_runs (
    tenant_id, campaign_id, content_revision_id, send_plan_id, run_no,
    request_id, request_hash, trigger_kind, profile,
    source_hash, plan_hash, coverage_manifest_hash,
    renderer_version, compiler_version, fixture_set_version, plan_policy_version,
    analyzer_suite_version, model_suite_version, prompt_suite_version,
    prompt_suite_hash, normalization_version, scoring_version,
    gate_policy_version, methodology_version,
    required_scenario_count, required_configuration_count,
    required_extraction_count, max_attempts, max_modeled_cost_microunits, created_by
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
    $6::uuid, $7, $8, $9,
    $10, $11, $12,
    $13, $14, $15, $16,
    $17, $18, $19,
    $20, $21, $22,
    $23, $24,
    $25, $26, $27, $28, $29, NULLIF($30, '')::uuid
)
ON CONFLICT (tenant_id, campaign_id, request_id) DO NOTHING
RETURNING `+runJSON("campaign_assurance_runs"),
		tenantID, input.CampaignID, input.ContentRevisionID, input.SendPlanID,
		nextRunNo, input.RequestID, requestHash, input.TriggerKind, input.Profile,
		plan.SourceHash, plan.PlanHash, plan.CoverageHash,
		plan.RendererVersion, plan.CompilerVersion, plan.FixtureSetVersion,
		plan.PlanPolicyVersion, input.AnalyzerSuiteVersion, input.ModelSuiteVersion,
		input.PromptSuiteVersion, input.PromptSuiteHash, input.NormalizationVersion,
		input.ScoringVersion, input.GatePolicyVersion, input.MethodologyVersion,
		len(artifacts), len(input.Configurations), len(targets), input.MaxAttempts,
		maxModeledCostMicrounits,
		input.CreatedBy,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		run, err = scanRun(tx.QueryRow(ctx, `
SELECT `+runJSON("runs")+`
  FROM campaign_assurance_runs AS runs
 WHERE runs.tenant_id = $1::uuid
   AND runs.campaign_id = $2::uuid
   AND runs.request_id = $3::uuid`, tenantID, input.CampaignID, input.RequestID))
		if err != nil {
			return nil, err
		}
		if run.RequestHash != requestHash {
			return nil, ErrIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &run, nil
	}
	if err != nil {
		return nil, err
	}

	for index, artifact := range artifacts {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_assurance_run_artifacts (
    tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
    ordinal, scenario_id, outbound_mime_hash, mime_structure_hash
)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9)`,
			tenantID, input.CampaignID, run.ID, input.SendPlanID, artifact.ID,
			index+1, artifact.ScenarioID, artifact.OutboundMIMEHash,
			artifact.MIMEStructureHash); err != nil {
			return nil, err
		}
	}
	for index, configuration := range input.Configurations {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_assurance_run_configurations (
    tenant_id, campaign_id, run_id, ordinal, configuration_id,
    source_class, configuration_hash, configuration
)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb)`,
			tenantID, input.CampaignID, run.ID, index+1, configuration.ID,
			configuration.SourceClass, configurationHashes[index],
			string(configuration.Configuration)); err != nil {
			return nil, err
		}
	}
	for index, target := range targets {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_assurance_run_targets (
    tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
    configuration_id, ordinal, source_class, configuration_hash,
    outbound_mime_hash
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
    $6, $7, $8, $9, $10
)`, tenantID, input.CampaignID, run.ID, input.SendPlanID,
			target.Artifact.ID, target.Configuration.ID, index+1,
			target.Configuration.SourceClass, target.ConfigurationHash,
			target.Artifact.OutboundMIMEHash); err != nil {
			return nil, err
		}
	}

	run, err = scanRun(tx.QueryRow(ctx, `
UPDATE campaign_assurance_runs AS runs
   SET snapshot_frozen_at = now()
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND id = $3::uuid
   AND state = 'queued'
   AND snapshot_frozen_at IS NULL
RETURNING `+runJSON("runs"), tenantID, input.CampaignID, run.ID))
	if err != nil {
		if isConstraint(err, "campaign_assurance_runs_one_active_artifact_profile_uidx") {
			return nil, ErrRunInFlight
		}
		return nil, err
	}
	startedBy := ""
	if run.CreatedBy != nil {
		startedBy = *run.CreatedBy
	}
	if err := appendRunAuditEvent(ctx, tx, auditAssuranceStarted, run, startedBy, nil); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

func listArtifactsTx(ctx context.Context, tx pgx.Tx, tenantID, runID string) ([]RunArtifact, error) {
	rows, err := tx.Query(ctx, `
SELECT `+tenantJSON("artifacts")+`
  FROM campaign_assurance_run_artifacts AS artifacts
 WHERE artifacts.tenant_id = $1::uuid AND artifacts.run_id = $2::uuid
 ORDER BY artifacts.ordinal`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make([]RunArtifact, 0)
	for rows.Next() {
		value, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func listConfigurationsTx(ctx context.Context, tx pgx.Tx, tenantID, runID string) ([]RunConfiguration, error) {
	rows, err := tx.Query(ctx, `
SELECT `+tenantJSON("configurations")+`
  FROM campaign_assurance_run_configurations AS configurations
 WHERE configurations.tenant_id = $1::uuid AND configurations.run_id = $2::uuid
 ORDER BY configurations.ordinal`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make([]RunConfiguration, 0)
	for rows.Next() {
		value, err := scanConfiguration(rows)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func listTargetsTx(ctx context.Context, tx pgx.Tx, tenantID, runID string) ([]RunTarget, error) {
	rows, err := tx.Query(ctx, `
SELECT `+tenantJSON("targets")+`
  FROM campaign_assurance_run_targets AS targets
 WHERE targets.tenant_id = $1::uuid AND targets.run_id = $2::uuid
 ORDER BY targets.ordinal`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make([]RunTarget, 0)
	for rows.Next() {
		value, err := scanTarget(rows)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func loadClaimedManifestTx(ctx context.Context, tx pgx.Tx, run Run) (*ClaimedRun, error) {
	artifacts, err := listArtifactsTx(ctx, tx, run.TenantID, run.ID)
	if err != nil {
		return nil, err
	}
	configurations, err := listConfigurationsTx(ctx, tx, run.TenantID, run.ID)
	if err != nil {
		return nil, err
	}
	targets, err := listTargetsTx(ctx, tx, run.TenantID, run.ID)
	if err != nil {
		return nil, err
	}
	if len(artifacts) != run.RequiredScenarioCount ||
		len(configurations) != run.RequiredConfigurationCount ||
		len(targets) != run.RequiredExtractionCount {
		return nil, ErrSnapshotIncomplete
	}
	return &ClaimedRun{Run: run, Artifacts: artifacts, Configurations: configurations, Targets: targets}, nil
}

// ClaimRun leases one exact tenant/run command. It deliberately does not
// enumerate across tenants; workers receive tenant/run identity from durable
// command delivery and bind both tenant and worker scopes.
func (r *Repo) ClaimRun(ctx context.Context, tenantID, runID, workerID string, leaseTTL time.Duration) (*ClaimedRun, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	workerID = strings.TrimSpace(workerID)
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok || !validText(workerID, maxWorkerIDRunes) ||
		leaseTTL < time.Millisecond || leaseTTL > maxLeaseTTL {
		return nil, ErrInvalidLease
	}
	tx, err := withWorkerTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := scanRun(tx.QueryRow(ctx, `
UPDATE campaign_assurance_runs AS runs
   SET state = 'running',
       claim_token = gen_random_uuid(),
       lease_owner = $3,
       lease_expires_at = now() + ($4 * interval '1 millisecond'),
       heartbeat_at = now(),
       attempt_count = attempt_count + 1,
       retry_not_before = NULL,
       error_code = NULL,
       error_message = NULL,
       started_at = COALESCE(started_at, now())
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND state = 'queued'
   AND snapshot_frozen_at IS NOT NULL
   AND artifact_set_hash IS NOT NULL
   AND configuration_manifest_hash IS NOT NULL
   AND target_manifest_hash IS NOT NULL
   AND attempt_count < max_attempts
   AND (retry_not_before IS NULL OR retry_not_before <= now())
   AND required_scenario_count = (
       SELECT count(*)::integer FROM campaign_assurance_run_artifacts AS a
        WHERE a.tenant_id = runs.tenant_id AND a.run_id = runs.id
   )
   AND required_configuration_count = (
       SELECT count(*)::integer FROM campaign_assurance_run_configurations AS c
        WHERE c.tenant_id = runs.tenant_id AND c.run_id = runs.id
   )
   AND required_extraction_count = (
       SELECT count(*)::integer FROM campaign_assurance_run_targets AS t
        WHERE t.tenant_id = runs.tenant_id AND t.run_id = runs.id
   )
RETURNING `+runJSON("runs"), tenantID, runID, workerID, leaseTTL.Milliseconds()))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	claimed, err := loadClaimedManifestTx(ctx, tx, run)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return claimed, nil
}

func (r *Repo) RenewLease(ctx context.Context, tenantID, runID, claimToken string, attempt int, leaseTTL time.Duration) (*Run, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, leaseTTL)
	if !ok {
		return nil, ErrInvalidLease
	}
	tx, err := withWorkerTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := scanRun(tx.QueryRow(ctx, `
UPDATE campaign_assurance_runs AS runs
   SET heartbeat_at = now(),
       lease_expires_at = now() + ($5 * interval '1 millisecond')
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state = 'running' AND claim_token = $3::uuid
   AND attempt_count = $4 AND lease_expires_at > statement_timestamp()
RETURNING `+runJSON("runs"), tenantID, runID, claimToken, attempt, leaseTTL.Milliseconds()))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrLeaseLost
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

func lockActiveAttemptTx(ctx context.Context, tx pgx.Tx, tenantID, runID, claimToken string, attempt int, lock string) (Run, error) {
	if lock != "SHARE" && lock != "UPDATE" {
		return Run{}, ErrInvalidLease
	}
	run, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runJSON("runs")+`
  FROM campaign_assurance_runs AS runs
 WHERE runs.tenant_id = $1::uuid AND runs.id = $2::uuid
   AND runs.state = 'running' AND runs.claim_token = $3::uuid
   AND runs.attempt_count = $4
   AND runs.lease_expires_at > statement_timestamp()
 FOR `+lock, tenantID, runID, claimToken, attempt))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrLeaseLost
	}
	return run, err
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func insertExtractionTx(
	ctx context.Context,
	tx pgx.Tx,
	run Run,
	claimToken string,
	attempt int,
	input ExtractionInput,
	receiptHash string,
) (Extraction, error) {
	extraction, err := scanExtraction(tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_extractions (
    tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
    configuration_id, source_class, configuration_hash, outbound_mime_hash,
    attempt_count, claim_token, status, normalized_extraction,
    evidence_manifest, unsupported_claims, ambiguities,
    raw_output_object_ref, raw_output_hash, raw_output_expires_at,
    model_provider, model_id, model_version, prompt_version, prompt_hash,
    seed_value, temperature, input_tokens, output_tokens, cost_microunits,
    latency_ms, error_code, error_message, receipt_hash,
    model_cache_key, model_input_manifest_hash, model_invocation_id,
    execution_kind, reused_from_extraction_id, reused_from_receipt_hash,
    reused_original_cost_microunits
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
    $6, $7, $8, $9,
    $10, $11::uuid, $12, $13::jsonb,
    $14::jsonb, $15::jsonb, $16::jsonb,
    $17, $18, $19,
    $20, $21, $22, $23, $24,
    $25, $26, $27, $28, $29,
    $30, $31, $32, $33,
    $34, $35, $36, $37, NULLIF($38, '')::uuid, $39, $40
)
ON CONFLICT (
    tenant_id, run_id, attempt_count, artifact_id, configuration_id
) DO NOTHING
RETURNING `+workerEvidenceJSON("campaign_assurance_extractions"),
		run.TenantID, run.CampaignID, run.ID, run.SendPlanID, input.ArtifactID,
		input.ConfigurationID, input.SourceClass, input.ConfigurationHash,
		input.OutboundMIMEHash, attempt, claimToken, input.Status,
		nullJSON(input.NormalizedExtraction), string(input.EvidenceManifest),
		string(input.UnsupportedClaims), string(input.Ambiguities),
		nullString(input.RawOutputObjectRef), nullString(input.RawOutputHash),
		input.RawOutputExpiresAt, nullString(input.ModelProvider),
		nullString(input.ModelID), nullString(input.ModelVersion),
		nullString(input.PromptVersion), nullString(input.PromptHash),
		nullString(input.SeedValue), input.Temperature, input.InputTokens,
		input.OutputTokens, input.CostMicrounits, input.LatencyMS,
		nullString(input.ErrorCode), nullString(input.ErrorMessage), receiptHash,
		nullString(input.ModelCacheKey), nullString(input.ModelInputManifestHash),
		nullString(input.ModelInvocationID), nullString(input.ExecutionKind),
		input.ReusedFromExtractionID, nullString(input.ReusedFromReceiptHash),
		input.ReusedOriginalCostMicrounits,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		extraction, err = scanExtraction(tx.QueryRow(ctx, `
SELECT `+workerEvidenceJSON("extractions")+`
  FROM campaign_assurance_extractions AS extractions
 WHERE extractions.tenant_id = $1::uuid AND extractions.run_id = $2::uuid
   AND extractions.attempt_count = $3 AND extractions.artifact_id = $4::uuid
   AND extractions.configuration_id = $5`, run.TenantID, run.ID, attempt,
			input.ArtifactID, input.ConfigurationID))
		if err != nil {
			return Extraction{}, err
		}
		if extraction.ReceiptHash != receiptHash {
			return Extraction{}, ErrIdempotencyConflict
		}
	}
	if err != nil {
		return Extraction{}, mapInvariantError(err, ErrInvalidReceipt)
	}
	return extraction, nil
}

// RecordExtraction is first-write-wins for one exact target and worker
// attempt. A replay with a different receipt hash fails visibly.
func (r *Repo) RecordExtraction(ctx context.Context, tenantID, runID, claimToken string, attempt int, rawInput ExtractionInput) (*Extraction, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, time.Second)
	if !ok {
		return nil, ErrInvalidLease
	}
	input, receiptHash, err := normalizeExtractionInput(rawInput)
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
	extraction, err := insertExtractionTx(ctx, tx, run, claimToken, attempt, input, receiptHash)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &extraction, nil
}

func nullJSON(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	return string(value)
}
