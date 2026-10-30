// SPDX-License-Identifier: AGPL-3.0-only

package send_time_opt

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"
)

func TestWeightFor_KnownTypes(t *testing.T) {
	w := SignalWeights{Open: 1, Click: 3, Reply: 5}
	cases := []struct {
		event string
		want  int
	}{
		{"opened", 1},
		{"clicked", 3},
		{"replied", 5},
		{"OPENED", 1}, // case-insensitive
		{"  clicked ", 3},
		{"bounced", 0}, // unknown → 0
		{"", 0},        // empty → 0
		{"complained", 0},
	}
	for _, c := range cases {
		got := weightFor(c.event, w)
		if got != c.want {
			t.Errorf("weightFor(%q) = %d, want %d", c.event, got, c.want)
		}
	}
}

func TestClampWeights_OutOfRange(t *testing.T) {
	in := SignalWeights{Open: -5, Click: 200, Reply: 50}
	got := clampWeights(in)
	want := SignalWeights{Open: 0, Click: MaxSignalWeight, Reply: 50}
	if got != want {
		t.Errorf("clampWeights(%+v) = %+v, want %+v", in, got, want)
	}
}

// stubWeightsReader implements SignalWeightsReader for tests.
type stubWeightsReader struct {
	w   SignalWeights
	err error
}

func (s stubWeightsReader) GetSTOSignalWeights(_ context.Context, _ string) (SignalWeights, error) {
	return s.w, s.err
}

func TestResolveWeights_NilReader_ReturnsDefaults(t *testing.T) {
	got := resolveWeights(context.Background(), nil, "tenant-1")
	if got != DefaultSignalWeights {
		t.Errorf("nil reader: got %+v, want %+v", got, DefaultSignalWeights)
	}
}

func TestResolveWeights_ReaderError_FallsBackToDefaults(t *testing.T) {
	r := stubWeightsReader{
		w:   SignalWeights{Open: 99, Click: 99, Reply: 99},
		err: errors.New("DB unreachable"),
	}
	got := resolveWeights(context.Background(), r, "tenant-1")
	if got != DefaultSignalWeights {
		t.Errorf("read error: got %+v, want %+v", got, DefaultSignalWeights)
	}
}

func TestResolveWeights_ClampsOutOfRange(t *testing.T) {
	r := stubWeightsReader{
		w: SignalWeights{Open: -10, Click: 500, Reply: 7},
	}
	got := resolveWeights(context.Background(), r, "tenant-1")
	want := SignalWeights{Open: 0, Click: MaxSignalWeight, Reply: 7}
	if got != want {
		t.Errorf("clamp: got %+v, want %+v", got, want)
	}
}

// buildWeightedPattern: a reply at hour H should dominate 4 opens at
// hour H' (5 > 4) under the default weights — verifies the multiplicity
// approach actually shifts the modal pick.
func TestBuildWeightedPattern_ReplyDominatesFewOpens(t *testing.T) {
	// 4 opens (weight 1 each = 4 units) at Mon 9am.
	// 1 reply  (weight 5     = 5 units) at Fri 5pm.
	// Best should be Fri 5pm.
	times := []time.Time{
		dowHourTime(1, 9), dowHourTime(1, 9), dowHourTime(1, 9), dowHourTime(1, 9),
		dowHourTime(5, 17),
	}
	weights := []int{1, 1, 1, 1, 5}
	p := buildWeightedPattern(times, weights)
	if p.BestDOW != 5 || p.BestHour != 17 {
		t.Errorf("reply should dominate: best=(%d,%d) want (5,17)", p.BestDOW, p.BestHour)
	}
	if p.SampleSize != 9 { // 4 + 5 weighted units
		t.Errorf("SampleSize=%d want 9 (weighted)", p.SampleSize)
	}
	// Grid still sums to 1.0.
	var sum float64
	for d := 0; d < 7; d++ {
		for h := 0; h < 24; h++ {
			sum += p.Grid[d][h]
		}
	}
	if math.Abs(sum-1.0) > 1e-9 {
		t.Errorf("normalised sum=%f want 1.0", sum)
	}
}

// buildWeightedPattern with weight=0 entries: zero-weighted events
// must be skipped entirely. Useful for tenants who zero out the click
// signal (treating it as noise).
func TestBuildWeightedPattern_ZeroWeightSkipped(t *testing.T) {
	times := []time.Time{
		dowHourTime(1, 9),  // open, weight 1
		dowHourTime(3, 14), // click, weight 0 (disabled)
	}
	weights := []int{1, 0}
	p := buildWeightedPattern(times, weights)
	if p.SampleSize != 1 {
		t.Errorf("SampleSize=%d want 1 (zero-weight skipped)", p.SampleSize)
	}
	if p.BestDOW != 1 || p.BestHour != 9 {
		t.Errorf("best=(%d,%d) want (1,9); zero-weight click should not influence", p.BestDOW, p.BestHour)
	}
	// Disabled cell stays at zero.
	if p.Grid[3][14] != 0 {
		t.Errorf("Grid[3][14]=%f want 0 (zero-weight event)", p.Grid[3][14])
	}
}

// buildPattern (the back-compat wrapper) should produce the same
// result as buildWeightedPattern with weights=all-ones.
func TestBuildPattern_EqualsWeightedAllOnes(t *testing.T) {
	times := []time.Time{
		dowHourTime(1, 9), dowHourTime(1, 9),
		dowHourTime(3, 14),
	}
	flat := buildPattern(times)

	weights := []int{1, 1, 1}
	weighted := buildWeightedPattern(times, weights)

	if flat.SampleSize != weighted.SampleSize {
		t.Errorf("SampleSize: flat=%d weighted=%d", flat.SampleSize, weighted.SampleSize)
	}
	if flat.BestDOW != weighted.BestDOW || flat.BestHour != weighted.BestHour {
		t.Errorf("best differs: flat=(%d,%d) weighted=(%d,%d)",
			flat.BestDOW, flat.BestHour, weighted.BestDOW, weighted.BestHour)
	}
	for d := 0; d < 7; d++ {
		for h := 0; h < 24; h++ {
			if math.Abs(flat.Grid[d][h]-weighted.Grid[d][h]) > 1e-9 {
				t.Errorf("Grid[%d][%d] differs: flat=%f weighted=%f",
					d, h, flat.Grid[d][h], weighted.Grid[d][h])
			}
		}
	}
}
