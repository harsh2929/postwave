// SPDX-License-Identifier: AGPL-3.0-only

package replies

import "testing"

// A References chain must be tokenized, not compared whole.
//
// The ingest path stored the entire "<a@x> <b@x> <c@x>" string in a field the
// matcher compares against ONE Message-ID. That comparison cannot succeed — it
// returns no rows and looks exactly like a reply to a message we never sent, so
// the row lands in manual review and nobody learns the matcher was fine.
func TestAReferencesChainIsTokenized(t *testing.T) {
	got := ParseMessageIDs("<root@example.test> <middle@example.test> <parent@example.test>")
	if len(got) != 3 {
		t.Fatalf("got %d ids from a three-id chain: %v", len(got), got)
	}
	// Most specific first: RFC 5322 puts the immediate parent LAST, and the
	// immediate parent is the message being replied to. Attributing to the oldest
	// ancestor would credit a reply to the first campaign in a long thread.
	if got[0] != "parent@example.test" {
		t.Fatalf("first candidate = %q, want the immediate parent (last in the "+
			"header) — a long thread would attribute to its oldest ancestor", got[0])
	}
	if got[2] != "root@example.test" {
		t.Errorf("last candidate = %q, want the thread root", got[2])
	}
}

// Folded and comma-separated headers are handled.
func TestFoldedAndCommaSeparatedReferencesParse(t *testing.T) {
	for _, raw := range []string{
		"<a@x.test>\r\n <b@x.test>",
		"<a@x.test>,<b@x.test>",
		"<a@x.test>\t<b@x.test>",
		"  <a@x.test>   <b@x.test>  ",
	} {
		got := ParseMessageIDs(raw)
		if len(got) != 2 {
			t.Errorf("%q produced %d ids: %v", raw, len(got), got)
		}
	}
}

// Angle brackets are stripped, and non-Message-IDs are dropped.
func TestParsingStripsBracketsAndRejectsNonMessageIDs(t *testing.T) {
	got := ParseMessageIDs("<real@example.test> not-an-id <alsoreal@example.test>")
	if len(got) != 2 {
		t.Fatalf("got %v, want the two real ids only", got)
	}
	for _, id := range got {
		if id[0] == '<' || id[len(id)-1] == '>' {
			t.Errorf("%q still carries angle brackets; the stored Message-ID does not", id)
		}
	}
}

// In-Reply-To wins over References when both are present.
//
// In-Reply-To names exactly one parent; References is a chain whose last entry is
// only conventionally the parent. Preferring the unambiguous header is the whole
// reason the PRD lists them in that order.
func TestInReplyToWinsOverReferences(t *testing.T) {
	got := firstThreadCandidate(
		"<direct@example.test>",
		"<root@example.test> <other@example.test>",
	)
	if got != "direct@example.test" {
		t.Fatalf("candidate = %q, want the In-Reply-To value", got)
	}

	// With no In-Reply-To, the immediate parent from References is used.
	got = firstThreadCandidate("", "<root@example.test> <parent@example.test>")
	if got != "parent@example.test" {
		t.Fatalf("candidate = %q, want the immediate parent from References — a "+
			"reply carrying only References could not match at all before this", got)
	}

	// Neither present is empty, not garbage.
	if got := firstThreadCandidate("", ""); got != "" {
		t.Fatalf("candidate = %q from no headers at all", got)
	}
}

// Duplicates collapse, so a thread that re-lists ids does not retry the same
// lookup.
func TestDuplicateReferencesCollapse(t *testing.T) {
	got := ParseMessageIDs("<a@x.test> <b@x.test> <a@x.test>")
	if len(got) != 2 {
		t.Fatalf("got %v, want two distinct ids", got)
	}
}
