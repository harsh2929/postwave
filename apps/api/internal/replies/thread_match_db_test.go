// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"os"
	"strings"
	"testing"
)

// The thread matcher must query a key something actually writes.
//
// It queried `outbox_events.payload->>'esp_message_id'` on the belief that the
// send pipeline wrote it. Nothing does — a repo-wide search finds only readers,
// and the live table holds zero rows carrying that key. So the matcher's own
// PRIMARY branch could never resolve: every threaded reply fell through to VERP
// or subscriber matching, and one with neither landed in manual review looking
// exactly like a reply to a message we never sent.
//
// That is the worst kind of broken, because the matcher itself was correct. The
// priority discipline, the never-match-on-subject rule, the VERP fallback — all
// right, all reached only after the branch that should have answered first
// silently returned nothing.
func TestTheMatcherQueriesTheKeyTheSendLedgerWrites(t *testing.T) {
	source, err := os.ReadFile("match.go")
	if err != nil {
		t.Fatalf("read match.go: %v", err)
	}
	if len(source) < 1000 {
		t.Fatalf("match.go is %d bytes; the assertion would be vacuous", len(source))
	}
	body := string(source)

	if !strings.Contains(body, "FROM campaign_send_deliveries") {
		t.Error("the matcher does not query campaign_send_deliveries.message_id — " +
			"the only table whose message_id has a production writer")
	}
	// And it must be tried FIRST. Order is the whole point: the fallback is kept
	// for deployments that do populate esp_message_id, but a lookup that cannot
	// resolve must not run ahead of one that can.
	deliveries := strings.Index(body, "matchBySendDeliveryMessageID(ctx, tx")
	// Anchored to the SQL, not the words. The first version searched for
	// "payload->>'esp_message_id'" and matched the COMMENT explaining that the
	// fallback was demoted — a guard that cannot tell code from prose about code,
	// which is the second time that exact mistake has been made in this project.
	outbox := strings.Index(body, "WHERE payload->>'esp_message_id'")
	if deliveries == -1 {
		t.Fatal("the send-ledger lookup is not called")
	}
	if outbox != -1 && outbox < deliveries {
		t.Error("the esp_message_id fallback runs BEFORE the send-ledger lookup; " +
			"the branch that cannot resolve is being tried first")
	}
}

// The old lookup is retained rather than deleted.
//
// A deployment whose pipeline does populate esp_message_id should keep working.
// Deleting a fallback because it is unreachable HERE is how a fix becomes a
// regression somewhere else.
func TestTheOldLookupIsKeptAsAFallback(t *testing.T) {
	source, err := os.ReadFile("match.go")
	if err != nil {
		t.Fatalf("read match.go: %v", err)
	}
	if !strings.Contains(string(source), "esp_message_id") {
		t.Error("the esp_message_id lookup was deleted rather than demoted; a " +
			"deployment that does write it would silently stop matching")
	}
}
