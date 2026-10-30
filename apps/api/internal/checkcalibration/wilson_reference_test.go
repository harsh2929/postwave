// SPDX-License-Identifier: AGPL-3.0-only

package checkcalibration

import (
	"math"
	"testing"
)

// Checked against published Wilson score values rather than against this
// implementation, so the interval is verified, not merely self-consistent.
// 0/10 at 95%: upper bound ~0.2775 (the "rule of three" gives ~0.30 as a rough
// check). 5/10: ~[0.2366, 0.7634], the classic symmetric case.
func TestWilsonMatchesPublishedValues(t *testing.T) {
	cases := []struct {
		s, n   int
		lo, hi float64
	}{
		{0, 10, 0.0, 0.2775},
		{5, 10, 0.2366, 0.7634},
		{1, 100, 0.0018, 0.0538},
	}
	for _, c := range cases {
		lo, hi := wilsonInterval(c.s, c.n, zScore95)
		if math.Abs(lo-c.lo) > 0.001 || math.Abs(hi-c.hi) > 0.001 {
			t.Errorf("wilson(%d/%d) = [%.4f,%.4f], want ~[%.4f,%.4f]", c.s, c.n, lo, hi, c.lo, c.hi)
		}
	}
}
