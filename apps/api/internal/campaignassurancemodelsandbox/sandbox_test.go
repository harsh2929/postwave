// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancemodelsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

type recordingExecutor struct {
	identity campaignassuranceworker.ModelExecutorIdentity
	mu       sync.Mutex
	requests []campaignassuranceworker.ModelRequest
	execute  func(context.Context, campaignassuranceworker.ModelRequest) (campaignassuranceworker.ModelResult, error)
}

type testNetworkIsolation struct {
	error       error
	attestation NetworkIsolationAttestation
}

func (isolation testNetworkIsolation) Enforce(context.Context) (NetworkIsolationAttestation, error) {
	return isolation.attestation, isolation.error
}

func validTestNetworkIsolation() testNetworkIsolation {
	return testNetworkIsolation{attestation: NetworkIsolationAttestation{
		seal: networkIsolationSeal, processWide: true, noNewPrivs: true,
		afINETDenied: true, afINET6Denied: true, afUNIXAllowed: true, noInternetFDs: true,
	}}
}

func (executor *recordingExecutor) Identity() campaignassuranceworker.ModelExecutorIdentity {
	return executor.identity
}

func (executor *recordingExecutor) Execute(
	ctx context.Context,
	request campaignassuranceworker.ModelRequest,
) (campaignassuranceworker.ModelResult, error) {
	executor.mu.Lock()
	executor.requests = append(executor.requests, request)
	executor.mu.Unlock()
	if executor.execute != nil {
		return executor.execute(ctx, request)
	}
	return validModelResult(request.Configuration, validExtraction(tinyEvidenceID)), nil
}

func (executor *recordingExecutor) observed() []campaignassuranceworker.ModelRequest {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return append([]campaignassuranceworker.ModelRequest(nil), executor.requests...)
}

const tinyEvidenceID = "mime"

func testIdentity() campaignassuranceworker.ModelExecutorIdentity {
	return campaignassuranceworker.ModelExecutorIdentity{
		ID: "test.data-only-executor", Version: "test.data-only-executor.v1",
		MaximumCostMicrounits: 100,
	}
}

func testModelRequest() campaignassuranceworker.ModelRequest {
	mimeBody := []byte("From: sender@example.test\r\nTo: synthetic@example.test\r\nSubject: Update\r\n\r\nRead https://example.test/update")
	identity := testIdentity()
	configuration := campaignassuranceworker.ModeledConfigurationV1{
		SchemaVersion: 1, ExecutorID: identity.ID, ExecutorVersion: identity.Version,
		ModelSuiteVersion: "test.model-suite.v1", ModelProvider: "test-provider",
		ModelID: "test-model", ModelVersion: "test-model-001",
		PromptSuiteVersion: "test.prompt-suite.v1", PromptVersion: "test.prompt.v1",
		PromptHash: strings.Repeat("a", 64), SeedValue: "17", Temperature: 0,
		TimeoutMS: 1000, MaximumCostMicrounits: identity.MaximumCostMicrounits,
	}
	return campaignassuranceworker.ModelRequest{
		InvocationID: strings.Repeat("b", 64), BudgetInvocationID: "must-not-cross-budget",
		CacheKey: strings.Repeat("b", 64), TenantID: "must-not-cross-tenant",
		RunID: "must-not-cross-run", AttemptCount: 7, CampaignID: "must-not-cross-campaign",
		ContentRevisionID: "must-not-cross-revision", SendPlanID: "must-not-cross-plan",
		ArtifactID: "must-not-cross-artifact", ScenarioID: "must-not-cross-scenario",
		ConfigurationID: "must-not-cross-configuration", ConfigurationHash: strings.Repeat("c", 64),
		OutboundMIMEHash: sha256Hex(mimeBody), SourceHash: strings.Repeat("d", 64),
		PlanHash: strings.Repeat("e", 64), ArtifactSetHash: strings.Repeat("f", 64),
		AnalyzerSuiteVersion: "must-not-cross-analyzer", ModelSuiteVersion: configuration.ModelSuiteVersion,
		PromptSuiteVersion:   configuration.PromptSuiteVersion,
		NormalizationVersion: "must-not-cross-normalization", ScoringVersion: "must-not-cross-scoring",
		GatePolicyVersion: "must-not-cross-gate", MethodologyVersion: "must-not-cross-methodology",
		InputManifestHash: strings.Repeat("1", 64), Configuration: configuration,
		Vocabulary: campaignassuranceworker.RecoveryVocabularyV1{
			SchemaVersion: 1,
			PrimaryAction: campaignassuranceworker.RecoveryActionSlot{
				ActionID: "continue", BlockID: "primary_action",
			},
		},
		Evidence: []campaignassuranceworker.ModelEvidence{{
			ID: tinyEvidenceID, Representation: "mime", SHA256: sha256Hex(mimeBody),
		}},
		AllowedEvidenceIDs: []string{tinyEvidenceID},
		ExtractionSchema:   campaigncomprehension.ExtractionJSONSchemaV1(),
		MaxOutputBytes:     campaigncomprehension.MaxExtractionBytes,
		Artifact: campaignassuranceworker.ModelArtifact{
			Subject: "Update", HTML: `<p>Read <a href="https://example.test/update">the update</a></p>`,
			PlainText: "Read https://example.test/update", StructuredData: json.RawMessage(`{}`),
			RFC822: mimeBody,
		},
	}
}

func validExtraction(evidenceID string) []byte {
	encoded, err := json.Marshal(campaigncomprehension.ExtractionV1{
		SchemaVersion: 1, Summary: "An update is available.",
		PrimaryIntent: campaigncomprehension.ExtractedIntent{
			Kind: factcontract.IntentInform, Value: "Update", EvidenceIDs: []string{evidenceID},
		},
		CoreClaim: campaigncomprehension.ExtractedStatement{
			Value: "An update is available", EvidenceIDs: []string{evidenceID},
		},
		PrimaryAction: campaigncomprehension.ExtractedAction{
			ActionID: "continue", BlockID: "primary_action", Role: factcontract.PrimaryActionNavigate,
			Label: "Read the update", CanonicalURL: "https://example.test/update",
			EvidenceIDs: []string{evidenceID},
		},
		Facts:             []campaigncomprehension.ExtractedFact{},
		UnsupportedClaims: []campaigncomprehension.UnsupportedClaim{},
		Ambiguities:       []campaigncomprehension.Ambiguity{},
	})
	if err != nil {
		panic(err)
	}
	return encoded
}

func validModelResult(
	configuration campaignassuranceworker.ModeledConfigurationV1,
	raw []byte,
) campaignassuranceworker.ModelResult {
	return campaignassuranceworker.ModelResult{
		RawExtraction: raw,
		Provenance: campaignassuranceworker.ModelProvenance{
			ExecutorID: configuration.ExecutorID, ExecutorVersion: configuration.ExecutorVersion,
			ModelProvider: configuration.ModelProvider, ModelID: configuration.ModelID,
			ModelVersion: configuration.ModelVersion, PromptVersion: configuration.PromptVersion,
			PromptHash: configuration.PromptHash, SeedValue: configuration.SeedValue,
			Temperature: configuration.Temperature,
		},
		InputTokens: 10, OutputTokens: 5, CostMicrounits: 3,
	}
}

func startTestSandbox(t *testing.T, executor campaignassuranceworker.ModelExecutor) (string, context.CancelFunc, <-chan error) {
	t.Helper()
	sanitizeCredentialEnvironmentForTest(t)
	directory, err := os.MkdirTemp("/tmp", "pw-model-sandbox-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "model.sock")
	server, err := NewServer(ServerConfig{
		SocketPath: path, Executor: executor, AllowedClientUID: os.Geteuid(),
		NetworkIsolation: validTestNetworkIsolation(),
		CallTimeout:      time.Second, MaxConcurrent: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe(ctx) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		information, statErr := os.Lstat(path)
		if statErr == nil && information.Mode()&os.ModeSocket != 0 {
			break
		}
		select {
		case serveErr := <-done:
			cancel()
			t.Fatalf("sandbox failed before readiness: %v", serveErr)
		default:
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("sandbox socket was not created")
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Cleanup(func() {
		cancel()
		select {
		case serveErr := <-done:
			if serveErr != nil {
				t.Errorf("sandbox shutdown: %v", serveErr)
			}
		case <-time.After(2 * time.Second):
			t.Error("sandbox did not stop")
		}
	})
	return path, cancel, done
}

func startTestProviderGateway(
	t *testing.T,
	executor campaignassuranceworker.ModelExecutor,
) (string, context.CancelFunc, <-chan error) {
	t.Helper()
	sanitizeCredentialEnvironmentForTest(t)
	directory, err := os.MkdirTemp("/tmp", "pw-provider-gateway-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "gateway.sock")
	server, err := NewProviderGatewayServer(ProviderGatewayServerConfig{
		SocketPath: path, Executor: executor, AllowedClientUID: os.Geteuid(),
		CallTimeout: time.Second, MaxConcurrent: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe(ctx) }()
	waitForSocket(t, path, cancel, done)
	t.Cleanup(func() {
		cancel()
		select {
		case serveErr := <-done:
			if serveErr != nil {
				t.Errorf("provider gateway shutdown: %v", serveErr)
			}
		case <-time.After(2 * time.Second):
			t.Error("provider gateway did not stop")
		}
	})
	return path, cancel, done
}

func sanitizeCredentialEnvironmentForTest(t *testing.T) {
	t.Helper()
	for _, entry := range os.Environ() {
		name, _, exists := strings.Cut(entry, "=")
		if !exists {
			continue
		}
		if RejectSandboxCredentialEnvironment([]string{entry}) != nil {
			t.Setenv(name, "")
		}
	}
}

func waitForSocket(t *testing.T, path string, cancel context.CancelFunc, done <-chan error) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		information, statErr := os.Lstat(path)
		if statErr == nil && information.Mode()&os.ModeSocket != 0 {
			return
		}
		select {
		case serveErr := <-done:
			cancel()
			t.Fatalf("IPC service failed before readiness: %v", serveErr)
		default:
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("IPC socket was not created")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func newTestClient(t *testing.T, path string, identity campaignassuranceworker.ModelExecutorIdentity) *Client {
	t.Helper()
	client, err := NewClient(ClientConfig{
		SocketPath: path, ExpectedServerUID: os.Geteuid(), ExpectedIdentity: identity,
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestUnixBoundaryIsReadyAndMinimizesDataBeforeExecution(t *testing.T) {
	executor := &recordingExecutor{identity: testIdentity()}
	path, _, _ := startTestSandbox(t, executor)
	client := newTestClient(t, path, executor.identity)
	if _, err := client.Execute(t.Context(), testModelRequest()); err == nil {
		t.Fatal("execute before readiness succeeded")
	}
	if err := client.Ready(t.Context()); err != nil {
		t.Fatalf("readiness: %v", err)
	}
	result, err := client.Execute(t.Context(), testModelRequest())
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if string(result.RawExtraction) != string(validExtraction(tinyEvidenceID)) {
		t.Fatalf("unexpected extraction: %s", result.RawExtraction)
	}
	requests := executor.observed()
	if len(requests) != 1 {
		t.Fatalf("provider executions = %d, want 1", len(requests))
	}
	observed := requests[0]
	if observed.TenantID != "" || observed.RunID != "" || observed.CampaignID != "" ||
		observed.ContentRevisionID != "" || observed.SendPlanID != "" || observed.ArtifactID != "" ||
		observed.BudgetInvocationID != "" || observed.SourceHash != "" || observed.PlanHash != "" {
		t.Fatalf("application identity crossed data-only boundary: %+v", observed)
	}
	if !strings.Contains(observed.Artifact.HTML, "https://example.test/update") ||
		observed.InvocationID != testModelRequest().InvocationID {
		t.Fatalf("quoted email data or invocation identity was lost: %+v", observed)
	}

	wireBody, err := json.Marshal(modelInputFromRequest(testModelRequest()))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"must-not-cross", `"tenant_id"`, `"run_id"`, `"campaign_id"`, `"object_ref"`,
		`"provider_endpoint"`, `"credential"`, `"callback"`, `"tool_config"`,
	} {
		if strings.Contains(string(wireBody), forbidden) {
			t.Errorf("wire request contains forbidden capability/application field %q: %s", forbidden, wireBody)
		}
	}
}

func TestCompleteTwoHopTopologyKeepsProviderBehindNoNetworkSandbox(t *testing.T) {
	provider := &recordingExecutor{identity: testIdentity()}
	gatewayPath, _, _ := startTestProviderGateway(t, provider)
	gateway, err := NewProviderGatewayClient(ProviderGatewayClientConfig{
		SocketPath: gatewayPath, ExpectedServerUID: os.Geteuid(),
		ExpectedIdentity: provider.identity, Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	sandboxPath, _, _ := startTestSandbox(t, gateway)
	apiClient := newTestClient(t, sandboxPath, provider.identity)
	if err := apiClient.Ready(t.Context()); err != nil {
		t.Fatalf("two-hop readiness: %v", err)
	}
	if _, err := apiClient.Execute(t.Context(), testModelRequest()); err != nil {
		t.Fatalf("two-hop execute: %v", err)
	}
	if calls := len(provider.observed()); calls != 1 {
		t.Fatalf("provider calls = %d, want exactly one", calls)
	}
	if !gateway.IsReady() || !apiClient.IsReady() {
		t.Fatal("successful two-hop readiness was not retained")
	}
}

func TestSandboxRefusesMissingFailedOrFabricatedNetworkIsolation(t *testing.T) {
	sanitizeCredentialEnvironmentForTest(t)
	directory, err := os.MkdirTemp("/tmp", "pw-isolation-contract-")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(directory) }()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	base := ServerConfig{
		SocketPath:       filepath.Join(directory, "model.sock"),
		Executor:         &recordingExecutor{identity: testIdentity()},
		AllowedClientUID: os.Geteuid(), CallTimeout: time.Second,
	}
	if _, err := NewServer(base); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("missing enforcer error = %v", err)
	}
	for _, isolation := range []testNetworkIsolation{
		{error: errors.New("seccomp unavailable")},
		{attestation: NetworkIsolationAttestation{seal: networkIsolationSeal}},
	} {
		configuration := base
		configuration.NetworkIsolation = isolation
		server, err := NewServer(configuration)
		if err != nil {
			t.Fatal(err)
		}
		err = server.ListenAndServe(t.Context())
		if !errors.Is(err, ErrNetworkIsolation) {
			t.Fatalf("failed/fabricated enforcer error = %v", err)
		}
		if _, statErr := os.Lstat(configuration.SocketPath); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("listener existed before isolation: %v", statErr)
		}
	}
}

func TestWireInputHashAndValidationSurviveStrictRoundTrip(t *testing.T) {
	input := modelInputFromRequest(testModelRequest())
	if err := validateModelInput(input, testIdentity()); err != nil {
		t.Fatalf("pre-wire validation: %v", err)
	}
	inputBody, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	envelopeBody, err := json.Marshal(wireEnvelope{
		Protocol: ProtocolVersion, Operation: "execute", RequestID: input.InvocationID,
		Input: &input, InputHash: sha256Hex(inputBody),
	})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeWireEnvelope(envelopeBody, ProtocolVersion)
	if err != nil {
		t.Fatal(err)
	}
	decodedBody, err := json.Marshal(decoded.Input)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.InputHash != sha256Hex(decodedBody) {
		t.Fatalf("input hash drift: sent=%s decoded=%s\nsent body=%s\ndecoded=%s",
			decoded.InputHash, sha256Hex(decodedBody), inputBody, decodedBody)
	}
	if err := validateModelInput(*decoded.Input, testIdentity()); err != nil {
		t.Fatalf("post-wire validation: %v", err)
	}
}

func TestServerAndClientBothRejectInvalidModelOutput(t *testing.T) {
	executor := &recordingExecutor{
		identity: testIdentity(),
		execute: func(_ context.Context, request campaignassuranceworker.ModelRequest) (campaignassuranceworker.ModelResult, error) {
			return validModelResult(request.Configuration, []byte(`{"schema_version":1,"unknown":"<script>"}`)), nil
		},
	}
	path, _, _ := startTestSandbox(t, executor)
	client := newTestClient(t, path, executor.identity)
	if err := client.Ready(t.Context()); err != nil {
		t.Fatal(err)
	}
	_, err := client.Execute(t.Context(), testModelRequest())
	var failure *campaignassuranceworker.ModelExecutionFailure
	if !errors.As(err, &failure) || failure.Code != "sandbox_output_invalid" ||
		failure.Kind != campaignassuranceworker.ModelFailureError {
		t.Fatalf("invalid output error = %#v, want terminal sandbox_output_invalid", err)
	}
}

func TestClassifiedProviderFailureCrossesWithoutProviderText(t *testing.T) {
	executor := &recordingExecutor{
		identity: testIdentity(),
		execute: func(context.Context, campaignassuranceworker.ModelRequest) (campaignassuranceworker.ModelResult, error) {
			return campaignassuranceworker.ModelResult{}, &campaignassuranceworker.ModelExecutionFailure{
				Code: "provider_retryable", Kind: campaignassuranceworker.ModelFailureRetryable,
			}
		},
	}
	path, _, _ := startTestSandbox(t, executor)
	client := newTestClient(t, path, executor.identity)
	if err := client.Ready(t.Context()); err != nil {
		t.Fatal(err)
	}
	_, err := client.Execute(t.Context(), testModelRequest())
	var failure *campaignassuranceworker.ModelExecutionFailure
	if !errors.As(err, &failure) || failure.Code != "provider_retryable" ||
		failure.Kind != campaignassuranceworker.ModelFailureRetryable {
		t.Fatalf("classified failure = %#v", err)
	}
}

func TestCallTimeoutIsRetryableAndProviderIsInvokedOnce(t *testing.T) {
	executor := &recordingExecutor{
		identity: testIdentity(),
		execute: func(ctx context.Context, _ campaignassuranceworker.ModelRequest) (campaignassuranceworker.ModelResult, error) {
			<-ctx.Done()
			return campaignassuranceworker.ModelResult{}, context.Cause(ctx)
		},
	}
	path, _, _ := startTestSandbox(t, executor)
	client := newTestClient(t, path, executor.identity)
	if err := client.Ready(t.Context()); err != nil {
		t.Fatal(err)
	}
	request := testModelRequest()
	request.Configuration.TimeoutMS = 100
	_, err := client.Execute(t.Context(), request)
	var failure *campaignassuranceworker.ModelExecutionFailure
	if !errors.As(err, &failure) || failure.Code != "sandbox_execution_timeout" ||
		failure.Kind != campaignassuranceworker.ModelFailureRetryable {
		t.Fatalf("timeout failure = %#v", err)
	}
	if calls := len(executor.observed()); calls != 1 {
		t.Fatalf("provider calls after timeout = %d, want exactly one", calls)
	}
}

func TestSocketModeAndPinnedIdentityFailClosed(t *testing.T) {
	executor := &recordingExecutor{identity: testIdentity()}
	path, _, _ := startTestSandbox(t, executor)
	wrong := executor.identity
	wrong.Version = "foreign.v1"
	client := newTestClient(t, path, wrong)
	if err := client.Ready(t.Context()); !errors.Is(err, ErrProtocol) {
		t.Fatalf("foreign identity readiness error = %v, want ErrProtocol", err)
	}
	if err := os.Chmod(path, 0o666); err != nil {
		t.Fatal(err)
	}
	client = newTestClient(t, path, executor.identity)
	if err := client.Ready(t.Context()); !errors.Is(err, ErrUnsafeSocket) {
		t.Fatalf("unsafe socket readiness error = %v, want ErrUnsafeSocket", err)
	}
}

func TestCredentialAuditAllowsProviderOnlyAndRejectsApplicationCredentials(t *testing.T) {
	if err := RejectApplicationCredentialEnvironment([]string{
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY=provider-secret",
		"DATABASE_URL=", "PATH=/usr/bin",
	}); err != nil {
		t.Fatalf("provider-only environment rejected: %v", err)
	}
	for _, environment := range [][]string{
		{"DATABASE_URL=postgres://secret"},
		{"AWS_SECRET_ACCESS_KEY=secret"},
		{"POSTWAVE_PORTAL_JWT_SECRET=secret"},
		{"POSTWAVE_SMTP_RELAY_ADDR=smtp.internal:25"},
	} {
		err := RejectApplicationCredentialEnvironment(environment)
		if !errors.Is(err, ErrApplicationCredential) || strings.Contains(err.Error(), "postgres://") {
			t.Fatalf("credential audit error = %v", err)
		}
	}
}

func TestStrictProtocolRejectsDuplicateAndUnknownFields(t *testing.T) {
	requestID := strings.Repeat("a", 64)
	duplicate := []byte(`{"protocol":"` + ProtocolVersion + `","protocol":"` + ProtocolVersion +
		`","operation":"ready","request_id":"` + requestID + `"}`)
	if _, err := decodeWireEnvelope(duplicate, ProtocolVersion); !errors.Is(err, ErrProtocol) {
		t.Fatalf("duplicate field error = %v", err)
	}
	unknown := []byte(`{"protocol":"` + ProtocolVersion + `","operation":"ready","request_id":"` +
		requestID + `","provider_url":"https://evil.test"}`)
	if _, err := decodeWireEnvelope(unknown, ProtocolVersion); !errors.Is(err, ErrProtocol) {
		t.Fatalf("capability-bearing unknown field error = %v", err)
	}
}

func TestSummaryOutputUsesClosedSchemaAndEnum(t *testing.T) {
	for _, raw := range []string{
		`{"one_line_summary":"Update","primary_intent":"made_up","primary_action":"Read"}`,
		`{"one_line_summary":"Update","primary_intent":"announcement","primary_action":"Read","url":"https://evil.test"}`,
		`{"one_line_summary":"First","one_line_summary":"Second","primary_intent":"announcement","primary_action":"Read"}`,
	} {
		if err := validateSummaryOutput([]byte(raw)); err == nil {
			t.Fatalf("unsafe summary output accepted: %s", raw)
		}
	}
	if err := validateSummaryOutput([]byte(
		`{"one_line_summary":"Update","primary_intent":"announcement","primary_action":"Read"}`,
	)); err != nil {
		t.Fatalf("valid summary rejected: %v", err)
	}
}
