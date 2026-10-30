// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/mail"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/campaignplanbuilder"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const (
	testTenantID   = "00000000-0000-4000-8000-000000000001"
	testCampaignID = "00000000-0000-4000-8000-000000000002"
	testRevisionID = "00000000-0000-4000-8000-000000000003"
	testPlanID     = "00000000-0000-4000-8000-000000000004"
	testArtifactID = "00000000-0000-4000-8000-000000000005"
	testRunID      = "00000000-0000-4000-8000-000000000006"
	testClaimToken = "00000000-0000-4000-8000-000000000007"
)

type assuranceFake struct {
	mu                  sync.Mutex
	claimed             campaignassurance.ClaimedRun
	extractions         []campaignassurance.ExtractionInput
	findings            []campaignassurance.FindingInput
	renewals            int
	retries             int
	failures            int
	finalizeInput       campaignassurance.FinalizeInput
	claimErr            error
	renewErr            error
	retryErr            error
	recordExtractionErr error
	cacheCandidate      *campaignassurance.ReusableModeledExtraction
	cacheLookupErr      error
	cacheReuseErr       error
	reservationErr      error
	invocationResultErr error
	reservations        []campaignassurance.ModeledInvocationReservationInput
	invocationResults   []campaignassurance.ModeledInvocationResultInput
	stateAfterLoss      string
}

func (f *assuranceFake) ClaimRun(_ context.Context, _, _, _ string, _ time.Duration) (*campaignassurance.ClaimedRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	copy := f.claimed
	return &copy, nil
}

func (f *assuranceFake) RenewLease(_ context.Context, _, _, _ string, _ int, _ time.Duration) (*campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renewals++
	if f.renewErr != nil {
		return nil, f.renewErr
	}
	run := f.claimed.Run
	return &run, nil
}

func (f *assuranceFake) RecordExtraction(_ context.Context, _, _, _ string, _ int, input campaignassurance.ExtractionInput) (*campaignassurance.Extraction, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.recordExtractionErr != nil {
		return nil, f.recordExtractionErr
	}
	f.extractions = append(f.extractions, input)
	return &campaignassurance.Extraction{ID: uuid.NewString(), ExtractionInput: input}, nil
}

func (f *assuranceFake) FindReusableModeledExtraction(_ context.Context, _, _, _ string, _ int, _ campaignassurance.ModeledCacheLookupInput) (*campaignassurance.ReusableModeledExtraction, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cacheLookupErr != nil {
		return nil, f.cacheLookupErr
	}
	if f.cacheCandidate == nil {
		return nil, nil
	}
	copy := *f.cacheCandidate
	return &copy, nil
}

func (f *assuranceFake) RecordModeledCacheReuse(_ context.Context, _, _, _ string, _ int, input campaignassurance.ModeledCacheReuseInput) (*campaignassurance.Extraction, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cacheReuseErr != nil {
		return nil, f.cacheReuseErr
	}
	f.extractions = append(f.extractions, input.Extraction)
	return &campaignassurance.Extraction{ID: uuid.NewString(), ExtractionInput: input.Extraction}, nil
}

func (f *assuranceFake) ReserveModeledInvocation(_ context.Context, _, _, claimToken string, attempt int, input campaignassurance.ModeledInvocationReservationInput) (*campaignassurance.ModeledInvocationReservation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reservationErr != nil {
		return nil, f.reservationErr
	}
	f.reservations = append(f.reservations, input)
	return &campaignassurance.ModeledInvocationReservation{
		RunID: f.claimed.Run.ID, AttemptCount: attempt, ClaimToken: claimToken,
		ModeledInvocationReservationInput: input,
	}, nil
}

func (f *assuranceFake) RecordModeledInvocationResult(_ context.Context, _, _, claimToken string, attempt int, input campaignassurance.ModeledInvocationResultInput) (*campaignassurance.ModeledInvocationResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.invocationResultErr != nil {
		return nil, f.invocationResultErr
	}
	f.invocationResults = append(f.invocationResults, input)
	return &campaignassurance.ModeledInvocationResult{
		RunID: f.claimed.Run.ID, AttemptCount: attempt, ClaimToken: claimToken,
		ModeledInvocationResultInput: input,
	}, nil
}

func (f *assuranceFake) RecordFinding(_ context.Context, _, _, _ string, _ int, input campaignassurance.FindingInput) (*campaignassurance.Finding, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.findings = append(f.findings, input)
	return &campaignassurance.Finding{ID: uuid.NewString(), FindingInput: input}, nil
}

func (f *assuranceFake) FinalizeRun(_ context.Context, _, _, _ string, _ int, input campaignassurance.FinalizeInput) (*campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finalizeInput = input
	run := f.claimed.Run
	run.ClaimToken = nil
	run.GateDecision = input.GateDecision
	run.State = campaignassurance.StateComplete
	for _, extraction := range f.extractions {
		if extraction.Status != campaignassurance.ExtractionComplete {
			run.State = campaignassurance.StateIncomplete
			run.GateDecision = campaignassurance.GateUnavailable
			break
		}
	}
	f.claimed.Run = run
	return &run, nil
}

func (f *assuranceFake) RetryRun(_ context.Context, _, _, _ string, _ int, notBefore time.Time, _ campaignassurance.RunFailure) (*campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.retries++
	if f.retryErr != nil {
		if errors.Is(f.retryErr, campaignassurance.ErrLeaseLost) && f.stateAfterLoss != "" {
			f.claimed.Run.State = f.stateAfterLoss
			f.claimed.Run.ClaimToken = nil
		}
		return nil, f.retryErr
	}
	run := f.claimed.Run
	if run.AttemptCount >= run.MaxAttempts {
		run.State = campaignassurance.StateFailed
	} else {
		run.State = campaignassurance.StateQueued
		run.RetryNotBefore = &notBefore
	}
	run.ClaimToken = nil
	f.claimed.Run = run
	return &run, nil
}

func (f *assuranceFake) FailRun(_ context.Context, _, _, _ string, _ int, _ campaignassurance.RunFailure) (*campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failures++
	run := f.claimed.Run
	run.State = campaignassurance.StateFailed
	run.ClaimToken = nil
	f.claimed.Run = run
	return &run, nil
}

func (f *assuranceFake) GetRun(_ context.Context, _, _ string) (*campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	run := f.claimed.Run
	return &run, nil
}

type artifactFake struct {
	plan          campaignartifact.Plan
	revision      campaignartifact.Revision
	artifact      campaignartifact.Artifact
	planCalls     int
	revisionCalls int
	artifactCalls int
}

func (f *artifactFake) GetRevision(context.Context, string, string, string) (*campaignartifact.Revision, error) {
	f.revisionCalls++
	value := f.revision
	return &value, nil
}

func (f *artifactFake) GetPlan(context.Context, string, string, string) (*campaignartifact.Plan, error) {
	f.planCalls++
	value := f.plan
	return &value, nil
}

func (f *artifactFake) GetArtifact(context.Context, string, string, string, string) (*campaignartifact.Artifact, error) {
	f.artifactCalls++
	value := f.artifact
	return &value, nil
}

type objectValue struct {
	body        []byte
	contentType string
}

type objectFake struct {
	mu      sync.Mutex
	objects map[string]objectValue
	calls   int
	hook    func(context.Context, string) error
}

func (*objectFake) CampaignAssuranceRawOutputStore() {}

func (f *objectFake) Get(ctx context.Context, _ string, rest string) (io.ReadCloser, string, error) {
	f.mu.Lock()
	f.calls++
	hook := f.hook
	value, ok := f.objects[rest]
	f.mu.Unlock()
	if hook != nil {
		if err := hook(ctx, rest); err != nil {
			return nil, "", err
		}
	}
	if !ok {
		return nil, "", errors.New("object temporarily unavailable")
	}
	return io.NopCloser(bytes.NewReader(value.body)), value.contentType, nil
}

func (f *objectFake) Put(_ context.Context, tenantID, rest, contentType string, body io.Reader) (string, error) {
	value, err := io.ReadAll(body)
	if err != nil {
		return "", err
	}
	f.mu.Lock()
	f.objects[rest] = objectValue{body: value, contentType: contentType}
	f.mu.Unlock()
	return "tenants/" + tenantID + "/" + rest, nil
}

func (f *objectFake) Delete(_ context.Context, _ string, rest string) error {
	f.mu.Lock()
	delete(f.objects, rest)
	f.mu.Unlock()
	return nil
}

type fixture struct {
	worker    *Worker
	assurance *assuranceFake
	artifacts *artifactFake
	objects   *objectFake
	compiled  campaigncompiler.Result
}

func TestWorkerExecutesExactDeterministicArtifact(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceDeterministic)
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeComplete || result.Run == nil || result.Run.GateDecision == campaignassurance.GateUnavailable {
		t.Fatalf("result = %+v", result)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if len(fixture.assurance.extractions) != 1 || fixture.assurance.extractions[0].Status != campaignassurance.ExtractionComplete {
		t.Fatalf("extractions = %+v", fixture.assurance.extractions)
	}
	if fixture.assurance.extractions[0].ModelProvider != "" ||
		!bytes.Contains(fixture.assurance.extractions[0].NormalizedExtraction, []byte(`"comprehension_status":"not_measured"`)) {
		t.Fatalf("deterministic receipt overclaimed comprehension/model use: %+v", fixture.assurance.extractions[0])
	}
	if len(fixture.assurance.findings) == 0 || fixture.objects.calls != 3 {
		t.Fatalf("findings=%d object calls=%d", len(fixture.assurance.findings), fixture.objects.calls)
	}
}

func TestWorkerPersistsModeledUnavailableWithoutReadingArtifact(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeIncomplete || result.Run.GateDecision != campaignassurance.GateUnavailable {
		t.Fatalf("result = %+v", result)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if len(fixture.assurance.extractions) != 1 || fixture.assurance.extractions[0].Status != campaignassurance.ExtractionUnavailable ||
		fixture.assurance.extractions[0].ModelProvider != "not_invoked" || fixture.assurance.extractions[0].ModelID != "not_invoked" {
		t.Fatalf("modeled unavailable receipt = %+v", fixture.assurance.extractions)
	}
	if fixture.objects.calls != 0 || fixture.artifacts.artifactCalls != 0 || fixture.artifacts.planCalls != 0 {
		t.Fatalf("unsupported modeled target performed artifact I/O: object=%d artifact=%d plan=%d",
			fixture.objects.calls, fixture.artifacts.artifactCalls, fixture.artifacts.planCalls)
	}
}

func TestWorkerPersistsTamperedObjectAsBlockingUnavailable(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceDeterministic)
	rest, err := campaignmaterializer.ParseObjectReference(fixture.artifacts.artifact.HTMLObjectRef)
	if err != nil {
		t.Fatal(err)
	}
	value := fixture.objects.objects[rest]
	value.body = append(value.body, []byte("tampered")...)
	fixture.objects.objects[rest] = value
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeIncomplete || result.BlockerCount != 1 {
		t.Fatalf("result = %+v", result)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if len(fixture.assurance.extractions) != 1 || fixture.assurance.extractions[0].ErrorCode != "artifact_integrity_failed" ||
		len(fixture.assurance.findings) != 1 || fixture.assurance.findings[0].Code != "ARTIFACT_INTEGRITY_UNAVAILABLE" ||
		!fixture.assurance.findings[0].Blocking || fixture.assurance.findings[0].Overridable {
		t.Fatalf("tamper evidence extraction=%+v findings=%+v", fixture.assurance.extractions, fixture.assurance.findings)
	}
}

func TestWorkerRenewsLeaseAndRequeuesTransientObjectFailure(t *testing.T) {
	fixture := newFixture(t, campaignassurance.SourceDeterministic)
	fixture.worker.Config.LeaseTTL = 80 * time.Millisecond
	fixture.worker.Config.HeartbeatEvery = 10 * time.Millisecond
	fixture.worker.Config.RetryBackoff = func(int) time.Duration { return time.Second }
	fixture.objects.hook = func(ctx context.Context, _ string) error {
		timer := time.NewTimer(35 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return errors.New("transient internal object failure")
		}
	}
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeRequeued || result.RetryAt == nil {
		t.Fatalf("result = %+v", result)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if fixture.assurance.renewals < 2 || fixture.assurance.retries != 1 || len(fixture.assurance.extractions) != 0 {
		t.Fatalf("renewals=%d retries=%d extractions=%d", fixture.assurance.renewals, fixture.assurance.retries, len(fixture.assurance.extractions))
	}
}

func TestWorkerCancellationObservesConcurrentRunCancellation(t *testing.T) {
	fixture := newFixture(t, campaignassurance.SourceDeterministic)
	fixture.worker.Config.LeaseTTL = 100 * time.Millisecond
	fixture.worker.Config.HeartbeatEvery = 10 * time.Millisecond
	fixture.assurance.retryErr = campaignassurance.ErrLeaseLost
	fixture.assurance.stateAfterLoss = campaignassurance.StateCancelled
	ctx, cancel := context.WithCancel(context.Background())
	fixture.objects.hook = func(ctx context.Context, _ string) error {
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}
	result, err := fixture.worker.Process(ctx, Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeCancelled {
		t.Fatalf("result = %+v", result)
	}
}

func TestWorkerFailsCorruptClaimBeforeArtifactAccess(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceDeterministic)
	fixture.assurance.claimed.Targets[0].ConfigurationHash = strings.Repeat("0", 64)
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeFailed || fixture.assurance.failures != 1 || fixture.objects.calls != 0 {
		t.Fatalf("result=%+v failures=%d object calls=%d", result, fixture.assurance.failures, fixture.objects.calls)
	}
}

func TestWorkerRejectsRealRecipientBeforeAnalysis(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceDeterministic)
	rest, err := campaignmaterializer.ParseObjectReference(fixture.artifacts.artifact.MIMEObjectRef)
	if err != nil {
		t.Fatal(err)
	}
	value := fixture.objects.objects[rest]
	value.body = bytes.Replace(value.body, []byte("fixture@example.test"), []byte("person@customer.io"), 1)
	valueHash := digestBytes(value.body)
	delete(fixture.objects.objects, rest)
	objectBase := "campaign-assurance/plans/" + testPlanID + "/artifacts/" + digestBytes([]byte(fixture.artifacts.artifact.ScenarioID)) + "/"
	rest = objectBase + valueHash + ".eml"
	fixture.objects.objects[rest] = value
	fixture.artifacts.artifact.OutboundMIMEHash = valueHash
	fixture.artifacts.artifact.MIMEObjectRef = campaignmaterializer.FormatObjectReference(rest)
	fixture.assurance.claimed.Artifacts[0].OutboundMIMEHash = valueHash
	fixture.assurance.claimed.Targets[0].OutboundMIMEHash = valueHash
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeIncomplete || result.BlockerCount != 1 ||
		fixture.assurance.extractions[0].ErrorCode != "synthetic_fixture_required" {
		t.Fatalf("real-recipient artifact result=%+v extraction=%+v", result, fixture.assurance.extractions)
	}
}

func TestWorkerFailsPermanentReceiptRejectionWithoutRetryLoop(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	fixture.assurance.recordExtractionErr = campaignassurance.ErrInvalidReceipt
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if result.Outcome != OutcomeFailed || fixture.assurance.failures != 1 || fixture.assurance.retries != 0 {
		t.Fatalf("result=%+v failures=%d retries=%d", result, fixture.assurance.failures, fixture.assurance.retries)
	}
}

func TestEffectiveRevisionUsesExactReviewedVariant(t *testing.T) {
	t.Parallel()
	document := semanticemail.NormalizeV2(semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2, Language: "en-US", Direction: semanticemail.DirectionAuto,
		Nodes: []semanticemail.Node{{
			ID: "variant_heading", Type: semanticemail.NodeHeading, Role: semanticemail.RoleHeading,
			Version: semanticemail.NodeVersionV2, Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
			Content: semanticemail.NodeContent{Heading: &semanticemail.HeadingContent{
				Level: 1, Text: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "Reviewed variant"}}},
			}},
		}},
	})
	variantID := "00000000-0000-4000-8000-000000000099"
	revision := campaignartifact.Revision{
		ID: testRevisionID, CampaignID: testCampaignID, SourceMode: campaignartifact.SourceModeSemantic,
		ContentSchemaVersion: semanticemail.SchemaVersionV2, Subject: "Base", SemanticTree: json.RawMessage(`[]`),
		FactContract: json.RawMessage(`{}`), Locales: json.RawMessage(`["en-US"]`),
		Variants: mustTestJSON(t, []reviewedVariant{{
			AdapterVersion: reviewedVariantAdapterVersion, ID: variantID, Subject: "Variant subject", Document: document,
		}}),
	}
	effective, documentHash, err := effectiveRevisionForArtifact(revision, campaignartifact.Artifact{
		ArtifactInput: campaignartifact.ArtifactInput{VariantID: variantID, Locale: "en-US"},
	})
	if err != nil {
		t.Fatal(err)
	}
	expectedDocument := mustTestJSON(t, document)
	var nodes []semanticemail.Node
	if err := json.Unmarshal(effective.SemanticTree, &nodes); err != nil {
		t.Fatal(err)
	}
	if effective.Subject != "Variant subject" || len(nodes) != 1 || nodes[0].ID != "variant_heading" ||
		documentHash != digestBytes(expectedDocument) {
		t.Fatalf("effective=%+v hash=%q", effective, documentHash)
	}
}

func TestExtractStructuredDataPreservesExactPayload(t *testing.T) {
	t.Parallel()
	payload := `{"@context":"http://schema.org","@type":"Order"}`
	actual, count, err := extractStructuredData([]byte(`<html><head><script type="application/ld+json">` + payload + `</script></head></html>`))
	if err != nil || count != 1 || string(actual) != payload {
		t.Fatalf("payload=%q count=%d err=%v", actual, count, err)
	}
	if _, _, err := extractStructuredData([]byte(`<script type="application/ld+json">{}`)); err == nil {
		t.Fatal("unterminated JSON-LD script was accepted")
	}
}

type queueFake struct {
	command      Command
	receiveErr   error
	acknowledged int
	released     int
	releaseAt    time.Time
}

type renewingQueueFake struct {
	queueFake
	renewErr error
	renewals int
}

func (f *renewingQueueFake) Renew(context.Context, Command) error {
	f.renewals++
	return f.renewErr
}

func (f *queueFake) Receive(context.Context) (Command, error) { return f.command, f.receiveErr }
func (f *queueFake) Acknowledge(context.Context, Command) error {
	f.acknowledged++
	return nil
}
func (f *queueFake) Release(_ context.Context, _ Command, at time.Time) error {
	f.released++
	f.releaseAt = at
	return nil
}

func TestOrchestratorAcknowledgesTerminalAndReleasesDeferredCommands(t *testing.T) {
	t.Run("terminal", func(t *testing.T) {
		fixture := newFixture(t, campaignassurance.SourceModeled)
		queue := &queueFake{command: Command{TenantID: testTenantID, RunID: testRunID}}
		result, err := (&Orchestrator{Worker: fixture.worker, Queue: queue}).RunOnce(context.Background())
		if err != nil || result.Outcome != OutcomeIncomplete || queue.acknowledged != 1 || queue.released != 0 {
			t.Fatalf("result=%+v err=%v queue=%+v", result, err, queue)
		}
	})
	t.Run("deferred", func(t *testing.T) {
		fixture := newFixture(t, campaignassurance.SourceDeterministic)
		fixture.assurance.claimErr = campaignassurance.ErrNotFound
		fixture.assurance.claimed.Run.State = campaignassurance.StateQueued
		retryAt := time.Now().Add(time.Hour)
		fixture.assurance.claimed.Run.RetryNotBefore = &retryAt
		queue := &queueFake{command: Command{TenantID: testTenantID, RunID: testRunID}}
		result, err := (&Orchestrator{Worker: fixture.worker, Queue: queue}).RunOnce(context.Background())
		if err != nil || result.Outcome != OutcomeDeferred || queue.acknowledged != 0 || queue.released != 1 ||
			!queue.releaseAt.Equal(retryAt) {
			t.Fatalf("result=%+v err=%v queue=%+v", result, err, queue)
		}
	})
	t.Run("worker error remains unacknowledged", func(t *testing.T) {
		fixture := newFixture(t, campaignassurance.SourceDeterministic)
		fixture.assurance.claimErr = errors.New("database unavailable")
		queue := &queueFake{command: Command{TenantID: testTenantID, RunID: testRunID}}
		_, err := (&Orchestrator{Worker: fixture.worker, Queue: queue}).RunOnce(context.Background())
		if err == nil || queue.acknowledged != 0 || queue.released != 0 {
			t.Fatalf("err=%v queue=%+v", err, queue)
		}
	})
}

func TestOrchestratorQueueHeartbeatCancelsWorkAfterVisibilityLeaseLoss(t *testing.T) {
	t.Parallel()
	queue := &renewingQueueFake{renewErr: errors.New("lease owner changed")}
	orchestrator := &Orchestrator{Queue: queue, QueueHeartbeatEvery: time.Millisecond}
	workContext, stop := orchestrator.startQueueHeartbeat(context.Background(), Command{
		TenantID: testTenantID, RunID: testRunID,
	})
	select {
	case <-workContext.Done():
	case <-time.After(time.Second):
		t.Fatal("queue heartbeat did not cancel work")
	}
	if err := stop(); !errors.Is(err, ErrQueue) ||
		!errors.Is(context.Cause(workContext), ErrQueue) || queue.renewals == 0 {
		t.Fatalf("stop err=%v cause=%v renewals=%d", err, context.Cause(workContext), queue.renewals)
	}
}

func newFixture(t *testing.T, sourceClass string) fixture {
	t.Helper()
	document := semanticemail.NormalizeV2(semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2, Language: "en-US", Direction: semanticemail.DirectionAuto,
		Nodes: []semanticemail.Node{
			{
				ID: "heading", Type: semanticemail.NodeHeading, Role: semanticemail.RoleHeading, Version: semanticemail.NodeVersionV2,
				Content: semanticemail.NodeContent{Heading: &semanticemail.HeadingContent{
					Level: 1, Text: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "Assurance fixture"}}},
				}}, Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
			{
				ID: "primary_action", Type: semanticemail.NodeAction, Role: semanticemail.RolePrimaryAction, Version: semanticemail.NodeVersionV2,
				Content: semanticemail.NodeContent{Action: &semanticemail.ActionContent{
					ActionID: "continue", Label: "Continue", CanonicalURL: "https://example.test/continue",
				}}, Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
		},
	})
	tree := mustTestJSON(t, document.Nodes)
	revision := campaignartifact.Revision{
		ID: testRevisionID, TenantID: testTenantID, CampaignID: testCampaignID, RevisionNo: 1,
		SourceMode: campaignartifact.SourceModeSemantic, ContentSchemaVersion: semanticemail.SchemaVersionV2,
		Subject: "Assurance fixture", SemanticTree: tree, FactContract: json.RawMessage(`{}`),
		Variants: json.RawMessage(`[]`), Locales: json.RawMessage(`["en-US"]`), SourceHash: strings.Repeat("a", 64),
	}
	bundle, err := campaignplanbuilder.CompileSyntheticCoverage(campaignplanbuilder.CompileInput{
		Revision: revision, TrackingSettings: json.RawMessage(`{}`),
		PolicyVersion: "postwave.test.plan-policy.v1", EnvelopeFactoryVersion: "postwave.test.envelope.v1",
		EnvelopeFactory: func(scenario campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error) {
			suffix := scenario.ScenarioID
			if len(suffix) > 24 {
				suffix = suffix[len(suffix)-24:]
			}
			return campaigncompiler.Envelope{
				From:      mail.Address{Name: "Moosewave", Address: "sender@example.test"},
				To:        []mail.Address{{Name: "Synthetic", Address: "fixture@example.test"}},
				Date:      time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC),
				MessageID: "<" + suffix + "@example.test>", Boundary: "postwave-" + suffix,
			}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(bundle.Compiled) != 1 {
		t.Fatalf("test fixture compiled %d scenarios, want 1", len(bundle.Compiled))
	}
	compiled := bundle.Compiled[0]
	objectBase := "campaign-assurance/plans/" + testPlanID + "/artifacts/" + digestBytes([]byte(compiled.Artifact.ScenarioID)) + "/"
	htmlRest := objectBase + compiled.Artifact.HTMLHash + ".html"
	textRest := objectBase + compiled.Artifact.TextHash + ".txt"
	mimeRest := objectBase + compiled.Artifact.OutboundMIMEHash + ".eml"
	expires := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	artifactInput := compiled.Artifact
	artifactInput.HTMLObjectRef = campaignmaterializer.FormatObjectReference(htmlRest)
	artifactInput.TextObjectRef = campaignmaterializer.FormatObjectReference(textRest)
	artifactInput.MIMEObjectRef = campaignmaterializer.FormatObjectReference(mimeRest)
	artifactInput.ExpiresAt = &expires
	artifact := campaignartifact.Artifact{
		ID: testArtifactID, TenantID: testTenantID, SendPlanID: testPlanID,
		ArtifactInput: artifactInput,
	}
	planHash := strings.Repeat("b", 64)
	plan := campaignartifact.Plan{
		ID: testPlanID, TenantID: testTenantID, CampaignID: testCampaignID, ContentRevisionID: testRevisionID,
		RendererVersion: bundle.RendererVersion, CompilerVersion: bundle.CompilerVersion,
		TransformManifest: bundle.TransformManifest, CoverageManifest: bundle.CoverageManifest, FixtureSetVersion: bundle.Manifest.FixtureSetVersion,
		PolicyVersion: bundle.PolicyVersion, PlanHash: &planHash, State: campaignartifact.PlanReady,
	}
	configuration, err := NewDeterministicConfiguration("postwave.test.gate-policy.v1")
	if err != nil {
		t.Fatal(err)
	}
	configurationID := configuration.ID
	configurationRaw := configuration.Configuration
	if sourceClass != campaignassurance.SourceDeterministic {
		configurationID = "model.primary"
		configurationRaw = json.RawMessage(`{"model_provider":"not-configured"}`)
	}
	configurationHash, err := canonicalConfigurationHash(configurationRaw)
	if err != nil {
		t.Fatal(err)
	}
	coverageJSON, err := canonicalJSONObject(bundle.CoverageManifest, campaigncoverage.MaxManifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	run := campaignassurance.Run{
		ID: testRunID, TenantID: testTenantID, CampaignID: testCampaignID,
		ContentRevisionID: testRevisionID, SendPlanID: testPlanID, State: campaignassurance.StateRunning,
		SourceHash: revision.SourceHash, PlanHash: planHash, ArtifactSetHash: strings.Repeat("c", 64),
		CoverageManifestHash: digestBytes(coverageJSON), ConfigurationManifestHash: strings.Repeat("d", 64),
		TargetManifestHash: strings.Repeat("e", 64), RendererVersion: plan.RendererVersion,
		CompilerVersion: plan.CompilerVersion, FixtureSetVersion: plan.FixtureSetVersion,
		PlanPolicyVersion: plan.PolicyVersion, AnalyzerSuiteVersion: "postwave.test.analyzer-suite.v1",
		ModelSuiteVersion: "postwave.test.model-suite.v1", PromptSuiteVersion: "postwave.test.prompt-suite.v1",
		PromptSuiteHash: strings.Repeat("f", 64), GatePolicyVersion: "postwave.test.gate-policy.v1",
		RequiredScenarioCount: 1, RequiredConfigurationCount: 1, RequiredExtractionCount: 1,
		ClaimToken: stringPointer(testClaimToken), AttemptCount: 1, MaxAttempts: 3,
	}
	claimed := campaignassurance.ClaimedRun{
		Run: run,
		Artifacts: []campaignassurance.RunArtifact{{
			TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID, SendPlanID: testPlanID,
			ArtifactID: testArtifactID, Ordinal: 1, ScenarioID: compiled.Artifact.ScenarioID,
			OutboundMIMEHash: compiled.Artifact.OutboundMIMEHash, MIMEStructureHash: compiled.Artifact.MIMEStructureHash,
		}},
		Configurations: []campaignassurance.RunConfiguration{{
			TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID, Ordinal: 1,
			ID: configurationID, SourceClass: sourceClass, ConfigurationHash: configurationHash,
			Configuration: configurationRaw,
		}},
		Targets: []campaignassurance.RunTarget{{
			TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID, SendPlanID: testPlanID,
			ArtifactID: testArtifactID, ConfigurationID: configurationID, Ordinal: 1,
			SourceClass: sourceClass, ConfigurationHash: configurationHash,
			OutboundMIMEHash: compiled.Artifact.OutboundMIMEHash,
		}},
	}
	assurance := &assuranceFake{claimed: claimed}
	artifacts := &artifactFake{plan: plan, revision: revision, artifact: artifact}
	objects := &objectFake{objects: map[string]objectValue{
		htmlRest: {body: []byte(compiled.HTML), contentType: "text/html; charset=utf-8"},
		textRest: {body: []byte(compiled.Text), contentType: "text/plain; charset=utf-8"},
		mimeRest: {body: compiled.RFC822, contentType: "message/rfc822"},
	}}
	worker := &Worker{
		Assurance: assurance, Artifacts: artifacts, Objects: objects, RawOutputs: objects,
		Config: Configuration{
			WorkerID: "campaign-assurance-test-worker", LeaseTTL: time.Minute,
			HeartbeatEvery: 10 * time.Second, Now: func() time.Time { return time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC) },
		},
	}
	return fixture{worker: worker, assurance: assurance, artifacts: artifacts, objects: objects, compiled: compiled}
}

func mustTestJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func stringPointer(value string) *string { return &value }
