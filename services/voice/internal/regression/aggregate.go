// SPDX-License-Identifier: AGPL-3.0-only
//
// aggregate.go — a pure roll-up of already-computed ReplayResults into a
// BatchResult. The streaming replay-batch endpoint scores each example once
// and emits it, then needs the same mean / p25 / per-surface aggregate the
// non-streaming ReplayBatch produces — WITHOUT replaying the LLM a second
// time. AggregateResults gives both paths one shared, testable aggregation.
package regression

import "math"

// AggregateResults rolls a slice of (already-scored) ReplayResults into a
// BatchResult using warn as the per-example pass threshold (score >= warn =>
// passed). Error results are counted in Total / per-surface Total but
// excluded from the score statistics — so the UI can honestly show
// "1 of 5 failed to generate". Zero is a valid frozen threshold and means
// every finite scored result passes.
func AggregateResults(results []ReplayResult, warn float64) BatchResult {
	if math.IsNaN(warn) || math.IsInf(warn, 0) || warn < 0 || warn > 100 {
		warn = DefaultWarnThreshold
	}
	out := BatchResult{BySurface: map[string]SurfaceAggregate{}, Results: results}
	scores := make([]float64, 0, len(results))
	surfaceScores := map[string][]float64{}
	for _, rr := range results {
		out.Total++
		agg := out.BySurface[rr.SurfaceKind]
		agg.Total++
		if rr.Severity != "error" && rr.FidelityScore != nil {
			score := *rr.FidelityScore
			out.Scored++
			agg.Scored++
			scores = append(scores, score)
			surfaceScores[rr.SurfaceKind] = append(surfaceScores[rr.SurfaceKind], score)
			if score >= warn {
				out.Passed++
				agg.Passed++
			}
		}
		out.BySurface[rr.SurfaceKind] = agg
	}
	out.MeanScore = meanPointer(scores)
	out.P25Score = percentilePointer(scores, 25)
	for k, ss := range surfaceScores {
		agg := out.BySurface[k]
		agg.MeanScore = meanPointer(ss)
		out.BySurface[k] = agg
	}
	return out
}
