// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/factcontract"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

type branchTarget struct {
	requirementIndex int
	desired          []bool
}

type criticalReference struct {
	sourcePath string
	critical   bool
}

type slotOccurrence struct {
	slot       semanticemail.SlotReference
	sourcePath string
}

// Enumerate builds a complete immutable scenario matrix. It returns no partial
// manifest when a branch, critical block, slot, locale projection, or bound
// cannot be proven. Warnings can accompany a valid manifest.
func Enumerate(input Input) (Manifest, Diagnostics) {
	sink := diagnosticSink{}
	prepared := prepareInput(input, &sink)
	if sink.items.HasErrors() {
		return Manifest{}, sink.items
	}
	inventory, _ := collectSlotInventory(prepared.variants, &sink)
	if sink.items.HasErrors() {
		return Manifest{}, sink.items
	}
	baseline, fixtureBuilder := buildBaseFixtures(inventory, &sink)
	addCartesianBranchFixtures(inventory, baseline, fixtureBuilder)
	if sink.items.HasErrors() {
		return Manifest{}, sink.items
	}
	requirements := make([]Requirement, 0)
	targets := make([]branchTarget, 0)
	criticalByVariant := make(map[string]map[semanticemail.NodeID][]criticalReference, len(prepared.variants))

	for _, variant := range prepared.variants {
		critical := criticalReferences(variant, prepared.contract)
		criticalByVariant[variant.id] = critical
		prefix := stableVariantPath(variant)
		for nodeIndex, node := range variant.document.Nodes {
			if len(node.Conditions) == 0 {
				continue
			}
			nodePath := fmt.Sprintf("%s/nodes/%d", prefix, nodeIndex)
			_, isCritical := critical[node.ID]

			allTrue := make([]bool, len(node.Conditions))
			for i := range allTrue {
				allTrue[i] = true
			}
			assignment, reachable := solveNodeTarget(node.Conditions, allTrue, baseline, inventory)
			requirement := Requirement{
				Kind: RequirementNodeIncluded, VariantID: variant.id, NodeID: string(node.ID),
				Expected: "all_conditions_true", SourcePath: nodePath + "/conditions",
				Critical: isCritical, Reachable: reachable,
			}
			requirement.ID = requirementID(requirement)
			if reachable {
				requirement.WitnessFixtureID = fixtureBuilder.add(assignment, FixtureBranchWitness, "branch:"+variant.id+":"+string(node.ID)+":included")
			} else if isCritical {
				sink.add(Diagnostic{
					Severity: SeverityError, Code: CodeCriticalBranchDead,
					Path: nodePath + "/conditions", VariantID: variant.id, NodeID: string(node.ID),
					Message: "conditions make a critical/fact-bearing node impossible to include",
				})
			} else {
				sink.add(Diagnostic{
					Severity: SeverityWarning, Code: CodeCriticalBranchDead,
					Path: nodePath + "/conditions", VariantID: variant.id, NodeID: string(node.ID),
					Message: "conditions make this non-critical node impossible to include",
				})
			}
			requirements = append(requirements, requirement)
			targets = append(targets, branchTarget{requirementIndex: len(requirements) - 1, desired: allTrue})

			for conditionIndex, condition := range node.Conditions {
				desired := append([]bool(nil), allTrue...)
				desired[conditionIndex] = false
				assignment, reachable = solveNodeTarget(node.Conditions, desired, baseline, inventory)
				requirement = Requirement{
					Kind: RequirementConditionEdge, VariantID: variant.id, NodeID: string(node.ID),
					ConditionID: string(condition.ID), Expected: "condition_false_with_peers_true",
					SourcePath: fmt.Sprintf("%s/conditions/%d", nodePath, conditionIndex),
					Critical:   isCritical, Reachable: reachable,
				}
				requirement.ID = requirementID(requirement)
				if reachable {
					requirement.WitnessFixtureID = fixtureBuilder.add(assignment, FixtureBranchWitness,
						"branch:"+variant.id+":"+string(node.ID)+":"+string(condition.ID)+":false")
				}
				requirements = append(requirements, requirement)
				targets = append(targets, branchTarget{requirementIndex: len(requirements) - 1, desired: desired})
			}
		}
	}
	if sink.items.HasErrors() {
		return Manifest{}, sink.items
	}
	fixtures := fixtureBuilder.fixtures()
	if len(requirements) > MaxRequirements {
		sink.error(CodeLimitExceeded, "/requirements", fmt.Sprintf("generated requirements exceed the hard limit of %d", MaxRequirements))
		return Manifest{}, sink.items
	}
	scenarioCount := len(prepared.variants) * len(prepared.locales) * len(fixtures)
	if scenarioCount == 0 || scenarioCount > MaxScenarios {
		sink.error(CodeLimitExceeded, "/scenarios", fmt.Sprintf("coverage matrix requires %d scenarios; the hard limit is %d", scenarioCount, MaxScenarios))
		return Manifest{}, sink.items
	}
	nodeEvaluations := 0
	for _, variant := range prepared.variants {
		nodeEvaluations += len(variant.document.Nodes) * len(prepared.locales) * len(fixtures)
	}
	if nodeEvaluations > MaxScenarioNodeEvaluations {
		sink.error(CodeLimitExceeded, "/scenarios", fmt.Sprintf("coverage matrix requires %d node evaluations; the hard limit is %d", nodeEvaluations, MaxScenarioNodeEvaluations))
		return Manifest{}, sink.items
	}

	branches, scenarios := compileScenarios(prepared, fixtures, &sink)
	if sink.items.HasErrors() {
		return Manifest{}, sink.items
	}
	bindBranchWitnesses(prepared.variants, branches, scenarios, fixtures, requirements, targets, &sink)
	requirements = append(requirements, proveCriticalContent(prepared, criticalByVariant, fixtures, scenarios, &sink)...)
	if len(requirements) > MaxRequirements {
		sink.error(CodeLimitExceeded, "/requirements", fmt.Sprintf("generated requirements exceed the hard limit of %d", MaxRequirements))
	}
	if sink.items.HasErrors() {
		return Manifest{}, sink.items
	}

	manifest := Manifest{
		SchemaVersion: ManifestSchemaVersion, EnumeratorVersion: EnumeratorVersion,
		FixtureSetVersion: FixtureSetVersionV1, SourceHash: input.Revision.SourceHash,
		FactContractHash: prepared.factContractHash, RevisionVariantsHash: prepared.revisionVariantsHash,
		Locales: prepared.locales, Fixtures: fixtures, Branches: branches,
		Requirements: requirements, Scenarios: scenarios,
	}
	for _, variant := range prepared.variants {
		manifest.Variants = append(manifest.Variants, VariantIdentity{ID: variant.id, DocumentHash: variant.documentHash})
	}
	sortManifest(&manifest)
	if err := finalizeHashes(&manifest); err != nil {
		sink.error(CodeInvalidInput, "", "finalize coverage hashes: "+err.Error())
		return Manifest{}, sink.items
	}
	validation := ValidateManifest(manifest)
	if validation.HasErrors() {
		sink.items = append(sink.items, validation...)
		return Manifest{}, sink.items
	}
	return manifest, sink.items
}

func compileScenarios(prepared preparedInput, fixtures []Fixture, sink *diagnosticSink) ([]Branch, []Scenario) {
	branchByKey := make(map[string]Branch)
	scenarioByID := make(map[string]Scenario)
	coordinateByKey := make(map[string]string)
	for _, variant := range prepared.variants {
		for _, locale := range prepared.locales {
			for _, fixture := range fixtures {
				assignments := assignmentMapFromFixture(fixture)
				outcomes, resolved := evaluateBranch(variant, assignments, fixture.ID, sink)
				if !resolved {
					continue
				}
				key := branchKey(variant.id, outcomes)
				branch := Branch{Key: key, VariantID: variant.id, Outcomes: outcomes}
				if existing, exists := branchByKey[key]; exists && !equalCanonical(existing, branch) {
					sink.add(Diagnostic{Severity: SeverityError, Code: CodeCollision, Path: "/branches", VariantID: variant.id, FixtureID: fixture.ID, Message: "branch hash collision for different outcomes"})
					continue
				}
				branchByKey[key] = branch

				result, diagnostics := semanticemail.CompileV2(variant.document, semanticemail.CompileOptions{
					Locale: locale, Slots: compileSlots(assignments),
				})
				failed := false
				for _, issue := range diagnostics {
					if issue.Severity != semanticemail.SeverityError {
						continue
					}
					failed = true
					sink.add(Diagnostic{
						Severity: SeverityError, Code: CodeScenarioCompileFailed,
						Path: variantPath(variant) + issue.Path, VariantID: variant.id,
						Locale: locale, NodeID: string(issue.NodeID), FixtureID: fixture.ID,
						Message: string(issue.Code) + ": " + issue.Message,
					})
				}
				if failed {
					continue
				}
				assignmentHash, _ := digest(fixture.Assignments)
				id := scenarioID(variant.id, locale, key, fixture.ID)
				included := make([]string, len(result.IncludedNodeIDs))
				for i, nodeID := range result.IncludedNodeIDs {
					included[i] = string(nodeID)
				}
				scenario := Scenario{
					ID: id, VariantID: variant.id, Locale: locale, BranchKey: key,
					FixtureID: fixture.ID, AssignmentHash: assignmentHash, IncludedNodeIDs: included,
				}
				coordinate := strings.Join([]string{variant.id, locale, key, fixture.ID}, "\x00")
				if first, duplicate := coordinateByKey[coordinate]; duplicate {
					sink.add(Diagnostic{Severity: SeverityError, Code: CodeDuplicate, Path: "/scenarios", VariantID: variant.id, Locale: locale, FixtureID: fixture.ID, Message: "scenario coordinate duplicates " + first})
					continue
				}
				coordinateByKey[coordinate] = id
				if existing, collision := scenarioByID[id]; collision && !equalCanonical(existing, scenario) {
					sink.add(Diagnostic{Severity: SeverityError, Code: CodeCollision, Path: "/scenarios", VariantID: variant.id, Locale: locale, FixtureID: fixture.ID, Message: "scenario id collision for different coordinates"})
					continue
				}
				scenarioByID[id] = scenario
			}
		}
	}
	branches := make([]Branch, 0, len(branchByKey))
	for _, branch := range branchByKey {
		branches = append(branches, branch)
	}
	sort.Slice(branches, func(i, j int) bool { return branches[i].Key < branches[j].Key })
	scenarios := make([]Scenario, 0, len(scenarioByID))
	for _, scenario := range scenarioByID {
		scenarios = append(scenarios, scenario)
	}
	sort.Slice(scenarios, func(i, j int) bool { return scenarios[i].ID < scenarios[j].ID })
	return branches, scenarios
}

func evaluateBranch(variant preparedVariant, assignments assignmentMap, fixtureID string, sink *diagnosticSink) ([]NodeOutcome, bool) {
	outcomes := make([]NodeOutcome, 0)
	resolvedAll := true
	for nodeIndex, node := range variant.document.Nodes {
		if len(node.Conditions) == 0 {
			continue
		}
		outcome := NodeOutcome{NodeID: string(node.ID), Included: true, Conditions: make([]ConditionOutcome, 0, len(node.Conditions))}
		for conditionIndex, condition := range node.Conditions {
			assignment := assignments[condition.SlotID]
			matched, resolved := evaluatePredicate(assignment, condition)
			if !resolved {
				resolvedAll = false
				sink.add(Diagnostic{
					Severity: SeverityError, Code: CodeConditionUnresolved,
					Path:      fmt.Sprintf("%s/nodes/%d/conditions/%d/slot_id", variantPath(variant), nodeIndex, conditionIndex),
					VariantID: variant.id, NodeID: string(node.ID), ConditionID: string(condition.ID),
					SlotID: string(condition.SlotID), FixtureID: fixtureID,
					Message: "equality condition has no present synthetic fixture value",
				})
			}
			outcome.Conditions = append(outcome.Conditions, ConditionOutcome{ConditionID: string(condition.ID), Matched: matched})
			outcome.Included = outcome.Included && resolved && matched
		}
		outcomes = append(outcomes, outcome)
	}
	return outcomes, resolvedAll
}

func bindBranchWitnesses(variants []preparedVariant, branches []Branch, scenarios []Scenario, fixtures []Fixture, requirements []Requirement, targets []branchTarget, sink *diagnosticSink) {
	branchByKey := make(map[string]Branch, len(branches))
	for _, branch := range branches {
		branchByKey[branch.Key] = branch
	}
	scenariosByVariantFixture := make(map[string][]Scenario)
	for _, scenario := range scenarios {
		key := scenario.VariantID + "\x00" + scenario.FixtureID
		scenariosByVariantFixture[key] = append(scenariosByVariantFixture[key], scenario)
	}
	variantByID := make(map[string]preparedVariant, len(variants))
	for _, variant := range variants {
		variantByID[variant.id] = variant
	}
	fixtureByID := make(map[string]Fixture, len(fixtures))
	for _, fixture := range fixtures {
		fixtureByID[fixture.ID] = fixture
	}
	for _, target := range targets {
		requirement := &requirements[target.requirementIndex]
		if !requirement.Reachable {
			continue
		}
		variant := variantByID[requirement.VariantID]
		fixture, ok := fixtureByID[requirement.WitnessFixtureID]
		if !ok {
			continue
		}
		outcomes, resolved := evaluateBranch(variant, assignmentMapFromFixture(fixture), fixture.ID, sink)
		if !resolved || !branchTargetMatches(outcomes, requirement, target.desired) {
			sink.add(Diagnostic{
				Severity: SeverityError, Code: CodeBranchUncovered, Path: requirement.SourcePath,
				VariantID: requirement.VariantID, NodeID: requirement.NodeID,
				ConditionID: requirement.ConditionID, FixtureID: requirement.WitnessFixtureID,
				Message: "generated fixture does not satisfy its declared branch proof obligation",
			})
			continue
		}
		key := requirement.VariantID + "\x00" + requirement.WitnessFixtureID
		candidates := scenariosByVariantFixture[key]
		sort.Slice(candidates, func(i, j int) bool { return candidates[i].ID < candidates[j].ID })
		for _, scenario := range candidates {
			if equalCanonical(branchByKey[scenario.BranchKey].Outcomes, outcomes) {
				requirement.WitnessScenarioID = scenario.ID
				break
			}
		}
		if requirement.WitnessScenarioID == "" {
			sink.add(Diagnostic{
				Severity: SeverityError, Code: CodeBranchUncovered, Path: requirement.SourcePath,
				VariantID: requirement.VariantID, NodeID: requirement.NodeID,
				ConditionID: requirement.ConditionID, FixtureID: requirement.WitnessFixtureID,
				Message: "reachable branch has no successfully compiled scenario witness",
			})
		}
	}
}

func branchTargetMatches(outcomes []NodeOutcome, requirement *Requirement, desired []bool) bool {
	for _, outcome := range outcomes {
		if outcome.NodeID != requirement.NodeID || len(outcome.Conditions) != len(desired) {
			continue
		}
		for i, expected := range desired {
			if outcome.Conditions[i].Matched != expected {
				return false
			}
		}
		return true
	}
	return false
}

func proveCriticalContent(prepared preparedInput, criticalByVariant map[string]map[semanticemail.NodeID][]criticalReference, fixtures []Fixture, scenarios []Scenario, sink *diagnosticSink) []Requirement {
	requirements := make([]Requirement, 0)
	fixtureByID := make(map[string]Fixture, len(fixtures))
	for _, fixture := range fixtures {
		fixtureByID[fixture.ID] = fixture
	}
	for _, variant := range prepared.variants {
		nodeByID := make(map[semanticemail.NodeID]struct {
			index int
			node  semanticemail.Node
		}, len(variant.document.Nodes))
		for i, node := range variant.document.Nodes {
			nodeByID[node.ID] = struct {
				index int
				node  semanticemail.Node
			}{i, node}
		}
		nodeIDs := make([]string, 0, len(criticalByVariant[variant.id]))
		for nodeID := range criticalByVariant[variant.id] {
			nodeIDs = append(nodeIDs, string(nodeID))
		}
		sort.Strings(nodeIDs)
		for _, rawNodeID := range nodeIDs {
			nodeID := semanticemail.NodeID(rawNodeID)
			location, exists := nodeByID[nodeID]
			if !exists {
				for _, reference := range criticalByVariant[variant.id][nodeID] {
					sink.add(Diagnostic{
						Severity: SeverityError, Code: CodeContractBlockMissing,
						Path: reference.sourcePath, VariantID: variant.id, NodeID: rawNodeID,
						Message: "critical/fact-bearing block is absent from this active variant",
					})
				}
				continue
			}
			for _, locale := range prepared.locales {
				for _, reference := range criticalByVariant[variant.id][nodeID] {
					requirement := Requirement{
						Kind: RequirementContractBlock, VariantID: variant.id, Locale: locale,
						NodeID: rawNodeID, Expected: "node_included", SourcePath: reference.sourcePath,
						Critical: reference.critical, Reachable: true,
					}
					requirement.ID = requirementID(requirement)
					if witness, ok := findIncludedScenario(scenarios, variant.id, locale, rawNodeID); ok {
						requirement.WitnessFixtureID = witness.FixtureID
						requirement.WitnessScenarioID = witness.ID
					} else {
						sink.add(Diagnostic{
							Severity: SeverityError, Code: CodeBranchUncovered,
							Path: reference.sourcePath, VariantID: variant.id, Locale: locale, NodeID: rawNodeID,
							Message: "critical/fact-bearing block has no included scenario witness",
						})
					}
					requirements = append(requirements, requirement)
				}

				content, contentPath, ok := localizedContent(variant, location.index, location.node, locale)
				if !ok {
					continue
				}
				occurrences := contentSlotOccurrences(content, contentPath)
				seenSlots := make(map[semanticemail.SlotID]struct{}, len(occurrences))
				for _, occurrence := range occurrences {
					if _, duplicate := seenSlots[occurrence.slot.ID]; duplicate {
						continue
					}
					seenSlots[occurrence.slot.ID] = struct{}{}
					requirement := Requirement{
						Kind: RequirementFactBearingSlot, VariantID: variant.id, Locale: locale,
						NodeID: rawNodeID, SlotID: string(occurrence.slot.ID),
						Expected: "nonempty_fixture_value_or_fallback", SourcePath: occurrence.sourcePath,
						Critical: true, Reachable: true,
					}
					requirement.ID = requirementID(requirement)
					if witness, ok := findResolvedSlotScenario(scenarios, fixtureByID, variant.id, locale, rawNodeID, occurrence.slot); ok {
						requirement.WitnessFixtureID = witness.FixtureID
						requirement.WitnessScenarioID = witness.ID
					} else {
						sink.add(Diagnostic{
							Severity: SeverityError, Code: CodeCriticalSlotUncovered,
							Path: occurrence.sourcePath, VariantID: variant.id, Locale: locale,
							NodeID: rawNodeID, SlotID: string(occurrence.slot.ID),
							Message: "fact-bearing slot has no included scenario with a non-empty synthetic value or declared fallback",
						})
					}
					requirements = append(requirements, requirement)
				}
			}
		}
	}
	return requirements
}

func criticalReferences(variant preparedVariant, contract *factcontract.ContractV1) map[semanticemail.NodeID][]criticalReference {
	out := make(map[semanticemail.NodeID][]criticalReference)
	add := func(nodeID semanticemail.NodeID, path string, critical bool) {
		for _, existing := range out[nodeID] {
			if existing.sourcePath == path {
				return
			}
		}
		out[nodeID] = append(out[nodeID], criticalReference{sourcePath: path, critical: critical})
	}
	if contract != nil {
		add(semanticemail.NodeID(contract.PrimaryAction.BlockID), "/revision/fact_contract/primary_action/block_id", true)
		for i, blockID := range contract.CoreClaim.SourceBlockIDs {
			add(semanticemail.NodeID(blockID), fmt.Sprintf("/revision/fact_contract/core_claim/source_block_ids/%d", i), true)
		}
		for factIndex, fact := range contract.RequiredFacts {
			for blockIndex, blockID := range fact.SourceBlockIDs {
				add(semanticemail.NodeID(blockID), fmt.Sprintf("/revision/fact_contract/required_facts/%d/source_block_ids/%d", factIndex, blockIndex), fact.Criticality == factcontract.CriticalityCritical)
			}
		}
	}
	prefix := stableVariantPath(variant)
	for i, node := range variant.document.Nodes {
		if factBearingNode(node) {
			add(node.ID, fmt.Sprintf("%s/nodes/%d", prefix, i), true)
		}
		if node.Type == semanticemail.NodeStructuredData && node.Content.StructuredData != nil {
			for _, referenced := range structuredReferenceIDs(*node.Content.StructuredData) {
				add(referenced, fmt.Sprintf("%s/nodes/%d/content/structured_data/declaration", prefix, i), true)
			}
		}
	}
	return out
}

func factBearingNode(node semanticemail.Node) bool {
	if node.Role == semanticemail.RolePrimaryAction {
		return true
	}
	switch node.Type {
	case semanticemail.NodeDateTime, semanticemail.NodeMoney, semanticemail.NodeDeadline,
		semanticemail.NodeOffer, semanticemail.NodeLocation, semanticemail.NodeProduct,
		semanticemail.NodeFact, semanticemail.NodeStructuredData:
		return true
	default:
		return false
	}
}

func structuredReferenceIDs(content semanticemail.StructuredDataContent) []semanticemail.NodeID {
	ids := make([]semanticemail.NodeID, 0)
	declaration := content.Declaration
	if declaration.DiscountOffer != nil {
		ids = append(ids, declaration.DiscountOffer.OfferNodeID)
	}
	if declaration.PromotionCard != nil {
		current := declaration.PromotionCard
		ids = append(ids, current.ImageNodeID, current.ActionNodeID)
		ids = appendNonemptyNodeIDs(ids, current.HeadlineNodeID, current.PriceNodeID, current.DiscountValueNodeID)
	}
	if declaration.EventReservation != nil {
		current := declaration.EventReservation
		ids = append(ids, current.ReservationNumberNodeID, current.UnderNameNodeID, current.EventNameNodeID,
			current.StartDateTimeNodeID, current.LocationNodeID, current.StatusNodeID)
		ids = appendNonemptyNodeIDs(ids, current.ActionNodeID)
	}
	if declaration.Order != nil {
		current := declaration.Order
		ids = append(ids, current.MerchantNodeID, current.OrderNumberNodeID, current.TotalNodeID)
		ids = appendNonemptyNodeIDs(ids, current.ActionNodeID)
		for _, item := range current.Items {
			ids = append(ids, item.ProductNodeID, item.PriceNodeID, item.QuantityNodeID)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	unique := ids[:0]
	for _, id := range ids {
		if id == "" || (len(unique) > 0 && unique[len(unique)-1] == id) {
			continue
		}
		unique = append(unique, id)
	}
	return unique
}

func appendNonemptyNodeIDs(ids []semanticemail.NodeID, values ...semanticemail.NodeID) []semanticemail.NodeID {
	for _, value := range values {
		if value != "" {
			ids = append(ids, value)
		}
	}
	return ids
}

func localizedContent(variant preparedVariant, nodeIndex int, node semanticemail.Node, locale string) (semanticemail.NodeContent, string, bool) {
	base := fmt.Sprintf("%s/nodes/%d", stableVariantPath(variant), nodeIndex)
	if locale == variant.document.Language || node.Type == semanticemail.NodeStructuredData {
		return node.Content, base + "/content", true
	}
	content, ok := node.Localizations[locale]
	if !ok {
		return semanticemail.NodeContent{}, base + "/localizations/" + escapeJSONPointer(locale), false
	}
	return content, base + "/localizations/" + escapeJSONPointer(locale), true
}

func contentSlotOccurrences(content semanticemail.NodeContent, path string) []slotOccurrence {
	out := make([]slotOccurrence, 0)
	collectRich := func(rich semanticemail.RichText, richPath string) {
		for i, run := range rich.Runs {
			if run.Kind == semanticemail.InlineSlot && run.Slot != nil {
				out = append(out, slotOccurrence{slot: *run.Slot, sourcePath: fmt.Sprintf("%s/runs/%d/slot", richPath, i)})
			}
		}
	}
	if content.Heading != nil {
		collectRich(content.Heading.Text, path+"/heading/text")
	}
	if content.Paragraph != nil {
		collectRich(content.Paragraph.Text, path+"/paragraph/text")
	}
	if content.List != nil {
		for i, item := range content.List.Items {
			collectRich(item, fmt.Sprintf("%s/list/items/%d", path, i))
		}
	}
	if content.Answer != nil {
		collectRich(content.Answer.Question, path+"/answer/question")
		collectRich(content.Answer.Answer, path+"/answer/answer")
	}
	if content.Legal != nil {
		collectRich(content.Legal.Text, path+"/legal/text")
	}
	if content.Offer != nil {
		collectRich(content.Offer.Description, path+"/offer/description")
		collectRich(content.Offer.Terms, path+"/offer/terms")
	}
	if content.Personalization != nil {
		out = append(out, slotOccurrence{slot: content.Personalization.Slot, sourcePath: path + "/personalization/slot"})
	}
	return out
}

func findIncludedScenario(scenarios []Scenario, variantID, locale, nodeID string) (Scenario, bool) {
	for _, scenario := range scenarios {
		if scenario.VariantID == variantID && scenario.Locale == locale && containsString(scenario.IncludedNodeIDs, nodeID) {
			return scenario, true
		}
	}
	return Scenario{}, false
}

func findResolvedSlotScenario(scenarios []Scenario, fixtures map[string]Fixture, variantID, locale, nodeID string, slot semanticemail.SlotReference) (Scenario, bool) {
	for _, scenario := range scenarios {
		if scenario.VariantID != variantID || scenario.Locale != locale || !containsString(scenario.IncludedNodeIDs, nodeID) {
			continue
		}
		fixture, ok := fixtures[scenario.FixtureID]
		if !ok {
			continue
		}
		assignment := assignmentMapFromFixture(fixture)[slot.ID]
		if assignment.state == AssignmentValue && assignment.value != "" {
			return scenario, true
		}
		if slot.Fallback != "" {
			return scenario, true
		}
	}
	return Scenario{}, false
}
