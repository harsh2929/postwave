// SPDX-License-Identifier: AGPL-3.0-only

// Package operation carries the canonical lifecycle for long-running work.
//
// The blueprint asks for a universal Operation schema so migration, export and
// their neighbours stop each inventing a lifecycle. They have — and more widely
// than a first pass suggested. Read from the live CHECK constraints, terminal
// success across job-family tables is spelled at least SIX ways:
//
//	succeeded  agent_routine_runs, audience_sync_jobs, ops_action_runs, feed_source_runs, …
//	completed  flow_runs, report_runs, audit_export_jobs, automation_backfill_jobs, …
//	ready      tenant_exports, subscriber_imports, content_remix_tts_jobs
//	complete   subscriber_duplicate_scans
//	empty      streaming_export_runs
//	ok         webmention_parser_runs
//
// "Waiting" is spelled `queued` or `pending`; "working" is `running`,
// `in_progress`, `generating`, `rendering` or `delivering`. A user watching two
// jobs sees two vocabularies for one idea, and a cross-family view cannot exist
// without a translation.
//
// SCOPE — stated because an earlier version of this comment implied more, and
// then a corrected version implied LESS. Counting non-partition tables whose
// `status` column carries a CHECK that enumerates a `failed` value plus a
// waiting-or-working value, there are 66. It said 63 when written and "ten,
// about 16%" for the registry, both of which had drifted — a hand-kept number
// in a comment is the exact failure `registry_coverage_db_test.go` was added to
// replace: that guard asks the database the same question on every run (its rule
// is slightly wider — any two lifecycle words — and finds 70), logs how many are
// registered, and FAILS on a table in none of its three lists. Read the guard's
// output rather than this sentence. This registry covers the families in
// `Families` and NOT the rest; an unregistered table returns ok=false from
// Canonical rather than being guessed at.
//
// "Roughly forty" appeared here first and was wrong in the flattering
// direction, which is the failure this paragraph exists to prevent. The rule
// above is stated so the number can be recomputed and disagreed with.
//
// `rejected` and `needs_reconciliation` WERE listed here as missing canonical
// states blocking `audience_sync_jobs` and `audience_sync_runs`. Both now exist
// — see their definitions for why neither folds into a neighbour — and both
// families are registered. The design work is done; what remains below is the
// same kind of question for other families. `partial` WAS on this list and is now `StatePartial` — see its
// definition for why it could not be folded into either neighbour. An earlier version of this list said
// `needs_review` "on the sync families"; that value exists on exactly one table
// in the schema, `scheduled_report_runs`, which is a report family — the same
// names-the-wrong-table error this comment block keeps retracting.
//
// WHAT THIS IS. A projection, not a migration. Rewriting the tables and their
// CHECK constraints is a client-visible cutover; this maps what they already
// store onto one vocabulary. The per-family raw values remain the wire contract:
// all three of `internal/exports`' status-reporting endpoints — create, get and
// list — return both `status` (raw) and `state` (canonical). An earlier version
// of this sentence was false: `state` had been added to `list` alone, the one
// endpoint a poller does not use.
//
// A REGISTERED FAMILY MUST HAVE A LIFECYCLE. Two tables were registered and then
// removed for failing that: `report_exports` (dead — zero rows, referenced only
// by migration 0204), `content_remix_tts_jobs` (no UPDATE anywhere; the INSERT
// omits `status`, so every row is permanently `queued` and its `submitted`,
// `rendering`, `ready` and `failed` values have no writer) and
// `predictive_model_runs` (INSERT hardcodes `completed` with
// started_at = completed_at; the sole UPDATE touches counters, so a row is born
// terminal). Registering a table whose states nothing ever reaches inflates the
// coverage figure and describes a lifecycle that does not run.
//
// The mapping is verified against the DATABASE, not against this file: a
// DB-backed test reads each table's real constraint and asserts the mapping is
// exhaustive in both directions, so adding a status without classifying it
// fails rather than silently projecting as unknown.
package operation

// State is the canonical lifecycle position.
type State string

const (
	// StateQueued — accepted, not started. Nothing has been consumed yet.
	StateQueued State = "queued"
	// StateRunning — in progress. Some work may already be externally visible.
	StateRunning State = "running"
	// StateSucceeded — finished, and the result is usable. Covers `ready` (an
	// artefact is downloadable), `completed` (work is done) and `empty` (there
	// was nothing to do, which is a success, not a failure).
	StateSucceeded State = "succeeded"
	// StateFailed — finished, and the result is not usable.
	StateFailed State = "failed"
	// StateCancelled — stopped deliberately. Distinct from failed because
	// nothing went wrong and it must not page anyone.
	StateCancelled State = "cancelled"
	// StateExpired — succeeded once, and the artefact has since been reaped.
	// Kept distinct from succeeded so a user clicking download can be told the
	// file is gone rather than shown a dead link.
	//
	// NOTE: no writer produces `expired` today. `tenant_exports` PERMITS it, but
	// the retention sweeper DELETES the row instead of transitioning it, so the
	// state is schema-reachable and code-unreachable. It stays because the
	// constraint permits it and this mapping must be exhaustive — a permitted
	// value with no mapping is exactly what the DB test exists to catch — not
	// because the experience above currently occurs.
	StateExpired State = "expired"
	// StatePartial — finished, and the result is PARTLY usable. Some records
	// moved, some did not.
	//
	// Its own state rather than folded into either neighbour, for the same
	// reason `expired` is not folded into `succeeded`: both alternatives lie to
	// the operator in a way that changes what they do next.
	//
	//   - As SUCCEEDED it reads as "the sync worked", and nobody goes looking
	//     for the records that did not arrive. The failure surfaces later as
	//     missing data with no run to blame.
	//   - As FAILED it pages someone about a run that largely worked, and — worse
	//     — invites a retry of the whole thing when only a remainder is missing.
	//
	// The 14 sync families that carry it are exactly the ones where "most of it
	// arrived" is the normal outcome of a provider rate-limiting or rejecting a
	// subset, so this is the common case, not an edge.
	StatePartial State = "partial"
	// StatePreview — accepted by the system, and waiting on a PERSON rather than
	// on a worker. Nothing will happen without another human action, so showing
	// it as "waiting" in a shared view would misreport what is pending.
	//
	// It was "a dry run awaiting confirmation. Only imports have it" — true when
	// written and no longer. `campaigns` maps `draft` here, which is not a dry
	// run but has the property that matters: the system will never pick it up on
	// its own. The state is named for where imports first needed it; what it
	// MEANS is "the next move is yours".
	//
	// The cost is real and worth stating: an unfiltered operations list now
	// includes every draft campaign a tenant keeps. That is the price of the
	// alternative being worse — leaving the most-watched operation in the
	// product out of the operations view entirely — and `?state=` exists so a
	// client that wants only live work can ask for it.
	StatePreview State = "preview"
	// StateRejected — the destination refused the work, and repeating it
	// unchanged will be refused again.
	//
	// Its own state rather than folded into `failed`, on the same test the rest
	// of this vocabulary uses: does the operator's NEXT ACTION differ? It does,
	// and in the most expensive direction. `failed` invites a retry, because
	// most failures are transient — a network blip, a rate limit, a bug since
	// fixed. A rejection is the opposite: the input is the problem, so retrying
	// identical input produces an identical refusal. Shown as `failed`, a
	// rejected sync becomes a retry loop that teaches nobody anything and
	// consumes provider quota doing it.
	//
	// Not `cancelled` either, which is the mirror error: cancelled means WE
	// stopped it deliberately and nothing is wrong, so it must not page anyone.
	// Rejected means the other side stopped it and something IS wrong.
	//
	// Concretely, `audience_destinations` sets it on ErrAudienceCapExceeded —
	// the destination will not accept an audience this large. Nothing gets
	// better until a person shrinks the audience or changes the plan.
	StateRejected State = "rejected"
	// StateNeedsReconciliation — the run stopped without a terminal answer, and
	// the two sides may now disagree about what happened.
	//
	// The hardest of the three to fold, and the most dangerous to fold wrongly,
	// because it is the state that means WE DO NOT KNOW.
	//
	//   - As `succeeded` it asserts the audience is in sync when nobody has
	//     established that. The divergence surfaces later as a campaign sent to
	//     the wrong people, with a run history that says everything was fine.
	//   - As `failed` it invites a retry of work that may have ALREADY been
	//     applied externally — the specific way you turn an uncertain outcome
	//     into a duplicated one.
	//   - As `partial` it claims knowledge the run does not have. `partial` means
	//     "some records moved, some did not, and we know which", and its action
	//     is to retry the remainder. This means "we never got an acknowledgement",
	//     and its action is to compare the two sides before touching anything.
	//
	// Written when an operation lease expires while a run is still `running`:
	// the worker died mid-flight, external effects may or may not have landed,
	// and the safe answer is to say so rather than guess. Both audience-sync
	// families reach it, and it is why they could not be registered until now.
	StateNeedsReconciliation State = "needs_reconciliation"
	// StateBlocked — live, and unable to proceed until something outside this
	// system changes.
	//
	// The three alternatives each break something specific, and for privacy
	// requests one of them breaks compliance rather than presentation.
	//
	//   - As `running` it claims progress. An operator watching for completion
	//     waits on a row that will not move until a lawyer lifts a hold.
	//   - As `queued` it claims imminence. Queued means "about to happen"; this
	//     means "will not happen until a human resolves a legal hold or an
	//     ownership dispute", which is a different thing to tell someone.
	//   - As `failed` it claims the work is OVER, and that is the dangerous one.
	//     `privacy_requests` has a statutory clock, and its own overdue metric
	//     counts everything except fulfilled/cancelled/rejected as still owed —
	//     so blocked rows are, by the system's own accounting, outstanding
	//     obligations. Filing them under a terminal state would drop them out of
	//     the set the deadline applies to. The bug would not be a wrong label; it
	//     would be a missed regulatory deadline nobody was warned about.
	//
	// Distinct from `needs_reconciliation`, which is also non-progressing: that
	// one means the outcome is UNKNOWN, this one means the outcome is known to
	// be pending on somebody else.
	StateBlocked State = "blocked"
	// StatePaused — started, deliberately stopped, and it will resume.
	//
	// Held back until a family earned it. `domain_warmup_plans` was the first
	// candidate and was refused: its status is a label an operator maintains, so
	// a canonical state justified by it would have been a vocabulary entry
	// serving a table that should not be registered. `campaigns` earns it — the
	// queue worker writes `sending`, and a pause interrupts work the system is
	// actively doing.
	//
	//   - Not `running`: nothing is progressing, and an operator watching for
	//     completion waits on a row that will not move until somebody resumes it.
	//   - Not `queued`: queued means accepted and not yet started. This started.
	//     The difference is not pedantic for a send — a paused campaign has
	//     already delivered to part of its audience, and calling it queued hides
	//     that the audience is now split.
	//   - Not `cancelled`: cancelled is terminal and must not page anyone. Paused
	//     is outstanding work, and for a half-delivered send it is outstanding
	//     work somebody has to decide about.
	StatePaused State = "paused"
	// StateUnknown — the row's raw status is not in this family's map.
	//
	// NOT a registry state: nothing maps ONTO it, and `Canonical` never returns
	// it. It exists for the shared view, which has to render a row whose status
	// arrived after a migration and before the registry caught up. The
	// alternatives are both worse than admitting ignorance: hiding the row makes
	// somebody's running job invisible, and guessing a neighbouring state
	// answers the question with a confident wrong answer — the same reason
	// `graph_version_id` stays NULL rather than defaulting to the current
	// version.
	//
	// A row in this state is a bug report. The DB-backed exhaustiveness test
	// fails on any unmapped value, so seeing one in production means the
	// registry is behind the schema.
	StateUnknown State = "unknown"
)

// Family is a table whose rows are long-running operations.
type Family struct {
	// Table is the physical table, and the key the DB-backed test reads its
	// CHECK constraint from.
	Table string
	// Kind is the user-facing operation type.
	Kind string
	// States maps every raw value the table permits onto a canonical state.
	// Exhaustive by contract — the test fails on an unmapped value.
	States map[string]State
}

// Families is the registry. Sourced from the live CHECK constraints; the
// DB-backed test is what keeps it that way.
var Families = []Family{
	// The sync families. Six tables, one shared vocabulary, and the reason
	// `StatePartial` had to exist before any of them could be registered: a
	// provider rate-limiting or rejecting a subset is their NORMAL outcome, so
	// `partial` is the common case and folding it into success or failure
	// misreports most of their runs.
	{
		Table: "analytics_sync_runs",
		Kind:  "analytics_sync",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	{
		Table: "review_sync_runs",
		Kind:  "review_sync",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	{
		Table: "subscription_sync_runs",
		Kind:  "subscription_sync",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	{
		Table: "support_sync_runs",
		Kind:  "support_sync",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	{
		Table: "writeback_runs",
		Kind:  "writeback",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	// Straightforward families: every raw value they permit already has a
	// meaning in the shared vocabulary, so registering them is transcription.
	// They are here rather than deferred precisely BECAUSE they are easy — the
	// gap list should hold only the ones that need a decision.
	{
		Table: "ai_regression_runs",
		Kind:  "ai_regression",
		States: map[string]State{
			"pending": StateQueued, "running": StateRunning,
			"completed": StateSucceeded, "failed": StateFailed,
		},
	},
	{
		// `ready` (an artefact is downloadable) and `expired` (it has since been
		// reaped) are the two that make this family the model for the whole
		// vocabulary — see StateExpired.
		Table: "report_exports",
		Kind:  "report_export",
		States: map[string]State{
			"queued": StateQueued, "running": StateRunning,
			"ready": StateSucceeded, "failed": StateFailed,
			"expired": StateExpired,
		},
	},
	{
		Table: "subscriber_duplicate_scans",
		Kind:  "duplicate_scan",
		States: map[string]State{
			"running": StateRunning, "complete": StateSucceeded,
			"failed": StateFailed,
		},
	},
	{
		Table: "voice_ingest_jobs",
		Kind:  "voice_ingest",
		States: map[string]State{
			"pending": StateQueued, "running": StateRunning,
			"succeeded": StateSucceeded, "failed": StateFailed,
		},
	},
	{
		Table: "voice_sequence_jobs",
		Kind:  "voice_sequence",
		States: map[string]State{
			"pending": StateQueued, "running": StateRunning,
			"succeeded": StateSucceeded, "failed": StateFailed,
		},
	},
	{
		// `ok` is this family's spelling of terminal success, and `partial` is
		// the same "some of it arrived" outcome the sync families have.
		Table: "webmention_parser_runs",
		Kind:  "webmention_parse",
		States: map[string]State{
			"running": StateRunning, "ok": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	{
		// The only one of the six that can be QUEUED or CANCELLED — a warehouse
		// sync is scheduled work an operator can call off, where the others are
		// triggered and run immediately.
		Table: "warehouse_sync_runs",
		Kind:  "warehouse_sync",
		States: map[string]State{
			"queued": StateQueued, "running": StateRunning,
			"completed": StateSucceeded, "failed": StateFailed,
			"cancelled": StateCancelled,
		},
	},
	// The audience-sync pair. Same worker machinery, and the two states that
	// kept them off the registry — `rejected` and `needs_reconciliation` — are
	// now canonical. See their definitions for why neither folds.
	//
	// `runs` has no `queued`: a run row is created by the runner at the moment it
	// starts, so there is no accepted-but-not-started window to represent.
	// `jobs` does, because a job is recorded before the provider call is made.
	// Transcribing that difference rather than flattening it is the point — a
	// `queued` this table can never hold would be a state the shared view offers
	// as a filter and never returns a row for.
	{
		Table: "audience_sync_runs",
		Kind:  "audience_sync.run",
		States: map[string]State{
			"running": StateRunning, "succeeded": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
			"rejected":             StateRejected,
			"needs_reconciliation": StateNeedsReconciliation,
		},
	},
	{
		Table: "audience_sync_jobs",
		Kind:  "audience_sync.job",
		States: map[string]State{
			"queued": StateQueued, "running": StateRunning,
			"succeeded": StateSucceeded, "partial": StatePartial,
			"failed":               StateFailed,
			"rejected":             StateRejected,
			"needs_reconciliation": StateNeedsReconciliation,
		},
	},
	// Scheduled reports. A worker family with a lease, so `leased` and
	// `delivering` are both in-flight rather than waiting, and `needs_review`
	// carries the same "finished, outcome partly unknown" meaning as the sync
	// families' `needs_reconciliation`.
	{
		Table: "scheduled_report_runs",
		Kind:  "report.scheduled_run",
		States: map[string]State{
			"queued": StateQueued, "leased": StateRunning,
			"delivering": StateRunning, "succeeded": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
			"needs_review": StateNeedsReconciliation,
		},
	},
	// Privacy requests. A statutory-clock family, worker-driven through its
	// spine (intake writes `queued`, workflow advances `verifying` then
	// `in_progress`, the deletion worker writes `fulfilled`) with human
	// decisions on the branches.
	//
	// Both `blocked_*` values are written by real code paths — SetLegalHold and
	// the account-deletion worker's ownership check — and both map to
	// StateBlocked rather than to a terminal state, because this table's own
	// overdue metric treats them as still owed.
	{
		Table: "privacy_requests",
		Kind:  "privacy.request",
		States: map[string]State{
			"queued": StateQueued, "verifying": StateRunning,
			"in_progress": StateRunning,
			// An appeal reopens a rejected request and a reviewer works it, so
			// it is progressing rather than blocked: nothing external has to
			// change first.
			"appealed":           StateRunning,
			"blocked_legal_hold": StateBlocked, "blocked_ownership": StateBlocked,
			"fulfilled": StateSucceeded, "rejected": StateRejected,
			"cancelled": StateCancelled,
		},
	},
	// Campaigns. Both the entity and the operation, because there is no separate
	// send-run table: the campaign's own status is how a send is tracked, and
	// "is my campaign sending?" is the question this view exists to answer.
	//
	// The spine is machinery — the queue worker writes `sending` — with the
	// authoring states and pause/resume driven by a person, the same shape as
	// privacy_requests.
	{
		Table: "campaigns",
		Kind:  "campaign.send",
		States: map[string]State{
			"draft": StatePreview, "scheduled": StateQueued,
			"sending": StateRunning, "paused": StatePaused,
			"sent": StateSucceeded, "failed": StateFailed,
			"cancelled": StateCancelled,
		},
	},
	// SMS campaigns. Identical vocabulary to email campaigns and identical
	// reasoning — the store writes `sending` from the sender path — so this
	// needed no new words. Kept as its own family rather than folded in because
	// the two are different tables an operator filters separately, and because
	// their COLUMNS differ: this one records no start and no finish beyond
	// `sent_at`.
	{
		Table: "sms_campaigns",
		Kind:  "campaign.sms_send",
		States: map[string]State{
			"draft": StatePreview, "scheduled": StateQueued,
			"sending": StateRunning, "paused": StatePaused,
			"sent": StateSucceeded, "failed": StateFailed,
			"cancelled": StateCancelled,
		},
	},
	// The consent-sync ledger. One row per (consent change, destination): the
	// question "you were told to stop; who else holds this, and were they told?"
	//
	// Registered now that it RUNS. It shipped complete and inert — the writer
	// was guarded at seven call sites by a field nothing assigned — so every
	// state was unreachable and registering it would have described a lifecycle
	// that never executed. It is assigned at main.go:3176 with its retry sweeper
	// started at :3183, which is what makes `retrying` a real state rather than
	// a permanent one.
	{
		Table: "consent_sync_ledger",
		Kind:  "consent.sync",
		States: map[string]State{
			"pending": StateQueued, "retrying": StateRunning,
			"delivered": StateSucceeded, "failed": StateFailed,
		},
	},
	// AI design drafts. A real generation pipeline, not the empty table an
	// earlier note called it: every state has a writer and the live table holds
	// rows in five of them.
	//
	// The three trailing values are what a PERSON did with a finished result —
	// kept it, built a campaign from it, put it away — and all three project to
	// succeeded. The operation is the generation, and it ended when the artefact
	// appeared; `archived` is deliberately NOT StateExpired, because the draft
	// still exists and is merely filtered out of a list, where expired means the
	// artefact was reaped and a download would fail.
	{
		Table: "campaign_template_design_drafts",
		Kind:  "template.design_generation",
		States: map[string]State{
			"queued": StateQueued, "generating": StateRunning,
			"ready": StateSucceeded, "failed": StateFailed,
			"saved": StateSucceeded, "campaign_created": StateSucceeded,
			"archived": StateSucceeded,
		},
	},
	// Two PLATFORM-level families: no tenant_id, so they cannot appear in the
	// tenant-scoped view. Registered anyway because Canonical() serves more than
	// that view, and because an unregistered table is one whose states nothing
	// checks against the live constraint.
	{
		// An affiliate waiting to be paid is waiting on a run: it starts, it
		// finishes, and somebody cares when. Platform-scoped because affiliates
		// are not owned by a tenant.
		Table: "affiliate_payouts",
		Kind:  "affiliate.payout",
		States: map[string]State{
			"pending": StateQueued, "sent": StateSucceeded, "failed": StateFailed,
		},
	},
	{
		// The preview-image broker. `retry` is in flight rather than failed —
		// next_attempt_at is set and the broker will come back — while
		// `source_missing` is terminal, because no retry produces an image that
		// no longer exists.
		Table: "campaign_template_preview_assets",
		Kind:  "template.preview_asset",
		States: map[string]State{
			"queued": StateQueued, "fetching": StateRunning,
			"retry": StateRunning, "ready": StateSucceeded,
			"source_missing": StateFailed, "failed": StateFailed,
		},
	},
	// Intelligent retry. Registered via the one vocabulary OVERRIDE this package
	// permits: its `ready` means "an operator approved this retry and it is
	// waiting to run", the opposite end of the lifecycle from `ready` elsewhere.
	// See vocabularyOverrides for why neither renaming the value nor folding it
	// into succeeded was available.
	//
	// `retried` is terminal success — the retry went out. `dismissed` is a
	// person deciding not to, which is a cancellation and must not page anyone.
	{
		Table: "intelligent_retry_events",
		Kind:  "deliverability.retry",
		States: map[string]State{
			"pending": StateQueued, "ready": StateQueued,
			"retrying": StateRunning, "retried": StateSucceeded,
			"dismissed": StateCancelled, "failed": StateFailed,
		},
	},
	{
		Table: "tenant_exports",
		Kind:  "export.tenant",
		States: map[string]State{
			"queued": StateQueued, "running": StateRunning, "ready": StateSucceeded,
			"failed": StateFailed, "expired": StateExpired,
		},
	},
	{
		Table: "subscriber_imports",
		Kind:  "import.subscribers",
		States: map[string]State{
			// `preview` is its own state, not queued — see StatePreview.
			"preview": StatePreview, "queued": StateQueued, "running": StateRunning,
			"verification_queued": StateQueued, "verification_running": StateRunning,
			"ready": StateSucceeded, "failed": StateFailed, "cancelled": StateCancelled,
		},
	},
	{
		Table: "automation_backfill_jobs",
		Kind:  "backfill.automation",
		States: map[string]State{
			"queued": StateQueued, "running": StateRunning, "completed": StateSucceeded,
			"failed": StateFailed, "cancelled": StateCancelled,
		},
	},
	{
		Table: "audit_export_jobs",
		Kind:  "export.audit",
		States: map[string]State{
			"pending": StateQueued, "in_progress": StateRunning,
			"completed": StateSucceeded, "failed": StateFailed,
		},
	},
	{
		// The exact twin of audit_export_jobs, plus cancelled. Omitting it while
		// including its twin is what made an earlier comment claim audit exports
		// were "the only family" spelling pending/in_progress.
		Table: "audit_sink_replay_jobs",
		Kind:  "replay.audit_sink",
		States: map[string]State{
			"pending": StateQueued, "in_progress": StateRunning,
			"completed": StateSucceeded, "failed": StateFailed, "cancelled": StateCancelled,
		},
	},
	{
		Table: "flow_runs",
		Kind:  "run.flow",
		States: map[string]State{
			"queued": StateQueued, "running": StateRunning, "completed": StateSucceeded,
			"failed": StateFailed, "cancelled": StateCancelled,
		},
	},
	{
		Table: "report_runs",
		Kind:  "run.report",
		States: map[string]State{
			"queued": StateQueued, "running": StateRunning, "completed": StateSucceeded,
			"failed": StateFailed, "cancelled": StateCancelled,
		},
	},
	{
		Table: "agent_routine_runs",
		Kind:  "run.agent_routine",
		States: map[string]State{
			"running": StateRunning, "succeeded": StateSucceeded, "failed": StateFailed,
		},
	},
	{
		Table: "ops_action_runs",
		Kind:  "run.ops_action",
		States: map[string]State{
			"running": StateRunning, "succeeded": StateSucceeded, "failed": StateFailed,
		},
	},
	{
		Table: "streaming_export_runs",
		Kind:  "export.streaming",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			// `empty` means the run found nothing to export. That is a success:
			// classifying it as failed would page someone for a quiet day.
			"empty": StateSucceeded, "failed": StateFailed,
		},
	},

	// Third batch. The remaining destination-sync families share the exact
	// vocabulary the first six established, which is the argument for taking
	// them together: a per-table judgment call that keeps reaching the same
	// answer is a shape, and transcribing it four more times is honest work.
	{
		Table: "crm_sync_runs",
		Kind:  "crm_sync",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	{
		Table: "lead_sync_runs",
		Kind:  "lead_sync",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	{
		Table: "loyalty_sync_runs",
		Kind:  "loyalty_sync",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	{
		Table: "marketing_sync_runs",
		Kind:  "marketing_sync",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"partial": StatePartial, "failed": StateFailed,
		},
	},
	{
		Table: "feed_source_runs",
		Kind:  "feed_source_poll",
		States: map[string]State{
			"running": StateRunning, "succeeded": StateSucceeded,
			"failed": StateFailed,
		},
	},
	{
		Table: "predictive_model_runs",
		Kind:  "predictive_model_train",
		States: map[string]State{
			"queued": StateQueued, "running": StateRunning,
			"completed": StateSucceeded, "failed": StateFailed,
		},
	},
	// `generating` is this family's spelling of running — the model is
	// producing output. Nothing here is ambiguous.
	{
		Table: "content_remix_jobs",
		Kind:  "content_remix",
		States: map[string]State{
			"pending": StateQueued, "generating": StateRunning,
			"completed": StateSucceeded, "failed": StateFailed,
			"cancelled": StateCancelled,
		},
	},
	// TWO spellings of running, and they are not redundant. `submitted` means
	// the request is with the speech provider and `rendering` means the
	// provider started work; both are in flight from the operator's side, and
	// both collapse to StateRunning because the shared view answers "is this
	// still going" rather than "which leg of the provider handshake is it on".
	{
		Table: "content_remix_tts_jobs",
		Kind:  "content_remix_tts",
		States: map[string]State{
			"queued": StateQueued, "submitted": StateRunning,
			"rendering": StateRunning, "ready": StateSucceeded,
			"failed": StateFailed,
		},
	},
	// `abandoned` is a FAILURE, not a cancellation.
	//
	// The distinction the vocabulary draws is deliberateness: cancelled means
	// somebody stopped it and nothing went wrong, so it must not page anyone.
	// A scan is abandoned when its lease expired and no worker resumed it —
	// nobody chose that, and the membership data the scan was refreshing is now
	// silently stale. Reading it as cancelled would file a died-quietly worker
	// under "nothing to see".
	{
		Table: "crm_list_membership_scans",
		Kind:  "crm_list_membership_scan",
		States: map[string]State{
			"running": StateRunning, "completed": StateSucceeded,
			"failed": StateFailed, "abandoned": StateFailed,
		},
	},
	// NOT tenant-scoped — the third such family, after `ops_action_runs` and
	// `webmention_parser_runs`. Consent reconciliation sweeps every tenant in
	// one pass, so there is no tenant_id to scope it by and it cannot appear in
	// a tenant's view. Registered anyway: it is a real operation, and the
	// registry is what the ops console reads.
	{
		Table: "subscriber_email_consent_reconciliation_runs",
		Kind:  "consent_reconciliation",
		States: map[string]State{
			"running": StateRunning, "complete": StateSucceeded,
			"failed": StateFailed,
		},
	},
	// Bulk email verification. Registered because it is the clearest example in
	// the whole registry of the thing the shared view exists for: an operator
	// hands over a list of up to 250,000 addresses (`MaxJobAddresses`), the run
	// is measured in hours because each vendor probe is a real SMTP
	// conversation, and it spends real money as it goes. "Is it finished, how
	// far has it got, and what has it cost me so far" is precisely the question
	// nobody could ask without knowing which of thirty pages to look at.
	//
	// It is also the only family so far that a user can CANCEL from the product
	// — `POST /api/v1/verification/jobs/{id}/cancel` → `Store.CancelJob`, which
	// the runner honours at the next batch boundary rather than after the whole
	// list is billed. `cancelled` on the other families is written by workers or
	// schedulers; here it is a person deciding to stop paying, which is exactly
	// the case StateCancelled's doc comment says must not page anyone.
	//
	// `canceled`, ONE `l`. The table's CHECK spells it the American way while
	// every other family in the registry spells it with two, and the canonical
	// state is `cancelled`. That divergence is the registry's whole job: the raw
	// value stays the wire contract and both spellings project onto one state,
	// so a client filtering `state=cancelled` sees this family's stopped runs
	// without knowing which dictionary the migration author used.
	//
	// EVERY STATE HAS A WRITER, which is the bar this file removed three
	// families for failing. verification/jobs.go: CreateJob inserts `pending`,
	// markJobRunning takes it to `running`, completeJob to `completed`, failJob
	// to `failed`, CancelJob to `canceled`; the drainer (`Runner.Run`) is started
	// unconditionally by the API process. Nothing here is born terminal and no
	// state is schema-only.
	//
	// One honest caveat about volume, not about the lifecycle: job CREATION is
	// behind an explicit release gate (`BulkJobCreationEnabled`, false at the
	// composition root until crash-safe exclusive claiming is proven), so the
	// table is empty until that flips. That is a reason to expect no rows — NOT
	// a reason to register a BlockedReason. A blocked reason means queued work
	// that cannot progress; verification jobs progress the moment they exist,
	// because the runner is live. Labelling them blocked would be the same lie
	// in the opposite direction.
	{
		Table: "verification_jobs",
		Kind:  "verify.emails",
		States: map[string]State{
			"pending": StateQueued, "running": StateRunning,
			"import_pending": StateQueued, "import_running": StateRunning,
			"completed": StateSucceeded, "failed": StateFailed,
			"canceled": StateCancelled,
		},
	},
}

// Canonical projects a family's raw status onto the shared vocabulary.
//
// Returns ok=false for an unmapped value rather than guessing. A wrong guess
// here is worse than no answer: projecting an unknown status as `running` makes
// a shared view wait forever on work that already finished, and projecting it
// as `failed` pages someone about a job that is fine.
func Canonical(table, rawStatus string) (State, bool) {
	for _, f := range Families {
		if f.Table != table {
			continue
		}
		s, ok := f.States[rawStatus]
		return s, ok
	}
	return "", false
}

// Terminal reports whether no further transition is expected.
func (s State) Terminal() bool {
	switch s {
	case StateSucceeded, StateFailed, StateCancelled, StateExpired:
		return true
	}
	return false
}
