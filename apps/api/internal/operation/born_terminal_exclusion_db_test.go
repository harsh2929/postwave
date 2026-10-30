// SPDX-License-Identifier: AGPL-3.0-only

package operation

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// bornTerminalExclusions are the tables excluded from the registry because
// nothing in this repository ever moves their rows to another status.
//
// Every OTHER exclusion rests on a judgment that cannot go stale: a row per
// recipient stays a row per recipient. These three rest on a fact about the
// CODE — "no writer transitions this" — and facts about code change without
// anyone revisiting the comment that depended on them. The day someone adds
// the worker that marks a remix asset `ready`, the table becomes a genuine
// operation family and this exclusion turns into a lie that hides real work
// from the shared view. Nothing else would notice: the coverage test would
// still pass, because the table is still classified.
//
// So the claim is asserted rather than narrated. The exclusion prose says
// there is no UPDATE anywhere; this fails the moment there is one.
var bornTerminalExclusions = map[string]string{
	"sar_bundles":          "both writers INSERT 'ready'; no UPDATE exists",
	"lookalike_models":     "the single writer INSERTs 'ready'; no UPDATE exists",
	"content_remix_assets": "the INSERT omits status so rows stay 'pending'; rendering is deferred",

	// Added 2026-08-10, after the detector below was hardened. Three OTHER
	// candidates were checked at the same time and turned out to HAVE writers
	// that a plain grep for `UPDATE <table>` had missed — which is the whole
	// argument for putting the claim under this guard rather than in a comment.
	"automation_journey_executions": "zero INSERTs and zero UPDATEs; only internal/sar reads it",
	"inbound_route_action_runs":     "status is bound at INSERT once the action has already run",
	"review_requests":               "status is bound at INSERT (reviews/repo.go) and never moved",
	"subscriber_prediction_runs":    "status is bound at INSERT (sto_predictive_clv/repo.go) and never moved",

	// Added last, and it is the reason the detector now tells an UPDATE apart
	// from a TRANSITION. This table IS updated — to record an export
	// destination — while its status never moves, so the old "was the table
	// UPDATEd" test would have reported a lifecycle that does not exist and
	// blocked a correct classification.
	"subscriber_lookalike_audiences": "INSERT hardcodes 'ready'; the one UPDATE sets exported_destination_id, not status",
}

// sqlIdentifier is one SQL name, optionally double-quoted. Used only for the
// schema half of a qualified reference, where the name is not known ahead of
// time — `public` today, but a guard that only knows `public` is a guard that
// a `SET search_path` refactor walks straight past.
const sqlIdentifier = `(?:"[A-Za-z_][A-Za-z0-9_$]*"|[A-Za-z_][A-Za-z0-9_$]*)`

// maxStatementWindow bounds how far after an `INSERT INTO <table>` this guard
// will look for the `ON CONFLICT ... DO UPDATE` tail that belongs to it. Every
// upsert in this repository is far shorter; the cap only exists so that an
// unterminated match cannot drag in a later, unrelated query.
const maxStatementWindow = 4096

// nextStatementStart bounds a statement window when no terminator is present —
// SQL embedded in a Go interpreted string literal has neither a `;` nor a
// closing backtick to stop at, so the next INSERT is the backstop.
var nextStatementStart = regexp.MustCompile(`(?i)\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO|DELETE\s+FROM)\b`)

// continuationUpdate matches the two places SQL writes UPDATE as part of a
// LARGER statement rather than as the start of a new one: `ON CONFLICT ... DO
// UPDATE` and `WHEN MATCHED ... THEN UPDATE`.
//
// Go's regexp has no lookbehind, so the window scanner filters these by looking
// at what precedes each candidate. Both were found by the guard's own fixtures
// within a minute of each other — treating either as a statement boundary cuts
// the window off immediately before the clause that branch exists to find.
var continuationUpdate = regexp.MustCompile(`(?is)\b(?:DO|THEN)\s+$`)

// bornTerminalDetector recognises the ways this repository actually writes a
// status transition to one named table.
//
// The obvious pattern — `\bUPDATE\s+<table>\b` — reads like it covers the case
// and does not. It demands the bare unqualified name in the very next token, so
// every one of these slips through untouched:
//
//	UPDATE public.sar_bundles SET ...        -- schema-qualified; migration 1768
//	                                            already writes this exact shape
//	UPDATE "lookalike_models" SET ...        -- quoted identifier
//	UPDATE ONLY sar_bundles SET ...          -- inheritance-scoped
//	INSERT ... ON CONFLICT ... DO UPDATE ... -- the transition hidden in an upsert
//
// Four ordinary ways to write the thing the guard exists to notice. Each one is
// a silent pass, which is the worst outcome available to a guard: the exclusion
// prose keeps claiming "no UPDATE exists" and the test keeps agreeing.
type bornTerminalDetector struct {
	table string
	// update matches a direct UPDATE of the table in any of its spellings.
	update *regexp.Regexp
	// insert matches an INSERT INTO the table. It is only half an answer: the
	// upsert tail has to be found separately so that a `DO UPDATE` belonging to
	// some other statement in the same file cannot be attributed to this table.
	insert *regexp.Regexp
	// upsert matches the conflict tail, searched only inside one statement.
	upsert *regexp.Regexp
	// statusAssign matches a SET clause that assigns status, used to tell a
	// transition apart from an update of some other column.
	statusAssign *regexp.Regexp
	// merge matches MERGE INTO the table; mergeWrite matches the MATCHED arm
	// that performs the transition. Split for the same reason as insert/upsert:
	// the arm must be found inside this statement, not anywhere in the file.
	merge      *regexp.Regexp
	mergeWrite *regexp.Regexp
}

func newBornTerminalDetector(table string) bornTerminalDetector {
	quoted := regexp.QuoteMeta(table)
	// [schema.]table. The unquoted arm carries \b so `UPDATE sar_bundles_archive`
	// (a table that does not exist today, and might) cannot masquerade as a hit
	// on this one; the quoted arm needs no \b because the closing quote is the
	// boundary — "sar_bundles" cannot be a prefix of "sar_bundles_archive".
	ref := `(?:` + sqlIdentifier + `\s*\.\s*)?(?:"` + quoted + `"|` + quoted + `\b)`
	return bornTerminalDetector{
		table: table,
		// (?i) only: no (?s) is needed, and `.` staying line-bound keeps the
		// tokens between UPDATE and the table name on one logical run of
		// whitespace — which \s+ already spans newlines for.
		update: regexp.MustCompile(`(?i)\bUPDATE\s+(?:ONLY\s+)?` + ref),
		insert: regexp.MustCompile(`(?i)\bINSERT\s+INTO\s+` + ref),
		upsert: regexp.MustCompile(`(?is)\bON\s+CONFLICT\b.*?\bDO\s+UPDATE\b`),
		// MERGE hides the verb behind the table: `MERGE INTO t … WHEN MATCHED
		// THEN UPDATE SET …` never puts the table after the word UPDATE, so the
		// `update` pattern cannot see it, and there is no INSERT INTO for the
		// upsert path to hang off. It is not hypothetical here —
		// `internal/dbrouter/classifier_test.go` already pins a MERGE against
		// `subscribers` as a write, so the codebase reasons about this form
		// elsewhere while this guard did not.
		merge: regexp.MustCompile(`(?i)\bMERGE\s+INTO\s+(?:ONLY\s+)?` + ref),
		// An UPDATE of the table is only a TRANSITION if it assigns `status`.
		// Without this the guard answers a different question than the one it
		// claims to: `subscriber_lookalike_audiences` is updated to record an
		// export destination and never moves its status, and reading that as a
		// lifecycle would have blocked a correct born-terminal classification.
		//
		// Anchored on `status =` rather than the bare word, so a RETURNING list
		// that merely names the column does not count — that update reads the
		// status back, it does not set it.
		statusAssign: regexp.MustCompile(`(?is)\bSET\b.*?\bstatus\s*=`),
		mergeWrite:   regexp.MustCompile(`(?is)\bWHEN\s+MATCHED\b.*?\bTHEN\s+UPDATE\b`),
	}
}

// mayMention reports whether src could hold a match of any of d's patterns.
// Every pattern embeds d.table (the ref built in newBornTerminalDetector), so
// a file that never names the table cannot transition it; lower must be
// strings.ToLower(src). The patterns match case-insensitively under Unicode
// simple folding, where the ASCII letters of a table name have exactly two
// non-ASCII partners: U+212A KELVIN SIGN (k), which strings.ToLower already
// maps to 'k', and U+017F LATIN SMALL LETTER LONG S (s), which it does not. A
// file carrying either rune goes to the full patterns unfiltered, so this
// filter can never hide a match. TestBornTerminalPrefilterNeverHidesAMatch
// pins both halves of that argument.
func (d bornTerminalDetector) mayMention(src, lower string) bool {
	return strings.Contains(lower, d.table) || strings.ContainsAny(src, "\u212A\u017F")
}

// transitions reports whether src contains a status transition against the
// detector's table.
func (d bornTerminalDetector) transitions(src string) bool {
	for _, loc := range d.update.FindAllStringIndex(src, -1) {
		if d.statusAssign.MatchString(statementWindow(src[loc[1]:])) {
			return true
		}
	}
	// An upsert only counts when its conflict tail is inside the SAME statement
	// as the INSERT naming this table. Searching the whole file for `DO UPDATE`
	// would flag any file that happens to both mention the table and upsert
	// something else — a false alarm on a guard whose failure message tells the
	// reader to go re-register a family.
	for _, loc := range d.insert.FindAllStringIndex(src, -1) {
		if d.upsert.MatchString(statementWindow(src[loc[1]:])) {
			return true
		}
	}
	for _, loc := range d.merge.FindAllStringIndex(src, -1) {
		if d.mergeWrite.MatchString(statementWindow(src[loc[1]:])) {
			return true
		}
	}
	return false
}

// statementWindow returns the text belonging to the statement that has just
// begun, given everything that follows its opening keywords.
//
// MEASURED RESIDUAL, so nobody has to re-derive it. Sweeping the three scan
// roots for real `INSERT … ON CONFLICT … DO UPDATE` statements finds 346, of
// which 11 are still invisible to the detector for their own table (it was 19
// before the backtick was dropped). The remainder are queries assembled across
// more indirection than any text window can follow — a fragment held in a
// variable, a builder loop — and closing them needs a parser rather than a
// better regex.
//
// That residual is acceptable HERE and the reason is specific: none of the 11
// involves `sar_bundles`, `lookalike_models` or `content_remix_assets`, the
// only three tables this guard checks. It is a bound on a hypothetical future
// miss, not a live hole. If a fourth table is ever excluded as born-terminal,
// re-run that measurement for it rather than assuming this one carries over.
func statementWindow(rest string) string {
	if len(rest) > maxStatementWindow {
		rest = rest[:maxStatementWindow]
	}
	// A statement ends at the SQL terminator. It does NOT end at a backtick.
	//
	// An earlier version stopped at one, reasoning that the closing backtick of
	// a Go raw string is where the query ends. That is true only for a query
	// written as a single literal. A backtick is a FRAGMENT boundary, and any
	// query assembled from more than one — `b.WriteString(\`INSERT INTO … \`)`
	// followed by `b.WriteString(\`ON CONFLICT … DO UPDATE\`)`, or a literal
	// interrupted by `+ renum +` — had its own conflict tail thrown away. Ten
	// real upserts in this repository were invisible to the detector for their
	// own table because of it, including the exact hidden-in-an-upsert form
	// this guard exists to catch. Dropping the backtick costs nothing: every
	// fixture that supposedly justified it still passes on `nextStatementStart`
	// alone, which is the real backstop.
	//
	// The `;` search skips single-quoted SQL literals, so a semicolon inside a
	// value ('a; b') cannot end the statement early — the same class of
	// premature truncation, one character wide.
	if i := statementTerminator(rest); i >= 0 {
		rest = rest[:i]
	}
	for _, loc := range nextStatementStart.FindAllStringIndex(rest, -1) {
		// `DO UPDATE` and `THEN UPDATE` are continuations, not new statements.
		if continuationUpdate.MatchString(rest[:loc[0]]) {
			continue
		}
		rest = rest[:loc[0]]
		break
	}
	return rest
}

// statementTerminator finds the `;` that ends this statement, ignoring any
// that sits inside a single-quoted SQL string literal. Doubled quotes (”) are
// the SQL escape for a literal quote and correctly toggle twice, leaving the
// parser inside the string where it belongs.
func statementTerminator(rest string) int {
	inLiteral := false
	for i := 0; i < len(rest); i++ {
		switch rest[i] {
		case '\'':
			inLiteral = !inLiteral
		case ';':
			if !inLiteral {
				return i
			}
		}
	}
	return -1
}

// TestBornTerminalTransitionDetector pins the detector against the forms it has
// to catch and the lookalikes it must not.
//
// It runs on literal SQL held here rather than on probe files written into the
// repository: a guard that can only be exercised by dirtying the tree is a
// guard nobody exercises, and a probe file left behind by a crashed run would
// fail the real scan for reasons that have nothing to do with the code.
func TestBornTerminalTransitionDetector(t *testing.T) {
	matches := []struct {
		name  string
		table string
		src   string
	}{{
		name:  "bare",
		table: "sar_bundles",
		src:   `UPDATE sar_bundles SET status = 'failed' WHERE id = $1;`,
	}, {
		// The three below were all MISSED by the first version of this detector
		// and were found by an adversarial pass over the real corpus, not by
		// imagination. Each is a shape this repository already writes.
		name:  "upsert split across two Go string fragments",
		table: "content_remix_assets",
		src: "b.WriteString(`INSERT INTO content_remix_assets (tenant_id, kind) VALUES `)\n" +
			"b.WriteString(`ON CONFLICT (tenant_id, kind) DO UPDATE SET status = 'ready'`)",
	}, {
		name:  "upsert whose literal is interrupted by a concatenation",
		table: "content_remix_assets",
		src: "tx.Exec(ctx, `INSERT INTO content_remix_assets (tenant_id) VALUES ` + values + `\n" +
			"ON CONFLICT (tenant_id) DO UPDATE SET status = 'ready'`)",
	}, {
		name:  "merge with a matched update arm",
		table: "sar_bundles",
		src:   `MERGE INTO sar_bundles t USING staging s ON t.id = s.id WHEN MATCHED THEN UPDATE SET status = 'failed';`,
	}, {
		name:  "merge qualified and quoted",
		table: "content_remix_assets",
		src:   `MERGE INTO public."content_remix_assets" t USING s ON true WHEN MATCHED THEN UPDATE SET status = 'ready';`,
	}, {
		name:  "semicolon inside a string literal does not end the statement",
		table: "content_remix_assets",
		src:   `INSERT INTO content_remix_assets (tenant_id, note) VALUES ($1, 'a; b') ON CONFLICT (tenant_id) DO UPDATE SET status = 'ready';`,
	}, {
		name:  "schema qualified",
		table: "sar_bundles",
		src:   `UPDATE public.sar_bundles SET status = 'failed';`,
	}, {
		name:  "quoted identifier",
		table: "lookalike_models",
		src:   `UPDATE "lookalike_models" SET status = 'running';`,
	}, {
		name:  "only",
		table: "sar_bundles",
		src:   `UPDATE ONLY sar_bundles SET status = 'pending';`,
	}, {
		name:  "only plus quoted schema qualification",
		table: "sar_bundles",
		src:   `UPDATE ONLY "public"."sar_bundles" SET status = 'pending';`,
	}, {
		name:  "padded qualification",
		table: "lookalike_models",
		src:   "UPDATE public . lookalike_models\n  SET status = 'running';",
	}, {
		name:  "line broken after keyword",
		table: "lookalike_models",
		src:   "UPDATE\n\tpublic.lookalike_models\nSET status = 'running';",
	}, {
		name:  "upsert transition",
		table: "content_remix_assets",
		src: `INSERT INTO content_remix_assets (tenant_id, remix_id, status)
		      VALUES ($1, $2, 'pending')
		      ON CONFLICT (tenant_id, remix_id) DO UPDATE SET status = 'ready';`,
	}, {
		name:  "upsert transition in a go raw string",
		table: "content_remix_assets",
		src: "_, err := db.Exec(ctx, `\n" +
			"\tINSERT INTO content_remix_assets (tenant_id, remix_id, status)\n" +
			"\tVALUES ($1, $2, 'pending')\n" +
			"\tON CONFLICT (tenant_id, remix_id)\n" +
			"\tDO UPDATE SET status = excluded.status\n" +
			"`, tenantID, remixID)",
	}, {
		name:  "upsert on the qualified quoted name",
		table: "content_remix_assets",
		src: `INSERT INTO public."content_remix_assets" (tenant_id) VALUES ($1)
		      ON CONFLICT DO UPDATE SET status = 'ready';`,
	}, {
		name:  "lowercase keywords",
		table: "sar_bundles",
		src:   `update only public.sar_bundles set status = 'failed';`,
	}}

	for _, tc := range matches {
		t.Run("matches/"+tc.name, func(t *testing.T) {
			if !newBornTerminalDetector(tc.table).transitions(tc.src) {
				t.Errorf("detector for %s missed a transition it must catch:\n%s", tc.table, tc.src)
			}
		})
	}

	misses := []struct {
		name  string
		table string
		src   string
	}{{
		// An UPDATE that touches some OTHER column is not a transition. This is
		// the real shape from subscribers/lookalike.go, which records an export
		// destination on a row whose status never moves. Before the detector
		// distinguished the two, this read as a lifecycle and blocked a correct
		// born-terminal classification — note `status` appears in RETURNING,
		// which is why the check is anchored on `status =` rather than the word.
		name:  "update of another column, with status only in RETURNING",
		table: "subscriber_lookalike_audiences",
		src: `UPDATE subscriber_lookalike_audiences
   SET exported_destination_id = $3::uuid, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, name, status, payload`,
	}, {
		// The whole reason the original pattern was word-anchored, and the one
		// property the widening must not cost.
		name:  "different table sharing the prefix",
		table: "sar_bundles",
		src:   `UPDATE sar_bundles_archive SET status = 'failed';`,
	}, {
		name:  "different table sharing the prefix, quoted",
		table: "sar_bundles",
		src:   `UPDATE "sar_bundles_archive" SET status = 'failed';`,
	}, {
		name:  "different table sharing the prefix, qualified",
		table: "sar_bundles",
		src:   `UPDATE public.sar_bundles_archive SET status = 'failed';`,
	}, {
		name:  "prose about a neighbouring table",
		table: "lookalike_models",
		src: "-- lookalike_models rows are immutable once scored; the UPDATE below\n" +
			"-- retargets lookalike_members, which does have a lifecycle.\n" +
			"UPDATE lookalike_members SET status = 'ready';",
	}, {
		// The exclusion prose itself lives next to the word UPDATE, and must not
		// read as its own violation.
		name:  "exclusion prose",
		table: "sar_bundles",
		src:   `"sar_bundles": "both writers INSERT 'ready'; no UPDATE exists",`,
	}, {
		// Today's real writer: an INSERT that leaves status at its default.
		name:  "plain insert",
		table: "content_remix_assets",
		src:   `INSERT INTO content_remix_assets (tenant_id, remix_id) VALUES ($1, $2);`,
	}, {
		name:  "insert with conflict but no update",
		table: "content_remix_assets",
		src: `INSERT INTO content_remix_assets (tenant_id, remix_id) VALUES ($1, $2)
		      ON CONFLICT (tenant_id, remix_id) DO NOTHING;`,
	}, {
		// The upsert has to be tied to THIS table, not to any DO UPDATE that
		// happens to share the file with a mention of it.
		name:  "upsert on another table in a file that names this one",
		table: "content_remix_assets",
		src: `-- content_remix_assets rows are created by the job row below.
		      INSERT INTO content_remix_jobs (tenant_id, id) VALUES ($1, $2)
		      ON CONFLICT (tenant_id, id) DO UPDATE SET status = 'ready';`,
	}, {
		name:  "upsert on a table sharing the prefix",
		table: "content_remix_assets",
		src: `INSERT INTO content_remix_assets_v2 (tenant_id) VALUES ($1)
		      ON CONFLICT (tenant_id) DO UPDATE SET status = 'ready';`,
	}, {
		name:  "conflict tail belongs to a later statement",
		table: "content_remix_assets",
		src: `INSERT INTO content_remix_assets (tenant_id, remix_id) VALUES ($1, $2);
		      INSERT INTO content_remix_jobs (tenant_id, id) VALUES ($1, $2)
		      ON CONFLICT (tenant_id, id) DO UPDATE SET status = 'ready';`,
	}, {
		name:  "conflict tail in a different go query string",
		table: "content_remix_assets",
		src: "db.Exec(ctx, `INSERT INTO content_remix_assets (tenant_id) VALUES ($1)`)\n" +
			"db.Exec(ctx, `INSERT INTO content_remix_jobs (tenant_id) VALUES ($1)\n" +
			"  ON CONFLICT (tenant_id) DO UPDATE SET status = 'ready'`)",
	}, {
		name:  "the table read, not written",
		table: "sar_bundles",
		src:   `UPDATE sar_exports SET bundle_count = (SELECT count(*) FROM public.sar_bundles);`,
	}}

	for _, tc := range misses {
		t.Run("ignores/"+tc.name, func(t *testing.T) {
			if newBornTerminalDetector(tc.table).transitions(tc.src) {
				t.Errorf("detector for %s fired on something that is not a transition:\n%s", tc.table, tc.src)
			}
		})
	}
}

// TestBornTerminalExclusionsStillHaveNoWriter fails when one of them gains a
// state transition.
//
// The failure is deliberately a PROMPT rather than a defect report: gaining a
// writer is good news — it means a lifecycle now runs — and the right response
// is to register the family, not to delete the UPDATE. A guard that reads as
// an accusation for doing the right thing gets suppressed.
func TestBornTerminalExclusionsStillHaveNoWriter(t *testing.T) {
	root := repoRootForOperationGuard(t)

	detectors := make(map[string]bornTerminalDetector, len(bornTerminalExclusions))
	for table := range bornTerminalExclusions {
		detectors[table] = newBornTerminalDetector(table)
	}

	// Go and SQL only. Migrations are included on purpose: a status transition
	// written as a trigger or a backfill is still a transition, and excluding
	// SQL would leave the most likely hiding place unscanned.
	//
	// Every root carries its own floor rather than contributing to one total,
	// because a total cannot tell a full sweep from a partial one. infra/
	// migrations alone holds 870 files — it clears any plausible total on its
	// own, so the day apps/api stops resolving (a rename, the module moving,
	// os.Stat quietly failing) the guard would report a clean sweep having read
	// none of the 3,600 files where the writers would actually live. The floors
	// sit roughly a quarter of today's counts: low enough that deleting code
	// never trips them, high enough that a root reduced to stragglers cannot
	// pass as scanned.
	scanRoots := []struct {
		rel      []string
		minFiles int
	}{
		{[]string{"apps", "api"}, 1000},        // ~3.6k .go today
		{[]string{"services"}, 100},            // ~460 .go today
		{[]string{"infra", "migrations"}, 300}, // ~870 .sql today
	}

	// The guard's own file names all three tables next to the word UPDATE, in
	// prose and now in self-test fixtures. Identify it by the path the compiler
	// recorded rather than by a hardcoded name, so renaming the file cannot turn
	// it into a fake violation; fall back to the base name for -trimpath builds,
	// where the recorded path is module-relative.
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this test file; the self-exclusion below would not hold")
	}
	thisBase := filepath.Base(thisFile)

	found := map[string][]string{}
	for _, scanRoot := range scanRoots {
		dir := filepath.Join(append([]string{root}, scanRoot.rel...)...)
		if _, err := os.Stat(dir); err != nil {
			t.Fatalf("scan root %s is missing: %v; a result that skipped it would "+
				"be a clean sweep over a fraction of the corpus", dir, err)
		}
		scanned := 0
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				switch d.Name() {
				case "vendor", "node_modules", ".git", "testdata":
					return fs.SkipDir
				}
				return nil
			}
			ext := filepath.Ext(path)
			if ext != ".go" && ext != ".sql" {
				return nil
			}
			// Skipping this file by name would also skip a real violation added
			// here later, but a transition is never written in a test that
			// asserts transitions do not exist.
			if path == thisFile || filepath.Base(path) == thisBase {
				return nil
			}
			raw, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			scanned++
			src := string(raw)
			lower := strings.ToLower(src)
			for table, det := range detectors {
				// Only a file that can name the table can transition it; see
				// mayMention. Without this filter the sweep ran every pattern
				// of all nine detectors over ~4,900 files, which under -race
				// took about 7 of the package's 10 minutes in CI.
				if !det.mayMention(src, lower) {
					continue
				}
				if det.transitions(src) {
					rel, relErr := filepath.Rel(root, path)
					if relErr != nil {
						rel = path
					}
					found[table] = append(found[table], rel)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
		if scanned < scanRoot.minFiles {
			t.Fatalf("scan root %s yielded only %d source files (expected at least "+
				"%d); this root is not being read and a clean result here would "+
				"mean nothing", dir, scanned, scanRoot.minFiles)
		}
	}

	for table, files := range found {
		t.Errorf("%s is excluded from the operation registry because %s — but %d "+
			"file(s) now transition it: %s.\n"+
			"That is good news, not a defect: the table has a lifecycle now. "+
			"Register it in Families with its full status vocabulary and remove "+
			"it from `excluded` (and from bornTerminalExclusions here).",
			table, bornTerminalExclusions[table], len(files), strings.Join(files, ", "))
	}
}

// TestBornTerminalPrefilterNeverHidesAMatch pins the soundness of mayMention:
// every pattern names its table, a spelling in any case still reaches the
// patterns, the fold partners that strings.ToLower misses bypass the filter,
// and a file that never names the table is skipped.
func TestBornTerminalPrefilterNeverHidesAMatch(t *testing.T) {
	for table := range bornTerminalExclusions {
		det := newBornTerminalDetector(table)
		quoted := regexp.QuoteMeta(table)
		for name, re := range map[string]*regexp.Regexp{"update": det.update, "insert": det.insert, "merge": det.merge} {
			if !strings.Contains(re.String(), quoted) {
				t.Errorf("the %s pattern for %s does not embed the table name, so "+
					"mayMention could skip a file it matches", name, table)
			}
		}
		for _, src := range []string{
			"UPDATE " + strings.ToUpper(table) + " SET status = 'done'",
			"update public.\"" + table + "\" set STATUS = 'done'",
		} {
			if !det.transitions(src) {
				t.Fatalf("fixture %q should be a transition of %s", src, table)
			}
			if !det.mayMention(src, strings.ToLower(src)) {
				t.Errorf("the prefilter hides %q from the %s detector", src, table)
			}
		}
		other := "UPDATE some_other_table SET status = 'done'"
		if det.mayMention(other, strings.ToLower(other)) {
			t.Errorf("the prefilter should skip a file that never names %s", table)
		}
	}

	// (?i) folds U+017F with 's' and U+212A with 'k'; strings.ToLower maps only
	// the second. Both must reach the full patterns.
	det := newBornTerminalDetector("sar_bundles")
	for _, src := range []string{
		"UPDATE \u017Far_bundles SET status = 'done'",
		"UPDATE sar_bundles SET status = 'done' -- \u212A",
	} {
		if !det.mayMention(src, strings.ToLower(src)) {
			t.Errorf("the prefilter hides %q, which the full patterns must see", src)
		}
	}
	if longS := "UPDATE \u017Far_bundles SET status = 'done'"; !det.transitions(longS) {
		t.Errorf("expected the case-insensitive pattern to match the long-s spelling %q; "+
			"if Go's folding changed, revisit mayMention's argument", longS)
	}
}

// TestBornTerminalExclusionsAreActuallyExcluded keeps the two lists in step.
//
// Without it, deleting an entry from `excluded` while leaving it here would
// leave this file guarding a claim nothing relies on any more — and, worse,
// the reverse: an entry here that was never excluded reads as protected when
// nothing is protecting anything.
func TestBornTerminalExclusionsAreActuallyExcluded(t *testing.T) {
	for table := range bornTerminalExclusions {
		if excluded[table] == "" {
			t.Errorf("%s is listed as a born-terminal exclusion but is not in "+
				"`excluded`; this guard is protecting a decision that no longer exists",
				table)
		}
	}
}

func repoRootForOperationGuard(t *testing.T) string {
	t.Helper()
	// apps/api/internal/operation -> repo root
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "infra", "migrations")); err != nil {
		t.Fatalf("repo root %s does not look like the repository: %v", root, err)
	}
	return root
}
