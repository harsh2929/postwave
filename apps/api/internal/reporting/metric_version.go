// SPDX-License-Identifier: AGPL-3.0-only

package reporting

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// Which definitions produced a number, and as of when the data was current.
//
// A stored report run carried neither. Two consequences, both of which look
// like a bug in whichever surface you happen to be looking at:
//
//  1. `campaign.open_rate` is opens/delivered. If it ever becomes opens/sent,
//     every run computed under the old rule still reads as "open rate", and
//     nothing distinguishes them. A quarter-over-quarter comparison then mixes
//     two different measurements and reports the difference as a result.
//
//  2. A run at 09:00 over a pipeline that last landed at 03:00 is a six-hour-old
//     answer. Read as "now", it makes desktop and web disagree about the same
//     saved report, and the disagreement is indistinguishable from a defect.
//
// The version is DERIVED from the registry rather than hand-maintained, because
// a constant someone has to remember to bump is wrong exactly when it matters:
// the release where a formula changed.

// MetricRegistryVersion identifies the metric semantics currently in force.
//
// Computed once at init from the built-in registry. Stamped onto every run so a
// stored result can always say which definitions produced it.
var MetricRegistryVersion = metricRegistryFingerprint(BuiltinMetricRegistry())

// metricRegistryFingerprint hashes what a metric MEANS.
//
// Covered: key, source, aggregation, value type, computation and its operands —
// everything that changes the arithmetic. Deliberately NOT covered: label,
// product area, dimensions, runtime status. Renaming "Open rate" to "Opens"
// changes no number, and versioning it would make the signal noise, which
// trains people to ignore the one change that mattered.
//
// Order-independent: reordering the literal is not a redefinition, and a
// fingerprint that moved with source order would mark every unrelated edit as a
// metric change.
func metricRegistryFingerprint(defs []MetricDefinition) string {
	parts := make([]string, 0, len(defs))
	for _, d := range defs {
		parts = append(parts, fmt.Sprintf(
			"%s|%s|%s|%s|%s|%s|%s",
			strings.TrimSpace(d.Key),
			strings.TrimSpace(d.Source),
			strings.TrimSpace(d.Aggregation),
			strings.TrimSpace(d.ValueType),
			strings.TrimSpace(d.Computation),
			strings.TrimSpace(d.Numerator),
			strings.TrimSpace(d.Denominator),
		))
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	// Twelve hex chars: enough that an accidental collision between two
	// registries is not a practical concern, short enough to read in a response
	// body and compare by eye across two surfaces.
	return "mv1-" + hex.EncodeToString(sum[:])[:12]
}
