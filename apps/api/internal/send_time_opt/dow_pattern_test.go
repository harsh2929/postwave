// SPDX-License-Identifier: AGPL-3.0-only

package send_time_opt

import (
	"math"
	"testing"
	"time"
)

// dowHourTime constructs a UTC timestamp at the given day-of-week
// (Sunday=0) + hour-of-day. Anchored on 2024-01-07 Sunday 00:00 UTC.
func dowHourTime(dow, hour int) time.Time {
	base := time.Date(2024, 1, 7, 0, 0, 0, 0, time.UTC) // Sunday
	return base.AddDate(0, 0, dow).Add(time.Duration(hour) * time.Hour)
}

func TestBuildPattern_EmptyReturnsZero(t *testing.T) {
	p := buildPattern(nil)
	if p.SampleSize != 0 {
		t.Errorf("empty opens should give SampleSize=0, got %d", p.SampleSize)
	}
	for d := 0; d < 7; d++ {
		for h := 0; h < 24; h++ {
			if p.Grid[d][h] != 0 {
				t.Errorf("empty pattern non-zero at [%d][%d]", d, h)
			}
		}
	}
}

func TestBuildPattern_NormalisesToFractions(t *testing.T) {
	// 10 opens, all on Monday 9am. Grid[1][9] should be 1.0; sum of
	// all cells should be 1.0.
	opens := make([]time.Time, 10)
	for i := range opens {
		opens[i] = dowHourTime(1, 9)
	}
	p := buildPattern(opens)
	if p.SampleSize != 10 {
		t.Fatalf("SampleSize=%d want 10", p.SampleSize)
	}
	if p.Grid[1][9] != 1.0 {
		t.Errorf("expected Grid[1][9]=1.0, got %f", p.Grid[1][9])
	}
	var sum float64
	for d := 0; d < 7; d++ {
		for h := 0; h < 24; h++ {
			sum += p.Grid[d][h]
		}
	}
	if math.Abs(sum-1.0) > 1e-9 {
		t.Errorf("grid sum=%f want 1.0", sum)
	}
}

func TestBuildPattern_FindsBestCell(t *testing.T) {
	// 5 opens at Monday 9am, 3 opens at Friday 5pm. Best should be
	// Monday 9am (5/8 = 0.625).
	opens := []time.Time{}
	for i := 0; i < 5; i++ {
		opens = append(opens, dowHourTime(1, 9))
	}
	for i := 0; i < 3; i++ {
		opens = append(opens, dowHourTime(5, 17))
	}
	p := buildPattern(opens)
	if p.BestDOW != 1 || p.BestHour != 9 {
		t.Errorf("best=(%d,%d) want (1,9)", p.BestDOW, p.BestHour)
	}
	if p.SecondaryDOW != 5 || p.SecondaryHour != 17 {
		t.Errorf("secondary=(%d,%d) want (5,17)", p.SecondaryDOW, p.SecondaryHour)
	}
}

func TestBuildPattern_BimodalDetection(t *testing.T) {
	// 5/5 split between two peaks → second/first = 1.0 → bimodal=true.
	opens := []time.Time{}
	for i := 0; i < 5; i++ {
		opens = append(opens, dowHourTime(1, 9))
	}
	for i := 0; i < 5; i++ {
		opens = append(opens, dowHourTime(3, 14))
	}
	p := buildPattern(opens)
	if !p.Bimodal {
		t.Errorf("expected bimodal=true for 5/5 split, got false")
	}

	// 8/2 split → second/first = 0.25 → bimodal=false.
	opens = nil
	for i := 0; i < 8; i++ {
		opens = append(opens, dowHourTime(1, 9))
	}
	for i := 0; i < 2; i++ {
		opens = append(opens, dowHourTime(3, 14))
	}
	p = buildPattern(opens)
	if p.Bimodal {
		t.Errorf("expected bimodal=false for 8/2 split, got true")
	}
}

func TestBuildPattern_BimodalSingleOpenSafe(t *testing.T) {
	// Single open — no division by zero, no false bimodal.
	p := buildPattern([]time.Time{dowHourTime(2, 10)})
	if p.SampleSize != 1 {
		t.Fatalf("SampleSize=%d want 1", p.SampleSize)
	}
	if p.Bimodal {
		t.Error("single open must not be flagged bimodal")
	}
	if p.Grid[2][10] != 1.0 {
		t.Errorf("Grid[2][10]=%f want 1.0", p.Grid[2][10])
	}
}

func TestBuildPattern_BimodalThresholdBoundary(t *testing.T) {
	// 5/3 split — second/first = 0.6 exactly; the >= 0.6 check should
	// flag this as bimodal.
	opens := []time.Time{}
	for i := 0; i < 5; i++ {
		opens = append(opens, dowHourTime(1, 9))
	}
	for i := 0; i < 3; i++ {
		opens = append(opens, dowHourTime(3, 14))
	}
	p := buildPattern(opens)
	if !p.Bimodal {
		t.Errorf("5/3 split (ratio 0.6) must be flagged bimodal")
	}
}
