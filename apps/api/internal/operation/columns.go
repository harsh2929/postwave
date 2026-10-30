// SPDX-License-Identifier: AGPL-3.0-only
package operation

// Where each family keeps the facts a shared operations view needs.
//
// The registry knew every family's STATES and nothing about where to read them
// from, which was enough while `Canonical` was the only consumer — it is handed
// a status string by a caller who already did the query. A view that spans
// families has to do the querying itself, and the twenty-two tables do not
// agree on a single column name for anything except `id` and `status`:
//
//	completed_at   on 13 tables      finished_at  on 6
//	error          on 7              error_message on 6      last_error on 2
//	last_error_code on 1
//	created_at     on 20             absent       on 2
//
// Discovering that per query — COALESCE across every spelling, or a lookup in
// information_schema — would make a typo in a table definition look like an
// empty result, which is the failure mode this whole registry exists to remove.
// Declaring it makes a wrong name a startup-visible error instead.
//
// TWO FAMILIES ARE NOT TENANT-SCOPED. `ops_action_runs` and
// `webmention_parser_runs` have no `tenant_id` at all: the first is the ops
// console's own action log, the second a global parser. They are real
// operations and belong in the registry, but they cannot appear in a
// tenant-scoped view, and a UNION that assumed a `tenant_id` on every family
// would either fail to compile the query or — far worse, had the column existed
// under another name — show one tenant another's runs. TenantID is left empty
// for them, and the aggregator skips them explicitly rather than by accident.
type Columns struct {
	// TenantID is "" when the table is not tenant-scoped.
	TenantID string
	// CreatedAt is "" when the table records no queue time. Those rows enter
	// the view at their start time; claiming a created_at they do not have
	// would invent a queue delay of exactly zero.
	CreatedAt string
	// StartedAt is "" when the table records no start. `report_exports` and
	// `subscriber_duplicate_scans` are the two — they go straight from queued
	// to a completion.
	StartedAt string
	// FinishedAt is whichever of completed_at / finished_at this table uses.
	FinishedAt string
	// Error is whichever of error / error_message / last_error / last_error_code
	// this table uses,
	// or "" when it keeps no failure text. A family with no error column can
	// still be `failed`; it simply cannot say why, and the view shows that
	// honestly rather than substituting an empty string for "no message".
	Error string
}

// TenantScoped reports whether rows of this family belong to a tenant.
func (c Columns) TenantScoped() bool { return c.TenantID != "" }

// FamilyColumns is the per-table column map.
//
// Separate from the Family literals rather than a field on them: those literals
// are a wall of state mappings that is already hard to read, and interleaving
// column spellings would bury the state contract that is the registry's actual
// subject. The DB-backed test requires an entry here for every registered
// family, so the two cannot fall out of step.
var FamilyColumns = map[string]Columns{
	// The sync families: one shared shape as well as one shared vocabulary.
	"analytics_sync_runs":    {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"review_sync_runs":       {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"subscription_sync_runs": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"support_sync_runs":      {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"writeback_runs":         {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"warehouse_sync_runs":    {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error"},

	// The audience-sync pair spells its completion `finished_at` rather than
	// `completed_at`, and its failure text `error` rather than `error_message`.
	// Transcribed from the live columns rather than copied from the block above:
	// the six families there share a shape, these two only look like they do.
	"audience_sync_runs": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "finished_at", Error: "error"},
	"audience_sync_jobs": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "finished_at", Error: "error"},

	// Scheduled reports keep the human-readable failure in `last_error_summary`
	// and a machine code alongside it. The summary is what the shared view
	// wants: `last_error_code` would render "provider_outcome_unknown" where the
	// sentence next to it says which recipients and that no retry will happen.
	// privacy_requests spells none of the four the usual way, which is exactly
	// why these are read off the live table rather than copied from a sibling.
	// Intake is `requested_at`, not created_at. Work begins at `verified_at`,
	// when identity is established — the honest start, since a request sits
	// unstarted until then. The failure text is `denied_reason`, the sentence a
	// data subject is owed when a request is refused; `hold_reason` is
	// deliberately NOT used, because a legal hold is not a failure and putting
	// its text in the error column would render a blocked request as a broken
	// one.
	// campaigns has both `sent_at` and `finished_at`; `finished_at` is the send's
	// completion and `sent_at` is when it was dispatched, so the former is what a
	// "did this finish" view wants. No error column — a failed send's reason
	// lives in the delivery ledger, not on the campaign row, and pointing at a
	// near-enough column would put a wrong sentence in front of an operator.
	"campaigns": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "finished_at", Error: ""},

	// sms_campaigns records neither a start nor a distinct finish: `sent_at` is
	// the only completion signal it has, and there is no started_at to borrow.
	// Left empty rather than aliased to `updated_at`, which moves on every edit
	// and would render a draft touched this morning as a send that started then.
	"sms_campaigns": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "", FinishedAt: "sent_at", Error: ""},

	// consent_sync_ledger has no start and no finish column at all — it records
	// `last_attempted_at`, which moves on every retry and would report a row
	// retried this morning as one that STARTED this morning. Both are declared
	// absent, which the column guard permits only because the table genuinely
	// lacks started_at and finished_at/completed_at.
	// Design drafts keep no start and no finish column — `lease_expires_at` and
	// `next_attempt_at` are scheduling machinery, not history — and the failure
	// text is `last_error_message`, the sentence, rather than the code beside it.
	// Platform-scoped: TenantID "" is a real absence, not an oversight — neither
	// table has the column, and the non-tenant list in columns_db_test.go names
	// both so the exclusion from the tenant view is stated rather than silent.
	"affiliate_payouts":                {TenantID: "", CreatedAt: "created_at", StartedAt: "", FinishedAt: "sent_at", Error: ""},
	"campaign_template_preview_assets": {TenantID: "", CreatedAt: "created_at", StartedAt: "", FinishedAt: "ready_at", Error: "last_error"},

	"campaign_template_design_drafts": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "", FinishedAt: "", Error: "last_error_message"},

	// Retry events keep no start, no finish and no failure text — the table is a
	// queue of suggestions an operator acts on, not a run log. All three absences
	// are real, which is the only reason the column guard permits them.
	"intelligent_retry_events": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "", FinishedAt: "", Error: ""},

	"consent_sync_ledger": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "", FinishedAt: "", Error: "last_error"},

	"privacy_requests": {TenantID: "tenant_id", CreatedAt: "requested_at", StartedAt: "verified_at", FinishedAt: "completed_at", Error: "denied_reason"},

	"scheduled_report_runs": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "last_error_summary"},

	"ai_regression_runs":     {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"report_runs":            {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error"},
	"streaming_export_runs":  {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error"},
	"subscriber_imports":     {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error"},
	"tenant_exports":         {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error"},
	"audit_export_jobs":      {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at"},
	"audit_sink_replay_jobs": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "last_error"},

	// Third batch. The four remaining destination syncs share the first six's
	// shape exactly, which is why they were registered together.
	"crm_sync_runs":         {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"lead_sync_runs":        {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"loyalty_sync_runs":     {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"marketing_sync_runs":   {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error_message"},
	"predictive_model_runs": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error"},
	// finished_at + error, unlike its four neighbours above.
	"feed_source_runs": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "finished_at", Error: "error"},

	// last_error, and NO started_at: both remix families go from queued
	// straight to a completion, so the view shows no run duration for them
	// rather than inventing one.
	"content_remix_jobs":     {TenantID: "tenant_id", CreatedAt: "created_at", FinishedAt: "completed_at", Error: "last_error"},
	"content_remix_tts_jobs": {TenantID: "tenant_id", CreatedAt: "created_at", FinishedAt: "completed_at", Error: "last_error"},

	// No created_at and no error column. The scan records when it started and
	// when it stopped; a failed scan can say THAT it failed and not why, which
	// the view reports honestly rather than as an empty message.
	"crm_list_membership_scans": {TenantID: "tenant_id", StartedAt: "started_at", FinishedAt: "completed_at"},

	// The plainest shape in the registry: created/started/completed plus a
	// plain `error`. Worth stating that `error` here is `NOT NULL DEFAULT ''`
	// rather than nullable, unlike most of its neighbours — so a running job
	// scans as an empty string rather than NULL, and `Record.Error`'s
	// `omitempty` is what keeps that out of the JSON instead of the NULL check.
	"verification_jobs": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "completed_at", Error: "error"},

	// The third non-tenant-scoped family. TenantID is deliberately "" — see the
	// type doc; the aggregator skips these explicitly.
	"subscriber_email_consent_reconciliation_runs": {StartedAt: "started_at", FinishedAt: "completed_at", Error: "last_error_code"},

	// finished_at rather than completed_at.
	"agent_routine_runs":       {TenantID: "tenant_id", StartedAt: "started_at", FinishedAt: "finished_at", Error: "error"},
	"automation_backfill_jobs": {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "finished_at"},
	"flow_runs":                {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "finished_at", Error: "error"},
	"voice_ingest_jobs":        {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "finished_at", Error: "error_message"},
	"voice_sequence_jobs":      {TenantID: "tenant_id", CreatedAt: "created_at", StartedAt: "started_at", FinishedAt: "finished_at", Error: "error_message"},

	// No start time: these go from queued straight to a completion.
	"report_exports":             {TenantID: "tenant_id", CreatedAt: "created_at", Error: "error"},
	"subscriber_duplicate_scans": {TenantID: "tenant_id", CreatedAt: "created_at", FinishedAt: "completed_at"},

	// Not tenant-scoped. Registered because they ARE operations; excluded from
	// the tenant view because they belong to no tenant.
	"ops_action_runs":        {StartedAt: "started_at", FinishedAt: "finished_at"},
	"webmention_parser_runs": {StartedAt: "started_at", FinishedAt: "finished_at", Error: "last_error"},
}

// TenantFamilies are the families a tenant-scoped operations view may read.
func TenantFamilies() []Family {
	out := make([]Family, 0, len(Families))
	for _, f := range Families {
		if FamilyColumns[f.Table].TenantScoped() {
			out = append(out, f)
		}
	}
	return out
}
