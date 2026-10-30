// SPDX-License-Identifier: AGPL-3.0-only

package operation

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The registry's own tests can only see what is IN the registry.
//
// `TestEveryPermittedStatusIsMapped` and its siblings iterate `Families`, so
// they verify each registered table thoroughly and are structurally blind to
// the ones that were never registered. Ten families are registered; the ledger
// row that opened this counted sixty-three operation-like tables. A guard that
// validates what is declared, and cannot notice what is missing, is the same
// shape as a conformance fixture nobody runs — it reports green while covering
// a sixth of the surface.
//
// This asks the database instead: which tables carry a status CHECK whose
// vocabulary is a LIFECYCLE, and is each one either registered or deliberately
// excluded? Discovery inverts the question so a new operation-like table shows
// up here on the day it is added, rather than the day someone notices a shared
// view is missing a job.

// lifecycleVocabulary are the values that make a status column an OPERATION's
// status rather than an entity's.
//
// The distinction matters and is not cosmetic. `subscribers.status` holds
// enabled/blocklisted — a standing property of a person, with no beginning and
// no end. `tenant_exports.status` holds queued/running/ready — positions in a
// run that starts, progresses and finishes. Only the second kind belongs in an
// operations view, and only the second kind can leave a user waiting on
// something that already finished.
var lifecycleVocabulary = map[string]bool{
	"queued":     true,
	"running":    true,
	"processing": true,
	"pending":    true,
	"succeeded":  true,
	"completed":  true,
	"failed":     true,
	"cancelled":  true,
	"canceled":   true,
}

// A table is treated as an operation family when its status CHECK names at
// least this many lifecycle values. Two rather than one because a single
// "pending" or "failed" appears in plenty of genuinely non-operation vocabularies
// (a `pending` invitation, a `failed` payment attempt that is a fact rather than
// a run), and a rule that swept those in would produce a list nobody reads.
const lifecycleThreshold = 2

// excluded records tables whose status LOOKS like a lifecycle but which are
// deliberately NOT operation families, each with the reason.
//
// An allow-list with prose, not a bare set: the value of this test is the
// decision it forces, and a slug with no reason next to it is how an exclusion
// list becomes a place to hide things.
//
// (The line that used to end this comment — "Empty today" — outlived the map
// being empty by several entries. A comment that describes a collection's
// contents is wrong the first time anyone adds to it; this one now describes
// the RULE instead, which is what stays true.)
var excluded = map[string]string{
	"conversion_email_hmac_projection_states": "Readiness projection for one " +
		"tenant signing key, not independently started work. Its pending/ready/failed " +
		"value gates signed conversion resolution while the actual durable operations " +
		"are rows in conversion_email_hmac_projection_tasks.",

	"verification_job_items": "One row per address inside a registered " +
		"verification_jobs operation. These are bounded worker units and result " +
		"evidence; registering them would put up to 250,000 child rows beside the " +
		"single bulk job an operator started and is waiting on.",

	"campaign_recipients_partitioned": "One row per RECIPIENT of a send, not an " +
		"operation. The campaign send is the operation a user starts and watches; " +
		"these are the units of work inside it, and listing them would put " +
		"millions of rows in an operations view as though each were a job someone " +
		"is waiting on.",

	// Added 2026-08-06, by this guard catching a table added the same day.
	//
	// `web_push_deliveries` (migration 1883) carries `pending`/`failed`, so
	// discovery correctly flagged it. It is not an operation for the same reason
	// as the row above: one row per NOTIFICATION per browser endpoint — a side
	// effect of something else, not work a person starts and waits on. Nobody
	// opens an operations view to watch a push notification; they open it to see
	// whether their export finished.
	//
	// It is a delivery LEDGER, and its own question ("was this person
	// notified") is answered per-user rather than per-run. Putting it in the
	// shared view would bury the twenty families a user IS waiting on under one
	// row per notification ever sent.
	"web_push_deliveries": "One row per notification per browser endpoint — a " +
		"delivery ledger, not an operation someone starts and watches. Same " +
		"distinction as campaign_recipients_partitioned: these are the units of " +
		"work inside a notification, and the question they answer (was this " +
		"person notified) is per-user, not per-run.",

	// This guard has now caught the same author twice in one day, with two
	// different new tables, in a package they were not thinking about. That is
	// the entire argument for discovery over a hand-kept list.
	"notification_webhook_deliveries": "One row per (notification, person) " +
		"webhook attempt — the fourth notifyfanout channel's delivery ledger, " +
		"same reasoning as web_push_deliveries. A person does not start a " +
		"webhook post and wait on it; it is a side effect of a notification " +
		"they are already being shown.",

	// ENTITY STATES. Discovery matched these because words like `pending` and
	// `failed` appear in vocabularies that are otherwise nothing like a run.
	// The distinction is the one the lifecycle rule exists to draw: a run
	// STARTS, PROGRESSES and FINISHES, and someone may be waiting on it. These
	// are standing properties of a thing, with no beginning and no end — an
	// operations view listing them would never empty, and every entry would be
	// something nobody is waiting for.
	"automation_flow_ab_tests": "State of an experiment, not a run inside one.",

	// DECISIONS, not runs. A decision is made by a person and then it is over;
	// there is no progress to report and nothing to retry. Putting them in an
	// operations view would mean an approval sat there "in progress" for as
	// long as a human took to think.
	"archive_tips": "State of a payment (pending → succeeded/refunded/failed). The " +
		"charge is an external event, not work this system is running.",

	// PER-RECIPIENT DELIVERY ROWS, moved out of knownUnregistered 2026-08-10.
	//
	// These five sat on the gap list, which asserted the project OWED a
	// registration for each. It does not. They are the same class as
	// `campaign_recipients_partitioned` above — one row per person (or per
	// device) reached by a send, which is a unit of work INSIDE an operation
	// rather than an operation anybody starts and watches. The send is the
	// thing a user is waiting on; these are its rows.
	//
	// Moving them is not bookkeeping. A gap list is a debt list, and carrying
	// five entries that must never be paid teaches the next reader the wrong
	// thing and makes the real remainder look larger than it is. Registering
	// any of them would put one row per recipient into a view whose entire
	// purpose is answering "what am I waiting on", burying the families
	// somebody genuinely is.
	//
	// Verified per table rather than assumed from the name: each carries a
	// per-recipient or per-device key (`subscriber_id`, `recipient_id`,
	// `device_id`, or a per-row status under `campaign_id`).
	"campaign_recipients": "One row per recipient of a send — the unqualified " +
		"twin of campaign_recipients_partitioned, and excluded for the identical " +
		"reason. The campaign is the operation; these are its units of work.",

	"sms_campaign_recipients": "One row per recipient of an SMS send. Same " +
		"distinction as campaign_recipients: queued/sending/sent/blocked are the " +
		"progress of one message to one person, not of a job someone started.",

	"omni_recipients": "One row per (campaign, subscriber) across channels. Its " +
		"vocabulary is the longest of the three precisely because it tracks one " +
		"person's journey through a send — eligible, suppressed, delivered — " +
		"which is per-recipient detail, not the state of an operation.",

	"channel_send_history": "One row per (campaign, recipient) send attempt with " +
		"its engagement outcome (sent → delivered → opened → clicked). A history " +
		"ledger answering 'what happened to this person', which is per-user; an " +
		"operations view answers 'what is running', which is per-run.",

	"mobile_push_deliveries": "One row per notification per DEVICE — the mobile " +
		"sibling of web_push_deliveries and notification_webhook_deliveries, " +
		"excluded on the same reasoning. Nobody starts a push and waits on it; " +
		"it is a side effect of a notification they are already being shown.",

	// NO LIFECYCLE AT RUNTIME. Excluded 2026-08-10 after being pulled off the
	// gap list for registration and failing the bar state.go sets: EVERY STATE
	// MUST HAVE A WRITER.
	//
	// All three were checked the same way — every INSERT, UPDATE and status
	// write across Go, TypeScript, SQL and Python. In each case the only
	// non-INSERT references are GRANTs and RLS policies: nothing in this
	// repository ever moves any of these rows to another status. Their CHECK
	// constraints describe lifecycles their code does not run, which is exactly
	// why discovery flagged them and exactly why registering them would be
	// wrong. `report_exports`, `content_remix_tts_jobs` and
	// `predictive_model_runs` were removed from Families for this same reason;
	// these are the same finding in three more tables.
	//
	// Registering a born-terminal table inflates the coverage figure while
	// describing a lifecycle that never runs — the specific dishonesty this
	// package's discovery test exists to prevent, so it must not be committed
	// in the course of satisfying that test.
	"sar_bundles": "Born terminal. Both writers INSERT status 'ready' " +
		"(sar.go, erasure.go, subscribers/data_export.go) and the column " +
		"defaults to 'ready'; there is no UPDATE anywhere. A SAR bundle is " +
		"assembled inside one request and committed complete, so 'pending' and " +
		"'failed' are unreachable and nobody ever waits on one.",

	"lookalike_models": "Born terminal. The single writer " +
		"(audiences/lookalike.go) INSERTs status 'ready' and no UPDATE exists, " +
		"so 'pending', 'running' and 'failed' have no writer. The model is " +
		"computed synchronously before the row is written — the row is the " +
		"RESULT, not a job to watch.",

	// FOUR MORE, verified 2026-08-10 the same way and added to the same guard.
	//
	// Worth recording HOW they were checked, because a plain grep for
	// `UPDATE <table>` got this wrong. Seven tables looked writer-less by eye;
	// running the hardened detector — which also sees schema-qualified names,
	// quoted identifiers, ONLY, MERGE and transitions hidden in an upsert —
	// found real writers for three of them (`onsite_form_experiments`,
	// `privacy_request_subprocessor_acks`,
	// `tenant_archive_domain_verifications`). Those three stay on the gap list
	// as genuine operations. Excluding them on the grep would have put exactly
	// the false claim this guard exists to prevent into the exclusion prose.
	//
	// The four below survive that check, and each carries `status` as a bound
	// parameter at INSERT with nothing anywhere that moves it afterwards.
	// THREE MORE, 2026-08-10, each matching an exclusion this map already makes
	// rather than inventing a new argument.
	//
	// Verified from the schema, not the name — the previous pass was caught
	// excluding tables discovery had never surfaced, and the cure was to check.
	"sms_messages": "One row per MESSAGE to one phone number — `phone_e164`, " +
		"`direction`, `provider_message_id`, `delivered_at`. Its long vocabulary " +
		"(sent → delivered → read → undelivered) tracks one message's journey to " +
		"one person, which is the same per-recipient delivery ledger as " +
		"channel_send_history and omni_recipients. The SMS campaign is the " +
		"operation; these are its rows.",

	"gift_subscriptions": "State of a gift and the Stripe payment behind it " +
		"(`stripe_invoice_id`, `stripe_payment_url`, `redeemed_at`). Same " +
		"reasoning as archive_tips: pending → paid → granted → refunded tracks an " +
		"EXTERNAL charge and a recipient's redemption, neither of which is work " +
		"this system is running and waiting on.",

	"commerce_orders": "An order in a connected store, not a job. `cart` in the " +
		"vocabulary is decisive — a cart is a standing state of somebody's " +
		"basket, with no beginning and no end, and an operations view containing " +
		"every open cart would never empty. The money states (paid, refunded) are " +
		"external events this system records rather than performs.",

	// Same class as automation_flow_ab_tests above, and the same five words in
	// the same order (draft, running, completed, paused, archived). Its columns
	// say the rest: allocation_mode, winner_metric, winner_variant_id. This is
	// the DEFINITION of an experiment, not a run inside one — an operations view
	// listing it would hold every experiment a tenant has ever configured.
	"onsite_form_experiments": "State of an experiment, not a run inside one — " +
		"identical vocabulary and shape to automation_flow_ab_tests.",

	// OPERATOR-DECLARED STATUS LABELS. Excluded 2026-08-12 under a stated
	// assumption, recorded here so it can be reversed by one person reading one
	// comment rather than re-derived from four tables.
	//
	// THE ASSUMPTION: an operations view answers "what is the system doing".
	// These four answer "what has a person declared", and their only status
	// writer is a PATCH or an HTTP handler somebody calls by hand. Mixing the
	// two puts a question that is never stale beside one that is stale the
	// moment an operator forgets to update it — and the reader cannot tell which
	// kind of row they are looking at.
	//
	// They cleared every mechanical bar, which is why this needed deciding
	// rather than discovering: their vocabularies map onto the canonical states
	// and every state has a writer. `maintenance_windows` maps cleanly
	// (scheduled→queued, in_progress→running, completed→succeeded,
	// cancelled→cancelled) and was refused on this ground alone.
	//
	// REVERSING IT is deliberately cheap: move an entry into `Families` with a
	// `FamilyColumns` row and delete it here. Nothing else depends on the
	// choice. If the product decides an operations view SHOULD carry declared
	// work — a maintenance window is, after all, something people wait on — this
	// is four small registrations, not a redesign.
	//
	// `domain_warmup_plans` carries an extra wrinkle worth keeping: its ramp IS
	// automatic (TodayQuota is computed from started_on and the schedule) while
	// its status is not, so a finished warmup sits at `active` until somebody
	// changes it. Registering it would show every completed warmup as running.
	// That is a defect in the feature, not a reason to register the table, and
	// it is recorded in the package header where the wrong claim used to be.
	"maintenance_windows": "Operator-declared: the only status writer is a PATCH " +
		"endpoint. A maintenance window is a calendar entry somebody marks, not " +
		"work this system executes and reports on.",

	"domain_warmup_plans": "Operator-declared: status is set only by " +
		"PATCH /api/v1/domain-warmup/{domain}/status. The ramp is automatic; the " +
		"LABEL is not, so a finished plan reads `active` until a person changes it.",

	"privacy_request_subprocessor_acks": "Operator-declared: written by " +
		"RecordSubprocessorAck, an HTTP handler a compliance operator calls when a " +
		"subprocessor confirms. Nobody waits on this system — they wait on a third " +
		"party, and a human records the answer.",

	"tenant_archive_domain_verifications": "Operator-declared: `ssl_status` is " +
		"advanced by an operator-triggered verification rather than by a worker " +
		"this view could report progress on.",

	"subscriber_lookalike_audiences": "Born terminal, and the case that made the " +
		"born-terminal detector precise. The INSERT hardcodes 'ready' " +
		"(subscribers/lookalike.go) and the single UPDATE sets " +
		"exported_destination_id — the audience is the RESULT of a computation " +
		"that already finished, not a job to watch. Its `pending`, `running` and " +
		"`failed` values have no writer.",

	"automation_journey_executions": "No writer at all — zero INSERTs and zero " +
		"UPDATEs across the repository. Its only references are two reads in " +
		"internal/sar, so the SAR bundle queries it and gets nothing, every " +
		"time. Not an unregistered operation; an empty table with a lifecycle " +
		"nothing has ever run.",

	"inbound_route_action_runs": "Born terminal, and legitimately so. The action " +
		"has already run by the time the row is written — `status` is a bound " +
		"parameter carrying succeeded/failed/skipped — so the row is a RECORD of " +
		"what happened, not a job anyone is waiting on. It also has no time " +
		"columns to order a shared view by.",

	"review_requests": "Born and frozen. `status` is bound at INSERT " +
		"(reviews/repo.go) and no writer moves it, so `sent`, `opened` and " +
		"`submitted` are unreachable — the vocabulary describes a recipient's " +
		"journey the code never advances. Registering it would show a queue that " +
		"never drains.",

	"subscriber_prediction_runs": "Born terminal. `status` is bound at INSERT " +
		"(sto_predictive_clv/repo.go) and never updated, so the run is complete " +
		"when the row appears. This also retires the `skipped_insufficient_data` " +
		"question the gap list carried: a state nothing transitions into needs no " +
		"canonical mapping.",

	"content_remix_assets": "Born stuck, and the more misleading of the two " +
		"shapes. The INSERT omits `status`, so every row takes the 'pending' " +
		"default and nothing ever moves it — rendering is deliberately deferred " +
		"(archive_content_remix.go:311, MIGRATION.md). This is the identical " +
		"defect that removed its SIBLING `content_remix_tts_jobs` from " +
		"Families, one table over. Registering it would show permanently " +
		"'pending' work in a view whose whole purpose is telling someone what " +
		"is about to happen — the flow_runs 'queued for a fortnight' problem " +
		"again. If the renderer ever lands, this becomes a genuine family.",
}

// knownUnregistered are operation families that EXIST and are NOT yet in the
// registry. They are acknowledged gaps, not exclusions.
//
// The distinction is the whole point. An exclusion says "this is not an
// operation". Every entry here IS one: work a user can start and cannot see the
// state of in a shared view, because the registry does not know the table
// exists. Registering each means mapping its full status vocabulary onto the
// canonical states with real judgment per table — `empty` is a success,
// `preview` is not queued, `expired` is not `succeeded` — which is the work the
// ledger row describes and which is not done.
//
// A THIRD QUESTION, learned the hard way on this list: WHO writes the status?
//
// The two mechanical bars — the vocabulary maps, and every state has a writer —
// are both cleared by tables whose status is a label an OPERATOR maintains by
// hand rather than a position the system moves a row through.
// `maintenance_windows` and `domain_warmup_plans` are both like this: their only
// status writer is a PATCH endpoint. Registering either would make a shared
// "what is running" view answer "what has somebody declared" in the same list,
// and those are different questions — one of them is never stale and the other
// is stale the moment an operator forgets.
//
// `domain_warmup_plans` shows the failure concretely. Its ramp is genuinely
// automatic (TodayQuota is computed from started_on and the schedule) but its
// status is not, so a finished warmup sits at `active` until a person changes
// it. The package header claimed the plan "flips to status='completed'" after
// its days elapse; nothing has ever done that, and the claim is now corrected in
// place. A registry entry built on that column would have inherited the lie.
//
// So: an operator-declared status is a reason to leave a family HERE rather than
// register it, and the reason belongs in this comment rather than being
// rediscovered per table.
//
// ENUMERATED, NOT COUNTED. A guard that stores "57 remaining" drifts from the
// truth silently and teaches nothing; this repo has already shipped one such
// number that sat unchanged through two rounds of work. A list fails loudly
// when a NEW operation table appears, and shrinking it is a visible diff that
// names exactly what was closed.
// A WORD COLLISION blocks one of these, and it needs a schema change rather
// than a mapping, so it is recorded here instead of being rediscovered.
//
// `intelligent_retry_events.ready` means "an operator approved this retry and it
// is waiting to run" (intelligent_retry.go:143 sets it from an approve handler).
// Everywhere else in this registry `ready` means terminal SUCCESS — a
// downloadable export, a finished scan. The two are opposite ends of a
// lifecycle sharing one word.
//
// Neither mapping is available. As StateQueued it breaks the one-word-one-meaning
// invariant `TestEveryMappingAgreesWithTheVocabulary` exists to enforce; as
// StateSucceeded it reports an approved-but-not-yet-attempted retry as finished
// work. The fix is to rename the value (`retry_ready`) or give the registry a
// per-family override, and both are decisions with a migration behind them.
// OPERATOR-DECLARED, second instance of the rule above:
// `privacy_request_subprocessor_acks` is written by RecordSubprocessorAck, an
// HTTP handler a compliance operator calls when a subprocessor confirms. Nobody
// is waiting on this system to do anything — they are waiting on a third party,
// and a human records the answer when it arrives.
var knownUnregistered = map[string]bool{}

func TestEveryOperationLikeTableIsRegisteredOrExcluded(t *testing.T) {
	pool := operationTestPool(t)
	ctx := context.Background()

	registered := map[string]bool{}
	for _, f := range Families {
		registered[f.Table] = true
	}

	candidates := discoverOperationLikeTables(t, ctx, pool)
	if len(candidates) == 0 {
		t.Fatal("discovery found no operation-like tables at all. Either the " +
			"schema is not loaded or the query below stopped working — and a " +
			"discovery test that finds nothing passes for the wrong reason.")
	}

	var newlyFound []string
	for table, values := range candidates {
		if registered[table] || excluded[table] != "" || knownUnregistered[table] {
			continue
		}
		newlyFound = append(newlyFound, fmt.Sprintf("%s (%s)", table, strings.Join(values, ", ")))
	}
	sort.Strings(newlyFound)

	if len(newlyFound) > 0 {
		t.Errorf(
			"%d NEW table(s) carry an operation lifecycle and are in none of the "+
				"three lists. Each is work a user can start and cannot see the state "+
				"of in a shared view:\n  %s\n\n"+
				"Register it in Families, add it to `excluded` with the reason it is "+
				"not an operation, or add it to `knownUnregistered` to acknowledge "+
				"the gap. All three are decisions; being in none is not.",
			len(newlyFound), strings.Join(newlyFound, "\n  "),
		)
	}

	// The gap must not be forgotten just because it stopped failing. Reported
	// on every run so the number is in front of whoever reads the output, and
	// so a shrinking list is visible progress rather than silence.
	t.Logf("operation registry coverage: %d registered, %d acknowledged gaps",
		len(Families), len(knownUnregistered))
}

// A table that gets REGISTERED must leave the acknowledged-gap list.
//
// Otherwise the list becomes a place entries go to die: it would keep naming
// tables that are already handled, the number would stop meaning anything, and
// the next reader could not tell remaining work from finished work.
func TestNoTableIsBothRegisteredAndAcknowledgedAsAGap(t *testing.T) {
	for _, f := range Families {
		if knownUnregistered[f.Table] {
			t.Errorf("%s is registered in Families AND listed as an unregistered "+
				"gap; remove it from knownUnregistered", f.Table)
		}
	}
}

// An acknowledged gap must still be a real, discoverable table.
//
// A migration that drops or renames one leaves an entry inflating the gap
// count with work that no longer exists.
func TestEveryAcknowledgedGapStillExists(t *testing.T) {
	pool := operationTestPool(t)
	candidates := discoverOperationLikeTables(t, context.Background(), pool)
	for table := range knownUnregistered {
		if _, ok := candidates[table]; !ok {
			t.Errorf("%s is listed as an unregistered operation family but "+
				"discovery no longer finds it; the entry inflates the gap with "+
				"work that no longer exists", table)
		}
	}
}

// An exclusion must name a table that exists and is actually a candidate.
//
// Without this the list rots in the direction that hides things: a table
// renamed by a migration leaves a stale entry that silently excuses nothing,
// and the next table to take that name inherits the exemption.
func TestEveryExclusionIsStillReal(t *testing.T) {
	pool := operationTestPool(t)
	ctx := context.Background()
	candidates := discoverOperationLikeTables(t, ctx, pool)

	for table, reason := range excluded {
		if strings.TrimSpace(reason) == "" {
			t.Errorf("%s is excluded with no reason", table)
		}
		if _, ok := candidates[table]; !ok {
			t.Errorf("%s is excluded but discovery no longer finds it — the entry "+
				"excuses nothing and would silently exempt whatever takes that name",
				table)
		}
	}
}

// Every registered family must itself be discoverable.
//
// This is the mirror of the coverage test, and it pins the DISCOVERY rule
// rather than the registry: if the vocabulary or the threshold ever stops
// matching a table everyone agrees is an operation, the coverage test above
// starts passing because it finds nothing to complain about.
func TestDiscoveryFindsEveryRegisteredFamily(t *testing.T) {
	pool := operationTestPool(t)
	ctx := context.Background()
	candidates := discoverOperationLikeTables(t, ctx, pool)

	for _, f := range Families {
		if _, ok := candidates[f.Table]; !ok {
			t.Errorf("%s is a registered operation family but the discovery rule "+
				"does not classify it as one. The coverage test is only as good as "+
				"this rule, and a rule that misses a known family would report a "+
				"clean sweep over a shrinking set.", f.Table)
		}
	}
}

// discoverOperationLikeTables returns table -> the lifecycle values it permits.
//
// Reads `pg_constraint` directly, which is the same authority the registry's
// other tests use and has no row-level security, so this needs no elevated
// scope. Only tables in the public schema with a CHECK on a column named
// `status` are considered — a status stored under another name is out of reach
// of this rule, which is a real limit of the discovery and is why
// TestDiscoveryFindsEveryRegisteredFamily exists to keep it honest.
func discoverOperationLikeTables(
	t *testing.T, ctx context.Context, pool *db.Pool,
) map[string][]string {
	t.Helper()
	rows, err := pool.Query(ctx, `
SELECT cl.relname, pg_get_constraintdef(c.oid)
  FROM pg_constraint c
  JOIN pg_class cl ON cl.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = cl.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.conrelid
   AND a.attnum = ANY (c.conkey)
   AND a.attname = 'status'
 WHERE c.contype = 'c'
   AND n.nspname = 'public'
   -- 'r' ordinary tables AND 'p' partitioned PARENTS. Restricting to 'r'
   -- alone silently drops every partitioned parent, so a partitioned
   -- operation table would be invisible to a coverage check whose entire
   -- purpose is finding what is invisible.
   AND cl.relkind IN ('r', 'p')
   -- Partitions are not separate families. A partition inherits its parent's
   -- CHECK, so including them would list each monthly partition of
   -- campaign_recipients_partitioned
   -- as its own operation. Worse, the rotator creates a new one every
   -- month, so this guard would fail on a schedule. A check that breaks
   -- monthly is a check someone disables.
   AND cl.relispartition = false`)
	if err != nil {
		t.Fatalf("discovering status constraints: %v", err)
	}
	defer rows.Close()

	found := map[string][]string{}
	for rows.Next() {
		var table, def string
		if err := rows.Scan(&table, &def); err != nil {
			t.Fatalf("scan: %v", err)
		}
		var hits []string
		for _, lit := range quotedLiterals(def) {
			if lifecycleVocabulary[strings.ToLower(lit)] {
				hits = append(hits, lit)
			}
		}
		if len(hits) >= lifecycleThreshold {
			sort.Strings(hits)
			// A table can carry more than one CHECK on `status`; union them.
			found[table] = mergeSorted(found[table], hits)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return found
}

// quotedLiterals pulls the single-quoted values out of a CHECK definition.
//
// Parsing the constraint text rather than the column type because these are
// CHECK-constrained text columns, not enums — `pg_enum` would return nothing.
func quotedLiterals(def string) []string {
	var out []string
	for {
		start := strings.Index(def, "'")
		if start == -1 {
			return out
		}
		rest := def[start+1:]
		end := strings.Index(rest, "'")
		if end == -1 {
			return out
		}
		out = append(out, rest[:end])
		def = rest[end+1:]
	}
}

func mergeSorted(a, b []string) []string {
	seen := map[string]bool{}
	for _, v := range append(append([]string{}, a...), b...) {
		seen[v] = true
	}
	out := make([]string, 0, len(seen))
	for v := range seen {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}
