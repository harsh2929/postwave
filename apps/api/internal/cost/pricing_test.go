package cost

import "testing"

// The ledger recorded cents=0 for everything and no price constant existed, so
// /api/v1/costs reported $0 for every tenant and dollar budgets could never
// trip. The core problem is precision: SES is $0.10 per 1,000 emails = 0.01
// cents per email, which rounds to 0 in the int `cents` column. Pricing is
// therefore computed in MICROCENTS (1 cent = 10,000 microcents; $1 = 1,000,000
// microcents), integer-precise, and rounded to cents only for display.
func TestMicrocentsForSends(t *testing.T) {
	// $0.10 / 1,000 = 100 microcents/email.
	if got := DefaultPricing().MicrocentsForSends(1); got != 100 {
		t.Errorf("1 email = %d microcents, want 100 (0.01 cents)", got)
	}
	// A 10,000-email campaign = 1,000,000 microcents = 100 cents = $1.00.
	if got := DefaultPricing().MicrocentsForSends(10000); got != 1_000_000 {
		t.Errorf("10k emails = %d microcents, want 1,000,000 ($1.00)", got)
	}
}

func TestMicrocentsForTokens(t *testing.T) {
	p := DefaultPricing()
	// Sonnet: $3/M input, $15/M output. $1 = 1M microcents, so $3/M = 3
	// microcents/token in, 15 out.
	// 1,000 input tokens = 3,000 microcents = 0.3 cents.
	if got := p.MicrocentsForTokens("claude-sonnet-4-6", 1000, 0); got != 3000 {
		t.Errorf("1k sonnet input = %d microcents, want 3000", got)
	}
	// 1,000 output tokens = 15,000 microcents = 1.5 cents.
	if got := p.MicrocentsForTokens("claude-sonnet-4-6", 0, 1000); got != 15000 {
		t.Errorf("1k sonnet output = %d microcents, want 15000", got)
	}
	// The retired 3.5 Haiku family retains its historical $0.80/M + $4/M.
	if got := p.MicrocentsForTokens("claude-3-5-haiku-latest", 1000, 1000); got != 800+4000 {
		t.Errorf("1k+1k haiku = %d microcents, want 4800", got)
	}
	if got := p.MicrocentsForTokens("gemini-3-flash-preview", 1000, 1000); got != 500+3000 {
		t.Errorf("1k+1k Gemini Flash = %d microcents, want 3500", got)
	}
	if got := p.MicrocentsForTokens("gemini-3.1-pro-preview", 1000, 1000); got != 2000+12000 {
		t.Errorf("1k+1k Gemini Pro = %d microcents, want 14000", got)
	}
	// An unknown model must NOT price at zero — that would silently un-meter a
	// new model. It falls back to the (more expensive) default so cost is never
	// understated.
	if got := p.MicrocentsForTokens("some-future-model", 1000, 0); got <= 0 {
		t.Errorf("unknown model priced at %d; must fall back to a nonzero default", got)
	}
}

func TestCentsFromMicrocents(t *testing.T) {
	cases := map[int64]int{
		0:         0,
		4999:      0, // 0.4999 cents rounds down
		5000:      1, // 0.5 cents rounds up (half-up)
		10000:     1,
		1_000_000: 100,
		1_004_999: 100,
		1_005_000: 101,
	}
	for mc, want := range cases {
		if got := CentsFromMicrocents(mc); got != want {
			t.Errorf("CentsFromMicrocents(%d) = %d, want %d", mc, got, want)
		}
	}
}
