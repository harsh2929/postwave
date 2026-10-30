// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

func TestCompilationScenarioHandoffIsCompleteAndDefensive(t *testing.T) {
	manifest, diagnostics := Enumerate(validInput(t))
	if diagnostics.HasErrors() {
		t.Fatalf("Enumerate() diagnostics = %v", diagnostics)
	}
	resolved, err := manifest.CompilationScenarios()
	if err != nil {
		t.Fatalf("CompilationScenarios() error = %v", err)
	}
	if len(resolved) != len(manifest.Scenarios) {
		t.Fatalf("resolved scenarios = %d, want %d", len(resolved), len(manifest.Scenarios))
	}
	for i, scenario := range resolved {
		if scenario.ScenarioID != manifest.Scenarios[i].ID || scenario.BranchKey != manifest.Scenarios[i].BranchKey {
			t.Fatalf("resolved coordinate %d drifted: %+v / %+v", i, scenario, manifest.Scenarios[i])
		}
	}
	resolved[0].Slots[semanticemail.SlotID("first_name")] = "mutated"
	again, err := manifest.ResolveScenario(resolved[0].ScenarioID)
	if err != nil {
		t.Fatalf("ResolveScenario() error = %v", err)
	}
	if again.Slots[semanticemail.SlotID("first_name")] == "mutated" {
		t.Fatal("caller mutation escaped into frozen scenario resolution")
	}
}

func TestResolveScenarioRejectsUnknownAndInvalidManifest(t *testing.T) {
	manifest, diagnostics := Enumerate(validInput(t))
	if diagnostics.HasErrors() {
		t.Fatalf("Enumerate() diagnostics = %v", diagnostics)
	}
	if _, err := manifest.ResolveScenario("scn1_unknown"); !errors.Is(err, ErrScenarioNotFound) {
		t.Fatalf("unknown scenario error = %v, want ErrScenarioNotFound", err)
	}
	manifest.CoverageHash = "invalid"
	if _, err := manifest.CompilationScenarios(); err == nil {
		t.Fatal("invalid manifest was resolved")
	}
}
