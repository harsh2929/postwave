// SPDX-License-Identifier: AGPL-3.0-only

package handlers

import (
	"strings"
	"testing"
)

func TestFinalizeAuditListPageRequiresLookaheadForCursor(t *testing.T) {
	exactlyFull := []AuditRow{{ID: 30}, {ID: 20}}
	rows, cursor := finalizeAuditListPage(exactlyFull, 2)
	if len(rows) != 2 || cursor != "" {
		t.Fatalf("exact terminal page = (%d rows, cursor %q), want (2, empty)", len(rows), cursor)
	}

	withLookahead := []AuditRow{{ID: 30}, {ID: 20}, {ID: 10}}
	rows, cursor = finalizeAuditListPage(withLookahead, 2)
	if len(rows) != 2 || cursor != "20" {
		t.Fatalf("lookahead page = (%d rows, cursor %q), want (2, 20)", len(rows), cursor)
	}
	if rows[len(rows)-1].ID != 20 {
		t.Fatalf("lookahead row leaked into visible page: %#v", rows)
	}
}

func TestFinalizeAuditChainRequiresRow501ForTruncation(t *testing.T) {
	exact := make([]auditChainRow, auditChainLimit)
	rows, truncated := finalizeAuditChain(exact)
	if len(rows) != auditChainLimit || truncated {
		t.Fatalf("exact chain = (%d rows, truncated %v), want (%d, false)", len(rows), truncated, auditChainLimit)
	}

	lookahead := make([]auditChainRow, auditChainLimit+1)
	rows, truncated = finalizeAuditChain(lookahead)
	if len(rows) != auditChainLimit || !truncated {
		t.Fatalf("lookahead chain = (%d rows, truncated %v), want (%d, true)", len(rows), truncated, auditChainLimit)
	}
}

func TestAuditAggregateWindowExcludesMetaReadsByDefault(t *testing.T) {
	// The aggregate must hide exactly what the feed hides, or the headline
	// totals describe a different row set than the list beneath them. Both the
	// meta-read trail and the generic http.* middleware trail are excluded
	// unless the caller names an action.
	if !strings.Contains(auditAggregateWhere,
		"($4 <> '' OR (action NOT LIKE 'audit.read.%' AND action NOT LIKE 'http.%'))") {
		t.Fatalf("aggregate window no longer mirrors the feed's default exclusions: %s", auditAggregateWhere)
	}
}

func TestAuditCSVNeutralizesSpreadsheetFormulas(t *testing.T) {
	for _, dangerous := range []string{
		"=HYPERLINK(\"https://example.invalid\")",
		"+SUM(1,1)",
		"-1+2",
		"@cmd",
		"  =1+1",
	} {
		got := csvJoin(dangerous)
		if !strings.Contains(got, "'") {
			t.Fatalf("csvJoin(%q) = %q, want a formula-neutralizing apostrophe", dangerous, got)
		}
	}
	for _, safe := range []string{"human", "203.0.113.7", "{\"safe\":true}"} {
		if got := csvJoin(safe); strings.Contains(got, "'") {
			t.Fatalf("csvJoin(%q) = %q, safe field was modified", safe, got)
		}
	}
}
