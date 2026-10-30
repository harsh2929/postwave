// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import (
	"math"
	"sort"
	"strings"
)

// AggregateScenariosV1 returns a conservative cross-scenario result. Worst
// and Mean remain nil until every required scenario has one complete score.
func AggregateScenariosV1(requiredScenarioIDs []string, scores []ScenarioScoreV1) ScenarioAggregateV1 {
	result := ScenarioAggregateV1{
		ScoreVersion:     ScoreVersionV1,
		Coverage:         CoverageV1{Required: len(requiredScenarioIDs), MissingIDs: []string{}, FailedIDs: []string{}},
		WorstScenarioIDs: []string{}, Failures: []ScoreFailureV1{},
	}
	if len(requiredScenarioIDs) == 0 || len(requiredScenarioIDs) > 256 {
		result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_required_scenario_count", Detail: "one to 256 required scenario ids are required"})
	}
	requiredLimit := len(requiredScenarioIDs)
	if requiredLimit > 256 {
		requiredLimit = 256
	}
	required := make(map[string]struct{}, requiredLimit)
	for _, raw := range requiredScenarioIDs[:requiredLimit] {
		id := strings.TrimSpace(raw)
		if !validReference(id) {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "invalid_scenario_id", Detail: "scenario id must be a stable reference: " + id})
			continue
		}
		if _, duplicate := required[id]; duplicate {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "duplicate_required_scenario", Detail: "scenario id appears more than once: " + id})
			continue
		}
		required[id] = struct{}{}
	}
	result.Coverage.Required = len(required)
	if len(scores) > 256 {
		result.Failures = append(result.Failures, ScoreFailureV1{Code: "scenario_score_limit_exceeded", Detail: "at most 256 scenario scores are permitted"})
	}
	scoreLimit := len(scores)
	if scoreLimit > 256 {
		scoreLimit = 256
	}
	byID := make(map[string]ScenarioScoreV1, scoreLimit)
	duplicateIDs := make(map[string]struct{})
	for _, score := range scores[:scoreLimit] {
		id := strings.TrimSpace(score.ScenarioID)
		if _, expected := required[id]; !expected {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "unexpected_scenario", Detail: "score is not part of the required scenario set: " + id})
			continue
		}
		if _, alreadyDuplicate := duplicateIDs[id]; alreadyDuplicate {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "duplicate_scenario_score", Detail: "scenario has more than one score: " + id})
			continue
		}
		if _, duplicate := byID[id]; duplicate {
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "duplicate_scenario_score", Detail: "scenario has more than one score: " + id})
			delete(byID, id)
			duplicateIDs[id] = struct{}{}
			continue
		}
		byID[id] = score
	}
	values := []float64{}
	for id := range required {
		score, present := byID[id]
		if !present {
			result.Coverage.MissingIDs = append(result.Coverage.MissingIDs, id)
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "required_scenario_missing", Detail: "required scenario score is absent: " + id})
			continue
		}
		result.Coverage.Terminal++
		result.HasContradictions = result.HasContradictions || score.HasContradictions
		if score.ScoreVersion != ScoreVersionV1 || !score.Complete || score.Overall == nil ||
			math.IsNaN(dereferenceAggregate(score.Overall)) || math.IsInf(dereferenceAggregate(score.Overall), 0) ||
			dereferenceAggregate(score.Overall) < 0 || dereferenceAggregate(score.Overall) > 100 {
			result.Coverage.FailedIDs = append(result.Coverage.FailedIDs, id)
			result.Failures = append(result.Failures, ScoreFailureV1{Code: "required_scenario_incomplete", Detail: "required scenario has no complete score: " + id})
			continue
		}
		result.Coverage.Successful++
		values = append(values, *score.Overall)
	}
	if result.Coverage.Required > 0 {
		result.Coverage.Ratio = round6(float64(result.Coverage.Successful) / float64(result.Coverage.Required))
	}
	if len(values) != 0 {
		minimum, maximum := values[0], values[0]
		for _, value := range values[1:] {
			minimum = math.Min(minimum, value)
			maximum = math.Max(maximum, value)
		}
		result.Range = &ScoreRangeV1{Min: round4(minimum), Max: round4(maximum), Spread: round4(maximum - minimum)}
	}
	if result.Coverage.Required != 0 && result.Coverage.Successful == result.Coverage.Required && len(result.Failures) == 0 {
		result.Complete = true
		result.Worst = floatPointer(result.Range.Min)
		result.Mean = floatPointer(round4(mean(values)))
		for id, score := range byID {
			if score.Overall != nil && *score.Overall == *result.Worst {
				result.WorstScenarioIDs = append(result.WorstScenarioIDs, id)
			}
		}
	}
	sort.Strings(result.Coverage.MissingIDs)
	sort.Strings(result.Coverage.FailedIDs)
	sort.Strings(result.WorstScenarioIDs)
	sort.SliceStable(result.Failures, func(i, j int) bool {
		if result.Failures[i].Code != result.Failures[j].Code {
			return result.Failures[i].Code < result.Failures[j].Code
		}
		return result.Failures[i].Detail < result.Failures[j].Detail
	})
	return result
}

func dereferenceAggregate(value *float64) float64 {
	if value == nil {
		return math.NaN()
	}
	return *value
}
