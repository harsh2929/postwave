// SPDX-License-Identifier: AGPL-3.0-only

package slackint

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestSendTestSampleRenders verifies the INTG-033 synthetic test payload
// renders a non-empty Slack message carrying the test marker, so a "Send test"
// delivers something meaningful rather than an empty card.
func TestSendTestSampleRenders(t *testing.T) {
	msg := FormatSlackMessage("test", sampleTestBody)
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	if !strings.Contains(s, "Moosewave") {
		t.Fatalf("test message should mention Moosewave: %s", s)
	}
	if !strings.Contains(s, "test") {
		t.Fatalf("test message should carry the test event marker: %s", s)
	}
}
