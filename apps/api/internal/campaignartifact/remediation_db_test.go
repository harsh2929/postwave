// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
)

func patchTestSQLState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

func TestApplyAssuranceFindingCreatesImmutableRevision_DB(t *testing.T) {
	adminDatabaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_TEST_DATABASE_URL"))
	appDatabaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL"))
	if adminDatabaseURL == "" || appDatabaseURL == "" {
		t.Skip("POSTWAVE_ASSURANCE_TEST_DATABASE_URL and POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL are required for remediation DB proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	// Fixture setup and cleanup intentionally require the admin role. Keep that
	// pool outside db.New so the production runtime-role guard remains enabled
	// for appPool below and this proof cannot pass with a privileged app DSN.
	pool, err := pgxpool.New(ctx, adminDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	appPool, err := db.New(ctx, appDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(appPool.Close)
	var schemaReady bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_assurance_patch_applications') IS NOT NULL`).Scan(&schemaReady); err != nil {
		t.Fatal(err)
	}
	if !schemaReady {
		t.Fatal("configured database does not have migration 1929")
	}

	tenantID, campaignID := uuid.NewString(), uuid.NewString()
	actorID, foreignTenantID := uuid.NewString(), uuid.NewString()
	suffix := strings.ReplaceAll(tenantID, "-", "")[:14]
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, tenantID, foreignTenantID)
	})
	semanticTree := headingPatchTree(t)
	if _, err := pool.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Assurance remediation DB', 'studio'),
       ($3::uuid, $4, 'Foreign remediation DB', 'studio')`,
		tenantID, "assurance-patch-"+suffix, foreignTenantID, "assurance-patch-foreign-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, $4, 'editor')`, actorID, tenantID,
		"assurance-patch-"+suffix, "patch-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO campaigns (
    id, tenant_id, name, subject, status, body_html, plain_text,
    content_blocks, source_mode, content_schema_version, fact_contract
)
VALUES (
    $1::uuid, $2::uuid, 'Patch proof', 'Launch', 'draft',
    '<h1>Launch</h1><h3>Details</h3>', 'Launch\n\nDetails',
    $3::jsonb, 'semantic', 2, '{}'::jsonb
)`, campaignID, tenantID, []byte(semanticTree)); err != nil {
		t.Fatal(err)
	}

	artifacts := NewRepo(pool)
	baseRevision, err := artifacts.FreezeCurrent(ctx, tenantID, campaignID, actorID)
	if err != nil {
		t.Fatalf("freeze base revision: %v", err)
	}
	plan, err := artifacts.CreatePlan(ctx, tenantID, PlanInput{
		CampaignID: campaignID, ContentRevisionID: baseRevision.ID,
		RequestID: uuid.NewString(), RendererVersion: "renderer-v1",
		CompilerVersion: "compiler-v1", TransformManifest: json.RawMessage(`{}`),
		CoverageManifest:  json.RawMessage(`{"scenarios":["base"]}`),
		FixtureSetVersion: "fixtures-v1", PolicyVersion: "policy-v1",
		CreatedBy: actorID,
	})
	if err != nil {
		t.Fatalf("create plan: %v", err)
	}
	plan, err = artifacts.FinalizePlan(ctx, tenantID, plan.ID, []ArtifactInput{{
		ScenarioID: "base", Locale: "en-IN", BranchKey: "default", FixtureID: "base",
		SourceHash: baseRevision.SourceHash,
		HTMLHash:   strings.Repeat("1", 64), TextHash: strings.Repeat("2", 64),
		MIMEStructureHash: strings.Repeat("3", 64), OutboundMIMEHash: strings.Repeat("4", 64),
		CompilerReceipt: json.RawMessage(`{}`), RepresentationManifest: json.RawMessage(`{}`),
	}})
	if err != nil || plan.State != PlanReady {
		t.Fatalf("finalize plan=%+v err=%v", plan, err)
	}
	artifactRows, err := artifacts.ListArtifacts(ctx, tenantID, campaignID, plan.ID)
	if err != nil || len(artifactRows) != 1 {
		t.Fatalf("artifacts=%+v err=%v", artifactRows, err)
	}

	assurance := campaignassurance.NewRepo(pool)
	run, err := assurance.CreateRun(ctx, tenantID, campaignassurance.CreateRunInput{
		CampaignID: campaignID, ContentRevisionID: baseRevision.ID,
		SendPlanID: plan.ID, RequestID: uuid.NewString(),
		TriggerKind: campaignassurance.TriggerExplicit, Profile: campaignassurance.ProfileFast,
		AnalyzerSuiteVersion: "analyzers-v1", ModelSuiteVersion: "models-v1",
		PromptSuiteVersion: "prompts-v1", PromptSuiteHash: strings.Repeat("5", 64),
		NormalizationVersion: "normalization-v1", ScoringVersion: "score-v1",
		GatePolicyVersion: "gate-v1", MethodologyVersion: "method-v1",
		Configurations: []campaignassurance.ConfigurationInput{{
			ID: "deterministic.preflight", SourceClass: campaignassurance.SourceDeterministic,
			Configuration: json.RawMessage(`{"checks":"all"}`),
		}},
		Targets: []campaignassurance.TargetInput{{
			ArtifactID: artifactRows[0].ID, ConfigurationID: "deterministic.preflight",
		}},
		CreatedBy: actorID,
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	claim, err := assurance.ClaimRun(ctx, tenantID, run.ID, "patch-db-worker", time.Minute)
	if err != nil || len(claim.Targets) != 1 || claim.Run.ClaimToken == nil {
		t.Fatalf("claim=%+v err=%v", claim, err)
	}
	target := claim.Targets[0]
	extraction, err := assurance.RecordExtraction(ctx, tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, campaignassurance.ExtractionInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
			OutboundMIMEHash:     target.OutboundMIMEHash,
			Status:               campaignassurance.ExtractionComplete,
			NormalizedExtraction: json.RawMessage(`{"summary":"Launch details"}`),
			EvidenceManifest:     json.RawMessage(`{"nodes":["details"]}`),
			UnsupportedClaims:    json.RawMessage(`[]`), Ambiguities: json.RawMessage(`[]`),
		})
	if err != nil {
		t.Fatalf("record extraction: %v", err)
	}
	patchVersion := 1
	finding, err := assurance.RecordFinding(ctx, tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, campaignassurance.FindingInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			ExtractionID: extraction.ID, Code: "HEADING_LEVEL_SKIPPED",
			SourceClass: campaignassurance.SourceDeterministic, Severity: "warning",
			Dimension: "accessibility", BlockReferences: json.RawMessage(`[{"node_id":"details"}]`),
			EvidenceReferences:      json.RawMessage(`[{"representation":"visible_html"}]`),
			Explanation:             "The visible heading hierarchy skips a level.",
			Remediation:             json.RawMessage(`{"kind":"fix_heading_hierarchy","node_id":"details","field":"content.heading.level"}`),
			TypedPatch:              json.RawMessage(`{"schema_version":1,"operation":"set_semantic_field","node_id":"details","field":"content.heading.level","value":"2"}`),
			TypedPatchSchemaVersion: &patchVersion,
			DetectorVersion:         "detector-v1", PolicyVersion: "gate-v1",
		})
	if err != nil {
		t.Fatalf("record finding: %v", err)
	}
	run, err = assurance.FinalizeRun(ctx, tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount,
		campaignassurance.FinalizeInput{GateDecision: campaignassurance.GateWarn})
	if err != nil || run.State != campaignassurance.StateComplete {
		t.Fatalf("finalize run=%+v err=%v", run, err)
	}

	var updatedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT updated_at FROM campaigns WHERE id = $1::uuid`, campaignID).Scan(&updatedAt); err != nil {
		t.Fatal(err)
	}
	requestID := uuid.NewString()
	input := ApplyAssuranceFindingInput{
		CampaignID: campaignID, RunID: run.ID, FindingID: finding.ID,
		RequestID: requestID, ActorID: actorID,
		IfMatchToken: httpcache.ConcurrencyToken("campaign", campaignID, updatedAt),
	}
	// The HTTP runtime uses postwave_app, not the migration/database owner.
	// Keep fixture construction on the admin connection but execute every
	// governed application/replay through the restricted production role so
	// grants and RLS are part of this proof rather than silently bypassed.
	applicationArtifacts := NewRepo(appPool)
	applied, err := applicationArtifacts.ApplyAssuranceFinding(ctx, tenantID, input)
	if err != nil {
		t.Fatalf("apply finding: %v", err)
	}
	if applied.Revision.ID == baseRevision.ID ||
		applied.Application.BaseContentRevisionID != baseRevision.ID ||
		applied.Application.CreatedContentRevisionID != applied.Revision.ID ||
		!applied.RerunRequired || applied.OriginatingRunState != campaignassurance.StateStale {
		t.Fatalf("invalid apply receipt: %+v", applied)
	}
	var headingLevel int
	if err := pool.QueryRow(ctx, `
SELECT (node->'content'->'heading'->>'level')::integer
  FROM campaigns, jsonb_array_elements(content_blocks) AS node
 WHERE campaigns.id = $1::uuid AND node->>'id' = 'details'`, campaignID).Scan(&headingLevel); err != nil {
		t.Fatal(err)
	}
	if headingLevel != 2 {
		t.Fatalf("patched heading level=%d", headingLevel)
	}
	var runState, planState string
	if err := pool.QueryRow(ctx, `SELECT state FROM campaign_assurance_runs WHERE id = $1::uuid`, run.ID).Scan(&runState); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM campaign_send_plans WHERE id = $1::uuid`, plan.ID).Scan(&planState); err != nil {
		t.Fatal(err)
	}
	if runState != campaignassurance.StateStale || planState != PlanStale {
		t.Fatalf("run=%s plan=%s, want stale/stale", runState, planState)
	}

	replayed, err := applicationArtifacts.ApplyAssuranceFinding(ctx, tenantID, input)
	if err != nil || replayed.Application.ID != applied.Application.ID || replayed.Revision.ID != applied.Revision.ID {
		t.Fatalf("replay=%+v err=%v", replayed, err)
	}
	if _, err := pool.Exec(ctx, `
UPDATE campaigns SET name = 'Patch proof renamed', updated_at = clock_timestamp()
 WHERE id = $1::uuid`, campaignID); err != nil {
		t.Fatal(err)
	}
	replayedAfterLaterEdit, err := applicationArtifacts.ApplyAssuranceFinding(ctx, tenantID, input)
	if err != nil || replayedAfterLaterEdit.CampaignETag != applied.CampaignETag {
		t.Fatalf("durable replay after edit=%+v err=%v; original etag=%q", replayedAfterLaterEdit, err, applied.CampaignETag)
	}
	if err := pool.QueryRow(ctx, `SELECT updated_at FROM campaigns WHERE id = $1::uuid`, campaignID).Scan(&updatedAt); err != nil {
		t.Fatal(err)
	}
	duplicate := input
	duplicate.RequestID = uuid.NewString()
	duplicate.IfMatchToken = httpcache.ConcurrencyToken("campaign", campaignID, updatedAt)
	if _, err := applicationArtifacts.ApplyAssuranceFinding(ctx, tenantID, duplicate); !errors.Is(err, ErrPatchAlreadyApplied) {
		t.Fatalf("duplicate finding error=%v, want ErrPatchAlreadyApplied", err)
	}
	if _, err := applicationArtifacts.ApplyAssuranceFinding(ctx, foreignTenantID, input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant apply error=%v, want ErrNotFound", err)
	}

	_, err = pool.Exec(ctx, `
UPDATE campaign_assurance_patch_applications SET request_hash = repeat('f', 64)
 WHERE id = $1::uuid`, applied.Application.ID)
	if patchTestSQLState(err) != "55000" {
		t.Fatalf("rewrite application error=%v state=%q", err, patchTestSQLState(err))
	}
}
