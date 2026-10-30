// SPDX-License-Identifier: AGPL-3.0-only
//
// sto-strategy-persistence helper constants. Pairs with sto_strategy.go;
// kept in a separate file so the SQL-bearing code in sto_strategy.go
// reads cleanly without a wall of vocabulary constants up top.
//
// The CHECK constraint in migration 0299 pins the strategy vocabulary
// at the DB layer to:
//
//   'none' | 'modal_hour' | 'per_recipient'
//
// These Go-side constants and helpers exist so the rest of the package
// (and the send_time_opt handler that calls into us) doesn't sprinkle
// raw string literals next to every comparison.

package campaigns

import "strings"

// Send-time strategy vocabulary. Matches the CHECK constraint installed
// by migration 0299 on campaigns.send_time_strategy and
// tenant_send_settings.default_sto_strategy.
const (
	// SendTimeStrategyNone is the legacy "no STO applied" posture. New
	// campaigns get this by default so opt-in stays explicit.
	SendTimeStrategyNone = "none"

	// SendTimeStrategyModalHour collapses every recipient onto the
	// audience's modal best-hour. Surfaces as a tight cluster in the
	// schedule-preview distribution histogram.
	SendTimeStrategyModalHour = "modal_hour"

	// SendTimeStrategyPerRecipient honours each recipient's individual
	// best_hour — the personalized rung Klaviyo/Braze/Iterable surface
	// as their headline STO feature.
	SendTimeStrategyPerRecipient = "per_recipient"
)

// ValidSendTimeStrategy returns true iff `s` is one of the three
// labels the DB CHECK constraint will accept. Caller-side validation
// keeps a typo from a drifted client off the SQL path entirely.
//
// Case-insensitive by convention — the CHECK is case-sensitive, so we
// normalize via NormalizeSendTimeStrategy before persisting.
func ValidSendTimeStrategy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case SendTimeStrategyNone,
		SendTimeStrategyModalHour,
		SendTimeStrategyPerRecipient:
		return true
	default:
		return false
	}
}

// NormalizeSendTimeStrategy folds whitespace + casing into the
// canonical lower-case form the CHECK constraint expects. Unknown
// values are folded to SendTimeStrategyNone so a drifted caller can
// never write an invalid value into the column.
func NormalizeSendTimeStrategy(s string) string {
	n := strings.ToLower(strings.TrimSpace(s))
	switch n {
	case SendTimeStrategyNone,
		SendTimeStrategyModalHour,
		SendTimeStrategyPerRecipient:
		return n
	default:
		return SendTimeStrategyNone
	}
}
