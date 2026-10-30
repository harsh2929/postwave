// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

var (
	emailLike = regexp.MustCompile(`(?i)([a-z0-9.!#$%&'*+/=?^_` + "`" + `{|}~-]+)@([a-z0-9.-]+\.[a-z]{2,})`)
	phoneLike = regexp.MustCompile(`^\+[0-9 ()-]{9,22}$`)
)

type slotDefinition struct {
	id              semanticemail.SlotID
	class           semanticemail.SlotSemanticClass
	mustSupply      bool
	usedInCondition bool
	usedInEquality  bool
	conditionValues []string
	firstPath       string
}

type assignmentValue struct {
	state AssignmentState
	value string
}

type assignmentMap map[semanticemail.SlotID]assignmentValue

type fixtureAccumulator struct {
	byID map[string]*Fixture
	sink *diagnosticSink
}

func collectSlotInventory(variants []preparedVariant, sink *diagnosticSink) (map[semanticemail.SlotID]*slotDefinition, int) {
	inventory := make(map[semanticemail.SlotID]*slotDefinition)
	totalConditions := 0
	for _, variant := range variants {
		prefix := variantPath(variant)
		for nodeIndex, node := range variant.document.Nodes {
			nodePath := fmt.Sprintf("%s/nodes/%d", prefix, nodeIndex)
			for conditionIndex, condition := range node.Conditions {
				totalConditions++
				path := fmt.Sprintf("%s/conditions/%d/slot_id", nodePath, conditionIndex)
				// Conditions do not declare a semantic presentation class. Leave
				// it open until a content SlotReference supplies one.
				definition := ensureSlotDefinition(inventory, condition.SlotID, "", path, sink)
				definition.usedInCondition = true
				if condition.Operator == semanticemail.ConditionEquals || condition.Operator == semanticemail.ConditionNotEquals {
					definition.usedInEquality = true
					definition.conditionValues = appendUnique(definition.conditionValues, condition.Value)
					if !safeFixtureValue(condition.Value) {
						sink.add(Diagnostic{
							Severity: SeverityError, Code: CodeRecipientPIIForbidden,
							Path:      fmt.Sprintf("%s/conditions/%d/value", nodePath, conditionIndex),
							VariantID: variant.id, NodeID: string(node.ID),
							ConditionID: string(condition.ID), SlotID: string(condition.SlotID),
							Message: "condition value cannot be copied into a synthetic assurance fixture because it resembles recipient PII or exceeds fixture bounds",
						})
					}
				}
			}
			collectContentSlots(node.Content, nodePath+"/content", inventory, sink)
			locales := make([]string, 0, len(node.Localizations))
			for locale := range node.Localizations {
				locales = append(locales, locale)
			}
			sort.Strings(locales)
			for _, locale := range locales {
				collectContentSlots(node.Localizations[locale], nodePath+"/localizations/"+escapeJSONPointer(locale), inventory, sink)
			}
		}
	}
	if len(inventory) > MaxSlots {
		sink.error(CodeLimitExceeded, "/variants", fmt.Sprintf("semantic variants declare %d slots; at most %d are supported", len(inventory), MaxSlots))
	}
	if totalConditions > MaxConditions {
		sink.error(CodeLimitExceeded, "/variants", fmt.Sprintf("semantic variants declare %d conditions; at most %d are supported", totalConditions, MaxConditions))
	}
	for _, definition := range inventory {
		if definition.class == "" {
			definition.class = semanticemail.SlotText
		}
		sort.Strings(definition.conditionValues)
	}
	return inventory, totalConditions
}

func ensureSlotDefinition(inventory map[semanticemail.SlotID]*slotDefinition, slotID semanticemail.SlotID, class semanticemail.SlotSemanticClass, path string, sink *diagnosticSink) *slotDefinition {
	definition, exists := inventory[slotID]
	if !exists {
		definition = &slotDefinition{id: slotID, class: class, firstPath: path}
		inventory[slotID] = definition
		return definition
	}
	if class != "" && definition.class != "" && class != definition.class {
		sink.add(Diagnostic{
			Severity: SeverityError, Code: CodeSlotClassConflict, Path: path,
			SlotID: string(slotID), Message: "slot semantic class conflicts with its declaration at " + definition.firstPath,
		})
	}
	if definition.class == "" {
		definition.class = class
	}
	return definition
}

func collectContentSlots(content semanticemail.NodeContent, path string, inventory map[semanticemail.SlotID]*slotDefinition, sink *diagnosticSink) {
	collectRichText := func(rich semanticemail.RichText, richPath string) {
		for i, run := range rich.Runs {
			if run.Kind != semanticemail.InlineSlot || run.Slot == nil {
				continue
			}
			registerContentSlot(*run.Slot, fmt.Sprintf("%s/runs/%d/slot", richPath, i), inventory, sink)
		}
	}
	if content.Heading != nil {
		collectRichText(content.Heading.Text, path+"/heading/text")
	}
	if content.Paragraph != nil {
		collectRichText(content.Paragraph.Text, path+"/paragraph/text")
	}
	if content.List != nil {
		for i, item := range content.List.Items {
			collectRichText(item, fmt.Sprintf("%s/list/items/%d", path, i))
		}
	}
	if content.Answer != nil {
		collectRichText(content.Answer.Question, path+"/answer/question")
		collectRichText(content.Answer.Answer, path+"/answer/answer")
	}
	if content.Legal != nil {
		collectRichText(content.Legal.Text, path+"/legal/text")
	}
	if content.Offer != nil {
		collectRichText(content.Offer.Description, path+"/offer/description")
		collectRichText(content.Offer.Terms, path+"/offer/terms")
	}
	if content.Personalization != nil {
		registerContentSlot(content.Personalization.Slot, path+"/personalization/slot", inventory, sink)
	}
}

func registerContentSlot(slot semanticemail.SlotReference, path string, inventory map[semanticemail.SlotID]*slotDefinition, sink *diagnosticSink) {
	definition := ensureSlotDefinition(inventory, slot.ID, slot.SemanticClass, path, sink)
	definition.mustSupply = definition.mustSupply || (slot.Required && slot.Fallback == "")
}

func buildBaseFixtures(inventory map[semanticemail.SlotID]*slotDefinition, sink *diagnosticSink) (assignmentMap, *fixtureAccumulator) {
	accumulator := &fixtureAccumulator{byID: make(map[string]*Fixture), sink: sink}
	baseline := profileAssignments(inventory, FixtureBaseline)
	accumulator.add(baseline, FixtureBaseline, "boundary:baseline")
	accumulator.add(profileAssignments(inventory, FixtureMissingOptional), FixtureMissingOptional, "boundary:missing_optional")
	accumulator.add(profileAssignments(inventory, FixtureUnicode), FixtureUnicode, "boundary:unicode")
	accumulator.add(profileAssignments(inventory, FixtureRTL), FixtureRTL, "boundary:rtl")
	accumulator.add(profileAssignments(inventory, FixtureLong), FixtureLong, "boundary:long")
	return baseline, accumulator
}

// addCartesianBranchFixtures exhausts the finite equivalence classes that can
// change any condition result. It does not enumerate arbitrary strings: for an
// equality slot, empty, every authored comparison value, and one synthetic
// "other" value are complete; for a presence-only slot, missing and one value
// are complete. The hard fixture/scenario bounds fail closed before an
// exponential product can consume unbounded work.
func addCartesianBranchFixtures(inventory map[semanticemail.SlotID]*slotDefinition, baseline assignmentMap, accumulator *fixtureAccumulator) {
	conditionSlots := make([]semanticemail.SlotID, 0)
	for _, id := range sortedSlotIDs(inventory) {
		definition := inventory[id]
		if definition.usedInCondition {
			conditionSlots = append(conditionSlots, id)
		}
	}
	if len(conditionSlots) == 0 {
		return
	}
	domains := make([][]assignmentValue, len(conditionSlots))
	product := 1
	for i, id := range conditionSlots {
		definition := inventory[id]
		if definition.usedInEquality {
			domains[i] = []assignmentValue{{state: AssignmentEmpty}}
			for _, value := range definition.conditionValues {
				domains[i] = append(domains[i], assignmentValue{state: AssignmentValue, value: value})
			}
			domains[i] = append(domains[i], assignmentValue{state: AssignmentValue, value: syntheticValue(definition, FixtureBaseline)})
		} else {
			domains[i] = []assignmentValue{
				{state: AssignmentMissing},
				{state: AssignmentValue, value: syntheticValue(definition, FixtureBaseline)},
			}
		}
		domains[i] = uniqueAssignmentValues(domains[i])
		if len(domains[i]) == 0 || product > MaxFixtures/len(domains[i]) {
			accumulator.sink.error(CodeLimitExceeded, "/fixtures", fmt.Sprintf("reachable condition branch product exceeds the hard fixture limit of %d", MaxFixtures))
			return
		}
		product *= len(domains[i])
	}
	current := cloneAssignments(baseline)
	var enumerate func(int)
	enumerate = func(index int) {
		if accumulator.sink.items.HasErrors() {
			return
		}
		if index == len(conditionSlots) {
			assignments := assignmentSlice(current)
			assignmentHash, _ := digest(assignments)
			accumulator.add(current, FixtureBranchWitness, "branch:cartesian:"+assignmentHash)
			return
		}
		id := conditionSlots[index]
		for _, value := range domains[index] {
			current[id] = value
			enumerate(index + 1)
		}
	}
	enumerate(0)
}

func uniqueAssignmentValues(values []assignmentValue) []assignmentValue {
	out := make([]assignmentValue, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		key := string(value.state) + "\x00" + value.value
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, value)
	}
	return out
}

func profileAssignments(inventory map[semanticemail.SlotID]*slotDefinition, profile FixtureProfile) assignmentMap {
	out := make(assignmentMap, len(inventory))
	ids := sortedSlotIDs(inventory)
	for _, id := range ids {
		definition := inventory[id]
		switch profile {
		case FixtureMissingOptional:
			if !definition.mustSupply {
				if definition.usedInEquality {
					out[id] = assignmentValue{state: AssignmentEmpty}
				} else {
					out[id] = assignmentValue{state: AssignmentMissing}
				}
				continue
			}
		}
		out[id] = assignmentValue{state: AssignmentValue, value: syntheticValue(definition, profile)}
	}
	return out
}

func syntheticValue(definition *slotDefinition, profile FixtureProfile) string {
	var value string
	switch profile {
	case FixtureUnicode:
		switch definition.class {
		case semanticemail.SlotName:
			value = "परीक्षण प्राप्तकर्ता"
		case semanticemail.SlotIdentifier:
			value = "कृत्रिम-पहचान-००१"
		case semanticemail.SlotCode:
			value = "टेस्ट-कोड-००१"
		default:
			value = "कृत्रिम आश्वासन मान"
		}
	case FixtureRTL:
		switch definition.class {
		case semanticemail.SlotName:
			value = "مستلم تجريبي"
		case semanticemail.SlotIdentifier:
			value = "معرف-تجريبي-001"
		case semanticemail.SlotCode:
			value = "رمز-اختبار-001"
		default:
			value = "قيمة ضمان تجريبية"
		}
	case FixtureLong:
		value = strings.TrimSpace(strings.Repeat("Synthetic assurance value ", 16))
	default:
		switch definition.class {
		case semanticemail.SlotName:
			value = "Assurance Recipient"
		case semanticemail.SlotIdentifier:
			value = "synthetic-recipient-0001"
		case semanticemail.SlotCode:
			value = "TEST-CODE-0001"
		default:
			value = "Synthetic assurance value"
		}
	}
	for containsString(definition.conditionValues, value) {
		value += "-other"
	}
	return value
}

func (a *fixtureAccumulator) add(assignments assignmentMap, profile FixtureProfile, purpose string) string {
	encoded := assignmentSlice(assignments)
	id := fixtureID(encoded)
	if existing, ok := a.byID[id]; ok {
		if !equalCanonical(existing.Assignments, encoded) {
			a.sink.add(Diagnostic{Severity: SeverityError, Code: CodeCollision, Path: "/fixtures", FixtureID: id, Message: "fixture id collision for different assignments"})
			return ""
		}
		existing.Profiles = appendFixtureProfile(existing.Profiles, profile)
		existing.Purposes = appendUnique(existing.Purposes, purpose)
		sort.Slice(existing.Profiles, func(i, j int) bool { return existing.Profiles[i] < existing.Profiles[j] })
		sort.Strings(existing.Purposes)
		return id
	}
	if len(a.byID) >= MaxFixtures {
		a.sink.error(CodeLimitExceeded, "/fixtures", fmt.Sprintf("generated fixtures exceed the hard limit of %d", MaxFixtures))
		return ""
	}
	a.byID[id] = &Fixture{ID: id, Profiles: []FixtureProfile{profile}, Assignments: encoded, Purposes: []string{purpose}}
	return id
}

func (a *fixtureAccumulator) fixtures() []Fixture {
	out := make([]Fixture, 0, len(a.byID))
	for _, fixture := range a.byID {
		copyFixture := *fixture
		out = append(out, copyFixture)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func assignmentSlice(assignments assignmentMap) []SlotAssignment {
	ids := make([]string, 0, len(assignments))
	byString := make(map[string]semanticemail.SlotID, len(assignments))
	for id := range assignments {
		raw := string(id)
		ids = append(ids, raw)
		byString[raw] = id
	}
	sort.Strings(ids)
	out := make([]SlotAssignment, 0, len(ids))
	for _, raw := range ids {
		value := assignments[byString[raw]]
		out = append(out, SlotAssignment{SlotID: raw, State: value.state, Value: value.value})
	}
	return out
}

func assignmentMapFromFixture(fixture Fixture) assignmentMap {
	out := make(assignmentMap, len(fixture.Assignments))
	for _, assignment := range fixture.Assignments {
		out[semanticemail.SlotID(assignment.SlotID)] = assignmentValue{state: assignment.State, value: assignment.Value}
	}
	return out
}

func compileSlots(assignments assignmentMap) map[semanticemail.SlotID]string {
	out := make(map[semanticemail.SlotID]string, len(assignments))
	for id, assignment := range assignments {
		switch assignment.state {
		case AssignmentEmpty:
			out[id] = ""
		case AssignmentValue:
			out[id] = assignment.value
		}
	}
	return out
}

func solveNodeTarget(conditions []semanticemail.Condition, desired []bool, baseline assignmentMap, inventory map[semanticemail.SlotID]*slotDefinition) (assignmentMap, bool) {
	if len(conditions) != len(desired) {
		return nil, false
	}
	bySlot := make(map[semanticemail.SlotID][]int)
	for i, condition := range conditions {
		bySlot[condition.SlotID] = append(bySlot[condition.SlotID], i)
	}
	out := cloneAssignments(baseline)
	ids := make([]string, 0, len(bySlot))
	byString := make(map[string]semanticemail.SlotID, len(bySlot))
	for id := range bySlot {
		ids = append(ids, string(id))
		byString[string(id)] = id
	}
	sort.Strings(ids)
	for _, raw := range ids {
		id := byString[raw]
		definition := inventory[id]
		candidates := conditionCandidates(definition, baseline[id])
		selected := assignmentValue{}
		found := false
		for _, candidate := range candidates {
			matchesAll := true
			for _, conditionIndex := range bySlot[id] {
				matched, resolved := evaluatePredicate(candidate, conditions[conditionIndex])
				if !resolved || matched != desired[conditionIndex] {
					matchesAll = false
					break
				}
			}
			if matchesAll {
				selected = candidate
				found = true
				break
			}
		}
		if !found {
			return nil, false
		}
		out[id] = selected
	}
	return out, true
}

func conditionCandidates(definition *slotDefinition, baseline assignmentValue) []assignmentValue {
	candidates := []assignmentValue{baseline}
	if definition != nil {
		for _, value := range definition.conditionValues {
			candidates = append(candidates, assignmentValue{state: AssignmentValue, value: value})
		}
		candidates = append(candidates, assignmentValue{state: AssignmentValue, value: syntheticValue(definition, FixtureBaseline)})
	}
	candidates = append(candidates, assignmentValue{state: AssignmentEmpty}, assignmentValue{state: AssignmentMissing})
	out := make([]assignmentValue, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		key := string(candidate.state) + "\x00" + candidate.value
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, candidate)
	}
	return out
}

func evaluatePredicate(assignment assignmentValue, condition semanticemail.Condition) (bool, bool) {
	exists := assignment.state != AssignmentMissing
	present := assignment.state == AssignmentValue && assignment.value != ""
	value := ""
	if exists {
		value = assignment.value
	}
	switch condition.Operator {
	case semanticemail.ConditionPresent:
		return present, true
	case semanticemail.ConditionAbsent:
		return !present, true
	case semanticemail.ConditionEquals:
		if !exists {
			return false, false
		}
		return value == condition.Value, true
	case semanticemail.ConditionNotEquals:
		if !exists {
			return false, false
		}
		return value != condition.Value, true
	default:
		return false, false
	}
}

func cloneAssignments(input assignmentMap) assignmentMap {
	out := make(assignmentMap, len(input))
	for id, value := range input {
		out[id] = value
	}
	return out
}

func safeFixtureValue(value string) bool {
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > MaxFixtureValueRunes {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	for _, match := range emailLike.FindAllStringSubmatch(value, -1) {
		domain := strings.ToLower(match[2])
		if domain != "example.com" && domain != "example.net" && domain != "example.org" && !strings.HasSuffix(domain, ".example") && !strings.HasSuffix(domain, ".invalid") {
			return false
		}
	}
	if phoneLike.MatchString(strings.TrimSpace(value)) {
		digits := 0
		for _, current := range value {
			if current >= '0' && current <= '9' {
				digits++
			}
		}
		if digits >= 10 {
			return false
		}
	}
	return true
}

func sortedSlotIDs(inventory map[semanticemail.SlotID]*slotDefinition) []semanticemail.SlotID {
	ids := make([]semanticemail.SlotID, 0, len(inventory))
	for id := range inventory {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func appendFixtureProfile(values []FixtureProfile, value FixtureProfile) []FixtureProfile {
	for _, current := range values {
		if current == value {
			return values
		}
	}
	return append(values, value)
}

func appendUnique(values []string, value string) []string {
	for _, current := range values {
		if current == value {
			return values
		}
	}
	return append(values, value)
}

func containsString(values []string, value string) bool {
	for _, current := range values {
		if current == value {
			return true
		}
	}
	return false
}

func escapeJSONPointer(value string) string {
	value = strings.ReplaceAll(value, "~", "~0")
	return strings.ReplaceAll(value, "/", "~1")
}

func variantPath(variant preparedVariant) string {
	if variant.inputIndex < 0 {
		return "/revision/semantic_tree"
	}
	return fmt.Sprintf("/variants/%d/document", variant.inputIndex)
}

// stableVariantPath is persisted in proof requirements. Unlike diagnostic
// paths into the caller's array, it cannot change when active variants are
// supplied in a different order.
func stableVariantPath(variant preparedVariant) string {
	return "/variant_documents/" + escapeJSONPointer(variant.id)
}
