// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	hashPattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	referencePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

func canonicalJSON(value any) ([]byte, error) {
	return json.Marshal(value)
}

func digest(value any) (string, error) {
	encoded, err := canonicalJSON(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func fixtureID(assignments []SlotAssignment) string {
	hash, _ := digest(struct {
		Version     string           `json:"version"`
		Assignments []SlotAssignment `json:"assignments"`
	}{FixtureSetVersionV1, assignments})
	return "fx1_" + hash
}

func branchKey(variantID string, outcomes []NodeOutcome) string {
	hash, _ := digest(struct {
		Version   string        `json:"version"`
		VariantID string        `json:"variant_id"`
		Outcomes  []NodeOutcome `json:"outcomes"`
	}{EnumeratorVersion, variantID, outcomes})
	return "br1_" + hash
}

func scenarioID(variantID, locale, branch, fixture string) string {
	hash, _ := digest(struct {
		Version   string `json:"version"`
		VariantID string `json:"variant_id"`
		Locale    string `json:"locale"`
		Branch    string `json:"branch_key"`
		Fixture   string `json:"fixture_id"`
	}{EnumeratorVersion, variantID, locale, branch, fixture})
	return "scn1_" + hash
}

func requirementID(requirement Requirement) string {
	hash, _ := digest(struct {
		Version     string          `json:"version"`
		Kind        RequirementKind `json:"kind"`
		VariantID   string          `json:"variant_id"`
		Locale      string          `json:"locale,omitempty"`
		NodeID      string          `json:"node_id"`
		ConditionID string          `json:"condition_id,omitempty"`
		SlotID      string          `json:"slot_id,omitempty"`
		Expected    string          `json:"expected"`
		SourcePath  string          `json:"source_path"`
		Critical    bool            `json:"critical"`
	}{
		EnumeratorVersion, requirement.Kind, requirement.VariantID,
		requirement.Locale, requirement.NodeID, requirement.ConditionID,
		requirement.SlotID, requirement.Expected, requirement.SourcePath,
		requirement.Critical,
	})
	return "req1_" + hash
}

type coverageHashPayload struct {
	SchemaVersion        int               `json:"schema_version"`
	EnumeratorVersion    string            `json:"enumerator_version"`
	FixtureSetVersion    string            `json:"fixture_set_version"`
	SourceHash           string            `json:"source_hash"`
	FactContractHash     string            `json:"fact_contract_hash"`
	RevisionVariantsHash string            `json:"revision_variants_hash"`
	VariantSetHash       string            `json:"variant_set_hash"`
	FixtureSetHash       string            `json:"fixture_set_hash"`
	ScenarioSetHash      string            `json:"scenario_set_hash"`
	Variants             []VariantIdentity `json:"variants"`
	Locales              []string          `json:"locales"`
	Fixtures             []Fixture         `json:"fixtures"`
	Branches             []Branch          `json:"branches"`
	Requirements         []Requirement     `json:"requirements"`
	Scenarios            []Scenario        `json:"scenarios"`
}

func manifestPayload(manifest Manifest) coverageHashPayload {
	return coverageHashPayload{
		SchemaVersion: manifest.SchemaVersion, EnumeratorVersion: manifest.EnumeratorVersion,
		FixtureSetVersion: manifest.FixtureSetVersion, SourceHash: manifest.SourceHash,
		FactContractHash: manifest.FactContractHash, RevisionVariantsHash: manifest.RevisionVariantsHash,
		VariantSetHash: manifest.VariantSetHash, FixtureSetHash: manifest.FixtureSetHash,
		ScenarioSetHash: manifest.ScenarioSetHash, Variants: manifest.Variants,
		Locales: manifest.Locales, Fixtures: manifest.Fixtures, Branches: manifest.Branches,
		Requirements: manifest.Requirements, Scenarios: manifest.Scenarios,
	}
}

func finalizeHashes(manifest *Manifest) error {
	var err error
	manifest.VariantSetHash, err = digest(struct {
		Version  string            `json:"version"`
		Variants []VariantIdentity `json:"variants"`
	}{EnumeratorVersion, manifest.Variants})
	if err != nil {
		return err
	}
	manifest.FixtureSetHash, err = digest(struct {
		Version  string    `json:"version"`
		Fixtures []Fixture `json:"fixtures"`
	}{manifest.FixtureSetVersion, manifest.Fixtures})
	if err != nil {
		return err
	}
	manifest.ScenarioSetHash, err = digest(struct {
		Version      string        `json:"version"`
		Branches     []Branch      `json:"branches"`
		Requirements []Requirement `json:"requirements"`
		Scenarios    []Scenario    `json:"scenarios"`
	}{EnumeratorVersion, manifest.Branches, manifest.Requirements, manifest.Scenarios})
	if err != nil {
		return err
	}
	manifest.CoverageHash, err = digest(manifestPayload(*manifest))
	return err
}

func encodeCanonicalManifest(manifest Manifest) (json.RawMessage, error) {
	diagnostics := ValidateManifest(manifest)
	if diagnostics.HasErrors() {
		return nil, diagnostics
	}
	encoded, err := canonicalJSON(manifest)
	if err != nil {
		return nil, fmt.Errorf("encode campaign coverage manifest: %w", err)
	}
	return json.RawMessage(encoded), nil
}

// DecodeManifest rejects unknown fields, trailing values, non-canonical JSON,
// stale hashes, duplicate coordinates, and identity collisions.
func DecodeManifest(raw json.RawMessage) (Manifest, Diagnostics) {
	sink := diagnosticSink{}
	if len(raw) > MaxManifestBytes {
		sink.error(CodeLimitExceeded, "", fmt.Sprintf("coverage manifest exceeds the hard limit of %d bytes", MaxManifestBytes))
		return Manifest{}, sink.items
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		sink.error(CodeInvalidJSON, "", "decode coverage manifest: "+err.Error())
		return Manifest{}, sink.items
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		sink.error(CodeInvalidJSON, "", "coverage manifest contains trailing JSON")
		return Manifest{}, sink.items
	}
	canonical, err := canonicalJSON(manifest)
	if err != nil {
		sink.error(CodeInvalidJSON, "", "encode coverage manifest: "+err.Error())
		return Manifest{}, sink.items
	}
	if !bytes.Equal(bytes.TrimSpace(raw), canonical) {
		sink.error(CodeManifestNotCanonical, "", "coverage manifest must use its canonical JSON encoding")
	}
	validation := ValidateManifest(manifest)
	sink.items = append(sink.items, validation...)
	if sink.items.HasErrors() {
		return Manifest{}, sink.items
	}
	return manifest, sink.items
}

// ValidateManifest independently verifies the closed coverage receipt. It does
// not trust IDs or stored hashes supplied by a database or another service.
func ValidateManifest(manifest Manifest) Diagnostics {
	sink := diagnosticSink{}
	if manifest.SchemaVersion != ManifestSchemaVersion {
		sink.error(CodeUnsupportedVersion, "/schema_version", "schema_version must be 1")
	}
	if manifest.EnumeratorVersion != EnumeratorVersion {
		sink.error(CodeUnsupportedVersion, "/enumerator_version", "enumerator_version is not supported")
	}
	if manifest.FixtureSetVersion != FixtureSetVersionV1 {
		sink.error(CodeUnsupportedVersion, "/fixture_set_version", "fixture_set_version is not supported")
	}
	for _, field := range []struct{ path, value string }{
		{"/source_hash", manifest.SourceHash}, {"/fact_contract_hash", manifest.FactContractHash},
		{"/revision_variants_hash", manifest.RevisionVariantsHash}, {"/variant_set_hash", manifest.VariantSetHash},
		{"/fixture_set_hash", manifest.FixtureSetHash}, {"/scenario_set_hash", manifest.ScenarioSetHash},
		{"/coverage_hash", manifest.CoverageHash},
	} {
		if !hashPattern.MatchString(field.value) {
			sink.error(CodeInvalidInput, field.path, "value must be a lowercase SHA-256 hex digest")
		}
	}
	if len(manifest.Variants) == 0 || len(manifest.Variants) > MaxVariants {
		sink.error(CodeLimitExceeded, "/variants", fmt.Sprintf("variant count must be between 1 and %d", MaxVariants))
	}
	if len(manifest.Locales) == 0 || len(manifest.Locales) > MaxLocales {
		sink.error(CodeLimitExceeded, "/locales", fmt.Sprintf("locale count must be between 1 and %d", MaxLocales))
	}
	if len(manifest.Fixtures) == 0 || len(manifest.Fixtures) > MaxFixtures {
		sink.error(CodeLimitExceeded, "/fixtures", fmt.Sprintf("fixture count must be between 1 and %d", MaxFixtures))
	}
	if len(manifest.Scenarios) == 0 || len(manifest.Scenarios) > MaxScenarios {
		sink.error(CodeLimitExceeded, "/scenarios", fmt.Sprintf("scenario count must be between 1 and %d", MaxScenarios))
	}
	if len(manifest.Branches) > MaxScenarios {
		sink.error(CodeLimitExceeded, "/branches", fmt.Sprintf("branch count exceeds %d", MaxScenarios))
	}
	if len(manifest.Requirements) > MaxRequirements {
		sink.error(CodeLimitExceeded, "/requirements", fmt.Sprintf("requirement count exceeds %d", MaxRequirements))
	}
	validateManifestIdentities(&sink, manifest)

	expected := manifest
	if err := finalizeHashes(&expected); err != nil {
		sink.error(CodeInvalidInput, "", "recompute coverage hashes: "+err.Error())
		return sink.items
	}
	for _, candidate := range []struct{ path, actual, want string }{
		{"/variant_set_hash", manifest.VariantSetHash, expected.VariantSetHash},
		{"/fixture_set_hash", manifest.FixtureSetHash, expected.FixtureSetHash},
		{"/scenario_set_hash", manifest.ScenarioSetHash, expected.ScenarioSetHash},
		{"/coverage_hash", manifest.CoverageHash, expected.CoverageHash},
	} {
		if candidate.actual != candidate.want {
			sink.error(CodeManifestHashMismatch, candidate.path, "stored hash does not match canonical manifest content")
		}
	}
	return sink.items
}

func validateManifestIdentities(sink *diagnosticSink, manifest Manifest) {
	variantIDs := validateManifestVariants(sink, manifest)
	localeIDs := validateManifestLocales(sink, manifest)
	fixtures := validateManifestFixtures(sink, manifest)
	branches := validateManifestBranches(sink, manifest, variantIDs)
	scenarios := validateManifestScenarios(sink, manifest, variantIDs, localeIDs, fixtures, branches)
	validateManifestRequirements(sink, manifest, variantIDs, localeIDs, fixtures, branches, scenarios)
}

// validateManifestVariants checks variant identity, hashes, and canonical
// ordering, and indexes the variants by id.
func validateManifestVariants(sink *diagnosticSink, manifest Manifest) map[string]VariantIdentity {
	variantIDs := make(map[string]VariantIdentity, len(manifest.Variants))
	previous := ""
	for i, variant := range manifest.Variants {
		path := fmt.Sprintf("/variants/%d", i)
		if !validReference(variant.ID) {
			sink.error(CodeInvalidReference, path+"/id", "variant id is not a stable reference")
		}
		if !hashPattern.MatchString(variant.DocumentHash) {
			sink.error(CodeInvalidInput, path+"/document_hash", "document_hash must be a lowercase SHA-256 hex digest")
		}
		if _, duplicate := variantIDs[variant.ID]; duplicate {
			sink.error(CodeDuplicate, path+"/id", "variant id is duplicated")
		}
		if previous != "" && variant.ID <= previous {
			sink.error(CodeManifestNotCanonical, path+"/id", "variants must be strictly sorted by id")
		}
		variantIDs[variant.ID] = variant
		previous = variant.ID
	}
	return variantIDs
}

// validateManifestLocales checks locale canonicality and ordering, and
// indexes the locales.
func validateManifestLocales(sink *diagnosticSink, manifest Manifest) map[string]struct{} {
	localeIDs := make(map[string]struct{}, len(manifest.Locales))
	previous := ""
	for i, locale := range manifest.Locales {
		path := fmt.Sprintf("/locales/%d", i)
		canonical, ok := canonicalLocale(locale)
		if !ok || canonical != locale {
			sink.error(CodeInvalidLocale, path, "locale must be a canonical BCP 47 language tag")
		}
		if _, duplicate := localeIDs[locale]; duplicate {
			sink.error(CodeDuplicate, path, "locale is duplicated")
		}
		if previous != "" && locale <= previous {
			sink.error(CodeManifestNotCanonical, path, "locales must be strictly sorted")
		}
		localeIDs[locale] = struct{}{}
		previous = locale
	}
	return localeIDs
}

// validateManifestFixtures checks each fixture's shape, shared slot schema,
// derived id, and ordering, and indexes the fixtures by id.
func validateManifestFixtures(sink *diagnosticSink, manifest Manifest) map[string]Fixture {
	fixtures := make(map[string]Fixture, len(manifest.Fixtures))
	var fixtureSlotSchema []string
	previous := ""
	for i, fixture := range manifest.Fixtures {
		path := fmt.Sprintf("/fixtures/%d", i)
		validateFixture(sink, path, fixture)
		currentSchema := make([]string, len(fixture.Assignments))
		for assignmentIndex, assignment := range fixture.Assignments {
			currentSchema[assignmentIndex] = assignment.SlotID
		}
		if i == 0 {
			fixtureSlotSchema = currentSchema
		} else if !slicesEqual(fixtureSlotSchema, currentSchema) {
			sink.error(CodeInvalidInput, path+"/assignments", "every fixture must declare the same complete slot set")
		}
		if fixture.ID != fixtureID(fixture.Assignments) {
			sink.error(CodeManifestHashMismatch, path+"/id", "fixture id does not match assignments")
		}
		if existing, duplicate := fixtures[fixture.ID]; duplicate {
			if !equalCanonical(existing, fixture) {
				sink.error(CodeCollision, path+"/id", "fixture id collides with different content")
			} else {
				sink.error(CodeDuplicate, path+"/id", "fixture is duplicated")
			}
		}
		if previous != "" && fixture.ID <= previous {
			sink.error(CodeManifestNotCanonical, path+"/id", "fixtures must be strictly sorted by id")
		}
		fixtures[fixture.ID] = fixture
		previous = fixture.ID
	}
	return fixtures
}

// validateManifestBranches checks each branch's variant reference, derived
// key, outcomes, and ordering, and indexes the branches by key.
func validateManifestBranches(sink *diagnosticSink, manifest Manifest, variantIDs map[string]VariantIdentity) map[string]Branch {
	branches := make(map[string]Branch, len(manifest.Branches))
	previous := ""
	for i, branch := range manifest.Branches {
		path := fmt.Sprintf("/branches/%d", i)
		if _, ok := variantIDs[branch.VariantID]; !ok {
			sink.error(CodeInvalidReference, path+"/variant_id", "branch references an unknown variant")
		}
		if branch.Key != branchKey(branch.VariantID, branch.Outcomes) {
			sink.error(CodeManifestHashMismatch, path+"/key", "branch key does not match outcomes")
		}
		validateBranch(sink, path, branch)
		if existing, duplicate := branches[branch.Key]; duplicate {
			if !equalCanonical(existing, branch) {
				sink.error(CodeCollision, path+"/key", "branch key collides with different outcomes")
			} else {
				sink.error(CodeDuplicate, path+"/key", "branch is duplicated")
			}
		}
		if previous != "" && branch.Key <= previous {
			sink.error(CodeManifestNotCanonical, path+"/key", "branches must be strictly sorted by key")
		}
		branches[branch.Key] = branch
		previous = branch.Key
	}
	return branches
}

// validateManifestScenarios checks every scenario coordinate against the
// variants, locales, branches, and fixtures it references, then proves the
// full variant × locale × fixture matrix is covered and every branch and
// fixture is used. It indexes the scenarios by id.
func validateManifestScenarios(
	sink *diagnosticSink, manifest Manifest,
	variantIDs map[string]VariantIdentity, localeIDs map[string]struct{},
	fixtures map[string]Fixture, branches map[string]Branch,
) map[string]Scenario {
	scenarios := make(map[string]Scenario, len(manifest.Scenarios))
	coordinates := make(map[string]string, len(manifest.Scenarios))
	axisCoordinates := make(map[string]string, len(manifest.Scenarios))
	referencedBranches := make(map[string]struct{}, len(manifest.Branches))
	referencedFixtures := make(map[string]struct{}, len(manifest.Fixtures))
	previous := ""
	for i, scenario := range manifest.Scenarios {
		path := fmt.Sprintf("/scenarios/%d", i)
		if _, ok := variantIDs[scenario.VariantID]; !ok {
			sink.error(CodeInvalidReference, path+"/variant_id", "scenario references an unknown variant")
		}
		if _, ok := localeIDs[scenario.Locale]; !ok {
			sink.error(CodeInvalidReference, path+"/locale", "scenario references an unknown locale")
		}
		branch, branchOK := branches[scenario.BranchKey]
		if !branchOK || branch.VariantID != scenario.VariantID {
			sink.error(CodeInvalidReference, path+"/branch_key", "scenario references an unknown or cross-variant branch")
		} else {
			referencedBranches[scenario.BranchKey] = struct{}{}
			validateScenarioBranchParity(sink, path, scenario, branch)
		}
		fixture, fixtureOK := fixtures[scenario.FixtureID]
		if !fixtureOK {
			sink.error(CodeInvalidReference, path+"/fixture_id", "scenario references an unknown fixture")
		} else {
			referencedFixtures[scenario.FixtureID] = struct{}{}
			assignmentHash, _ := digest(fixture.Assignments)
			if scenario.AssignmentHash != assignmentHash {
				sink.error(CodeManifestHashMismatch, path+"/assignment_hash", "assignment_hash does not match fixture")
			}
		}
		wantID := scenarioID(scenario.VariantID, scenario.Locale, scenario.BranchKey, scenario.FixtureID)
		if scenario.ID != wantID {
			sink.error(CodeManifestHashMismatch, path+"/id", "scenario id does not match its coordinate")
		}
		coordinate := strings.Join([]string{scenario.VariantID, scenario.Locale, scenario.BranchKey, scenario.FixtureID}, "\x00")
		if first, duplicate := coordinates[coordinate]; duplicate {
			sink.error(CodeDuplicate, path, "scenario coordinate duplicates "+first)
		} else {
			coordinates[coordinate] = path
		}
		axisCoordinate := strings.Join([]string{scenario.VariantID, scenario.Locale, scenario.FixtureID}, "\x00")
		if first, duplicate := axisCoordinates[axisCoordinate]; duplicate {
			sink.error(CodeDuplicate, path, "variant/locale/fixture coordinate duplicates "+first)
		} else {
			axisCoordinates[axisCoordinate] = path
		}
		if !hashPattern.MatchString(scenario.AssignmentHash) {
			sink.error(CodeInvalidInput, path+"/assignment_hash", "assignment_hash must be a lowercase SHA-256 hex digest")
		}
		validateIncludedNodeIDs(sink, path+"/included_node_ids", scenario.IncludedNodeIDs)
		if existing, duplicate := scenarios[scenario.ID]; duplicate {
			if !equalCanonical(existing, scenario) {
				sink.error(CodeCollision, path+"/id", "scenario id collides with a different coordinate")
			} else {
				sink.error(CodeDuplicate, path+"/id", "scenario is duplicated")
			}
		}
		if previous != "" && scenario.ID <= previous {
			sink.error(CodeManifestNotCanonical, path+"/id", "scenarios must be strictly sorted by id")
		}
		scenarios[scenario.ID] = scenario
		previous = scenario.ID
	}
	for _, variant := range manifest.Variants {
		for _, locale := range manifest.Locales {
			for _, fixture := range manifest.Fixtures {
				coordinate := strings.Join([]string{variant.ID, locale, fixture.ID}, "\x00")
				if _, exists := axisCoordinates[coordinate]; !exists {
					sink.error(CodeBranchUncovered, "/scenarios", "full variant × locale × fixture matrix is incomplete")
				}
			}
		}
	}
	for _, branch := range manifest.Branches {
		if _, referenced := referencedBranches[branch.Key]; !referenced {
			sink.error(CodeInvalidReference, "/branches", "manifest contains a branch with no scenario")
		}
	}
	for _, fixture := range manifest.Fixtures {
		if _, referenced := referencedFixtures[fixture.ID]; !referenced {
			sink.error(CodeInvalidReference, "/fixtures", "manifest contains a fixture with no scenario")
		}
	}
	return scenarios
}

// validateManifestRequirements checks each requirement's derived id,
// references, reachability witnesses, and ordering.
func validateManifestRequirements(
	sink *diagnosticSink, manifest Manifest,
	variantIDs map[string]VariantIdentity, localeIDs map[string]struct{},
	fixtures map[string]Fixture, branches map[string]Branch, scenarios map[string]Scenario,
) {
	requirements := make(map[string]Requirement, len(manifest.Requirements))
	previous := ""
	for i, requirement := range manifest.Requirements {
		path := fmt.Sprintf("/requirements/%d", i)
		validateRequirementShape(sink, path, requirement)
		if requirement.ID != requirementID(requirement) {
			sink.error(CodeManifestHashMismatch, path+"/id", "requirement id does not match its proof coordinate")
		}
		if _, ok := variantIDs[requirement.VariantID]; !ok {
			sink.error(CodeInvalidReference, path+"/variant_id", "requirement references an unknown variant")
		}
		if requirement.Locale != "" {
			if _, ok := localeIDs[requirement.Locale]; !ok {
				sink.error(CodeInvalidReference, path+"/locale", "requirement references an unknown locale")
			}
		}
		if requirement.Reachable {
			if requirement.WitnessFixtureID == "" {
				sink.error(CodeBranchUncovered, path+"/witness_fixture_id", "reachable requirement has no fixture witness")
			} else if _, ok := fixtures[requirement.WitnessFixtureID]; !ok {
				sink.error(CodeInvalidReference, path+"/witness_fixture_id", "requirement references an unknown fixture")
			}
			if requirement.WitnessScenarioID == "" {
				sink.error(CodeBranchUncovered, path+"/witness_scenario_id", "reachable requirement has no scenario witness")
			} else if witness, ok := scenarios[requirement.WitnessScenarioID]; !ok {
				sink.error(CodeInvalidReference, path+"/witness_scenario_id", "requirement references an unknown scenario")
			} else {
				validateRequirementWitness(sink, path, requirement, witness, branches)
			}
		} else if requirement.WitnessFixtureID != "" || requirement.WitnessScenarioID != "" {
			sink.error(CodeInvalidInput, path, "unreachable requirement must not have a witness")
		}
		if existing, duplicate := requirements[requirement.ID]; duplicate {
			if !equalCanonical(existing, requirement) {
				sink.error(CodeCollision, path+"/id", "requirement id collides with different content")
			} else {
				sink.error(CodeDuplicate, path+"/id", "requirement is duplicated")
			}
		}
		if previous != "" && requirement.ID <= previous {
			sink.error(CodeManifestNotCanonical, path+"/id", "requirements must be strictly sorted by id")
		}
		requirements[requirement.ID] = requirement
		previous = requirement.ID
	}
}

func validateFixture(sink *diagnosticSink, path string, fixture Fixture) {
	if len(fixture.Profiles) == 0 || len(fixture.Profiles) > 6 || !strictlySortedFixtureProfiles(fixture.Profiles) {
		sink.error(CodeManifestNotCanonical, path+"/profiles", "fixture profiles must be non-empty, unique, and sorted")
	}
	if len(fixture.Purposes) == 0 || len(fixture.Purposes) > MaxRequirements+6 || !strictlySortedStrings(fixture.Purposes) {
		sink.error(CodeManifestNotCanonical, path+"/purposes", "fixture purposes must be unique and sorted")
	}
	for i, purpose := range fixture.Purposes {
		if !boundedControlFree(purpose, 512) {
			sink.error(CodeInvalidInput, fmt.Sprintf("%s/purposes/%d", path, i), "fixture purpose must be bounded, valid UTF-8, and control-free")
		}
	}
	if len(fixture.Assignments) > MaxSlots {
		sink.error(CodeLimitExceeded, path+"/assignments", fmt.Sprintf("fixture assignment count exceeds %d", MaxSlots))
	}
	previous := ""
	for i, assignment := range fixture.Assignments {
		assignmentPath := fmt.Sprintf("%s/assignments/%d", path, i)
		if !validReference(assignment.SlotID) {
			sink.error(CodeInvalidReference, assignmentPath+"/slot_id", "slot id is not a stable reference")
		}
		if previous != "" && assignment.SlotID <= previous {
			sink.error(CodeManifestNotCanonical, assignmentPath+"/slot_id", "fixture assignments must be strictly sorted by slot_id")
		}
		previous = assignment.SlotID
		switch assignment.State {
		case AssignmentMissing, AssignmentEmpty:
			if assignment.Value != "" {
				sink.error(CodeInvalidInput, assignmentPath+"/value", "missing and empty assignments cannot carry a value")
			}
		case AssignmentValue:
			if assignment.Value == "" || !safeFixtureValue(assignment.Value) {
				sink.error(CodeRecipientPIIForbidden, assignmentPath+"/value", "fixture value must be bounded, control-free, and synthetic-safe")
			}
		default:
			sink.error(CodeInvalidInput, assignmentPath+"/state", "assignment state is not supported")
		}
	}
}

func validateBranch(sink *diagnosticSink, path string, branch Branch) {
	if len(branch.Outcomes) > 512 {
		sink.error(CodeLimitExceeded, path+"/outcomes", "branch contains more outcomes than semantic v2 permits nodes")
	}
	seenNodes := make(map[string]struct{}, len(branch.Outcomes))
	seenConditions := make(map[string]struct{})
	totalConditions := 0
	for nodeIndex, outcome := range branch.Outcomes {
		nodePath := fmt.Sprintf("%s/outcomes/%d", path, nodeIndex)
		if !validReference(outcome.NodeID) {
			sink.error(CodeInvalidReference, nodePath+"/node_id", "branch node id is not a stable reference")
		}
		if _, duplicate := seenNodes[outcome.NodeID]; duplicate {
			sink.error(CodeDuplicate, nodePath+"/node_id", "branch node outcome is duplicated")
		}
		seenNodes[outcome.NodeID] = struct{}{}
		if len(outcome.Conditions) == 0 {
			sink.error(CodeInvalidInput, nodePath+"/conditions", "branch outcomes must describe at least one condition")
		}
		if len(outcome.Conditions) > 32 {
			sink.error(CodeLimitExceeded, nodePath+"/conditions", "branch node contains more conditions than semantic v2 permits")
		}
		totalConditions += len(outcome.Conditions)
		included := true
		for conditionIndex, condition := range outcome.Conditions {
			conditionPath := fmt.Sprintf("%s/conditions/%d/condition_id", nodePath, conditionIndex)
			if !validReference(condition.ConditionID) {
				sink.error(CodeInvalidReference, conditionPath, "condition id is not a stable reference")
			}
			if _, duplicate := seenConditions[condition.ConditionID]; duplicate {
				sink.error(CodeDuplicate, conditionPath, "condition outcome is duplicated in this branch")
			}
			seenConditions[condition.ConditionID] = struct{}{}
			included = included && condition.Matched
		}
		if included != outcome.Included {
			sink.error(CodeInvalidInput, nodePath+"/included", "node inclusion must equal the conjunction of its condition outcomes")
		}
	}
	if totalConditions > MaxConditions {
		sink.error(CodeLimitExceeded, path+"/outcomes", fmt.Sprintf("branch condition outcomes exceed %d", MaxConditions))
	}
}

func validateScenarioBranchParity(sink *diagnosticSink, path string, scenario Scenario, branch Branch) {
	for _, outcome := range branch.Outcomes {
		included := containsString(scenario.IncludedNodeIDs, outcome.NodeID)
		if included != outcome.Included {
			sink.error(CodeInvalidInput, path+"/included_node_ids", "included node ids disagree with the referenced conditional branch")
		}
	}
}

func validateIncludedNodeIDs(sink *diagnosticSink, path string, ids []string) {
	if len(ids) > 512 {
		sink.error(CodeLimitExceeded, path, "included node ids exceed the semantic v2 node bound")
	}
	seen := make(map[string]struct{}, len(ids))
	for i, id := range ids {
		itemPath := fmt.Sprintf("%s/%d", path, i)
		if !validReference(id) {
			sink.error(CodeInvalidReference, itemPath, "included node id is not a stable reference")
		}
		if _, duplicate := seen[id]; duplicate {
			sink.error(CodeDuplicate, itemPath, "included node id is duplicated")
		}
		seen[id] = struct{}{}
	}
}

func validateRequirementShape(sink *diagnosticSink, path string, requirement Requirement) {
	if !validReference(requirement.NodeID) {
		sink.error(CodeInvalidReference, path+"/node_id", "requirement node id is not a stable reference")
	}
	if requirement.ConditionID != "" && !validReference(requirement.ConditionID) {
		sink.error(CodeInvalidReference, path+"/condition_id", "requirement condition id is not a stable reference")
	}
	if requirement.SlotID != "" && !validReference(requirement.SlotID) {
		sink.error(CodeInvalidReference, path+"/slot_id", "requirement slot id is not a stable reference")
	}
	if requirement.SourcePath == "" || !strings.HasPrefix(requirement.SourcePath, "/") || !boundedControlFree(requirement.SourcePath, 4096) {
		sink.error(CodeInvalidInput, path+"/source_path", "source_path must be a bounded absolute JSON pointer")
	}
	if requirement.Expected == "" || !boundedControlFree(requirement.Expected, 128) {
		sink.error(CodeInvalidInput, path+"/expected", "expected must be a bounded proof predicate")
	}
	switch requirement.Kind {
	case RequirementNodeIncluded:
		if requirement.Locale != "" || requirement.ConditionID != "" || requirement.SlotID != "" || requirement.Expected != "all_conditions_true" {
			sink.error(CodeInvalidInput, path, "node_included requirement has an invalid coordinate")
		}
	case RequirementConditionEdge:
		if requirement.Locale != "" || requirement.ConditionID == "" || requirement.SlotID != "" || requirement.Expected != "condition_false_with_peers_true" {
			sink.error(CodeInvalidInput, path, "condition_edge requirement has an invalid coordinate")
		}
	case RequirementContractBlock:
		if requirement.Locale == "" || requirement.ConditionID != "" || requirement.SlotID != "" || requirement.Expected != "node_included" || !requirement.Reachable {
			sink.error(CodeInvalidInput, path, "contract_block requirement has an invalid coordinate")
		}
	case RequirementFactBearingSlot:
		if requirement.Locale == "" || requirement.ConditionID != "" || requirement.SlotID == "" || requirement.Expected != "nonempty_fixture_value_or_fallback" || !requirement.Reachable {
			sink.error(CodeInvalidInput, path, "fact_bearing_slot requirement has an invalid coordinate")
		}
	default:
		sink.error(CodeInvalidInput, path+"/kind", "requirement kind is not supported")
	}
}

func validateRequirementWitness(sink *diagnosticSink, path string, requirement Requirement, witness Scenario, branches map[string]Branch) {
	if witness.VariantID != requirement.VariantID {
		sink.error(CodeInvalidReference, path+"/witness_scenario_id", "witness scenario belongs to a different variant")
	}
	if requirement.Locale != "" && witness.Locale != requirement.Locale {
		sink.error(CodeInvalidReference, path+"/witness_scenario_id", "witness scenario belongs to a different locale")
	}
	if witness.FixtureID != requirement.WitnessFixtureID {
		sink.error(CodeInvalidReference, path+"/witness_fixture_id", "witness fixture does not match the witness scenario")
	}
	branch, ok := branches[witness.BranchKey]
	if !ok {
		return
	}
	switch requirement.Kind {
	case RequirementNodeIncluded:
		outcome, found := findNodeOutcome(branch.Outcomes, requirement.NodeID)
		if !found || !outcome.Included {
			sink.error(CodeBranchUncovered, path+"/witness_scenario_id", "witness does not include the required conditional node")
		}
	case RequirementConditionEdge:
		outcome, found := findNodeOutcome(branch.Outcomes, requirement.NodeID)
		if !found {
			sink.error(CodeBranchUncovered, path+"/witness_scenario_id", "witness has no outcome for the required conditional node")
			return
		}
		matchedTarget := false
		for _, condition := range outcome.Conditions {
			if condition.ConditionID == requirement.ConditionID {
				matchedTarget = true
				if condition.Matched {
					sink.error(CodeBranchUncovered, path+"/witness_scenario_id", "witness condition edge is true, expected false")
				}
			} else if !condition.Matched {
				sink.error(CodeBranchUncovered, path+"/witness_scenario_id", "witness does not keep peer conditions true")
			}
		}
		if !matchedTarget {
			sink.error(CodeBranchUncovered, path+"/witness_scenario_id", "witness has no outcome for the required condition")
		}
	case RequirementContractBlock, RequirementFactBearingSlot:
		if !containsString(witness.IncludedNodeIDs, requirement.NodeID) {
			sink.error(CodeBranchUncovered, path+"/witness_scenario_id", "witness does not include the required fact-bearing node")
		}
	}
}

func findNodeOutcome(outcomes []NodeOutcome, nodeID string) (NodeOutcome, bool) {
	for _, outcome := range outcomes {
		if outcome.NodeID == nodeID {
			return outcome, true
		}
	}
	return NodeOutcome{}, false
}

func slicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func equalCanonical(left, right any) bool {
	l, errLeft := canonicalJSON(left)
	r, errRight := canonicalJSON(right)
	return errLeft == nil && errRight == nil && bytes.Equal(l, r)
}

func validReference(value string) bool {
	if !utf8.ValidString(value) || !referencePattern.MatchString(value) {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func boundedControlFree(value string, maxBytes int) bool {
	if value == "" || len(value) > maxBytes || !utf8.ValidString(value) {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func strictlySortedStrings(values []string) bool {
	for i := 1; i < len(values); i++ {
		if values[i] <= values[i-1] {
			return false
		}
	}
	return true
}

func strictlySortedFixtureProfiles(values []FixtureProfile) bool {
	for i, value := range values {
		switch value {
		case FixtureBaseline, FixtureMissingOptional, FixtureUnicode, FixtureRTL, FixtureLong, FixtureBranchWitness:
		default:
			return false
		}
		if i > 0 && value <= values[i-1] {
			return false
		}
	}
	return true
}

func sortManifest(manifest *Manifest) {
	sort.Slice(manifest.Variants, func(i, j int) bool { return manifest.Variants[i].ID < manifest.Variants[j].ID })
	sort.Strings(manifest.Locales)
	sort.Slice(manifest.Fixtures, func(i, j int) bool { return manifest.Fixtures[i].ID < manifest.Fixtures[j].ID })
	sort.Slice(manifest.Branches, func(i, j int) bool { return manifest.Branches[i].Key < manifest.Branches[j].Key })
	sort.Slice(manifest.Requirements, func(i, j int) bool { return manifest.Requirements[i].ID < manifest.Requirements[j].ID })
	sort.Slice(manifest.Scenarios, func(i, j int) bool { return manifest.Scenarios[i].ID < manifest.Scenarios[j].ID })
}
