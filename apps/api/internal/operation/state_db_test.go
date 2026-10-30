// SPDX-License-Identifier: AGPL-3.0-only
package operation

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The mapping is verified against the DATABASE, not against itself.
//
// A registry of statuses checked only by its own unit tests is a second copy of
// the schema that drifts the moment someone adds a value to a CHECK constraint
// — and the drift is silent: an unmapped status projects as "unknown" in a
// shared view, or worse, gets guessed at. Reading the live constraints makes
// the schema the authority, so adding a status without classifying it FAILS.

var checkValues = regexp.MustCompile(`'([a-z_]+)'::text`)

func TestEveryPermittedStatusIsMapped(t *testing.T) {
	pool := operationTestPool(t)
	ctx := context.Background()

	for _, family := range Families {
		t.Run(family.Table, func(t *testing.T) {
			raw := statusCheckFor(t, ctx, pool, family.Table)
			if len(raw) == 0 {
				// The table exists — statusCheckFor fails loudly otherwise — but
				// carries no status CHECK. For a registered family that is a real
				// regression: without the constraint there is no authority left to
				// verify the mapping against.
				t.Fatalf("%s has no CHECK on its status column. The registry claims "+
					"to describe its vocabulary, and there is nothing left to check "+
					"that claim against.", family.Table)
			}
			permitted := permittedStatuses(t, family.Table, raw)

			for value := range permitted {
				state, ok := family.States[value]
				if !ok {
					t.Errorf("%s permits status %q but the registry does not map it. "+
						"An unmapped status projects as unknown in a shared view, or gets "+
						"guessed at — and a wrong guess makes the view wait forever on "+
						"finished work, or page someone about a healthy job.", family.Table, value)
					continue
				}
				if state == "" {
					t.Errorf("%s maps %q to the empty state", family.Table, value)
				}
			}
			// The reverse: a mapping for a value the table cannot hold is a
			// stale entry that hides the next real gap.
			for value := range family.States {
				if !permitted[value] {
					t.Errorf("the registry maps %s status %q, which the table's CHECK no "+
						"longer permits. Stale entries excuse nothing.", family.Table, value)
				}
			}
		})
	}
}

// enumeration isolates the `status = ANY (ARRAY[...])` clause from the rest of a
// constraint definition.
//
// Harvesting values from the WHOLE definition is wrong in a way this schema
// already contains: `scheduled_report_runs_lease_shape` carries a NEGATIVE
// clause, `status <> ALL (ARRAY['leased'::text, 'delivering'::text])`, alongside
// a positive one. A whole-definition regex reads those two as permitted when the
// constraint exists precisely to forbid them.
var enumeration = regexp.MustCompile(`status = ANY \(ARRAY\[([^\]]*)\]`)

// A single-status branch: `status = 'pending'::text`.
//
// Deliberately anchored on `=` rather than any comparison, so `status <> 'x'`
// and `status <> ALL (ARRAY[...])` are never harvested as permission. That is
// the same trap the enumeration comment above describes; a lifecycle constraint
// written as one branch per status is simply where it shows up next.
var statusEquality = regexp.MustCompile(`status = '([a-z_]+)'::text`)

// negativeStatus marks a constraint whose branches are NOT all positive
// status enumerations, so its permitted set cannot be read off the values it
// names. A negative discriminator such as `execution_class <> ...` also opens
// a branch to statuses the remaining branch does not name; treating that shape
// as a status enumeration incorrectly intersects away the bulk-job states.
//
// `scheduled_report_runs` has one:
//
//	(status = ANY (ARRAY['leased','delivering']) AND lease_owner IS NOT NULL ...)
//	OR (status <> ALL (ARRAY['leased','delivering']) AND lease_owner IS NULL ...)
//
// That constraint permits EVERY status — it is a rule about the lease columns,
// not about the status domain — but its only positive branch names two values.
// Read as an enumeration it claims the table permits exactly {leased,
// delivering}, and intersecting that with the real domain deletes the other
// five, which is how a correct registry gets reported as stale.
//
// A constraint like this contributes nothing and must be skipped: its open
// branch is unbounded, so it cannot narrow anything.
var negativeStatus = regexp.MustCompile(`(?:status|execution_class) <> `)

// permittedStatuses computes what the table actually permits.
//
// A row must satisfy EVERY CHECK constraint, so with more than one enumerating
// constraint the permitted set is their INTERSECTION. An earlier version joined
// the definitions into one string and harvested from that, which computes the
// UNION — too permissive, and it weakens the reverse guard: a migration that
// narrows the real enumeration while leaving a second constraint naming the
// dropped value would let a now-stale registry entry stay green.
// `subscriber_pii_findings`, `outbound_webhook_operator_notifications` and
// `scheduled_report_runs` all have that two-constraint shape today.
func permittedStatuses(t *testing.T, table string, defs []string) map[string]bool {
	t.Helper()
	var permitted map[string]bool
	for _, def := range defs {
		// WITHIN one constraint the branches are a DISJUNCTION, so the statuses
		// it permits are the UNION of every branch — while ACROSS constraints
		// the permitted set is still the intersection, because a row must
		// satisfy all of them. Getting that inner/outer pairing backwards is
		// what broke here.
		//
		// The trigger was migration 1918, which gave ai_regression_runs a
		// lifecycle constraint shaped as one branch per status:
		//
		//   (status = 'pending'  AND claim_token IS NULL AND ...)
		//   OR (status = 'running' AND claim_token IS NOT NULL AND ...)
		//   OR (status = ANY (ARRAY['completed','failed']) AND ...)
		//
		// Only the last branch uses ANY, so reading just the ANY clause made
		// that constraint look like it permitted {completed, failed} alone. The
		// intersection then deleted `pending` and `running`, and the test
		// reported the REGISTRY as stale — blaming a correct mapping for a
		// parser that could not see two thirds of the constraint.
		if negativeStatus.MatchString(def) {
			continue
		}
		this := map[string]bool{}
		// FindALL, not FindFirst. The comment above says the branches within one
		// constraint are a union, and the code read only the first enumeration —
		// so a two-branch constraint contributed half its statuses and the
		// intersection deleted the rest. `scheduled_report_runs` splits its
		// domain across two ANY clauses (terminal states with completed_at,
		// in-flight states without), and reading one of them yielded an empty
		// permitted set for the whole table.
		for _, clause := range enumeration.FindAllStringSubmatch(def, -1) {
			for _, m := range checkValues.FindAllStringSubmatch(clause[1], -1) {
				this[m[1]] = true
			}
		}
		// Equality branches. Anchored on `status = '` so a NEGATIVE clause
		// (`status <> 'x'` or `status <> ALL (ARRAY[...])`) can never be read as
		// permission — the hazard the enumeration comment above already names,
		// arriving here in its other form.
		for _, m := range statusEquality.FindAllStringSubmatch(def, -1) {
			this[m[1]] = true
		}
		if len(this) == 0 {
			continue
		}
		if permitted == nil {
			permitted = this
			continue
		}
		for value := range permitted {
			if !this[value] {
				delete(permitted, value)
			}
		}
	}
	if len(permitted) == 0 {
		t.Fatalf("could not parse any status for %s from: %v", table, defs)
	}
	return permitted
}

// vocabulary is what each raw status WORD means, in every family that uses it.
//
// This exists because the DB test verifies COVERAGE — that every permitted
// status is mapped — and coverage is silent about whether the mapping is
// CORRECT. A review demonstrated the cost: pointing all five `cancelled` values
// at StateFailed left the whole suite green, producing exactly the paging defect
// StateCancelled's own doc comment warns against.
//
// It is deliberately NOT a per-family table of expected results. That would be a
// hand-maintained second copy of `Families`, edited in the same commit by the
// same person, certifying the assumption instead of the behaviour — the failure
// this package keeps naming. This is one entry per word (twenty) against every
// mapping in `Families`, it encodes what the word MEANS rather than where it is
// used, and a new family is checked by it for free.
var vocabulary = map[string]State{
	"queued": StateQueued, "pending": StateQueued,
	"running": StateRunning, "in_progress": StateRunning,
	// Private rollout-safe subscriber-import states have the same operator
	// meaning as their public projections; the prefix only fences old workers.
	"verification_queued": StateQueued, "verification_running": StateRunning,
	"import_pending": StateQueued, "import_running": StateRunning,
	// Three more spellings of in-flight, each added with the whole vocabulary
	// in view because that is what this map is for. `generating` is a model
	// producing output; `submitted` is a request sitting with an external
	// provider; `rendering` is that provider working. All three answer "still
	// going" to the only question a shared view asks, and none of them is a
	// distinct outcome — the provider handshake is the family's business, not
	// the operator's.
	"generating": StateRunning, "submitted": StateRunning,
	"rendering": StateRunning,
	// The six spellings of terminal success, from the package doc.
	"succeeded": StateSucceeded, "completed": StateSucceeded,
	"ready": StateSucceeded, "complete": StateSucceeded,
	"empty": StateSucceeded, "ok": StateSucceeded,
	"failed": StateFailed,
	// `abandoned` is a failure, not a cancellation. Cancelled means somebody
	// stopped it deliberately and nothing went wrong; abandoned means a lease
	// expired and no worker came back, which nobody chose and which leaves the
	// work silently unfinished. Filing it under "nothing to see" would hide a
	// died-quietly worker.
	"abandoned": StateFailed,
	// `rejected` and `needs_reconciliation` arrived together with the
	// audience-sync families. Both sit next to words already in this map, and
	// the neighbours are named here because that is the decision this map
	// exists to force.
	//
	// `rejected` vs `failed`: failed invites a retry, rejected guarantees the
	// retry fails the same way. The destination refused the input, so nothing
	// improves until a person changes it.
	//
	// `needs_reconciliation` vs `abandoned` — the close one. Both mean a lease
	// expired with no worker coming back, and `abandoned` is already filed
	// under failed on the argument that the work silently did not finish. The
	// difference is EXTERNAL EFFECT: an abandoned local job did not happen, so
	// failed is honest. An audience sync had already begun pushing members to a
	// third party, so the truthful statement is not "it did not happen" but "we
	// never got an acknowledgement and the two sides may now disagree". Filing
	// that under failed invites a retry of work that may already be applied,
	// which is how an uncertain outcome becomes a duplicated one.
	"rejected":             StateRejected,
	"needs_reconciliation": StateNeedsReconciliation,
	// `leased` and `delivering` are two more spellings of in-flight, from
	// scheduled reports. `leased` is a worker holding the row with nothing
	// rendered yet, `delivering` is the same worker sending what it rendered
	// (worker.go picks between them on `rendered_at IS NULL`). Neither is
	// `queued`: a lease has been taken, so the work HAS been consumed, and a
	// shared view calling that "waiting" would tell an operator nobody has
	// picked it up. If the worker dies the lease expires and the row returns to
	// queued, which is the honest place for it then and not before.
	"leased": StateRunning, "delivering": StateRunning,
	// `needs_review` is scheduled reports' word for the same fact
	// `needs_reconciliation` names: finished, and part of the outcome is
	// unknown. The worker sets it when at least one recipient has an unknown
	// provider outcome, with "No automatic retry will occur" in its own summary
	// text — which is the operator instruction both words carry.
	//
	// Mapped onto the EXISTING state rather than given a new one. The vocabulary
	// is many spellings to one meaning, and an eighth state that differed from
	// needs_reconciliation only in which subsystem said it would split a filter
	// that should hold everything a human has to go and check.
	"needs_review": StateNeedsReconciliation,
	// Privacy-request words. `verifying` is the identity check before work
	// begins — in progress, not waiting. `fulfilled` is that family's spelling
	// of terminal success. `appealed` reopens a rejected request for a reviewer,
	// so it is progressing.
	"verifying": StateRunning, "fulfilled": StateSucceeded,
	"appealed": StateRunning,
	// Both blocked spellings mean the same thing: live, and stalled on somebody
	// outside this system. See StateBlocked for why neither is `failed` — this
	// table's overdue metric counts them as still owed.
	"blocked_legal_hold": StateBlocked, "blocked_ownership": StateBlocked,
	// Campaign words. `draft` is StatePreview for the property, not the name:
	// the system will not pick it up on its own. `scheduled` IS queued — unlike
	// an operator's calendar entry, a scheduled campaign is one the sender will
	// start by itself. `sent` is this family's terminal success.
	"draft": StatePreview, "scheduled": StateQueued,
	"sending": StateRunning, "sent": StateSucceeded,
	"paused": StatePaused,
	// Consent-sync words. `delivered` is that ledger's terminal success — the
	// destination accepted the consent change — and belongs with the other
	// spellings of "done". `retrying` is in-flight: an attempt failed, the
	// sweeper will try again, and the work is still outstanding. Calling it
	// `failed` would retire a row the system has not given up on, in the one
	// ledger that answers "were the other holders of this data told to stop".
	"delivered": StateSucceeded, "retrying": StateRunning,
	// What a person did with a finished artefact. All three mean the run ENDED
	// successfully and differ only in what happened next, which is the family's
	// business and not the operations view's — that view asks "what am I waiting
	// on", and the answer for all three is "nothing".
	"saved": StateSucceeded, "campaign_created": StateSucceeded,
	"archived": StateSucceeded,
	// Preview-asset words. `fetching` is the broker pulling the source image;
	// `retry` is a failed attempt waiting on next_attempt_at — still in flight,
	// because the broker WILL pick it up again, and calling it failed would
	// retire work that is still scheduled.
	"fetching": StateRunning, "retry": StateRunning,
	// `source_missing` is terminal and unusable: the image a preview is built
	// from is gone, so no amount of retrying produces one. A failure with a
	// known cause rather than a separate outcome — the next action it asks for
	// (replace the source) is what "failed" already means here.
	"source_missing": StateFailed,
	// `dismissed` is a person deciding not to act on a suggestion. That is a
	// cancellation, not a failure: nothing went wrong, the system did what it
	// was told, and paging somebody about a retry an operator deliberately
	// waved off is how a queue's alerts stop being read.
	"dismissed": StateCancelled,
	// `retried` is terminal success — the retry actually went out. Distinct from
	// `retrying`, which is the attempt in flight; collapsing the pair would make
	// a queue that is working look identical to one that is stuck.
	"retried":   StateSucceeded,
	"partial":   StatePartial,
	"cancelled": StateCancelled,
	// The American spelling, and the same decision. `verification_jobs` is the
	// one table whose CHECK writes `canceled`; adding the word here rather than
	// leaving it unlisted is the point — an unlisted word is SKIPPED by the
	// agreement test, so `canceled` could have been pointed at StateFailed in
	// that one family with nothing objecting, and a run an operator deliberately
	// stopped to save credits would page someone. Two spellings, one meaning,
	// asserted for every family that ever uses either.
	"canceled": StateCancelled,
	"expired":  StateExpired,
	"preview":  StatePreview,
}

// vocabularyOverrides are the places one raw word genuinely means two things,
// enumerated with the reason and the cost.
//
// The one-word-one-meaning rule is the point of this package, so bending it
// needs to be harder than following it — but "impossible" was the wrong
// hardness. `intelligent_retry_events` sat unregistered because its `ready`
// means "an operator approved this retry and it is waiting to run" while `ready`
// everywhere else means terminal SUCCESS. The alternatives were both worse than
// an exception: mapping it to succeeded reports an unattempted retry as
// finished work, which in a retry queue is the lie that stops somebody looking;
// and renaming the value is a breaking wire change, because desktop reads this
// status and it is in the published contract.
//
// So the exception lives HERE, beside the rule it bends, rather than as a field
// on Family where it could be set quietly. Each entry needs a reason, the test
// below requires the override to actually differ from the shared meaning (a
// redundant entry is a claim of conflict where there is none), and
// TestEveryOverrideIsForARegisteredFamily stops the list outliving its families.
var vocabularyOverrides = map[string]struct {
	state  State
	reason string
}{
	"intelligent_retry_events.ready": {
		state: StateQueued,
		reason: "an operator APPROVED this retry and it is waiting to run — the " +
			"opposite end of the lifecycle from `ready` elsewhere, which means a " +
			"downloadable artefact. Renaming it would break desktop and the " +
			"published contract; mapping it to succeeded would report an " +
			"unattempted retry as finished.",
	},
}

func TestEveryMappingAgreesWithTheVocabulary(t *testing.T) {
	for _, family := range Families {
		for raw, got := range family.States {
			want, known := vocabulary[raw]
			if !known {
				continue // caught by TestEveryRawStatusHasADefinedMeaning
			}
			if override, ok := vocabularyOverrides[family.Table+"."+raw]; ok {
				if override.state == want {
					t.Errorf("%s.%s is declared an override to %q, which is what %q "+
						"already means everywhere. An override that changes nothing "+
						"claims a conflict that does not exist.", family.Table, raw, want, raw)
				}
				if got != override.state {
					t.Errorf("%s maps %q to %q but its override declares %q. The "+
						"exception and the mapping must agree or the exception is "+
						"documenting something that is not happening.",
						family.Table, raw, got, override.state)
				}
				if strings.TrimSpace(override.reason) == "" {
					t.Errorf("%s.%s overrides the shared vocabulary with no reason", family.Table, raw)
				}
				continue
			}
			if got != want {
				t.Errorf("%s maps %q to %q, but %q means %q everywhere else. "+
					"One word with two meanings across families is the exact "+
					"condition this package exists to remove.",
					family.Table, raw, got, raw, want)
			}
		}
	}
}

// An override for a family nobody registered is a rule bent for nothing, and it
// would quietly pre-authorise the exception if that table were added later.
func TestEveryOverrideIsForARegisteredFamily(t *testing.T) {
	registered := map[string]bool{}
	for _, f := range Families {
		for raw := range f.States {
			registered[f.Table+"."+raw] = true
		}
	}
	for key := range vocabularyOverrides {
		if !registered[key] {
			t.Errorf("vocabulary override %q is for no registered family/status; "+
				"remove it rather than leaving the exception standing", key)
		}
	}
}

func TestEveryRawStatusHasADefinedMeaning(t *testing.T) {
	// Without this, the vocabulary check above is bypassed by any NEW word: an
	// unlisted status is skipped, so a family could introduce `halted` and
	// classify it however it liked with nothing objecting.
	for _, family := range Families {
		for raw := range family.States {
			if _, known := vocabulary[raw]; !known {
				t.Errorf("%s uses raw status %q, which has no entry in `vocabulary`. "+
					"Adding a word to the shared vocabulary is a decision about what "+
					"it means in EVERY family, so it has to be made explicitly.",
					family.Table, raw)
			}
		}
	}
}

func TestEveryFamilyHasATerminalSuccess(t *testing.T) {
	// A family with no success state cannot report completion in a shared view,
	// which is the whole point of the projection.
	for _, family := range Families {
		found := false
		for _, s := range family.States {
			if s == StateSucceeded {
				found = true
			}
		}
		if !found {
			t.Errorf("%s maps no status to succeeded", family.Table)
		}
	}
}

func TestCanonicalRefusesToGuess(t *testing.T) {
	if _, ok := Canonical("tenant_exports", "invented"); ok {
		t.Fatal("an unmapped status must report ok=false rather than a guess")
	}
	if _, ok := Canonical("not_a_table", "queued"); ok {
		t.Fatal("an unknown table must report ok=false")
	}
	if s, ok := Canonical("audit_export_jobs", "in_progress"); !ok || s != StateRunning {
		t.Fatalf("audit_export_jobs/in_progress -> (%q,%v), want running", s, ok)
	}
	// The divergence the package exists for: two spellings, one state.
	ready, _ := Canonical("tenant_exports", "ready")
	completed, _ := Canonical("automation_backfill_jobs", "completed")
	if ready != completed {
		t.Fatalf("`ready` (%q) and `completed` (%q) must project to one state", ready, completed)
	}
}

func TestExpiredIsNotFoldedIntoSucceeded(t *testing.T) {
	// A user clicking download on an expired export needs to be told the file
	// is gone, not shown a dead link.
	s, ok := Canonical("tenant_exports", "expired")
	if !ok || s != StateExpired {
		t.Fatalf("expired -> (%q,%v)", s, ok)
	}
	if !s.Terminal() {
		t.Fatal("expired is terminal")
	}
}

// statusCheckFor returns the CHECK constraint on the table's `status` COLUMN.
//
// Three defects a review demonstrated in the first version, all of which made a
// green result meaningless:
//
//   - a query error (a renamed table, a permissions problem) returned "" and the
//     caller SKIPPED. A migration renaming a registered table would leave the
//     registry describing something that no longer exists, with CI green — the
//     exact drift this test exists to prevent.
//   - the constraint was matched by the substring "status = ANY", which also
//     matches `mailchimp_status`, `tax_form_status` and `credentials_status`. On
//     `affiliates` it would resolve the wrong column immediately.
//   - with several matching constraints there was no ORDER BY, so the seq-scan
//     order decided which one was read. On `scheduled_report_runs` two of the
//     three matches carry different value sets, so a CORRECT mapping could fail
//     with spurious errors after a dump/restore.
//
// Resolved by joining `pg_attribute` on `conkey` — the constraint that actually
// covers the column named `status` — and by failing loudly on a query error.
func statusCheckFor(t *testing.T, ctx context.Context, pool *db.Pool, table string) []string {
	t.Helper()
	// `to_regclass` returns NULL for a missing relation rather than erroring, so
	// the query below succeeds with zero rows and the caller would report "no
	// CHECK on its status column" — sending the reader hunting for a dropped
	// constraint on a table that no longer exists. An earlier comment here
	// asserted statusCheckFor "would have failed otherwise"; it would not have.
	var exists bool
	if err := pool.QueryRow(ctx,
		`SELECT to_regclass($1) IS NOT NULL`, table).Scan(&exists); err != nil {
		t.Fatalf("resolving table %s: %v", table, err)
	}
	if !exists {
		t.Fatalf("the registry has a family for %s, but no such table exists. "+
			"A migration renaming or dropping a registered table leaves the "+
			"registry describing something that is gone.", table)
	}
	// A plain pooled read: `pg_constraint` has no row-level security, so the
	// worker RLS-bypass scope this used was over-privileged and implied the
	// check needed permissions it does not.
	rows, err := pool.Query(ctx, `
SELECT pg_get_constraintdef(c.oid)
  FROM pg_constraint c
  JOIN pg_attribute a
    ON a.attrelid = c.conrelid
   AND a.attnum = ANY (c.conkey)
   AND a.attname = 'status'
 WHERE c.contype = 'c'
   AND c.conrelid = to_regclass($1)
 ORDER BY c.conname`, table)
	if err != nil {
		t.Fatalf("reading the status CHECK for %s failed: %v. A registry entry "+
			"naming a table that cannot be read must FAIL, not skip — skipping is "+
			"how a renamed table leaves the registry stale with CI green.", table, err)
	}
	defer rows.Close()
	var defs []string
	for rows.Next() {
		var def string
		if err := rows.Scan(&def); err != nil {
			t.Fatalf("scan constraint for %s: %v", table, err)
		}
		if strings.Contains(def, "status = ANY") {
			defs = append(defs, def)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterating constraints for %s: %v", table, err)
	}
	// Returned as a LIST, ordered by constraint name. Joining them into one
	// string computes the union of what each permits; a row must satisfy all of
	// them, so the caller intersects instead. See permittedStatuses.
	return defs
}

func operationTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping operation registry test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// The two semantic calls the package doc advertises as deliberate. A review
// inverted BOTH — `empty` classified as a failure, `preview` as queued — and the
// suite stayed green: the DB test verifies COVERAGE, and classification is the
// part that can be wrong.

func TestAnEmptyRunIsASuccessNotAFailure(t *testing.T) {
	// streaming_export/worker.go writes `empty` when an hour window contained no
	// events. Classifying that as failed pages someone for a quiet hour.
	s, ok := Canonical("streaming_export_runs", "empty")
	if !ok {
		t.Fatal("`empty` must be mapped")
	}
	if s == StateFailed {
		t.Fatal("`empty` classified as FAILED — a run that found nothing to export " +
			"succeeded; treating it as a failure pages someone for a quiet hour")
	}
	if s != StateSucceeded {
		t.Fatalf("`empty` -> %q, want succeeded", s)
	}
}

func TestAPreviewIsNotQueued(t *testing.T) {
	// Nothing auto-advances a preview: every transition out of it is gated on an
	// explicit human call. Reporting it as queued in a shared view would claim
	// work is pending when it is waiting on a person who may never return.
	s, ok := Canonical("subscriber_imports", "preview")
	if !ok {
		t.Fatal("`preview` must be mapped")
	}
	if s == StateQueued {
		t.Fatal("`preview` classified as QUEUED — nothing advances it without a " +
			"human, so a shared view would report pending work that is not pending")
	}
	if s != StatePreview {
		t.Fatalf("`preview` -> %q, want preview", s)
	}
	if s.Terminal() {
		t.Fatal("`preview` is not terminal: a human can still confirm or cancel it")
	}
}

func TestSubscriberImportVerificationStatesStayNonTerminal(t *testing.T) {
	for raw, want := range map[string]State{
		"verification_queued":  StateQueued,
		"verification_running": StateRunning,
	} {
		got, ok := Canonical("subscriber_imports", raw)
		if !ok || got != want || got.Terminal() {
			t.Fatalf("%q -> %q,%v terminal=%v; want %q non-terminal", raw, got, ok, got.Terminal(), want)
		}
	}
}

func TestFamilyTablesAreUnique(t *testing.T) {
	// Canonical returns on first match, so a duplicated table would silently
	// shadow the second entry's mapping.
	seen := map[string]bool{}
	for _, f := range Families {
		if seen[f.Table] {
			t.Errorf("duplicate family for %s; the second mapping is unreachable", f.Table)
		}
		seen[f.Table] = true
	}
}
