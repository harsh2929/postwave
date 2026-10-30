// SPDX-License-Identifier: AGPL-3.0-only

package presend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
)

type assuranceEvaluatorProbe struct {
	mu         sync.Mutex
	request    campaignassurancegate.Request
	evaluation campaignassurancegate.Evaluation
	err        error
	wait       bool
	calls      int
}

func (p *assuranceEvaluatorProbe) Evaluate(ctx context.Context, request campaignassurancegate.Request) (campaignassurancegate.Evaluation, error) {
	p.mu.Lock()
	p.calls++
	p.request = request
	p.mu.Unlock()
	if p.wait {
		<-ctx.Done()
		return campaignassurancegate.Evaluation{
			PolicyVersion: campaignassurancegate.PolicyVersion,
			TenantID:      request.TenantID, CampaignID: request.CampaignID,
			ContentRevisionID: request.ContentRevisionID, SourceHash: request.SourceHash,
			Status:      campaignassurancegate.StatusError,
			ReasonCode:  campaignassurancegate.ReasonDependencyError,
			RefreshedAt: time.Now().UTC(),
		}, ctx.Err()
	}
	return p.evaluation, p.err
}

func (p *assuranceEvaluatorProbe) snapshot() (campaignassurancegate.Request, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.request, p.calls
}

func TestHandleConsumesExactCampaignAssuranceStatusInsideUnifiedVerdict(t *testing.T) {
	tenantID, campaignID, revisionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	input := assuranceInput(campaignID, revisionID)
	probe := &assuranceEvaluatorProbe{evaluation: validAssuranceEvaluation(tenantID, input, campaignassurancegate.StatusWarn)}
	deps := readyAssuranceDeps(t, probe)

	recorder, response := executeHandler(t, deps, input, tenantID, "attacker-tenant")
	if recorder.Code != http.StatusOK || response.Verdict != VerdictWarn || !response.Complete {
		t.Fatalf("response=%+v status=%d", response, recorder.Code)
	}
	if response.CampaignAssurance == nil || response.CampaignAssurance.Status != campaignassurancegate.StatusWarn ||
		response.CampaignAssurance.RunID != probe.evaluation.RunID || response.Components[3].Name != "campaign_assurance" ||
		response.Components[3].Status != "warn" {
		t.Fatalf("campaign assurance response=%+v component=%+v", response.CampaignAssurance, response.Components[3])
	}
	request, calls := probe.snapshot()
	if calls != 1 || request.TenantID != tenantID || request.CampaignID != campaignID ||
		request.ContentRevisionID != revisionID || request.SourceHash != input["source_hash"] {
		t.Fatalf("request=%+v calls=%d", request, calls)
	}
}

func TestHandleKeepsDeterministicBlockCriticalAndExposesExactOverrideState(t *testing.T) {
	tenantID, campaignID, revisionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	input := assuranceInput(campaignID, revisionID)
	blocked := validAssuranceEvaluation(tenantID, input, campaignassurancegate.StatusCritical)
	blocked.Authorized = false
	blocked.GateDecision = "block"
	blocked.ReasonCode = campaignassurancegate.ReasonDeterministicBlock
	probe := &assuranceEvaluatorProbe{evaluation: blocked, err: campaignassurancegate.ErrBlocked}

	_, response := executeHandler(t, readyAssuranceDeps(t, probe), input, tenantID, "")
	if response.Verdict != VerdictCritical || !response.Complete || response.CampaignAssurance == nil ||
		response.CampaignAssurance.Authorized || response.Components[3].Status != "critical" {
		t.Fatalf("blocked response=%+v", response)
	}

	overrideID := uuid.NewString()
	overridden := blocked
	overridden.Authorized = true
	overridden.GateDecision = "overridden"
	overridden.ReasonCode = campaignassurancegate.ReasonAuthorizedOverride
	overridden.OverrideIDs = []string{overrideID}
	probe = &assuranceEvaluatorProbe{evaluation: overridden}
	_, response = executeHandler(t, readyAssuranceDeps(t, probe), input, tenantID, "")
	if response.CampaignAssurance == nil || !response.CampaignAssurance.Authorized ||
		len(response.CampaignAssurance.OverrideIDs) != 1 || response.CampaignAssurance.OverrideIDs[0] != overrideID ||
		!strings.Contains(response.Components[3].Message, "override receipts") {
		t.Fatalf("overridden response=%+v", response)
	}
}

func TestHandleCampaignAssuranceTimeoutIsBoundedAndNeverGreen(t *testing.T) {
	tenantID, campaignID, revisionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	input := assuranceInput(campaignID, revisionID)
	probe := &assuranceEvaluatorProbe{wait: true}
	deps := readyAssuranceDeps(t, probe)
	deps.CampaignAssuranceTimeout = 20 * time.Millisecond

	started := time.Now()
	_, response := executeHandler(t, deps, input, tenantID, "")
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("bounded cached read took %s", elapsed)
	}
	if response.Verdict != VerdictIncomplete || response.Complete || response.CampaignAssurance == nil ||
		response.CampaignAssurance.Status != campaignassurancegate.StatusError || response.Components[3].Status != "error" {
		t.Fatalf("timeout response=%+v", response)
	}
}

func TestHandleRejectsPartialOrCrossTenantAssuranceIdentityWithoutFallback(t *testing.T) {
	tenantID, campaignID, revisionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	input := assuranceInput(campaignID, revisionID)
	delete(input, "source_hash")
	probe := &assuranceEvaluatorProbe{}
	_, response := executeHandler(t, readyAssuranceDeps(t, probe), input, tenantID, "")
	if _, calls := probe.snapshot(); calls != 0 || response.Verdict != VerdictIncomplete ||
		response.CampaignAssurance == nil || response.CampaignAssurance.ReasonCode != campaignassurancegate.ReasonIntegrityMismatch {
		t.Fatalf("partial response=%+v calls=%d", response, calls)
	}

	input = assuranceInput(campaignID, revisionID)
	evaluation := validAssuranceEvaluation(uuid.NewString(), input, campaignassurancegate.StatusOK)
	probe = &assuranceEvaluatorProbe{evaluation: evaluation}
	_, response = executeHandler(t, readyAssuranceDeps(t, probe), input, tenantID, "")
	if response.Verdict != VerdictIncomplete || response.Complete || response.CampaignAssurance == nil ||
		response.CampaignAssurance.Status != campaignassurancegate.StatusError ||
		response.CampaignAssurance.ReasonCode != campaignassurancegate.ReasonIntegrityMismatch {
		t.Fatalf("cross-tenant response=%+v", response)
	}
}

func TestHandleCampaignOnlyIdentityReportsNotAssuredWithoutEvaluatorFallback(t *testing.T) {
	tenantID, campaignID := uuid.NewString(), uuid.NewString()
	input := goodInput()
	input["campaign_id"] = campaignID
	probe := &assuranceEvaluatorProbe{}

	_, response := executeHandler(t, readyAssuranceDeps(t, probe), input, tenantID, "")
	if _, calls := probe.snapshot(); calls != 0 || response.Verdict != VerdictIncomplete ||
		response.Complete || response.CampaignAssurance == nil ||
		response.CampaignAssurance.Status != campaignassurancegate.StatusUnavailable ||
		response.CampaignAssurance.ReasonCode != campaignassurancegate.ReasonNotAssured ||
		len(response.Components) != 4 || response.Components[3].Name != "campaign_assurance" {
		t.Fatalf("campaign-only response=%+v calls=%d", response, calls)
	}
}

func assuranceInput(campaignID, revisionID string) map[string]any {
	input := goodInput()
	input["campaign_id"] = campaignID
	input["content_revision_id"] = revisionID
	input["source_hash"] = strings.Repeat("a", 64)
	return input
}

func validAssuranceEvaluation(tenantID string, input map[string]any, status campaignassurancegate.Status) campaignassurancegate.Evaluation {
	score, minimum, maximum := 81.0, 76.0, 86.0
	return campaignassurancegate.Evaluation{
		PolicyVersion: campaignassurancegate.PolicyVersion, TenantID: tenantID,
		CampaignID: input["campaign_id"].(string), ContentRevisionID: input["content_revision_id"].(string),
		SourceHash: input["source_hash"].(string), RunID: uuid.NewString(), SendPlanID: uuid.NewString(),
		PlanHash: strings.Repeat("b", 64), ArtifactSetHash: strings.Repeat("c", 64),
		CoverageManifestHash: strings.Repeat("d", 64), Status: status,
		ReasonCode: campaignassurancegate.ReasonAuthorizedWarn, GateDecision: "warn", Authorized: true,
		RunAttempt: 1, PredictedScore: &score, PredictedScoreMin: &minimum, PredictedScoreMax: &maximum,
		SourceCoverage: campaignassurancegate.SourceCoverage{
			Required: 3, Successful: 3, Ratio: 1, DeterministicConfigs: 1, ModeledConfigs: 2,
		},
		RefreshedAt: time.Now().UTC(),
	}
}

func readyAssuranceDeps(t *testing.T, evaluator campaignassurancegate.Evaluator) *Deps {
	t.Helper()
	voice := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"score":90,"severity":"ok"}`))
	}))
	predictor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"predicted":{"primary":0.9}}`))
	}))
	t.Cleanup(voice.Close)
	t.Cleanup(predictor.Close)
	return completeDeps(&Deps{
		VoiceServiceURL: voice.URL, PredictorServiceURL: predictor.URL,
		HTTPClient: voice.Client(), CampaignAssurance: evaluator,
	})
}

var _ campaignassurancegate.Evaluator = (*assuranceEvaluatorProbe)(nil)
