// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import (
	"math"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

const (
	criticalFactWeight   = 5.0
	importantFactWeight  = 3.0
	supportingFactWeight = 1.0
)

// ScoreV1 applies the pinned v1 rubric to one required scenario. It returns a
// diagnostic result instead of an error: invalid contracts and incomplete
// required output sets intentionally produce a nil Overall score.
func ScoreV1(input ScenarioScoreInputV1) ScenarioScoreV1 {
	result := ScenarioScoreV1{
		ScoreVersion:      ScoreVersionV1,
		ScenarioID:        strings.TrimSpace(input.ScenarioID),
		Coverage:          CoverageV1{MissingIDs: []string{}, FailedIDs: []string{}},
		OmittedDimensions: []string{}, OutputScores: []OutputScoreV1{},
		PairwiseAgreement: []PairAgreementV1{}, FactResults: []FactMatchResultV1{},
		UnsupportedClaims: []UnsupportedClaimResultV1{}, UndeclaredFacts: []UndeclaredFactResultV1{},
		Failures: []ScoreFailureV1{},
	}
	if !validReference(result.ScenarioID) {
		result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_scenario_id", Detail: "scenario id must be a stable reference"})
	}

	contract, contractErrors := factcontract.NormalizeAndValidateV1(input.Contract)
	if len(contractErrors) != 0 {
		result.ContractErrors = contractErrors
		result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_fact_contract", Detail: "a valid normalized Fact Contract v1 is required"})
		populateIncompleteCoverage(&result, input.RequiredOutputIDs, input.Outputs)
		stableScoreResult(&result)
		return result
	}

	requiredIDs, requiredValid := normalizeRequiredOutputIDs(input.RequiredOutputIDs, &result)
	outputs := normalizeAnalyzerOutputs(requiredIDs, input.Outputs, &result)
	result.Coverage.Required = len(requiredIDs)
	for _, id := range requiredIDs {
		output, exists := outputs[id]
		if !exists {
			result.Coverage.MissingIDs = append(result.Coverage.MissingIDs, id)
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "required_output_missing", ConfigurationID: id, Detail: "required analyzer output was not supplied"})
			continue
		}
		result.Coverage.Terminal++
		if output.Receipt == nil {
			result.Coverage.FailedIDs = append(result.Coverage.FailedIDs, id)
			code := output.FailureCode
			if !publicCodePattern.MatchString(code) {
				code = "invalid_failure_receipt"
			}
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "required_output_unavailable", ConfigurationID: id, Detail: code})
			continue
		}
		if receiptErrors := VerifyExtractionReceiptV1(*output.Receipt); len(receiptErrors) != 0 {
			result.Coverage.FailedIDs = append(result.Coverage.FailedIDs, id)
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_output_receipt", ConfigurationID: id, Detail: receiptErrors.Error()})
			outputs[id] = AnalyzerOutputV1{ConfigurationID: id, FailureCode: "invalid_output_receipt"}
			continue
		}
		result.Coverage.Successful++
	}
	if result.Coverage.Required > 0 {
		result.Coverage.Ratio = round6(float64(result.Coverage.Successful) / float64(result.Coverage.Required))
	}

	pairwise, robustness := analyzerRobustness(requiredIDs, outputs, contract)
	result.PairwiseAgreement = pairwise
	result.Agreement = floatPointer(round4(robustness / 100))
	result.Components.AnalyzerRobustness = floatPointer(robustness)

	if len(contract.RequiredFacts) == 0 {
		result.OmittedDimensions = append(result.OmittedDimensions, "entity_recovery")
	}

	var intentScores, actionScores, entityScores []float64
	// Surfaceability is counted separately from the fidelity dimensions because
	// it is a SHARE OF RUNS, not a mean of per-run scores: the PRD defines it as
	// the proportion of extractions that said the message would be mentioned at
	// all. Runs that did not answer are excluded from both numerator and
	// denominator rather than counted as "no" — an analyzer that was never asked
	// is not evidence that a message is invisible.
	surfacedRuns, answeredRuns := 0, 0
	for _, id := range requiredIDs {
		output := outputs[id]
		if output.Receipt == nil {
			continue
		}
		extraction := output.Receipt.Extraction
		intent := intentFidelity(extraction, contract)
		action := primaryActionFidelity(extraction.PrimaryAction, contract.PrimaryAction)
		entity, factResults := entityRecovery(id, extraction, contract)
		intentScores = append(intentScores, intent)
		actionScores = append(actionScores, action)
		if entity != nil {
			entityScores = append(entityScores, *entity)
		}
		if extraction.WouldSurfaceInDigest != nil {
			answeredRuns++
			if *extraction.WouldSurfaceInDigest {
				surfacedRuns++
			}
		}
		result.FactResults = append(result.FactResults, factResults...)
		result.UnsupportedClaims = append(result.UnsupportedClaims, unsupportedClaimResults(id, extraction, contract)...)
		result.UndeclaredFacts = append(result.UndeclaredFacts, undeclaredFactResults(id, extraction, contract)...)
	}
	if len(intentScores) != 0 {
		result.Components.IntentFidelity = floatPointer(round4(mean(intentScores)))
		result.Components.PrimaryAction = floatPointer(round4(mean(actionScores)))
	}
	if len(entityScores) != 0 {
		result.Components.EntityRecovery = floatPointer(round4(mean(entityScores)))
	}
	if answeredRuns != 0 {
		result.Components.Surfaceability = floatPointer(
			round4(float64(surfacedRuns) / float64(answeredRuns) * 100))
	} else {
		// nil, not 0. No analyzer answered, so the message's surfaceability is
		// unknown — and a 0 here would read as "no assistant would ever mention
		// this", which is a far stronger claim than the evidence supports.
		result.OmittedDimensions = append(result.OmittedDimensions, "surfaceability")
	}

	// Weights are computed HERE, not earlier: which dimensions are measurable is
	// only known after the runs have been read.
	weights := appliedWeights(len(contract.RequiredFacts) != 0, answeredRuns != 0)
	result.AppliedWeights = weights
	for _, unsupported := range result.UnsupportedClaims {
		if unsupported.Contradiction {
			result.HasContradictions = true
			break
		}
	}

	if result.Components.IntentFidelity != nil && result.Components.PrimaryAction != nil {
		for _, id := range successfulIDs(requiredIDs, outputs) {
			extraction := outputs[id].Receipt.Extraction
			intent := intentFidelity(extraction, contract)
			action := primaryActionFidelity(extraction.PrimaryAction, contract.PrimaryAction)
			entity, _ := entityRecovery(id, extraction, contract)
			overall := weightedComposite(intent, action, entity, robustness, weights)
			result.OutputScores = append(result.OutputScores, OutputScoreV1{
				ConfigurationID: id, IntentFidelity: intent, PrimaryAction: action,
				EntityRecovery: entity, Overall: overall,
			})
		}
		if len(result.OutputScores) != 0 {
			result.Range = scoreRange(result.OutputScores)
		}
	}

	completeOutputs := requiredValid && len(requiredIDs) >= 2 && result.Coverage.Successful == result.Coverage.Required &&
		len(result.Coverage.MissingIDs) == 0 && len(result.Coverage.FailedIDs) == 0
	if completeOutputs && result.Components.IntentFidelity != nil && result.Components.PrimaryAction != nil &&
		(len(contract.RequiredFacts) == 0 || result.Components.EntityRecovery != nil) && result.Components.AnalyzerRobustness != nil &&
		len(result.Failures) == 0 {
		result.Complete = true
		result.Overall = floatPointer(weightedComposite(
			*result.Components.IntentFidelity, *result.Components.PrimaryAction,
			result.Components.EntityRecovery, *result.Components.AnalyzerRobustness, weights,
		))
	}
	stableScoreResult(&result)
	return result
}

func normalizeRequiredOutputIDs(values []string, result *ScenarioScoreV1) ([]string, bool) {
	valid := true
	if len(values) < 2 || len(values) > 64 {
		result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_required_output_count", Detail: "two to 64 required analyzer output ids are required"})
		valid = false
	}
	seen := map[string]struct{}{}
	limit := len(values)
	if limit > 64 {
		limit = 64
	}
	normalized := make([]string, 0, limit)
	for _, raw := range values[:limit] {
		value := strings.TrimSpace(raw)
		if !validReference(value) {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_configuration_id", ConfigurationID: value, Detail: "configuration id must be a stable reference"})
			valid = false
			continue
		}
		if _, duplicate := seen[value]; duplicate {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "duplicate_required_output", ConfigurationID: value, Detail: "configuration id appears more than once"})
			valid = false
			continue
		}
		seen[value] = struct{}{}
		normalized = append(normalized, value)
	}
	sort.Strings(normalized)
	return normalized, valid
}

func normalizeAnalyzerOutputs(required []string, values []AnalyzerOutputV1, result *ScenarioScoreV1) map[string]AnalyzerOutputV1 {
	requiredSet := make(map[string]struct{}, len(required))
	for _, id := range required {
		requiredSet[id] = struct{}{}
	}
	capacity := len(values)
	if capacity > 64 {
		capacity = 64
	}
	outputs := make(map[string]AnalyzerOutputV1, capacity)
	duplicates := make(map[string]struct{})
	if len(values) > 64 {
		result.Failures = append(result.Failures, ScoreFailureV1{Code: "output_limit_exceeded", Detail: "at most 64 analyzer outputs are permitted"})
	}
	limit := len(values)
	if limit > 64 {
		limit = 64
	}
	for _, raw := range values[:limit] {
		value := raw
		value.ConfigurationID = strings.TrimSpace(value.ConfigurationID)
		if !validReference(value.ConfigurationID) {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_configuration_id", ConfigurationID: value.ConfigurationID, Detail: "configuration id must be a stable reference"})
			continue
		}
		if _, expected := requiredSet[value.ConfigurationID]; !expected {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "unexpected_output", ConfigurationID: value.ConfigurationID, Detail: "output is not part of the required analyzer set"})
			continue
		}
		if _, alreadyDuplicate := duplicates[value.ConfigurationID]; alreadyDuplicate {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "duplicate_output", ConfigurationID: value.ConfigurationID, Detail: "configuration produced more than one output"})
			continue
		}
		if _, duplicate := outputs[value.ConfigurationID]; duplicate {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "duplicate_output", ConfigurationID: value.ConfigurationID, Detail: "configuration produced more than one output"})
			outputs[value.ConfigurationID] = AnalyzerOutputV1{ConfigurationID: value.ConfigurationID, FailureCode: "duplicate_output"}
			duplicates[value.ConfigurationID] = struct{}{}
			continue
		}
		if value.Receipt != nil && value.FailureCode != "" {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_output_cardinality", ConfigurationID: value.ConfigurationID, Detail: "output must contain either a receipt or a failure code"})
			value = AnalyzerOutputV1{ConfigurationID: value.ConfigurationID, FailureCode: "invalid_output_cardinality"}
		} else if value.Receipt == nil && !publicCodePattern.MatchString(value.FailureCode) {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_output_cardinality", ConfigurationID: value.ConfigurationID, Detail: "failed output requires a bounded public failure code"})
			value.FailureCode = "invalid_failure_receipt"
		}
		outputs[value.ConfigurationID] = value
	}
	return outputs
}

func populateIncompleteCoverage(result *ScenarioScoreV1, required []string, outputs []AnalyzerOutputV1) {
	ids, _ := normalizeRequiredOutputIDs(required, result)
	result.Coverage.Required = len(ids)
	limit := len(outputs)
	if limit > 64 {
		limit = 64
		result.Failures = append(result.Failures, ScoreFailureV1{Code: "output_limit_exceeded", Detail: "at most 64 analyzer outputs are permitted"})
	}
	present := make(map[string]struct{}, limit)
	for _, output := range outputs[:limit] {
		present[strings.TrimSpace(output.ConfigurationID)] = struct{}{}
	}
	for _, id := range ids {
		if _, ok := present[id]; ok {
			result.Coverage.Terminal++
		} else {
			result.Coverage.MissingIDs = append(result.Coverage.MissingIDs, id)
		}
	}
}

func intentFidelity(extraction ExtractionV1, contract factcontract.ContractV1) float64 {
	intent := MatchWrong
	if extraction.PrimaryIntent.Kind == contract.PrimaryIntent.Kind {
		intent = compareText(extraction.PrimaryIntent.Value, contract.PrimaryIntent.Statement)
	}
	claim := compareText(extraction.CoreClaim.Value, contract.CoreClaim.Statement)
	return round4(100 * (matchCredit(intent) + matchCredit(claim)) / 2)
}

func primaryActionFidelity(extracted ExtractedAction, expected factcontract.PrimaryAction) float64 {
	expectedURL, _, _ := canonicalizeHTTPURL(expected.CanonicalURL)
	identityMatches := extracted.ActionID == expected.ActionID && extracted.BlockID == expected.BlockID &&
		extracted.Role == expected.Role && extracted.CanonicalURL == expectedURL
	if expected.Role == factcontract.PrimaryActionReply {
		identityMatches = extracted.ActionID == expected.ActionID && extracted.BlockID == expected.BlockID &&
			extracted.Role == expected.Role && extracted.CanonicalURL == ""
	}
	if !identityMatches {
		return 0
	}
	return round4(100 * matchCredit(compareText(extracted.Label, expected.Label)))
}

func entityRecovery(configurationID string, extraction ExtractionV1, contract factcontract.ContractV1) (*float64, []FactMatchResultV1) {
	if len(contract.RequiredFacts) == 0 {
		return nil, []FactMatchResultV1{}
	}
	byID := make(map[factcontract.FactID]ExtractedFact, len(extraction.Facts))
	for _, fact := range extraction.Facts {
		byID[fact.FactID] = fact
	}
	results := make([]FactMatchResultV1, 0, len(contract.RequiredFacts))
	weighted, totalWeight := 0.0, 0.0
	for _, expected := range contract.RequiredFacts {
		weight := criticalityWeight(expected.Criticality)
		observed, present := byID[expected.ID]
		match, reason := MatchMissing, "required fact was not recovered"
		observedValue := ""
		if present {
			observedValue = extractedFactValue(observed)
			match, reason = compareFact(observed, expected)
		}
		credit := matchCredit(match)
		results = append(results, FactMatchResultV1{
			ConfigurationID: configurationID, FactID: expected.ID, Type: expected.Type,
			Criticality: expected.Criticality, Weight: weight, Match: match, Credit: credit,
			Expected: expectedFactValue(expected), Observed: observedValue, Reason: reason,
		})
		weighted += weight * credit
		totalWeight += weight
	}
	score := round4(100 * weighted / totalWeight)
	return &score, results
}

func compareFact(observed ExtractedFact, expected factcontract.RequiredFact) (MatchClass, string) {
	if observed.Type != expected.Type {
		return MatchWrong, "recovered fact type differs from the contract"
	}
	switch expected.Type {
	case factcontract.FactTypeText, factcontract.FactTypeLocation:
		match := compareText(observed.Normalized, pointerString(expected.TextValue))
		return match, matchReason(match)
	case factcontract.FactTypeCode:
		if observed.Normalized == pointerString(expected.TextValue) {
			return MatchExact, matchReason(MatchExact)
		}
		return MatchWrong, "code differs from the contract; case is significant in score v1"
	case factcontract.FactTypeDateTime:
		if expected.DateTimeValue == nil {
			return MatchWrong, "contract datetime value is unavailable"
		}
		if observed.Normalized == expected.DateTimeValue.RFC3339 && observed.Timezone == expected.DateTimeValue.Timezone {
			return MatchExact, matchReason(MatchExact)
		}
		left, leftErr := time.Parse(time.RFC3339Nano, observed.Normalized)
		right, rightErr := time.Parse(time.RFC3339Nano, expected.DateTimeValue.RFC3339)
		if leftErr == nil && rightErr == nil && left.Equal(right) {
			return MatchEquivalent, "same instant recovered with a different declared timezone representation"
		}
		return MatchWrong, "datetime instant differs from the contract"
	case factcontract.FactTypeMoney:
		if expected.MoneyValue != nil && observed.Normalized == expected.MoneyValue.Amount && observed.Currency == string(expected.MoneyValue.Currency) {
			return MatchExact, matchReason(MatchExact)
		}
		return MatchWrong, "money amount or ISO 4217 currency differs from the contract"
	case factcontract.FactTypePercentage, factcontract.FactTypeQuantity:
		if expected.NumberValue == nil {
			return MatchWrong, "contract number value is unavailable"
		}
		if observed.Normalized == expected.NumberValue.Value && observed.Unit == expected.NumberValue.Unit {
			return MatchExact, matchReason(MatchExact)
		}
		if observed.Normalized == expected.NumberValue.Value && comparisonKey(observed.Unit) == comparisonKey(expected.NumberValue.Unit) {
			return MatchEquivalent, "same number recovered with an equivalent unit spelling"
		}
		return MatchWrong, "number or unit differs from the contract"
	case factcontract.FactTypeURL:
		if expected.URLValue != nil {
			expectedURL, _, ok := canonicalizeHTTPURL(*expected.URLValue)
			if ok && observed.Normalized == expectedURL {
				return MatchExact, matchReason(MatchExact)
			}
		}
		return MatchWrong, "canonical tracking-stripped URL differs from the contract"
	default:
		return MatchWrong, "unsupported fact type"
	}
}

func analyzerRobustness(requiredIDs []string, outputs map[string]AnalyzerOutputV1, contract factcontract.ContractV1) ([]PairAgreementV1, float64) {
	pairs := make([]PairAgreementV1, 0, len(requiredIDs)*(len(requiredIDs)-1)/2)
	for leftIndex := 0; leftIndex < len(requiredIDs); leftIndex++ {
		for rightIndex := leftIndex + 1; rightIndex < len(requiredIDs); rightIndex++ {
			leftID, rightID := requiredIDs[leftIndex], requiredIDs[rightIndex]
			left := outputs[leftID].Receipt
			right := outputs[rightID].Receipt
			items := 3 + len(contract.RequiredFacts)
			agreement := 0.0
			if left != nil && right != nil {
				agreement = pairExtractionAgreement(left.Extraction, right.Extraction, contract)
			}
			pairs = append(pairs, PairAgreementV1{
				LeftConfigurationID: leftID, RightConfigurationID: rightID,
				Agreement: agreement, ComparedItems: items,
			})
		}
	}
	if len(pairs) == 0 {
		return pairs, 0
	}
	values := make([]float64, len(pairs))
	for index := range pairs {
		values[index] = pairs[index].Agreement
	}
	return pairs, round4(mean(values))
}

func pairExtractionAgreement(left, right ExtractionV1, contract factcontract.ContractV1) float64 {
	agree, total := 0.0, 3.0+float64(len(contract.RequiredFacts))
	if left.PrimaryIntent.Kind == right.PrimaryIntent.Kind && equivalentOrExact(compareText(left.PrimaryIntent.Value, right.PrimaryIntent.Value)) {
		agree++
	}
	if equivalentOrExact(compareText(left.CoreClaim.Value, right.CoreClaim.Value)) {
		agree++
	}
	if actionsAgree(left.PrimaryAction, right.PrimaryAction) {
		agree++
	}
	leftFacts, rightFacts := factMap(left.Facts), factMap(right.Facts)
	for _, expected := range contract.RequiredFacts {
		leftFact, leftPresent := leftFacts[expected.ID]
		rightFact, rightPresent := rightFacts[expected.ID]
		if leftPresent && rightPresent && factsAgree(leftFact, rightFact) {
			agree++
		}
	}
	return round4(100 * agree / total)
}

func actionsAgree(left, right ExtractedAction) bool {
	return left.ActionID == right.ActionID && left.BlockID == right.BlockID && left.Role == right.Role &&
		left.CanonicalURL == right.CanonicalURL && equivalentOrExact(compareText(left.Label, right.Label))
}

func factsAgree(left, right ExtractedFact) bool {
	if left.Type != right.Type {
		return false
	}
	switch left.Type {
	case factcontract.FactTypeText, factcontract.FactTypeLocation:
		return equivalentOrExact(compareText(left.Normalized, right.Normalized))
	case factcontract.FactTypeQuantity:
		return left.Normalized == right.Normalized && comparisonKey(left.Unit) == comparisonKey(right.Unit)
	default:
		return extractedFactValue(left) == extractedFactValue(right)
	}
}

func unsupportedClaimResults(configurationID string, extraction ExtractionV1, contract factcontract.ContractV1) []UnsupportedClaimResultV1 {
	result := make([]UnsupportedClaimResultV1, 0, len(extraction.UnsupportedClaims))
	for _, claim := range extraction.UnsupportedClaims {
		matches := []factcontract.ForbiddenClaimID{}
		for _, forbidden := range contract.ForbiddenClaims {
			if equivalentOrExact(compareText(claim.Statement, forbidden.Statement)) {
				matches = append(matches, forbidden.ID)
			}
		}
		sort.Slice(matches, func(i, j int) bool { return matches[i] < matches[j] })
		result = append(result, UnsupportedClaimResultV1{
			ConfigurationID: configurationID, Statement: claim.Statement,
			EvidenceIDs: append([]string(nil), claim.EvidenceIDs...), ForbiddenClaimIDs: matches,
			Contradiction: len(matches) != 0, RequiresReview: true,
		})
	}
	return result
}

func undeclaredFactResults(configurationID string, extraction ExtractionV1, contract factcontract.ContractV1) []UndeclaredFactResultV1 {
	declared := make(map[factcontract.FactID]struct{}, len(contract.RequiredFacts))
	for _, fact := range contract.RequiredFacts {
		declared[fact.ID] = struct{}{}
	}
	result := []UndeclaredFactResultV1{}
	for _, fact := range extraction.Facts {
		if _, ok := declared[fact.FactID]; !ok {
			result = append(result, UndeclaredFactResultV1{ConfigurationID: configurationID, Fact: fact})
		}
	}
	return result
}

func expectedFactValue(fact factcontract.RequiredFact) string {
	switch fact.Type {
	case factcontract.FactTypeText, factcontract.FactTypeLocation, factcontract.FactTypeCode:
		return pointerString(fact.TextValue)
	case factcontract.FactTypeDateTime:
		if fact.DateTimeValue != nil {
			return fact.DateTimeValue.RFC3339 + "|" + fact.DateTimeValue.Timezone
		}
	case factcontract.FactTypeMoney:
		if fact.MoneyValue != nil {
			return fact.MoneyValue.Amount + "|" + string(fact.MoneyValue.Currency)
		}
	case factcontract.FactTypePercentage, factcontract.FactTypeQuantity:
		if fact.NumberValue != nil {
			return fact.NumberValue.Value + "|" + fact.NumberValue.Unit
		}
	case factcontract.FactTypeURL:
		if fact.URLValue != nil {
			canonical, _, _ := canonicalizeHTTPURL(*fact.URLValue)
			return canonical
		}
	}
	return ""
}

func extractedFactValue(fact ExtractedFact) string {
	switch fact.Type {
	case factcontract.FactTypeDateTime:
		return fact.Normalized + "|" + fact.Timezone
	case factcontract.FactTypeMoney:
		return fact.Normalized + "|" + fact.Currency
	case factcontract.FactTypePercentage, factcontract.FactTypeQuantity:
		return fact.Normalized + "|" + fact.Unit
	default:
		return fact.Normalized
	}
}

// appliedWeights distributes the overall score across the dimensions that could
// actually be measured, renormalising over the rest.
//
// The four original weights are scaled by 0.8 and surfaceability takes the
// remaining 0.20. That specific split is not arbitrary: it keeps the four
// original weights in their existing 30:20:25:25 PROPORTION, so a campaign
// scored before surfaceability existed and rescored after — with surfaceability
// unavailable — lands on the same number. Adding a dimension should not silently
// restate every historical score.
//
// A dimension that could not be measured is renormalised AWAY rather than
// scored 0. Scoring it 0 would treat "we could not ask" as "the answer is no",
// which is the same error the unknown bucket exists to prevent one layer down.
func appliedWeights(hasFacts, hasSurfaceability bool) ComponentWeightsV1 {
	const scale = 0.8
	weights := ComponentWeightsV1{
		IntentFidelity:     .30 * scale,
		PrimaryAction:      .20 * scale,
		EntityRecovery:     .25 * scale,
		AnalyzerRobustness: .25 * scale,
		Surfaceability:     .20,
	}
	if !hasFacts {
		weights.EntityRecovery = 0
	}
	if !hasSurfaceability {
		weights.Surfaceability = 0
	}
	total := weights.IntentFidelity + weights.PrimaryAction +
		weights.EntityRecovery + weights.AnalyzerRobustness + weights.Surfaceability
	if total > 0 {
		weights.IntentFidelity /= total
		weights.PrimaryAction /= total
		weights.EntityRecovery /= total
		weights.AnalyzerRobustness /= total
		weights.Surfaceability /= total
	}
	weights.IntentFidelity = round6(weights.IntentFidelity)
	weights.PrimaryAction = round6(weights.PrimaryAction)
	weights.EntityRecovery = round6(weights.EntityRecovery)
	weights.AnalyzerRobustness = round6(weights.AnalyzerRobustness)
	weights.Surfaceability = round6(weights.Surfaceability)
	return weights
}

func weightedComposite(intent, action float64, entity *float64, robustness float64, weights ComponentWeightsV1) float64 {
	value := weights.IntentFidelity*intent + weights.PrimaryAction*action + weights.AnalyzerRobustness*robustness
	if entity != nil {
		value += weights.EntityRecovery * *entity
	}
	return round4(value)
}

func successfulIDs(required []string, outputs map[string]AnalyzerOutputV1) []string {
	result := []string{}
	for _, id := range required {
		if outputs[id].Receipt != nil {
			result = append(result, id)
		}
	}
	return result
}

func factMap(values []ExtractedFact) map[factcontract.FactID]ExtractedFact {
	result := make(map[factcontract.FactID]ExtractedFact, len(values))
	for _, fact := range values {
		result[fact.FactID] = fact
	}
	return result
}

func compareText(observed, expected string) MatchClass {
	if observed == expected {
		return MatchExact
	}
	if observed != "" && expected != "" && comparisonKey(observed) == comparisonKey(expected) {
		return MatchEquivalent
	}
	return MatchWrong
}

func equivalentOrExact(value MatchClass) bool { return value == MatchExact || value == MatchEquivalent }

func matchCredit(value MatchClass) float64 {
	switch value {
	case MatchExact:
		return 1
	case MatchEquivalent:
		return .5
	default:
		return 0
	}
}

func matchReason(value MatchClass) string {
	switch value {
	case MatchExact:
		return "normalized typed value exactly matches the contract"
	case MatchEquivalent:
		return "value is equivalent under the conservative score-v1 normalizer"
	case MatchMissing:
		return "required value is missing"
	default:
		return "normalized typed value differs from the contract"
	}
}

func criticalityWeight(value factcontract.Criticality) float64 {
	switch value {
	case factcontract.CriticalityCritical:
		return criticalFactWeight
	case factcontract.CriticalityImportant:
		return importantFactWeight
	default:
		return supportingFactWeight
	}
}

func pointerString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func mean(values []float64) float64 {
	total := 0.0
	for _, value := range values {
		total += value
	}
	return total / float64(len(values))
}

func scoreRange(outputs []OutputScoreV1) *ScoreRangeV1 {
	if len(outputs) == 0 {
		return nil
	}
	minimum, maximum := outputs[0].Overall, outputs[0].Overall
	for _, output := range outputs[1:] {
		minimum = math.Min(minimum, output.Overall)
		maximum = math.Max(maximum, output.Overall)
	}
	return &ScoreRangeV1{Min: round4(minimum), Max: round4(maximum), Spread: round4(maximum - minimum)}
}

func floatPointer(value float64) *float64 { return &value }

func round4(value float64) float64 { return math.Round(value*1e4) / 1e4 }
func round6(value float64) float64 { return math.Round(value*1e6) / 1e6 }

func stableScoreResult(result *ScenarioScoreV1) {
	sort.Strings(result.Coverage.MissingIDs)
	sort.Strings(result.Coverage.FailedIDs)
	sort.Strings(result.OmittedDimensions)
	sort.Slice(result.OutputScores, func(i, j int) bool {
		return result.OutputScores[i].ConfigurationID < result.OutputScores[j].ConfigurationID
	})
	sort.Slice(result.FactResults, func(i, j int) bool {
		if result.FactResults[i].ConfigurationID != result.FactResults[j].ConfigurationID {
			return result.FactResults[i].ConfigurationID < result.FactResults[j].ConfigurationID
		}
		return result.FactResults[i].FactID < result.FactResults[j].FactID
	})
	sort.Slice(result.UnsupportedClaims, func(i, j int) bool {
		if result.UnsupportedClaims[i].ConfigurationID != result.UnsupportedClaims[j].ConfigurationID {
			return result.UnsupportedClaims[i].ConfigurationID < result.UnsupportedClaims[j].ConfigurationID
		}
		return result.UnsupportedClaims[i].Statement < result.UnsupportedClaims[j].Statement
	})
	sort.Slice(result.UndeclaredFacts, func(i, j int) bool {
		if result.UndeclaredFacts[i].ConfigurationID != result.UndeclaredFacts[j].ConfigurationID {
			return result.UndeclaredFacts[i].ConfigurationID < result.UndeclaredFacts[j].ConfigurationID
		}
		return result.UndeclaredFacts[i].Fact.FactID < result.UndeclaredFacts[j].Fact.FactID
	})
	sort.SliceStable(result.Failures, func(i, j int) bool {
		if result.Failures[i].ConfigurationID != result.Failures[j].ConfigurationID {
			return result.Failures[i].ConfigurationID < result.Failures[j].ConfigurationID
		}
		if result.Failures[i].Code != result.Failures[j].Code {
			return result.Failures[i].Code < result.Failures[j].Code
		}
		return result.Failures[i].Detail < result.Failures[j].Detail
	})
}
