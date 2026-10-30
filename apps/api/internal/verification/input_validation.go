// SPDX-License-Identifier: AGPL-3.0-only

package verification

// hasUnsafeControlText is shared by health, bulk HTTP, and durable job entry
// points. It checks the raw value before trimming so vertical tab, form feed,
// C1 controls, bidi/zero-width format controls, private-use runes, and invalid
// UTF-8 cannot disappear during normalization or reach persisted/operator text.
func hasUnsafeControlText(raw string) bool {
	return unsafeProviderResultText(raw)
}
