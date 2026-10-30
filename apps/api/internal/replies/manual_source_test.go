// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"os"
	"strings"
	"testing"
)

// A manually recorded reply is an OPERATOR ASSERTION, not a provider
// observation. Someone forwarded a reply, or read it in another inbox, and
// typed it in. That is worth recording — it is not evidence that the platform
// observed a human replying to a campaign.
//
// Strong() is what gates the canonical `replied` engagement event, which feeds
// lead scoring (weight 10), send-time optimisation, day-of-week patterns and
// the profile summary. Letting an operator's typing drive those would let a
// tenant inflate their own engagement signals by hand.
func TestManualMatchIsNeverStrongCorrelation(t *testing.T) {
	if !MatchManual.Valid() {
		t.Fatal("MatchManual must be a valid match method")
	}
	if MatchManual.Strong() {
		t.Fatal("MatchManual is strong correlation: an operator's assertion would " +
			"emit canonical engagement and inflate lead scoring and send-time models")
	}
	if !SourceManual.Valid() {
		t.Fatal("SourceManual must be a valid reply source")
	}
}

// The guarantee above only holds while the canonical-event gate actually
// consults Strong(). If a later edit drops that term, MatchManual becomes
// strong by omission and no unit test on the enum would notice.
func TestCanonicalEngagementGateStillRequiresStrongCorrelation(t *testing.T) {
	raw, err := os.ReadFile("store.go")
	if err != nil {
		t.Fatalf("read store.go: %v", err)
	}
	source := string(raw)
	index := strings.Index(source, "emitCanonical :=")
	if index < 0 {
		t.Fatal("canonical engagement gate not found: this test can no longer protect it")
	}
	gate := source[index:]
	if end := strings.Index(gate, "\n\tif emitCanonical"); end > 0 {
		gate = gate[:end]
	}
	if !strings.Contains(gate, "r.MatchMethod.Strong()") {
		t.Fatal("the canonical engagement gate no longer requires strong correlation, " +
			"so a manually asserted reply can now emit human engagement")
	}
}
