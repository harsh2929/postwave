package zerocopy_triggers

import "testing"

func TestShouldAbandon(t *testing.T) {
	cases := []struct {
		retryCount, maxRetries int
		abandon                bool
	}{
		{0, 5, false}, // next attempt -> 1, far below ceiling
		{3, 5, false}, // next -> 4, still below 5
		{4, 5, true},  // next would reach 5 -> abandon
		{9, 5, true},  // already past
		{0, 1, true},  // maxRetries=1: never retry
	}
	for _, c := range cases {
		if got := shouldAbandon(c.retryCount, c.maxRetries); got != c.abandon {
			t.Errorf("shouldAbandon(%d,%d)=%v want %v", c.retryCount, c.maxRetries, got, c.abandon)
		}
	}
}
