// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Every engagement reader must apply the shared predicate.
//
// The classification column is only worth having if something FILTERS on it. A
// column that is written and never read is the failure this project keeps
// meeting, and adding one while leaving all five readers counting every row
// would have been a more elaborate version of the original bug.
//
// The predicate is checked by NAME rather than by its SQL text: a reader that
// inlined `classification = 'human_reply'` would pass a text search and still be
// a sixth copy of the rule, free to drift.
func TestEveryEngagementReaderUsesTheSharedPredicate(t *testing.T) {
	for _, tc := range []struct{ path, why, symbol string }{
		{
			path: "store.go",
			why: "the A/B winner reply_rate numerator; counting an OOO here can " +
				"select the wrong campaign variant",
			symbol: "HumanEngagementPredicate",
		},
		{
			// The engagement panel takes NotKnownMachinePredicate, not the
			// human-only one, and the difference is deliberate rather than a
			// weakening. This surface reports ONE reply figure with no
			// unclassified bucket beside it, so excluding NULL would delete every
			// pre-classifier reply from the product's history. It still excludes
			// KNOWN auto-replies, which is the corruption the PRD names.
			//
			// The behavioural proof lives in internal/analytics
			// (TestTheUnfilteredReplyFigureExcludesKnownAutoRepliesOnly_DB): this
			// entry only pins that the panel uses a SHARED constant rather than a
			// hand-inlined sixth copy of the rule.
			path: "../analytics/classification_filter.go",
			why: "the engagement score that feeds AI-surfacing — an out-of-office " +
				"notice raising this score is the corruption the PRD names",
			symbol: "replies.NotKnownMachinePredicate",
		},
		{
			path:   "../reply_analytics/reply_analytics.go",
			why:    "the per-campaign reply counts an operator reads as engagement",
			symbol: "replies.HumanEngagementPredicate",
		},
	} {
		source, err := os.ReadFile(tc.path)
		if err != nil {
			t.Fatalf("read %s: %v", tc.path, err)
		}
		// Guard the guard: a truncated read would satisfy the check below.
		if len(source) < 1000 {
			t.Fatalf("%s is %d bytes; the assertion would be vacuous", tc.path, len(source))
		}
		body := string(source)
		if !strings.Contains(body, tc.symbol) {
			t.Errorf("%s (%s) does not use %s — it "+
				"counts auto-replies and out-of-office notices as engagement",
				tc.path, tc.why, tc.symbol)
		}
	}
}

// The predicate excludes NULL, and that is the deliberate choice.
//
// A NULL classification is a row that predates the classifier, so its class is
// UNKNOWN — and counting unknown as human is precisely the assumption the column
// exists to stop being made silently. The rows are not lost: they move to the
// unclassified count, which is the same treatment F01 gives its unknown bucket.
func TestThePredicateExcludesUnclassifiedRatherThanAssumingHuman(t *testing.T) {
	if !strings.Contains(HumanEngagementPredicate, "= 'human_reply'") {
		t.Fatalf("predicate %q does not restrict to human replies", HumanEngagementPredicate)
	}
	if strings.Contains(HumanEngagementPredicate, "IS NULL") {
		t.Fatal("the engagement predicate admits NULL classifications, which asserts " +
			"that every pre-classifier reply was human — the exact claim the column " +
			"exists to stop being made by default")
	}
	// And the unknown population has somewhere to be reported.
	if !strings.Contains(UnclassifiedPredicate, "IS NULL") {
		t.Error("there is no predicate for the unclassified population, so the drop " +
			"when classification landed would be unexplainable")
	}
	// The three predicates must partition the table: human, excluded, unknown.
	if strings.Contains(ExcludedPredicate, "IS NULL") ||
		!strings.Contains(ExcludedPredicate, "IS NOT NULL") {
		t.Error("the excluded predicate overlaps or misses the unknown population, " +
			"so the three counts will not sum to the total")
	}
}

// TestNoReaderInlinesTheClassificationLiteral is the REVERSE direction, and it
// enforces in code the exact fear the guard above states in prose:
//
//	"a reader that inlined `classification = 'human_reply'` would pass a text
//	 search and still be a sixth copy of the rule, free to drift"
//
// The test above answers "do the readers I LISTED use the shared symbol?" — a
// hand-enumerated table of three, whose own doc-comment says "all five
// readers". It cannot see a reader that is not in the table, and two existed:
//
//   - mailchimpv3/p1.go counted every reply with NO classification predicate
//     and divided by unique recipients, so its `reply_rate` counted
//     out-of-office and auto-replies as engagement.
//   - verification/health_store.go inlined the literal — the sixth copy,
//     verbatim as predicted.
//
// This scan needs no table. Outside this package there is exactly one correct
// way to spell the rule, and it is the exported constant.
func TestNoReaderInlinesTheClassificationLiteral(t *testing.T) {
	root := repoInternalRoot(t)
	// The literal, split so this test file does not match itself.
	needle := "classification = '" + "human_reply'"

	var offenders []string
	scanned := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		// classify.go DEFINES the predicate; it is the one place the literal
		// belongs.
		if filepath.Base(path) == "classify.go" &&
			strings.Contains(filepath.Dir(path), "replies") {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		scanned++
		// COMMENTS STRIPPED. Files that explain WHY they use the shared constant
		// name the literal in prose, and matching that reports the opposite of
		// the truth — the same trap this programme has now hit three times.
		if strings.Contains(stripGoComments(string(body)), needle) {
			rel, _ := filepath.Rel(root, path)
			offenders = append(offenders, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	// Vacuity floor: a walk that stops finding Go files would pass silently.
	if scanned < 200 {
		t.Fatalf("scanned only %d non-test Go files; the walk is not reaching the "+
			"tree and this test proves nothing", scanned)
	}
	if len(offenders) > 0 {
		t.Errorf("these inline the human-reply classification instead of using "+
			"replies.HumanEngagementPredicate:\n  %s\n"+
			"An inlined copy passes a text search and is still free to drift from "+
			"the rule every other reader shares.", strings.Join(offenders, "\n  "))
	}
}

// repoInternalRoot resolves apps/api/internal from this test's own location.
func repoInternalRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve caller")
	}
	// .../internal/replies/engagement_exclusion_test.go -> .../internal
	return filepath.Dir(filepath.Dir(current))
}

// stripGoComments removes block and line comments so a source scan measures
// CODE. Crude on purpose: it does not need to understand strings, because the
// only thing being searched for is a SQL literal, and a false negative here
// would require somebody to embed `//` inside the very predicate they are
// inlining.
func stripGoComments(src string) string {
	var b strings.Builder
	b.Grow(len(src))
	for i := 0; i < len(src); i++ {
		if src[i] == '/' && i+1 < len(src) {
			if src[i+1] == '/' {
				for i < len(src) && src[i] != '\n' {
					i++
				}
				b.WriteByte('\n')
				continue
			}
			if src[i+1] == '*' {
				end := strings.Index(src[i+2:], "*/")
				if end < 0 {
					break
				}
				i += 2 + end + 1
				continue
			}
		}
		b.WriteByte(src[i])
	}
	return b.String()
}
