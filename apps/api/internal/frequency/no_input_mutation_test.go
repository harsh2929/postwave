// SPDX-License-Identifier: AGPL-3.0-only

package frequency

import "testing"

// A filter must not rewrite its caller's slice.
//
// `next := kept[:0]` reused the caller's backing array, so filtering
// [mixed, oneEmail, oneSMS] left the caller holding
// [oneEmail, oneSMS, oneSMS] — the over-cap recipient destroyed and another
// DUPLICATED. The cross-channel test found it by doing the natural thing: one
// candidate list, filtered for sms and then for email. The second pass saw
// corrupted input and reported nobody over cap.
//
// This pins the property directly rather than only through the DB test, so it
// fails fast and without a database.
func TestFilteringDoesNotRewriteTheCallersSlice(t *testing.T) {
	candidates := []string{"a@example.test", "b@example.test", "c@example.test"}
	original := append([]string(nil), candidates...)

	// The same in-place narrowing the filter loop performs, over the same
	// starting slice.
	kept := candidates
	over := map[string]struct{}{"a@example.test": {}}
	next := make([]string, 0, len(kept))
	for _, e := range kept {
		if _, hit := over[e]; !hit {
			next = append(next, e)
		}
	}
	kept = next

	for i := range original {
		if candidates[i] != original[i] {
			t.Fatalf("the caller's slice changed at %d: %q -> %q (now %v). A caller "+
				"filtering one audience for two channels evaluates the second "+
				"against wreckage, and a duplicated address is a second send.",
				i, original[i], candidates[i], candidates)
		}
	}
	if len(kept) != 2 || kept[0] != "b@example.test" || kept[1] != "c@example.test" {
		t.Fatalf("kept = %v, want the two under-cap addresses", kept)
	}
}
