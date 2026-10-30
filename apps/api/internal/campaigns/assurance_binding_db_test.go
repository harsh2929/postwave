// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func buildPassingQueueAssurance(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, campaignID string,
) campaignassurancegate.Receipt {
	t.Helper()
	artifacts := campaignartifact.NewRepo(pool)
	revision, err := artifacts.FreezeCurrent(ctx, tenantID, campaignID, "")
	if err != nil {
		t.Fatalf("freeze queue revision: %v", err)
	}
	plan, err := artifacts.CreatePlan(ctx, tenantID, campaignartifact.PlanInput{
		CampaignID: campaignID, ContentRevisionID: revision.ID, RequestID: uuid.NewString(),
		RendererVersion: "queue-binding-renderer-v1", CompilerVersion: "queue-binding-compiler-v1",
		TransformManifest: json.RawMessage(`{}`),
		CoverageManifest:  json.RawMessage(`{"scenarios":["base"]}`),
		FixtureSetVersion: "queue-binding-fixtures-v1", PolicyVersion: "queue-binding-policy-v1",
	})
	if err != nil {
		t.Fatalf("create queue plan: %v", err)
	}
	plan, err = artifacts.FinalizePlan(ctx, tenantID, plan.ID, []campaignartifact.ArtifactInput{{
		ScenarioID: "base", Locale: "en-US", BranchKey: "default", FixtureID: "synthetic-base",
		SourceHash: revision.SourceHash, HTMLHash: strings.Repeat("1", 64),
		TextHash: strings.Repeat("2", 64), MIMEStructureHash: strings.Repeat("3", 64),
		OutboundMIMEHash: strings.Repeat("4", 64), CompilerReceipt: json.RawMessage(`{}`),
		RepresentationManifest: json.RawMessage(`{}`),
	}})
	if err != nil || plan.PlanHash == nil {
		t.Fatalf("finalize queue plan: plan=%+v err=%v", plan, err)
	}
	artifactRows, err := artifacts.ListArtifacts(ctx, tenantID, campaignID, plan.ID)
	if err != nil || len(artifactRows) != 1 {
		t.Fatalf("list queue artifacts: count=%d err=%v", len(artifactRows), err)
	}
	assuranceRepo := campaignassurance.NewRepo(pool)
	run, err := assuranceRepo.CreateRun(ctx, tenantID, campaignassurance.CreateRunInput{
		CampaignID: campaignID, ContentRevisionID: revision.ID, SendPlanID: plan.ID,
		RequestID: uuid.NewString(), TriggerKind: campaignassurance.TriggerQueue,
		Profile: campaignassurance.ProfileFast, AnalyzerSuiteVersion: "queue-binding-suite-v1",
		ModelSuiteVersion: "none-v1", PromptSuiteVersion: "none-v1",
		PromptSuiteHash: strings.Repeat("5", 64), NormalizationVersion: "queue-binding-normalization-v1",
		ScoringVersion: "queue-binding-score-v1", GatePolicyVersion: "queue-binding-gate-v1",
		MethodologyVersion: "queue-binding-methodology-v1",
		Configurations: []campaignassurance.ConfigurationInput{{
			ID: "deterministic.queue-binding", SourceClass: campaignassurance.SourceDeterministic,
			Configuration: json.RawMessage(`{"checks":["mime"]}`),
		}},
	})
	if err != nil {
		t.Fatalf("create queue assurance run: %v", err)
	}
	claim, err := assuranceRepo.ClaimRun(ctx, tenantID, run.ID, "queue-binding-worker", time.Minute)
	if err != nil || claim.Run.ClaimToken == nil || len(claim.Targets) != 1 {
		t.Fatalf("claim queue assurance: %+v err=%v", claim, err)
	}
	target := claim.Targets[0]
	if _, err := assuranceRepo.RecordExtraction(ctx, tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, campaignassurance.ExtractionInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
			OutboundMIMEHash: target.OutboundMIMEHash, Status: campaignassurance.ExtractionComplete,
			NormalizedExtraction: json.RawMessage(`{"summary":"Queue binding proof"}`),
			EvidenceManifest:     json.RawMessage(`{"representations":["mime"]}`),
			UnsupportedClaims:    json.RawMessage(`[]`), Ambiguities: json.RawMessage(`[]`),
		}); err != nil {
		t.Fatalf("record queue assurance extraction: %v", err)
	}
	if _, err = assuranceRepo.FinalizeRun(ctx, tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount,
		campaignassurance.FinalizeInput{GateDecision: campaignassurance.GatePass}); err != nil {
		t.Fatalf("finalize queue assurance: %v", err)
	}
	receipt, err := (&campaignassurancegate.Gate{Store: assuranceRepo}).Authorize(ctx,
		campaignassurancegate.Request{TenantID: tenantID, CampaignID: campaignID,
			ContentRevisionID: revision.ID, SourceHash: revision.SourceHash})
	if err != nil {
		t.Fatalf("authorize queue assurance: %v", err)
	}
	return receipt
}

func TestQueuePersistsExactAssuranceBindingAndRejectsRetryDrift_DB(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// setupTenantQ registers the tenant teardown, bound to the tenant. This test
	// also used to delete the tenant on the bare pool, which under the tenants
	// RLS policy matched nothing; it was a dead statement, so it is gone.
	tenantID := setupTenantQ(t, pool, ctx, "queue-assurance-binding")
	campaignID := insertQueueableCampaignQ(t, pool, ctx, tenantID, "queue assurance binding")
	receipt := buildPassingQueueAssurance(t, ctx, pool, tenantID, campaignID)
	repo := &Repo{Pool: pool}
	email := "assurance-bound@example.test"
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{{email: email, status: "enabled"}})
	queued, err := repo.QueueAndStartCampaign(ctx, tenantID, campaignID, "email",
		[]string{email}, nil, &receipt, nil)
	if err != nil || queued != 1 {
		t.Fatalf("queue exact binding: queued=%d err=%v", queued, err)
	}
	var runID, planID, decision, sourceHash string
	var attempt int
	readTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin persisted queue binding read: %v", err)
	}
	defer func() { _ = readTx.Rollback(ctx) }()
	if err := readTx.QueryRow(ctx, `
SELECT assurance_run_id::text, send_plan_id::text, assurance_attempt_count,
       assurance_gate_decision, assurance_source_hash
  FROM campaign_recipients
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND lower(subscriber_email) = lower($3)`, tenantID, campaignID, email).Scan(
		&runID, &planID, &attempt, &decision, &sourceHash,
	); err != nil {
		t.Fatalf("read persisted queue binding: %v", err)
	}
	if err := readTx.Commit(ctx); err != nil {
		t.Fatalf("commit persisted queue binding read: %v", err)
	}
	if runID != receipt.RunID || planID != receipt.SendPlanID ||
		attempt != receipt.RunAttempt || decision != receipt.Decision || sourceHash != receipt.SourceHash {
		t.Fatalf("persisted binding run=%s plan=%s attempt=%d decision=%s source=%s; receipt=%+v",
			runID, planID, attempt, decision, sourceHash, receipt)
	}
	drifted := receipt
	drifted.PlanHash = strings.Repeat("f", 64)
	if _, err := repo.QueueAndStartCampaign(ctx, tenantID, campaignID, "email",
		[]string{email}, nil, &drifted, nil); err == nil {
		t.Fatal("requeue accepted a different assurance binding for the same recipient")
	}
}
