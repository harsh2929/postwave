// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

const testHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func validCreateInput() CreateRunInput {
	return CreateRunInput{
		CampaignID:           uuid.NewString(),
		ContentRevisionID:    uuid.NewString(),
		SendPlanID:           uuid.NewString(),
		RequestID:            uuid.NewString(),
		TriggerKind:          TriggerExplicit,
		Profile:              ProfileFull,
		AnalyzerSuiteVersion: "assurance-suite-v1",
		ModelSuiteVersion:    "model-suite-2026-08-09",
		PromptSuiteVersion:   "prompt-suite-v1",
		PromptSuiteHash:      testHash,
		NormalizationVersion: "normalization-v1",
		ScoringVersion:       "score-v1",
		GatePolicyVersion:    "gate-v1",
		MethodologyVersion:   "methodology-v1",
		Configurations: []ConfigurationInput{
			{ID: "deterministic.mime", SourceClass: SourceDeterministic, Configuration: json.RawMessage(`{"b":2,"a":1}`)},
			{ID: "model.primary", SourceClass: SourceModeled, Configuration: json.RawMessage(`{"temperature":0}`)},
		},
	}
}

func TestCanonicalJSONIsStableAndClosed(t *testing.T) {
	t.Parallel()
	left, err := canonicalJSON(json.RawMessage(`{"b":2,"a":1}`), "object", 1024)
	if err != nil {
		t.Fatalf("canonicalize left: %v", err)
	}
	right, err := canonicalJSON(json.RawMessage(" { \"a\" : 1, \"b\": 2 } "), "object", 1024)
	if err != nil {
		t.Fatalf("canonicalize right: %v", err)
	}
	if string(left) != string(right) || string(left) != `{"a":1,"b":2}` {
		t.Fatalf("canonical JSON mismatch: left=%s right=%s", left, right)
	}
	for _, test := range []struct {
		name string
		raw  string
		kind string
	}{
		{"trailing", `{} {}`, "object"},
		{"wrong kind", `[]`, "object"},
		{"invalid", `{`, "object"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := canonicalJSON(json.RawMessage(test.raw), test.kind, 1024); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want ErrInvalidInput", err)
			}
		})
	}
}

func TestNormalizeCreateInputFreezesClosedConfigurationAndSparseTargets(t *testing.T) {
	t.Parallel()
	input := validCreateInput()
	artifactID := uuid.NewString()
	input.Targets = []TargetInput{{ArtifactID: artifactID, ConfigurationID: "model.primary"}}
	normalized, hashes, manifestHash, err := normalizeCreateInput(input)
	if err != nil {
		t.Fatalf("normalize valid input: %v", err)
	}
	if len(hashes) != 2 || !hashPattern.MatchString(hashes[0]) || !hashPattern.MatchString(manifestHash) {
		t.Fatalf("invalid manifest hashes: hashes=%v manifest=%q", hashes, manifestHash)
	}
	if string(normalized.Configurations[0].Configuration) != `{"a":1,"b":2}` {
		t.Fatalf("configuration not canonical: %s", normalized.Configurations[0].Configuration)
	}
	if normalized.MaxAttempts != defaultMaxAttempts || normalized.Targets[0].ArtifactID != artifactID {
		t.Fatalf("normalization lost lifecycle input: %+v", normalized)
	}

	tests := []struct {
		name   string
		mutate func(*CreateRunInput)
	}{
		{"no configurations", func(value *CreateRunInput) { value.Configurations = nil }},
		{"duplicate configuration", func(value *CreateRunInput) { value.Configurations[1].ID = value.Configurations[0].ID }},
		{"unknown target configuration", func(value *CreateRunInput) { value.Targets[0].ConfigurationID = "unknown" }},
		{"invalid target artifact", func(value *CreateRunInput) { value.Targets[0].ArtifactID = "not-a-uuid" }},
		{"missing methodology", func(value *CreateRunInput) { value.ScoringVersion = "" }},
		{"invalid prompt hash", func(value *CreateRunInput) { value.PromptSuiteHash = "nope" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := validCreateInput()
			value.Targets = []TargetInput{{ArtifactID: artifactID, ConfigurationID: "model.primary"}}
			test.mutate(&value)
			if _, _, _, err := normalizeCreateInput(value); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want ErrInvalidInput", err)
			}
		})
	}
}

func TestModeledRunCostCeilingIsFrozenAcrossEveryRequiredAttempt(t *testing.T) {
	t.Parallel()
	modeledTarget := func(raw string) resolvedTarget {
		return resolvedTarget{Configuration: ConfigurationInput{
			ID:            "model.primary",
			SourceClass:   SourceModeled,
			Configuration: json.RawMessage(raw),
		}}
	}
	deterministic := resolvedTarget{Configuration: ConfigurationInput{
		ID:            "deterministic.mime",
		SourceClass:   SourceDeterministic,
		Configuration: json.RawMessage(`{"maximum_cost_microunits":999999}`),
	}}

	ceiling, err := modeledRunCostCeiling([]resolvedTarget{
		modeledTarget(`{"maximum_cost_microunits":100}`),
		modeledTarget(`{"maximum_cost_microunits":250}`),
		deterministic,
	}, 3)
	if err != nil || ceiling != 1050 {
		t.Fatalf("aggregate ceiling = %d, err=%v, want 1050", ceiling, err)
	}

	for _, test := range []struct {
		name          string
		configuration string
		attempts      int
	}{
		{name: "negative", configuration: `{"maximum_cost_microunits":-1}`, attempts: 1},
		{name: "over per-invocation bound", configuration: `{"maximum_cost_microunits":1000000000000001}`, attempts: 1},
		{name: "fractional", configuration: `{"maximum_cost_microunits":1.5}`, attempts: 1},
		{name: "invalid attempts", configuration: `{"maximum_cost_microunits":1}`, attempts: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := modeledRunCostCeiling([]resolvedTarget{modeledTarget(test.configuration)}, test.attempts); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want ErrInvalidInput", err)
			}
		})
	}

	zero, err := modeledRunCostCeiling([]resolvedTarget{modeledTarget(`{}`)}, 9)
	if err != nil || zero != 0 {
		t.Fatalf("unavailable modeled adapter ceiling = %d, err=%v, want zero", zero, err)
	}
}

func TestUUIDNormalizationPrecedesTargetIdentityAndDoesNotMutateCallerSlice(t *testing.T) {
	t.Parallel()
	artifactID := uuid.NewString()
	upperArtifactID := strings.ToUpper(artifactID)
	input := validCreateInput()
	input.CampaignID = strings.ToUpper(input.CampaignID)
	input.Targets = []TargetInput{{ArtifactID: upperArtifactID, ConfigurationID: "model.primary"}}
	originalTargets := input.Targets
	normalized, _, _, err := normalizeCreateInput(input)
	if err != nil {
		t.Fatalf("normalize alternate UUID spelling: %v", err)
	}
	if normalized.CampaignID != strings.ToLower(input.CampaignID) ||
		normalized.Targets[0].ArtifactID != artifactID {
		t.Fatalf("UUIDs were not canonicalized before identity use: %+v", normalized)
	}
	if originalTargets[0].ArtifactID != upperArtifactID {
		t.Fatalf("normalization mutated caller-owned targets: %+v", originalTargets)
	}

	duplicate := validCreateInput()
	duplicate.Targets = []TargetInput{
		{ArtifactID: artifactID, ConfigurationID: "model.primary"},
		{ArtifactID: upperArtifactID, ConfigurationID: "model.primary"},
	}
	if _, _, _, err := normalizeCreateInput(duplicate); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("alternate-spelling duplicate error = %v, want ErrInvalidInput", err)
	}
}

func validModeledExtraction() ExtractionInput {
	temperature := 0.0
	return ExtractionInput{
		ArtifactID:           uuid.NewString(),
		ConfigurationID:      "model.primary",
		SourceClass:          SourceModeled,
		ConfigurationHash:    testHash,
		OutboundMIMEHash:     strings.Repeat("b", 64),
		Status:               ExtractionComplete,
		NormalizedExtraction: json.RawMessage(`{"summary":"Launch is Friday"}`),
		EvidenceManifest:     json.RawMessage(`{"blocks":["blk_01"]}`),
		UnsupportedClaims:    json.RawMessage(`[]`),
		Ambiguities:          json.RawMessage(`[]`),
		ModelProvider:        "openai",
		ModelID:              "gpt-test",
		ModelVersion:         "snapshot-42",
		PromptVersion:        "prompt-v1",
		PromptHash:           strings.Repeat("c", 64),
		Temperature:          &temperature,
		InputTokens:          100,
		OutputTokens:         20,
		CostMicrounits:       300,
		LatencyMS:            450,
	}
}

func TestNormalizeExtractionRequiresSourceAppropriateIdentityAndStableReceipt(t *testing.T) {
	t.Parallel()
	input := validModeledExtraction()
	normalized, receiptHash, err := normalizeExtractionInput(input)
	if err != nil {
		t.Fatalf("normalize modeled extraction: %v", err)
	}
	if !hashPattern.MatchString(receiptHash) || string(normalized.NormalizedExtraction) != `{"summary":"Launch is Friday"}` {
		t.Fatalf("invalid normalized extraction: hash=%q value=%s", receiptHash, normalized.NormalizedExtraction)
	}

	deterministic := input
	deterministic.SourceClass = SourceDeterministic
	deterministic.ConfigurationID = "deterministic.mime"
	deterministic.ModelProvider = ""
	deterministic.ModelID = ""
	deterministic.ModelVersion = ""
	deterministic.PromptVersion = ""
	deterministic.PromptHash = ""
	if _, _, err := normalizeExtractionInput(deterministic); err != nil {
		t.Fatalf("deterministic receipt required fabricated model identity: %v", err)
	}

	missingModel := input
	missingModel.ModelVersion = ""
	if _, _, err := normalizeExtractionInput(missingModel); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("missing model version error = %v", err)
	}
	errorReceipt := input
	errorReceipt.Status = ExtractionError
	errorReceipt.NormalizedExtraction = nil
	errorReceipt.ErrorCode = "provider_timeout"
	errorReceipt.ErrorMessage = "the configured analyzer timed out"
	if _, _, err := normalizeExtractionInput(errorReceipt); err != nil {
		t.Fatalf("valid terminal error receipt rejected: %v", err)
	}
	nonFinite := input
	nan := math.NaN()
	nonFinite.Temperature = &nan
	if _, _, err := normalizeExtractionInput(nonFinite); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("non-finite temperature error = %v", err)
	}
	remoteRaw := input
	remoteRaw.RawOutputObjectRef = "https://attacker.test/output"
	remoteRaw.RawOutputHash = testHash
	expires := time.Now().Add(time.Hour)
	remoteRaw.RawOutputExpiresAt = &expires
	if _, _, err := normalizeExtractionInput(remoteRaw); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("remote raw object error = %v", err)
	}
	validRaw := input
	validRaw.RawOutputObjectRef = objectReferencePrefix + "campaign-assurance/raw-output/run_01/receipt.json"
	validRaw.RawOutputHash = testHash
	validRaw.RawOutputExpiresAt = &expires
	if _, _, err := normalizeExtractionInput(validRaw); err != nil {
		t.Fatalf("tenant-relative raw object reference rejected: %v", err)
	}
	for _, unsafeReference := range []string{
		"file:///tmp/output", "/absolute/output", "../foreign/output",
		objectReferencePrefix + "../foreign/output",
		objectReferencePrefix + "campaign-assurance/raw-output/../foreign",
		objectReferencePrefix + "tenants/" + uuid.NewString() + "/output",
	} {
		unsafe := input
		unsafe.RawOutputObjectRef = unsafeReference
		unsafe.RawOutputHash = testHash
		unsafe.RawOutputExpiresAt = &expires
		if _, _, err := normalizeExtractionInput(unsafe); !errors.Is(err, ErrInvalidReceipt) {
			t.Errorf("unsafe raw object reference %q error = %v", unsafeReference, err)
		}
	}
}

func TestFindingKeysAreStableButReceiptsCoverHumanExplanation(t *testing.T) {
	t.Parallel()
	schemaVersion := 1
	input := FindingInput{
		ArtifactID:              uuid.NewString(),
		ConfigurationID:         "deterministic.mime",
		Code:                    "PRIMARY_ACTION_MISSING",
		SourceClass:             SourceDeterministic,
		Severity:                "critical",
		Blocking:                true,
		Overridable:             true,
		Dimension:               "primary_action",
		BlockReferences:         json.RawMessage(`[]`),
		EvidenceReferences:      json.RawMessage(`["html"]`),
		Explanation:             "The primary action is absent from visible HTML.",
		Remediation:             json.RawMessage(`{"kind":"add_action"}`),
		TypedPatch:              json.RawMessage(`{"op":"add"}`),
		TypedPatchSchemaVersion: &schemaVersion,
		DetectorVersion:         "detector-v1",
		PolicyVersion:           "gate-v1",
	}
	normalized, key, err := normalizeFindingInput(input)
	if err != nil {
		t.Fatalf("normalize finding: %v", err)
	}
	receipt, patchHash, err := findingReceiptHash(normalized, key, testHash, strings.Repeat("b", 64))
	if err != nil || !hashPattern.MatchString(receipt) || !hashPattern.MatchString(patchHash) {
		t.Fatalf("invalid finding receipt: receipt=%q patch=%q err=%v", receipt, patchHash, err)
	}
	changed := input
	changed.Explanation = "The CTA is absent from the final visible representation."
	changed, changedKey, err := normalizeFindingInput(changed)
	if err != nil || changedKey != key {
		t.Fatalf("human explanation unexpectedly changed semantic key: key=%q changed=%q err=%v", key, changedKey, err)
	}
	changedReceipt, _, err := findingReceiptHash(changed, changedKey, testHash, strings.Repeat("b", 64))
	if err != nil || changedReceipt == receipt {
		t.Fatalf("human explanation was not covered by receipt hash: old=%q new=%q err=%v", receipt, changedReceipt, err)
	}
	nonBlocking := input
	nonBlocking.Blocking = false
	if _, _, err := normalizeFindingInput(nonBlocking); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("non-blocking overrideable finding error = %v", err)
	}
}

func TestFinalizeNeverFabricatesScoreForIncompleteEvidence(t *testing.T) {
	t.Parallel()
	min, max, overall, agreement := 70.0, 90.0, 80.0, 0.8
	input := FinalizeInput{
		ComponentScores: json.RawMessage(`{"intent":80}`),
		OverallScore:    &overall, ScoreMin: &min, ScoreMax: &max,
		Agreement: &agreement, GateDecision: GatePass,
	}
	complete, err := normalizeFinalizeInput(input, true)
	if err != nil || complete.GateDecision != GatePass || complete.OverallScore == nil {
		t.Fatalf("complete receipt normalization: %+v err=%v", complete, err)
	}
	incomplete, err := normalizeFinalizeInput(input, false)
	if err != nil || incomplete.GateDecision != GateUnavailable || incomplete.OverallScore != nil ||
		incomplete.ScoreMin != nil || incomplete.Agreement != nil {
		t.Fatalf("incomplete receipt fabricated score: %+v err=%v", incomplete, err)
	}
	nan := math.NaN()
	input.OverallScore = &nan
	if _, err := normalizeFinalizeInput(input, true); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("NaN score error = %v", err)
	}
}

func TestOverrideRequiresHumanGovernanceAndStableRequestHash(t *testing.T) {
	t.Parallel()
	expires := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	actorID := uuid.NewString()
	input := OverrideInput{
		FindingID: uuid.NewString(), RequestID: uuid.NewString(), Decision: "allow_send",
		Reason: "Reviewed against the source contract and accepted for this send.", ExpiresAt: &expires,
	}
	_, leftHash, err := normalizeOverrideInput(input, actorID, "admin")
	if err != nil || !hashPattern.MatchString(leftHash) {
		t.Fatalf("normalize override: hash=%q err=%v", leftHash, err)
	}
	_, rightHash, err := normalizeOverrideInput(input, strings.ToUpper(actorID), "admin")
	if err != nil || rightHash != leftHash {
		t.Fatalf("override hash is unstable: left=%q right=%q err=%v", leftHash, rightHash, err)
	}
	for _, role := range []string{"system", "member"} {
		if _, _, err := normalizeOverrideInput(input, actorID, role); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("role %q error = %v", role, err)
		}
	}
}
