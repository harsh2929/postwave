// SPDX-License-Identifier: AGPL-3.0-only
package track

import "regexp"

const maxEventNameLength = 128

// eventNamePattern is the canonical Product Events naming contract shared
// with the desktop composer:
//
//   - lowercase ASCII letter at the start of every dot-delimited segment
//   - lowercase ASCII letters, digits, and underscores inside a segment
//   - no empty segments, whitespace, control characters, or punctuation
//
// Keeping this contract at the ingestion boundary prevents clients that skip
// the desktop validation from creating event names the rest of the product
// cannot reliably address.
var eventNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`)

// ValidEventName is the contract, exported because there is more than one
// ingestion boundary.
//
// The comment above described this as enforced "at the ingestion boundary",
// singular. There are two: `POST /api/v1/track` and the warehouse importer,
// which writes straight into `product_events` from a customer's own tables. The
// importer never called this, so a source object could create `Purchase`,
// `purchase_completed ` or a 300-character name — all of which the API rejects,
// all of which then appear in the catalog, in segment conditions, and in flow
// event triggers.
//
// The failure is silent and durable: a flow trigger on `purchase` never fires
// for an imported `Purchase`, and nothing anywhere reports a mismatch. One rule
// with one enforcer and one bypass is not a contract.
func ValidEventName(name string) bool {
	return len(name) <= maxEventNameLength && eventNamePattern.MatchString(name)
}

// MaxEventNameLength is exported alongside it so a second boundary can explain
// the limit in its own error message without restating the number.
const MaxEventNameLength = maxEventNameLength

func validEventName(name string) bool { return ValidEventName(name) }
