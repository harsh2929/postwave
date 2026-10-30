// SPDX-License-Identifier: AGPL-3.0-only

package reporting

import (
	"strings"
	"testing"
)

// A saved report's numbers are only interpretable with two facts attached.
//
//  1. WHICH metric definitions produced them. `campaign.open_rate` is
//     opens/delivered today; if it ever becomes opens/sent, every stored run
//     computed under the old rule silently means something else, and nothing
//     distinguishes the two.
//  2. AS OF WHEN the underlying data was current. A run at 09:00 over a
//     pipeline that last landed at 03:00 is a six-hour-old answer, and reading
//     it as "now" is how two surfaces show different numbers for the same
//     report and everyone assumes one of them is broken.
//
// Neither existed. The registry was a compile-time literal with no version and
// runs carried no freshness stamp, so desktop and web could disagree with no
// way to tell a bug from a lag from a redefinition.

func TestTheMetricRegistryDeclaresAVersion(t *testing.T) {
	if strings.TrimSpace(MetricRegistryVersion) == "" {
		t.Fatal("the registry has no version, so a stored run cannot say which " +
			"definitions produced it")
	}
}

func TestTheVersionChangesWhenTheRegistryDoes(t *testing.T) {
	// The version must be DERIVED from the registry, not a constant someone has
	// to remember to bump. A hand-maintained version is wrong exactly when it
	// matters — the release where a metric's formula changed.
	base := metricRegistryFingerprint(BuiltinMetricRegistry())

	changed := append([]MetricDefinition(nil), BuiltinMetricRegistry()...)
	for i := range changed {
		if changed[i].Key == "campaign.open_rate" {
			// The exact redefinition described above: opens/delivered → opens/sent.
			changed[i].Denominator = "campaign.sent"
		}
	}
	if metricRegistryFingerprint(changed) == base {
		t.Fatal("redefining open_rate's denominator did not change the " +
			"fingerprint, so a run computed under the old rule is " +
			"indistinguishable from one computed under the new")
	}
}

func TestTheVersionIsStableAcrossOrdering(t *testing.T) {
	// Reordering the literal is not a redefinition. A fingerprint that moved
	// with source order would mark every unrelated edit as a metric change and
	// train everyone to ignore it.
	reversed := append([]MetricDefinition(nil), BuiltinMetricRegistry()...)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	if metricRegistryFingerprint(reversed) != metricRegistryFingerprint(BuiltinMetricRegistry()) {
		t.Fatal("the fingerprint moved when only the source order changed")
	}
}

func TestALabelChangeIsNotARedefinition(t *testing.T) {
	// The fingerprint covers what a number MEANS — source, aggregation,
	// computation, operands. Renaming "Open rate" to "Opens" changes nothing
	// about the arithmetic, and versioning it would make the signal noise.
	relabelled := append([]MetricDefinition(nil), BuiltinMetricRegistry()...)
	for i := range relabelled {
		relabelled[i].Label = "renamed " + relabelled[i].Label
	}
	if metricRegistryFingerprint(relabelled) != metricRegistryFingerprint(BuiltinMetricRegistry()) {
		t.Fatal("a label change moved the metric version")
	}
}
