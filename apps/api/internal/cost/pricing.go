package cost

// pricing.go — the price constants the cost ledger never had.
//
// The ledger recorded cents=0 for every entry, so /api/v1/costs reported $0 for
// every tenant and dollar budgets could never trip. The blocker was precision:
// SES is $0.10 per 1,000 emails = 0.01 cents/email, which is 0 in the int
// `cents` column. Everything here is therefore computed in MICROCENTS and
// integer-precise:
//
//	1 dollar  = 100 cents = 1,000,000 microcents
//	1 cent    = 10,000 microcents
//
// The rates are 2026 list prices and are intended to be operator-tunable (a
// tenant on a negotiated SES rate can override MicrocentsPerSend). They are the
// public numbers, not secrets.

import "strings"

// Pricing carries the rates used to turn usage into microcents.
type Pricing struct {
	// MicrocentsPerSend is the cost of delivering one email.
	MicrocentsPerSend int64
	// tokenRates maps a model family to its per-1M-token rates. $1 = 1,000,000
	// microcents, so "$3 per 1M tokens" is exactly 3,000,000 microcents-per-1M,
	// i.e. 3 microcents/token — expressed here as microcents-per-1M so the
	// division stays integer.
	tokenRates map[string]tokenRate
	// defaultRate prices any model not in the table. Set to the most expensive
	// family so an unrecognised model is never under-metered.
	defaultRate tokenRate
}

type tokenRate struct {
	inputMicrocentsPerM  int64
	outputMicrocentsPerM int64
}

// DefaultPricing returns the built-in 2026 list-price table.
func DefaultPricing() Pricing {
	sonnet := tokenRate{inputMicrocentsPerM: 3_000_000, outputMicrocentsPerM: 15_000_000} // $3 / $15 per M
	return Pricing{
		// SES $0.10 / 1,000 = $0.0001/email = 100 microcents.
		MicrocentsPerSend: 100,
		tokenRates: map[string]tokenRate{
			"claude-opus-4-1":        {inputMicrocentsPerM: 15_000_000, outputMicrocentsPerM: 75_000_000}, // retired legacy rate
			"claude-opus":            {inputMicrocentsPerM: 5_000_000, outputMicrocentsPerM: 25_000_000},  // current Opus family
			"claude-sonnet-5":        {inputMicrocentsPerM: 2_000_000, outputMicrocentsPerM: 10_000_000},  // $2 / $10
			"claude-sonnet":          sonnet,
			"claude-3-5-son":         sonnet,
			"claude-haiku":           {inputMicrocentsPerM: 1_000_000, outputMicrocentsPerM: 5_000_000}, // Haiku 4.5 $1 / $5
			"claude-3-5-hai":         {inputMicrocentsPerM: 800_000, outputMicrocentsPerM: 4_000_000},
			"gpt":                    {inputMicrocentsPerM: 1_250_000, outputMicrocentsPerM: 10_000_000}, // GPT-5 $1.25 / $10
			"gemini-3.1-pro-preview": {inputMicrocentsPerM: 2_000_000, outputMicrocentsPerM: 12_000_000}, // <=200k prompt
			"gemini-3-flash-preview": {inputMicrocentsPerM: 500_000, outputMicrocentsPerM: 3_000_000},    // $0.50 / $3
			"gemini":                 {inputMicrocentsPerM: 2_000_000, outputMicrocentsPerM: 12_000_000}, // conservative known Gemini default
		},
		// Unknown model → current high-end rate: never silently price at zero.
		defaultRate: tokenRate{inputMicrocentsPerM: 10_000_000, outputMicrocentsPerM: 50_000_000},
	}
}

// MicrocentsForSends returns the cost of delivering n emails.
func (p Pricing) MicrocentsForSends(n int) int64 {
	if n <= 0 {
		return 0
	}
	return p.MicrocentsPerSend * int64(n)
}

// MicrocentsForTokens returns the cost of a generation of the given token
// counts on the given model. The model is matched by longest known prefix so
// "claude-sonnet-4-6" resolves to the sonnet rate without an exact-match table.
func (p Pricing) MicrocentsForTokens(model string, inputTokens, outputTokens int) int64 {
	rate := p.rateFor(model)
	// microcents = tokens * (microcents-per-1M) / 1,000,000. Integer math; the
	// division is exact for the round-number rates above and truncates
	// negligibly otherwise (sub-microcent).
	const perM = 1_000_000
	in := int64(max0(inputTokens)) * rate.inputMicrocentsPerM / perM
	out := int64(max0(outputTokens)) * rate.outputMicrocentsPerM / perM
	return in + out
}

func (p Pricing) rateFor(model string) tokenRate {
	m := strings.ToLower(strings.TrimSpace(model))
	var best tokenRate
	var bestLen int
	for prefix, rate := range p.tokenRates {
		if strings.HasPrefix(m, prefix) && len(prefix) > bestLen {
			best, bestLen = rate, len(prefix)
		}
	}
	if bestLen == 0 {
		return p.defaultRate
	}
	return best
}

// CentsFromMicrocents rounds microcents to whole cents, half-up. Used for the
// display `cents` column; microcents remains the precise source of truth.
func CentsFromMicrocents(mc int64) int {
	if mc <= 0 {
		return 0
	}
	return int((mc + 5000) / 10000)
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}
