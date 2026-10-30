// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

func testSuiteDefinitions() []SuiteDefinition {
	return []SuiteDefinition{
		{
			Profile:              campaignassurance.ProfileFast,
			AnalyzerSuiteVersion: "analyzers-2026-08-09", ModelSuiteVersion: "models-2026-08-09",
			PromptSuiteVersion: "prompts-2026-08-09", PromptSuiteHash: strings.Repeat("1", 64),
			NormalizationVersion: "normalization-v1", ScoringVersion: "scoring-v1",
			GatePolicyVersion: "gate-v1", MethodologyVersion: "method-v1", MaxAttempts: 2,
			Configurations: []campaignassurance.ConfigurationInput{{
				ID: "deterministic.preflight", SourceClass: campaignassurance.SourceDeterministic,
				Configuration: json.RawMessage(`{"policy":"message-contract-v1"}`),
			}},
		},
		{
			Profile:              campaignassurance.ProfileFull,
			AnalyzerSuiteVersion: "analyzers-2026-08-09", ModelSuiteVersion: "models-2026-08-09",
			PromptSuiteVersion: "prompts-2026-08-09", PromptSuiteHash: strings.Repeat("2", 64),
			NormalizationVersion: "normalization-v1", ScoringVersion: "scoring-v1",
			GatePolicyVersion: "gate-v1", MethodologyVersion: "method-v1", MaxAttempts: 3,
			Configurations: []campaignassurance.ConfigurationInput{
				{ID: "deterministic.preflight", SourceClass: campaignassurance.SourceDeterministic, Configuration: json.RawMessage(`{"checks":"all"}`)},
				{ID: "modeled.ensemble", SourceClass: campaignassurance.SourceModeled, Configuration: json.RawMessage(`{"samples":3}`)},
			},
		},
		{
			Profile:              campaignassurance.ProfileCalibration,
			AnalyzerSuiteVersion: "analyzers-2026-08-09", ModelSuiteVersion: "models-2026-08-09",
			PromptSuiteVersion: "prompts-2026-08-09", PromptSuiteHash: strings.Repeat("3", 64),
			NormalizationVersion: "normalization-v1", ScoringVersion: "scoring-v1",
			GatePolicyVersion: "gate-v1", MethodologyVersion: "method-v1", MaxAttempts: 3,
			Configurations: []campaignassurance.ConfigurationInput{{
				ID: "controlled.seed", SourceClass: campaignassurance.SourceControlledObservation,
				Configuration: json.RawMessage(`{"environment":"named-controlled-seed"}`),
			}},
		},
	}
}

func testSuiteRegistry(t *testing.T) *SuiteRegistry {
	t.Helper()
	registry, err := NewSuiteRegistry(testSuiteDefinitions())
	if err != nil {
		t.Fatalf("NewSuiteRegistry: %v", err)
	}
	return registry
}

func TestSuiteRegistryIsClosedAndDefensivelyImmutable(t *testing.T) {
	definitions := testSuiteDefinitions()
	registry, err := NewSuiteRegistry(definitions)
	if err != nil {
		t.Fatalf("NewSuiteRegistry: %v", err)
	}

	// Mutating the constructor input cannot alter the frozen registry.
	definitions[0].Configurations[0].ID = "attacker.changed"
	definitions[0].Configurations[0].Configuration[2] = 'X'
	first, ok := registry.Resolve(campaignassurance.ProfileFast)
	if !ok {
		t.Fatal("fast profile was not resolved")
	}
	if first.Configurations[0].ID != "deterministic.preflight" ||
		string(first.Configurations[0].Configuration) != `{"policy":"message-contract-v1"}` {
		t.Fatalf("constructor mutation reached registry: %+v", first.Configurations[0])
	}

	// Mutating a resolved snapshot cannot alter the next resolution.
	first.Configurations[0].ID = "attacker.changed.again"
	first.Configurations[0].Configuration[2] = 'Y'
	second, ok := registry.Resolve(campaignassurance.ProfileFast)
	if !ok || second.Configurations[0].ID != "deterministic.preflight" ||
		string(second.Configurations[0].Configuration) != `{"policy":"message-contract-v1"}` {
		t.Fatalf("resolved mutation reached registry: %+v", second.Configurations)
	}
	if _, ok := registry.Resolve("custom"); ok {
		t.Fatal("registry resolved a non-public profile")
	}
}

func TestSuiteRegistryRejectsIncompleteOrUnsafeMethodology(t *testing.T) {
	tests := []struct {
		name   string
		mutate func([]SuiteDefinition) []SuiteDefinition
	}{
		{name: "missing profile", mutate: func(values []SuiteDefinition) []SuiteDefinition { return values[:2] }},
		{name: "duplicate profile", mutate: func(values []SuiteDefinition) []SuiteDefinition { values[2].Profile = values[1].Profile; return values }},
		{name: "unknown source", mutate: func(values []SuiteDefinition) []SuiteDefinition {
			values[0].Configurations[0].SourceClass = "gemini_actual"
			return values
		}},
		{name: "non object config", mutate: func(values []SuiteDefinition) []SuiteDefinition {
			values[0].Configurations[0].Configuration = json.RawMessage(`[]`)
			return values
		}},
		{name: "bad prompt hash", mutate: func(values []SuiteDefinition) []SuiteDefinition { values[0].PromptSuiteHash = "latest"; return values }},
		{name: "control in version", mutate: func(values []SuiteDefinition) []SuiteDefinition {
			values[0].ScoringVersion = "score\nlatest"
			return values
		}},
		{name: "no configurations", mutate: func(values []SuiteDefinition) []SuiteDefinition { values[0].Configurations = nil; return values }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewSuiteRegistry(test.mutate(testSuiteDefinitions())); err == nil {
				t.Fatal("NewSuiteRegistry succeeded, want validation error")
			}
		})
	}
}
