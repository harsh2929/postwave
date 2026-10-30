// SPDX-License-Identifier: AGPL-3.0-only

// Package campaigncoverage freezes and proves the bounded semantic scenarios
// that Campaign Assurance must compile. It accepts immutable campaign sources,
// never subscribers or recipient records.
package campaigncoverage

import (
	"encoding/json"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const (
	ManifestSchemaVersion = 1
	EnumeratorVersion     = "postwave.campaign-assurance.coverage.v1"
	FixtureSetVersionV1   = "postwave.campaign-assurance.synthetic-fixtures.v1"

	// Bounds are part of the versioned enumerator contract. Raising one can
	// change the accepted scenario set and therefore requires a new version.
	MaxVariants                = 16
	MaxLocales                 = 32
	MaxSlots                   = 256
	MaxConditions              = 2048
	MaxFixtures                = 2048
	MaxScenarios               = 4096
	MaxRequirements            = 16384
	MaxDiagnostics             = 4096
	MaxFixtureValueRunes       = 512
	MaxManifestBytes           = 32 << 20
	MaxScenarioNodeEvaluations = 1_000_000
)

// Input binds enumeration to one immutable content revision. Variants contains
// the complete active semantic variant set; when it is empty, the revision's
// semantic tree is used as a single "control" variant. Locales defaults to the
// revision locale array and then to the Fact Contract language.
type Input struct {
	Revision          campaignartifact.Revision
	Variants          []Variant
	Locales           []string
	FixtureSetVersion string
}

// Variant is an already decoded, active semantic variant. The adapter that
// reads legacy campaign_variants rows is intentionally outside this package;
// only a typed v2 document can participate in a coverage proof.
type Variant struct {
	ID       string
	Document semanticemail.DocumentV2
}

type FixtureProfile string

const (
	FixtureBaseline        FixtureProfile = "baseline"
	FixtureMissingOptional FixtureProfile = "missing_optional"
	FixtureUnicode         FixtureProfile = "unicode"
	FixtureRTL             FixtureProfile = "rtl"
	FixtureLong            FixtureProfile = "long"
	FixtureBranchWitness   FixtureProfile = "branch_witness"
)

type AssignmentState string

const (
	AssignmentMissing AssignmentState = "missing"
	AssignmentEmpty   AssignmentState = "empty"
	AssignmentValue   AssignmentState = "value"
)

// SlotAssignment is complete and explicit: every known slot is represented,
// including missing and present-but-empty states. This distinction matters for
// present/absent conditions and makes fixture hashes reproducible.
type SlotAssignment struct {
	SlotID string          `json:"slot_id"`
	State  AssignmentState `json:"state"`
	Value  string          `json:"value,omitempty"`
}

type Fixture struct {
	ID          string           `json:"id"`
	Profiles    []FixtureProfile `json:"profiles"`
	Assignments []SlotAssignment `json:"assignments"`
	Purposes    []string         `json:"purposes"`
}

type VariantIdentity struct {
	ID           string `json:"id"`
	DocumentHash string `json:"document_hash"`
}

type ConditionOutcome struct {
	ConditionID string `json:"condition_id"`
	Matched     bool   `json:"matched"`
}

type NodeOutcome struct {
	NodeID     string             `json:"node_id"`
	Included   bool               `json:"included"`
	Conditions []ConditionOutcome `json:"conditions"`
}

type Branch struct {
	Key       string        `json:"key"`
	VariantID string        `json:"variant_id"`
	Outcomes  []NodeOutcome `json:"outcomes"`
}

type Scenario struct {
	ID              string   `json:"id"`
	VariantID       string   `json:"variant_id"`
	Locale          string   `json:"locale"`
	BranchKey       string   `json:"branch_key"`
	FixtureID       string   `json:"fixture_id"`
	AssignmentHash  string   `json:"assignment_hash"`
	IncludedNodeIDs []string `json:"included_node_ids"`
}

type RequirementKind string

const (
	RequirementNodeIncluded    RequirementKind = "node_included"
	RequirementConditionEdge   RequirementKind = "condition_edge"
	RequirementContractBlock   RequirementKind = "contract_block"
	RequirementFactBearingSlot RequirementKind = "fact_bearing_slot"
)

// Requirement is a machine-verifiable proof obligation. Reachable=false is a
// solver result for a redundant/impossible edge, not an uncovered branch.
// Reachable obligations carry exactly one deterministic witness when covered.
type Requirement struct {
	ID                string          `json:"id"`
	Kind              RequirementKind `json:"kind"`
	VariantID         string          `json:"variant_id"`
	Locale            string          `json:"locale,omitempty"`
	NodeID            string          `json:"node_id"`
	ConditionID       string          `json:"condition_id,omitempty"`
	SlotID            string          `json:"slot_id,omitempty"`
	Expected          string          `json:"expected"`
	SourcePath        string          `json:"source_path"`
	Critical          bool            `json:"critical"`
	Reachable         bool            `json:"reachable"`
	WitnessFixtureID  string          `json:"witness_fixture_id,omitempty"`
	WitnessScenarioID string          `json:"witness_scenario_id,omitempty"`
}

// Manifest is a closed, versioned coverage record suitable for
// campaignartifact.PlanInput.CoverageManifest. It contains synthetic slot
// assignments only; there is no recipient identifier/address field.
type Manifest struct {
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
	CoverageHash         string            `json:"coverage_hash"`
}

// JSON returns the exact canonical JSON persisted in a frozen send plan.
func (m Manifest) JSON() (json.RawMessage, error) {
	return encodeCanonicalManifest(m)
}
