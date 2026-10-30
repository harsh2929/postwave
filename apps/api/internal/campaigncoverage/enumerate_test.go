// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

func TestEnumerateGoldenDeterministicMatrix(t *testing.T) {
	input := validInput(t)
	manifest, diagnostics := Enumerate(input)
	if diagnostics.HasErrors() {
		t.Fatalf("Enumerate() diagnostics = %v", diagnostics)
	}
	if manifest.SchemaVersion != ManifestSchemaVersion || manifest.EnumeratorVersion != EnumeratorVersion {
		t.Fatalf("unexpected versions: %+v", manifest)
	}
	if len(manifest.Variants) != 2 || len(manifest.Locales) != 2 {
		t.Fatalf("variant/locale axes = %d/%d, want 2/2", len(manifest.Variants), len(manifest.Locales))
	}
	wantScenarios := len(manifest.Variants) * len(manifest.Locales) * len(manifest.Fixtures)
	if len(manifest.Scenarios) != wantScenarios {
		t.Fatalf("scenarios = %d, want full product %d", len(manifest.Scenarios), wantScenarios)
	}
	for _, requirement := range manifest.Requirements {
		if requirement.Reachable && (requirement.WitnessFixtureID == "" || requirement.WitnessScenarioID == "") {
			t.Fatalf("reachable requirement lacks witnesses: %+v", requirement)
		}
	}
	assertAxisCoverage(t, manifest)
	if got, want := manifest.CoverageHash, "a9d6b769ca7ccd5c1623d26234d8ac07d1af7c1e278672f1709c3d6724c47e55"; got != want {
		t.Fatalf("coverage hash changed: got %s want %s", got, want)
	}

	firstJSON, err := manifest.JSON()
	if err != nil {
		t.Fatalf("Manifest.JSON() error = %v", err)
	}
	second, secondDiagnostics := Enumerate(input)
	if secondDiagnostics.HasErrors() {
		t.Fatalf("second Enumerate() diagnostics = %v", secondDiagnostics)
	}
	secondJSON, err := second.JSON()
	if err != nil {
		t.Fatalf("second Manifest.JSON() error = %v", err)
	}
	if !bytes.Equal(firstJSON, secondJSON) {
		t.Fatal("identical input produced different canonical manifests")
	}
}

func TestEnumerateInvariantToVariantAndLocaleOrder(t *testing.T) {
	input := validInput(t)
	first, diagnostics := Enumerate(input)
	if diagnostics.HasErrors() {
		t.Fatalf("first Enumerate() diagnostics = %v", diagnostics)
	}
	slices.Reverse(input.Variants)
	input.Locales = []string{"HI", "en-in"}
	second, diagnostics := Enumerate(input)
	if diagnostics.HasErrors() {
		t.Fatalf("permuted Enumerate() diagnostics = %v", diagnostics)
	}
	firstJSON, _ := first.JSON()
	secondJSON, _ := second.JSON()
	if !bytes.Equal(firstJSON, secondJSON) {
		t.Fatalf("permuting set inputs changed manifest\nfirst=%s\nsecond=%s", first.CoverageHash, second.CoverageHash)
	}
}

func TestEnumerateUsesFrozenRevisionAsControlByDefault(t *testing.T) {
	input := validInput(t)
	input.Variants = nil
	input.Locales = nil
	manifest, diagnostics := Enumerate(input)
	if diagnostics.HasErrors() {
		t.Fatalf("revision control Enumerate() diagnostics = %v", diagnostics)
	}
	if len(manifest.Variants) != 1 || manifest.Variants[0].ID != "control" {
		t.Fatalf("revision control variants = %+v", manifest.Variants)
	}
	if !slices.Equal(manifest.Locales, []string{"en-IN", "hi"}) {
		t.Fatalf("revision locales = %v, want [en-IN hi]", manifest.Locales)
	}
}

func TestEnumerateRejectsDuplicateCanonicalCoordinates(t *testing.T) {
	t.Run("variant", func(t *testing.T) {
		input := validInput(t)
		input.Variants[1].ID = input.Variants[0].ID
		_, diagnostics := Enumerate(input)
		assertDiagnostic(t, diagnostics, CodeDuplicate, "/variants/1/id")
	})
	t.Run("locale", func(t *testing.T) {
		input := validInput(t)
		input.Locales = []string{"en-IN", "EN-in"}
		_, diagnostics := Enumerate(input)
		assertDiagnostic(t, diagnostics, CodeDuplicate, "/locales/1")
	})
}

func TestEnumerateBlocksUnreachableCriticalBranch(t *testing.T) {
	input := validInput(t)
	claim := &input.Variants[0].Document.Nodes[1]
	claim.Conditions = append(claim.Conditions, semanticemail.Condition{
		ID: "cond_tier_basic", SlotID: "segment", Operator: semanticemail.ConditionEquals, Value: "basic",
	})
	_, diagnostics := Enumerate(input)
	assertDiagnostic(t, diagnostics, CodeCriticalBranchDead, "/variant_documents/B/nodes/1/conditions")
}

func TestEnumerateBlocksMissingContractBlockInOneVariant(t *testing.T) {
	input := validInput(t)
	document := input.Variants[1].Document
	document.Nodes = append(document.Nodes[:1], document.Nodes[2:]...)
	input.Variants[1].Document = document
	_, diagnostics := Enumerate(input)
	assertDiagnostic(t, diagnostics, CodeContractBlockMissing, "/revision/fact_contract/core_claim/source_block_ids/0")
}

func TestEnumerateRejectsRecipientPIIInConditionFixture(t *testing.T) {
	input := validInput(t)
	input.Variants[0].Document.Nodes[1].Conditions[0].Value = "real.person@company.com"
	_, diagnostics := Enumerate(input)
	assertCode(t, diagnostics, CodeRecipientPIIForbidden)
	for _, diagnostic := range diagnostics {
		if strings.Contains(diagnostic.Message, "real.person") {
			t.Fatal("diagnostic reflected a rejected PII-like value")
		}
	}
}

func TestEnumerateEnforcesHardVariantBound(t *testing.T) {
	input := validInput(t)
	document := input.Variants[0].Document
	input.Variants = make([]Variant, MaxVariants+1)
	for i := range input.Variants {
		input.Variants[i] = Variant{ID: fmt.Sprintf("v%02d", i), Document: document}
	}
	_, diagnostics := Enumerate(input)
	assertDiagnostic(t, diagnostics, CodeLimitExceeded, "/variants")
}

func TestEnumerateFailsClosedBeforeExponentialBranchProduct(t *testing.T) {
	input := validInput(t)
	document := input.Variants[0].Document
	for i := 0; i < 12; i++ {
		document.Nodes[0].Conditions = append(document.Nodes[0].Conditions, semanticemail.Condition{
			ID: semanticemail.ConditionID(fmt.Sprintf("cond_axis_%02d", i)), SlotID: semanticemail.SlotID(fmt.Sprintf("axis_%02d", i)),
			Operator: semanticemail.ConditionPresent,
		})
	}
	input.Variants = []Variant{{ID: "control", Document: document}}
	_, diagnostics := Enumerate(input)
	assertDiagnostic(t, diagnostics, CodeLimitExceeded, "/fixtures")
}

func TestManifestStrictRoundTripAndTamperDetection(t *testing.T) {
	manifest, diagnostics := Enumerate(validInput(t))
	if diagnostics.HasErrors() {
		t.Fatalf("Enumerate() diagnostics = %v", diagnostics)
	}
	raw, err := manifest.JSON()
	if err != nil {
		t.Fatalf("Manifest.JSON() error = %v", err)
	}
	decoded, diagnostics := DecodeManifest(raw)
	if diagnostics.HasErrors() {
		t.Fatalf("DecodeManifest() diagnostics = %v", diagnostics)
	}
	if decoded.CoverageHash != manifest.CoverageHash {
		t.Fatalf("round-trip hash = %s, want %s", decoded.CoverageHash, manifest.CoverageHash)
	}

	tampered := manifest
	tampered.Scenarios = append([]Scenario(nil), manifest.Scenarios...)
	tampered.Scenarios[0].Locale = "hi"
	tamperedDiagnostics := ValidateManifest(tampered)
	if !tamperedDiagnostics.HasCode(CodeManifestHashMismatch) {
		t.Fatalf("tampered manifest diagnostics = %v", tamperedDiagnostics)
	}

	withUnknown := append([]byte(nil), raw[:len(raw)-1]...)
	withUnknown = append(withUnknown, []byte(`,"unknown":true}`)...)
	_, diagnostics = DecodeManifest(withUnknown)
	assertCode(t, diagnostics, CodeInvalidJSON)

	pretty := &bytes.Buffer{}
	if err := json.Indent(pretty, raw, "", "  "); err != nil {
		t.Fatalf("indent manifest: %v", err)
	}
	_, diagnostics = DecodeManifest(pretty.Bytes())
	assertCode(t, diagnostics, CodeManifestNotCanonical)
}

func TestValidateManifestDetectsDuplicateScenarioCoordinate(t *testing.T) {
	manifest, diagnostics := Enumerate(validInput(t))
	if diagnostics.HasErrors() {
		t.Fatalf("Enumerate() diagnostics = %v", diagnostics)
	}
	manifest.Scenarios = append(manifest.Scenarios, manifest.Scenarios[0])
	sortScenariosForTest(manifest.Scenarios)
	if diagnostics := ValidateManifest(manifest); !diagnostics.HasCode(CodeDuplicate) {
		t.Fatalf("duplicate scenario diagnostics = %v", diagnostics)
	}
}

func TestFixtureValuesAreSyntheticAndBoundaryProfilesPresent(t *testing.T) {
	manifest, diagnostics := Enumerate(validInput(t))
	if diagnostics.HasErrors() {
		t.Fatalf("Enumerate() diagnostics = %v", diagnostics)
	}
	profiles := map[FixtureProfile]bool{}
	for _, fixture := range manifest.Fixtures {
		for _, profile := range fixture.Profiles {
			profiles[profile] = true
		}
		for _, assignment := range fixture.Assignments {
			if assignment.State == AssignmentValue && !safeFixtureValue(assignment.Value) {
				t.Fatalf("unsafe generated fixture assignment: %+v", assignment)
			}
		}
	}
	for _, profile := range []FixtureProfile{FixtureBaseline, FixtureMissingOptional, FixtureUnicode, FixtureRTL, FixtureLong, FixtureBranchWitness} {
		if !profiles[profile] {
			t.Fatalf("fixture profile %q was not frozen", profile)
		}
	}
}

func TestEnumerateExhaustsReachableDocumentBranches(t *testing.T) {
	input := validInput(t)
	document := input.Variants[0].Document
	document.Nodes[0].Conditions = []semanticemail.Condition{{
		ID: "cond_region_present", SlotID: "region", Operator: semanticemail.ConditionPresent,
	}}
	input.Variants = []Variant{{ID: "control", Document: document}}
	input.Locales = []string{"en-IN"}
	manifest, diagnostics := Enumerate(input)
	if diagnostics.HasErrors() {
		t.Fatalf("Enumerate() diagnostics = %v", diagnostics)
	}
	combinations := map[string]bool{}
	for _, branch := range manifest.Branches {
		var heading, claim bool
		for _, outcome := range branch.Outcomes {
			switch outcome.NodeID {
			case "blk_heading":
				heading = outcome.Included
			case "blk_claim":
				claim = outcome.Included
			}
		}
		combinations[fmt.Sprintf("%t/%t", heading, claim)] = true
	}
	for _, combination := range []string{"false/false", "false/true", "true/false", "true/true"} {
		if !combinations[combination] {
			t.Fatalf("reachable branch %s was not enumerated; got %v", combination, combinations)
		}
	}
}

func assertAxisCoverage(t *testing.T, manifest Manifest) {
	t.Helper()
	seen := make(map[string]struct{}, len(manifest.Scenarios))
	for _, scenario := range manifest.Scenarios {
		key := strings.Join([]string{scenario.VariantID, scenario.Locale, scenario.FixtureID}, "\x00")
		if _, duplicate := seen[key]; duplicate {
			t.Fatalf("duplicate variant/locale/fixture axis coordinate: %q", key)
		}
		seen[key] = struct{}{}
	}
	for _, variant := range manifest.Variants {
		for _, locale := range manifest.Locales {
			for _, fixture := range manifest.Fixtures {
				key := strings.Join([]string{variant.ID, locale, fixture.ID}, "\x00")
				if _, ok := seen[key]; !ok {
					t.Fatalf("missing full-product coordinate %q", key)
				}
			}
		}
	}
}

func assertDiagnostic(t *testing.T, diagnostics Diagnostics, code DiagnosticCode, path string) {
	t.Helper()
	for _, diagnostic := range diagnostics {
		if diagnostic.Code == code && diagnostic.Path == path {
			return
		}
	}
	t.Fatalf("missing diagnostic %s at %s: %v", code, path, diagnostics)
}

func assertCode(t *testing.T, diagnostics Diagnostics, code DiagnosticCode) {
	t.Helper()
	if !diagnostics.HasCode(code) {
		t.Fatalf("missing diagnostic code %s: %v", code, diagnostics)
	}
}

func sortScenariosForTest(scenarios []Scenario) {
	slices.SortFunc(scenarios, func(left, right Scenario) int { return strings.Compare(left.ID, right.ID) })
}

func validInput(t *testing.T) Input {
	t.Helper()
	documentA := testDocument("Campaign A")
	documentB := testDocument("Campaign B")
	contract := testContract()
	nodes, err := json.Marshal(documentA.Nodes)
	if err != nil {
		t.Fatal(err)
	}
	contractJSON, err := json.Marshal(contract)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("frozen semantic source"))
	return Input{
		Revision: campaignartifact.Revision{
			SourceMode: campaignartifact.SourceModeSemantic, ContentSchemaVersion: semanticemail.SchemaVersionV2,
			SemanticTree: nodes, FactContract: contractJSON,
			Variants: json.RawMessage(`[ {"id":"B"}, {"id":"A"} ]`),
			Locales:  json.RawMessage(`["hi","en-IN"]`), SourceHash: hex.EncodeToString(sum[:]),
		},
		Variants: []Variant{{ID: "B", Document: documentB}, {ID: "A", Document: documentA}},
		Locales:  []string{"hi", "en-IN"},
	}
}

func testDocument(title string) semanticemail.DocumentV2 {
	heading := semanticemail.NodeContent{Heading: &semanticemail.HeadingContent{
		Level: 1, Text: richText(semanticemail.InlineRun{Kind: semanticemail.InlineText, Text: title}),
	}}
	claim := semanticemail.NodeContent{Paragraph: &semanticemail.ParagraphContent{Text: richText(
		semanticemail.InlineRun{Kind: semanticemail.InlineText, Text: "Hello "},
		semanticemail.InlineRun{Kind: semanticemail.InlineSlot, Slot: &semanticemail.SlotReference{
			ID: "first_name", SemanticClass: semanticemail.SlotName, Required: true,
		}},
		semanticemail.InlineRun{Kind: semanticemail.InlineText, Text: ", workflow automation is included."},
	)}}
	action := semanticemail.NodeContent{Action: &semanticemail.ActionContent{
		ActionID: "act_start", Label: "Start now", CanonicalURL: "https://example.com/start",
	}}
	return semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2, Language: "en-IN", Direction: semanticemail.DirectionAuto,
		Nodes: []semanticemail.Node{
			{
				ID: "blk_heading", Type: semanticemail.NodeHeading, Role: semanticemail.RoleHeading,
				Version: semanticemail.NodeVersionV2, Content: heading,
				Localizations: map[string]semanticemail.NodeContent{"hi": heading},
				Provenance:    semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
			{
				ID: "blk_claim", Type: semanticemail.NodeParagraph, Role: semanticemail.RoleBody,
				Version: semanticemail.NodeVersionV2, Content: claim,
				Conditions: []semanticemail.Condition{{
					ID: "cond_tier_vip", SlotID: "segment", Operator: semanticemail.ConditionEquals, Value: "vip",
				}},
				Localizations: map[string]semanticemail.NodeContent{"hi": claim},
				Provenance:    semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
			{
				ID: "blk_action", Type: semanticemail.NodeAction, Role: semanticemail.RolePrimaryAction,
				Version: semanticemail.NodeVersionV2, Content: action,
				Localizations: map[string]semanticemail.NodeContent{"hi": action},
				Provenance:    semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
		},
	}
}

func testContract() factcontract.ContractV1 {
	claim := "Workflow automation is included"
	return factcontract.ContractV1{
		SchemaVersion:   factcontract.SchemaVersionV1,
		PrimaryIntent:   factcontract.Intent{Kind: factcontract.IntentPromote, Statement: "Promote workflow automation"},
		AudienceContext: factcontract.Audience{Description: "Synthetic test audience"},
		CoreClaim:       factcontract.Claim{Statement: claim, SourceBlockIDs: []factcontract.BlockID{"blk_claim"}},
		PrimaryAction: factcontract.PrimaryAction{
			ActionID: "act_start", BlockID: "blk_action", Role: factcontract.PrimaryActionNavigate,
			Label: "Start now", CanonicalURL: "https://example.com/start",
		},
		RequiredFacts: []factcontract.RequiredFact{{
			ID: "fact_claim", Type: factcontract.FactTypeText, DisplayValue: claim,
			Criticality: factcontract.CriticalityCritical, SourceBlockIDs: []factcontract.BlockID{"blk_claim"}, TextValue: &claim,
		}},
		ForbiddenClaims:         []factcontract.ForbiddenClaim{},
		AllowedSecondaryActions: []factcontract.SecondaryActionRole{factcontract.SecondaryActionUnsubscribe},
		Language:                "en-IN",
	}
}

func richText(runs ...semanticemail.InlineRun) semanticemail.RichText {
	return semanticemail.RichText{Runs: runs}
}
