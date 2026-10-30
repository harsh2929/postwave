// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"errors"

	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

var ErrScenarioNotFound = errors.New("campaign coverage: scenario not found")

// CompilationScenario is the clean handoff to the canonical campaign
// compiler. Structured provider policy and wire metadata remain external plan
// inputs; this value resolves only the frozen coverage coordinate and synthetic
// semantic slot values.
type CompilationScenario struct {
	ScenarioID string
	VariantID  string
	Locale     string
	BranchKey  string
	FixtureID  string
	Slots      map[semanticemail.SlotID]string
}

// ResolveScenario verifies the manifest before resolving one scenario. The
// returned map is a fresh copy; callers cannot mutate the frozen manifest.
func (m Manifest) ResolveScenario(scenarioID string) (CompilationScenario, error) {
	diagnostics := ValidateManifest(m)
	if diagnostics.HasErrors() {
		return CompilationScenario{}, diagnostics
	}
	fixtures := make(map[string]Fixture, len(m.Fixtures))
	for _, fixture := range m.Fixtures {
		fixtures[fixture.ID] = fixture
	}
	for _, scenario := range m.Scenarios {
		if scenario.ID != scenarioID {
			continue
		}
		return compilationScenario(scenario, fixtures[scenario.FixtureID]), nil
	}
	return CompilationScenario{}, ErrScenarioNotFound
}

// CompilationScenarios verifies and resolves the complete canonical scenario
// list in stable scenario-ID order.
func (m Manifest) CompilationScenarios() ([]CompilationScenario, error) {
	diagnostics := ValidateManifest(m)
	if diagnostics.HasErrors() {
		return nil, diagnostics
	}
	fixtures := make(map[string]Fixture, len(m.Fixtures))
	for _, fixture := range m.Fixtures {
		fixtures[fixture.ID] = fixture
	}
	out := make([]CompilationScenario, len(m.Scenarios))
	for i, scenario := range m.Scenarios {
		out[i] = compilationScenario(scenario, fixtures[scenario.FixtureID])
	}
	return out, nil
}

func compilationScenario(scenario Scenario, fixture Fixture) CompilationScenario {
	return CompilationScenario{
		ScenarioID: scenario.ID, VariantID: scenario.VariantID,
		Locale: scenario.Locale, BranchKey: scenario.BranchKey,
		FixtureID: scenario.FixtureID, Slots: compileSlots(assignmentMapFromFixture(fixture)),
	}
}
