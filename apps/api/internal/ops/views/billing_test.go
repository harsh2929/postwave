package views

import "testing"

func TestMonthlySendsCap(t *testing.T) {
	cases := map[string]int{
		"studio":  2000,
		"sending": 50000,
		"pro":     500000,
		"":        2000, // unknown/empty defaults to the floor
		"bogus":   2000,
	}
	for tier, want := range cases {
		if got := MonthlySendsCap(tier); got != want {
			t.Errorf("MonthlySendsCap(%q) = %d, want %d", tier, got, want)
		}
	}
}

func TestUsageFraction(t *testing.T) {
	if got := UsageFraction(500, 2000); got != 0.25 {
		t.Errorf("500/2000 = %v, want 0.25", got)
	}
	// A zero cap must not divide by zero.
	if got := UsageFraction(10, 0); got != 0 {
		t.Errorf("cap 0 must yield 0, got %v", got)
	}
	// Over quota reports > 1.0 (operators must see overage).
	if got := UsageFraction(3000, 2000); got <= 1 {
		t.Errorf("over-quota must exceed 1.0, got %v", got)
	}
}
