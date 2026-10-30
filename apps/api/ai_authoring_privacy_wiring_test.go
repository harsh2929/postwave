package main

import (
	"strings"
	"testing"
)

// This is a production-composition invariant, not merely a decorator unit
// test. A future route must not accidentally give Chat the strict client while
// reconnecting Compose or Subject Lab to an unwrapped model client.
func TestAIAuthoringProductionWiringSharesFailClosedPrivacyClient(t *testing.T) {
	root := readAPICompositionRoot(t)
	source := root.main
	start := strings.Index(source, "// SUB-072: every production AI authoring call")
	if start < 0 {
		t.Fatal("main.go no longer exposes the AI authoring composition marker")
	}
	end := strings.Index(source[start:], "// BYOK (Bring-Your-Own-Key)")
	if end < 0 {
		t.Fatal("main.go no longer exposes the bounded AI authoring composition block")
	}
	// The block as it executes: its statements in run() plus any helper they
	// call, so a statement extracted from the block stays inside the contract.
	block := root.withCalledFunctions(source[start : start+end])

	required := []string{
		"aiVoiceClient := aicompose.NewStrictTextGatewayVoiceClient(",
		"aiVoiceGatewayRepo.StrictTextSanitizerForTenant(",
		"aichat.Mount(r, &aichat.Deps{Voice: aiVoiceClient",
		`VoiceNotDeployed: cfg.VoiceServiceURL == ""`,
		"aiComposer := aicompose.New(aiVoiceClient)",
		"subject_lab.MountRoutes(r, &subject_lab.Deps{Pool: pool, Composer: aiComposer})",
		"Composer: aiComposer,",
	}
	for _, marker := range required {
		if !strings.Contains(block, marker) {
			t.Fatalf("AI authoring composition is missing privacy marker %q", marker)
		}
	}
	if strings.Contains(block, "NewGatewayVoiceClient(") {
		t.Fatal("AI authoring composition downgraded to the legacy fail-open gateway")
	}
	if got := strings.Count(block, "NewHTTPVoiceClient(cfg.VoiceServiceURL, cfg.InternalAPIToken)"); got != 1 {
		t.Fatalf("AI authoring block has %d raw voice clients, want exactly one behind the strict gateway", got)
	}
}

func TestAgentRoutinesProductionWiringAuthenticatesAndSanitizesModelText(t *testing.T) {
	root := readAPICompositionRoot(t)
	source := root.main
	start := strings.Index(source, "// ----- agent routines (platform-2026 #1) -----")
	if start < 0 {
		t.Fatal("main.go no longer exposes the Agent Routines composition marker")
	}
	end := strings.Index(source[start:], "// ----- end agent routines -----")
	if end < 0 {
		t.Fatal("main.go no longer exposes a bounded Agent Routines composition block")
	}
	// e8d23a62d moved the AI regression harness inside this block into
	// buildAIRegressionRunner and startAIRegressionScheduler; read the block as
	// it executes so the voice-transport count and bypass check still cover them.
	block := root.withCalledFunctions(source[start : start+end])
	required := []string{
		"agentRoutinesPIIRepo := &pii_gateway.Repo{Pool: pool}",
		"agentRoutinesRunner := &agent_routines.Runner{",
		"agent_routines.NewHTTPVoiceClient(",
		"cfg.InternalAPIToken,",
		"agent_routines.StrictTextSanitizerFactoryFunc(func(",
		"agentRoutinesPIIRepo.StrictTextSanitizerForTenant(",
		"agentRoutinesScheduler := &agent_routines.Scheduler{",
		"Repo:   agentRoutinesRepo,",
		"Runner: agentRoutinesRunner,",
	}
	for _, marker := range required {
		if !strings.Contains(block, marker) {
			t.Fatalf("Agent Routines composition is missing security marker %q", marker)
		}
	}
	if got := strings.Count(block, "agent_routines.NewHTTPVoiceClient("); got != 1 {
		t.Fatalf("Agent Routines composition has %d voice transports, want one strict authenticated boundary", got)
	}
	if strings.Contains(block, "aicompose.NewHTTPVoiceClient(") {
		t.Fatal("Agent Routines composition bypasses its strict request-scoped PII transport")
	}
}
