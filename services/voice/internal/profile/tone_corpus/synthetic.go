// Package tone_corpus holds the labeled writing samples used to calibrate
// the tone classifier weights, plus a stub exporter for future production
// label sources.
//
// The corpus ships in-tree (rather than as a downloaded artifact) so the
// build is hermetic and the calibration step is reproducible from a clean
// checkout. Total size is ~200 samples; each carries five 0..1 axis labels.
//
// Adding samples
//   - Append to LabeledSamples in synthetic_data.go.
//   - Score every axis (no NaN / no skipped fields).
//   - Run `go test ./services/voice/internal/profile/tone_corpus/...` to
//     verify the coverage assertions still pass.
//   - Re-run the calibrator: `go run -tags=calibrate ./services/voice/...`
//   - Paste the new weights into tone_weights.go.
package tone_corpus

// LabeledSample is a single training example: one writing sample plus
// the five 0..1 tone-axis labels. All five labels are required (zero is
// a meaningful label, not a missing-value sentinel).
type LabeledSample struct {
	Text       string
	Humor      float64
	Formality  float64
	Optimism   float64
	Directness float64
	Warmth     float64
}

// AxisLabels returns the five labels in the canonical order
// (humor, formality, optimism, directness, warmth) for use by the
// trainer. Order matches profile.AxisFeatureWeights field order.
func (s LabeledSample) AxisLabels() [5]float64 {
	return [5]float64{s.Humor, s.Formality, s.Optimism, s.Directness, s.Warmth}
}

// AxisIndex maps the trainer's --axis flag to the slot in AxisLabels.
// Returns -1 for unknown axis names.
func AxisIndex(name string) int {
	switch name {
	case "humor":
		return 0
	case "formality":
		return 1
	case "optimism":
		return 2
	case "directness":
		return 3
	case "warmth":
		return 4
	}
	return -1
}

// AxisName is the inverse of AxisIndex.
func AxisName(i int) string {
	switch i {
	case 0:
		return "humor"
	case 1:
		return "formality"
	case 2:
		return "optimism"
	case 3:
		return "directness"
	case 4:
		return "warmth"
	}
	return ""
}

// CoverageStats summarizes the corpus along each axis: how many examples
// are "high" (label > 0.7), "low" (label < 0.3), or in the mid band.
// The trainer prints this on startup to make corpus skew visible.
type CoverageStats struct {
	Total       int
	PerAxisHigh [5]int
	PerAxisLow  [5]int
	PerAxisMid  [5]int
}

// Coverage walks LabeledSamples and tallies high/low/mid counts per axis.
func Coverage() CoverageStats {
	stats := CoverageStats{Total: len(LabeledSamples)}
	for _, s := range LabeledSamples {
		labels := s.AxisLabels()
		for i, v := range labels {
			switch {
			case v > 0.7:
				stats.PerAxisHigh[i]++
			case v < 0.3:
				stats.PerAxisLow[i]++
			default:
				stats.PerAxisMid[i]++
			}
		}
	}
	return stats
}
