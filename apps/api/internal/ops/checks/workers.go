// SPDX-License-Identifier: AGPL-3.0-only

// workers.go -- the declared background-worker census for the API PROCESS.
//
// The API spawns every in-process background worker through safego.Go, which
// swallows panics so one broken worker cannot take the process down. That is
// correct, and it is also exactly how a worker dies in silence: no error
// surfaces, no traffic changes, and the only evidence is work that stops
// happening.
//
// safego knows what IS running. This list is what OUGHT to be running. Their
// difference is the finding, and ops.Fleet computes it.
//
// SCOPE -- READ THIS BEFORE ADDING A ROW. ops.Fleet observes the process it
// lives in and nothing else. Workers that run in their own binaries under
// cmd/ (campaign-assurance-worker, the assurance sandboxes and gateways, and
// anything else deliberately kept out of the API process -- see
// TestMainKeepsCampaignAssuranceExecutionOutOfTheAPIProcess) are INVISIBLE
// here. Declaring one would render it RED forever, and a permanently red row
// gets snoozed, and a snoozed lane stops being read. Out-of-process workers
// need their own signal: a heartbeat written to ops_check_results from that
// process, surfaced as its own KindHeartbeat check.
//
// KEEPING IT HONEST. workers_guard_test.go reads every safego.Go call site in
// apps/api (comments stripped, _test.go and the safego package excluded) and
// asserts this list matches the source exactly, in both directions: a worker
// added without a declaration fails the build, and a declaration left behind
// after a worker is deleted fails it too. Those are the two ways a census
// rots, and the guard already caught both on its first run.
package checks

import "github.com/postwave/postwave/apps/api/internal/ops"

// DeclaredWorkers is the expected in-process background fleet, each worker
// mapped to the coverage surface it serves and the role that holds it.
var DeclaredWorkers = []ops.WorkerSpec{
	{
		Name: "ab-test-scheduler", Domain: "sending", Owner: "platform",
		Why: "split-test variants stop being promoted, so every test runs forever without ever picking a winner",
	},
	{
		Name: "agent-routines-scheduler", Domain: "flows", Owner: "platform",
		Why: "scheduled agent routines stop firing and the automations customers built silently do nothing",
	},
	{
		Name: "ai-regression-scheduler", Domain: "ai", Owner: "platform",
		Why: "model-quality regressions stop being detected, so a degraded model keeps shipping recommendations",
	},
	{
		Name: "analytics_integrations.backfill_on_connect", Domain: "integrations", Owner: "platform",
		Why: "a newly connected analytics source never backfills, so its segments look empty rather than pending",
	},
	{
		Name: "apikeycalls-recorder", Domain: "security", Owner: "security",
		Why: "API key usage stops being recorded, blinding both rate accounting and the audit trail for key abuse",
	},
	{
		Name: "apikeycalls-retention-sweeper", Domain: "security", Owner: "security",
		Why: "API call records grow without bound past their retention window, which is a storage cost and a privacy exposure",
	},
	{
		Name: "approvals-escalation-sweeper", Domain: "identity", Owner: "security",
		Why: "approval requests stop escalating, so a request nobody actions blocks a customer indefinitely",
	},
	{
		Name: "approvals-expiry-sweeper", Domain: "identity", Owner: "security",
		Why: "expired approvals stay live, leaving standing permission somebody already decided should lapse",
	},
	{
		Name: "assets-references-refresher", Domain: "data-platform", Owner: "platform",
		Why: "asset reference counts go stale, so assets still in use can be reported as orphaned and reaped",
	},
	{
		Name: "audience-provider-diagnostics", Domain: "integrations", Owner: "platform",
		Why: "audience-sync failures stop being diagnosed, so a silently broken destination keeps reporting success",
	},
	{
		Name: "audience-syncs-scheduler", Domain: "integrations", Owner: "platform",
		Why: "audiences stop syncing to ad and CRM destinations, so campaigns target lists that no longer match ours",
	},
	{
		Name: "audit-alerts-worker", Domain: "security", Owner: "security",
		Why: "audit-derived alerts stop firing, removing detection for the access patterns we specifically decided to watch",
	},
	{
		Name: "audit-export-schedule-worker", Domain: "compliance", Owner: "legal",
		Why: "scheduled audit exports stop being queued, so an evidence obligation quietly lapses between reviews",
	},
	{
		Name: "audit-export-worker", Domain: "compliance", Owner: "legal",
		Why: "audit exports never complete, so the evidence a regulator or auditor asked for is not produced",
	},
	{
		Name: "audit-trimmer", Domain: "compliance", Owner: "legal",
		Why: "audit records are never trimmed to their retention window, holding attributable activity longer than policy allows",
	},
	{
		Name: "audit-ueba-worker", Domain: "security", Owner: "security",
		Why: "behavioural analytics over audit data stops, so anomalous operator or key activity goes unscored",
	},
	{
		Name: "auditsink-delivery", Domain: "compliance", Owner: "legal",
		Why: "audit events stop reaching the customer's sink, breaking a contractual delivery guarantee with no error at our end",
	},
	{
		Name: "auditsink-key-rotator", Domain: "security", Owner: "security",
		Why: "audit sink signing keys stop rotating, so a compromised key stays trusted indefinitely",
	},
	{
		Name: "auditsink-merkle", Domain: "compliance", Owner: "legal",
		Why: "the tamper-evidence chain stops advancing, so the audit log loses the property that makes it evidence",
	},
	{
		Name: "blocklist-auto-suppress", Domain: "deliverability", Owner: "platform",
		Why: "addresses on a blocklist keep being mailed, which is the fastest route to a domain-wide reputation collapse",
	},
	{
		Name: "byok-reencrypt-sweeper", Domain: "security", Owner: "security",
		Why: "customer-managed key rotation never completes, so data stays encrypted under a key the customer believes is retired",
	},
	{
		Name: "campaign-scheduler", Domain: "sending", Owner: "platform",
		Why: "scheduled campaigns never leave. The customer set a time, the time passes, and nothing errors",
	},
	{
		Name: "campaign-template-design-worker", Domain: "campaign-assurance", Owner: "platform",
		Why: "template design jobs stall, leaving customers on a spinner with no failure to report",
	},
	{
		Name: "campaign-template-preview-worker", Domain: "campaign-assurance", Owner: "platform",
		Why: "previews stop rendering, so customers approve sends they were never shown",
	},
	{
		Name: "cdc-lakehouse-consumer", Domain: "data-platform", Owner: "platform",
		Why: "change-data-capture stops, and the warehouse silently serves an ever-older copy of production",
	},
	{
		Name: "commerce-lifecycle-worker", Domain: "flows", Owner: "platform",
		Why: "back-in-stock and price-drop notifications stop firing, so the highest-intent moment in commerce passes unused",
	},
	{
		Name: "commerce.backfill_on_connect", Domain: "integrations", Owner: "platform",
		Why: "a newly connected store never backfills, so its orders and products are missing from every segment",
	},
	{
		Name: "consent-sync-sweeper", Domain: "privacy", Owner: "legal",
		Why: "consent changes stop propagating, so somebody who withdrew consent keeps receiving mail",
	},
	{
		Name: "dashboard-benchmark-aggregator", Domain: "data-platform", Owner: "platform",
		Why: "benchmark comparisons freeze at their last value and quietly become wrong rather than absent",
	},
	{
		Name: "dashboard-digest-sender", Domain: "growth", Owner: "growth",
		Why: "the customer digest stops going out, removing the main re-engagement touch with our own users",
	},
	{
		Name: "dashboard-signal-emitter", Domain: "data-platform", Owner: "platform",
		Why: "in-product signals stop being emitted, so dashboards render stale numbers with a fresh timestamp",
	},
	{
		Name: "deliverability-hub-worker", Domain: "deliverability", Owner: "platform",
		Why: "deliverability remediation stops being applied, so known-bad sending continues unchecked",
	},
	{
		Name: "digest-runner", Domain: "console", Owner: "platform",
		Why: "the daily ops digest stops arriving, removing the one routine that surfaces reds nobody was paged about",
	},
	{
		Name: "double-optin-purger", Domain: "deliverability", Owner: "platform",
		Why: "unconfirmed opt-ins are never purged, so we keep mailing addresses that never confirmed",
	},
	{
		Name: "engagement-observation-retention", Domain: "flows", Owner: "platform",
		Why: "engagement observations accumulate past retention, inflating storage and holding behavioural data too long",
	},
	{
		Name: "engagement-stage-two-evaluator", Domain: "flows", Owner: "platform",
		Why: "engagement classification stalls at stage one, so lead scoring and send-time optimisation run on partial signal",
	},
	{
		Name: "exports-worker", Domain: "data-platform", Owner: "platform",
		Why: "customer data exports never complete, which is both a product failure and, for a DSAR export, a regulatory one",
	},
	{
		Name: "feed-ingest-scheduler", Domain: "integrations", Owner: "platform",
		Why: "product feeds stop refreshing, and campaigns advertise prices and stock that are no longer true",
	},
	{
		Name: "form-upload-malware-scanner", Domain: "security", Owner: "security",
		Why: "uploaded files are never scanned, so we host and serve whatever a form submitter sent",
	},
	{
		Name: "form-upload-orphan-sweeper", Domain: "security", Owner: "security",
		Why: "orphaned uploads are never reclaimed, accumulating unreferenced customer files indefinitely",
	},
	{
		Name: "hubspot-webhook-reconcile", Domain: "integrations", Owner: "platform",
		Why: "HubSpot webhook gaps are never reconciled, so records diverge silently between the two systems",
	},
	{
		Name: "inbound-route-matches-retention", Domain: "webhooks", Owner: "platform",
		Why: "inbound routing records grow without bound past their retention window",
	},
	{
		Name: "inbound-webhook-actions", Domain: "webhooks", Owner: "platform",
		Why: "inbound webhook actions stop executing, so events we accepted have no effect and the sender sees success",
	},
	{
		Name: "inbound-webhook-secret-maintenance", Domain: "webhooks", Owner: "platform",
		Why: "webhook signing secrets stop rotating, so a leaked secret stays valid forever",
	},
	{
		Name: "inbox-reality-dispatch-worker", Domain: "inbox-placement", Owner: "platform",
		Why: "seed sends stop dispatching, so inbox-placement measurement goes dark and delivery looks fine because nothing is measuring it",
	},
	{
		Name: "integration-writeback-scheduler", Domain: "integrations", Owner: "platform",
		Why: "write-back to CRMs and stores stops being scheduled, so engagement data never reaches the systems teams actually work in",
	},
	{
		Name: "intelligent-retry-worker", Domain: "queues", Owner: "platform",
		Why: "failed work stops being retried, converting every transient error into a permanent one",
	},
	{
		Name: "ip-snapshot-worker", Domain: "deliverability", Owner: "platform",
		Why: "sending-IP reputation snapshots stop, so a degrading IP is only discovered after the damage",
	},
	{
		Name: "landing-scheduler-worker", Domain: "flows", Owner: "platform",
		Why: "scheduled landing pages never publish or unpublish, so a campaign links to a page that is not live",
	},
	{
		Name: "lead_integrations.backfill_on_connect", Domain: "integrations", Owner: "platform",
		Why: "a newly connected lead source never backfills, leaving its contacts invisible to segmentation",
	},
	{
		Name: "list-health-history", Domain: "deliverability", Owner: "platform",
		Why: "list-health history stops accruing, removing the trend that distinguishes a bad send from a decaying list",
	},
	{
		Name: "list-version-snapshot-worker", Domain: "data-platform", Owner: "platform",
		Why: "list versions stop being snapshotted, so a destructive edit becomes unrecoverable",
	},
	{
		Name: "loyalty_integrations.backfill_on_connect", Domain: "integrations", Owner: "platform",
		Why: "a newly connected loyalty program never backfills, so tier and point segments are empty rather than pending",
	},
	{
		Name: "magic-link-auto-provision", Domain: "identity", Owner: "security",
		Why: "magic-link provisioning stalls, so invited users cannot get in and the failure looks like a broken link",
	},
	{
		Name: "mobile-push-receipt-worker", Domain: "clients", Owner: "platform",
		Why: "push receipts stop being processed, so dead device tokens are retried forever and delivery stats lie",
	},
	{
		Name: "nbp-builder", Domain: "ai", Owner: "platform",
		Why: "next-best-product recommendations go stale and keep recommending what customers already bought",
	},
	{
		Name: "notification-webhook-retry", Domain: "webhooks", Owner: "platform",
		Why: "failed webhook deliveries are never retried, leaving customer systems permanently out of sync with ours",
	},
	{
		Name: "operator-notify-engine-event", Domain: "console", Owner: "platform",
		Why: "operator notifications stop being emitted for engine events, so the console loses a signal it does not itself probe for",
	},
	{
		Name: "ops-push", Domain: "console", Owner: "platform",
		Why: "ops alerts stop being pushed. Every red on this board would then reach nobody, which is the failure mode the push canary exists for",
	},
	{
		Name: "ops-reconciler", Domain: "console", Owner: "platform",
		Why: "no check is ever re-run. Every evaluated row on this board goes stale and then red -- correctly, but the board stops being able to tell you anything new",
	},
	{
		Name: "outbound-webhooks-auth-rewrap", Domain: "webhooks", Owner: "platform",
		Why: "stored webhook credentials stop being re-wrapped after a key rotation, so deliveries begin failing authentication",
	},
	{
		Name: "outbound-webhooks-destination-rewrap", Domain: "webhooks", Owner: "platform",
		Why: "destination secrets stop being re-wrapped, which breaks delivery to every affected endpoint at once",
	},
	{
		Name: "outbound-webhooks-operator-notifications", Domain: "webhooks", Owner: "platform",
		Why: "operators stop being told their webhook endpoints are failing, so a dead integration stays dead",
	},
	{
		Name: "outbound-webhooks-redaction", Domain: "webhooks", Owner: "platform",
		Why: "webhook payload redaction stops being applied, which sends unredacted customer data to third-party endpoints",
	},
	{
		Name: "outbound-webhooks-worker", Domain: "webhooks", Owner: "platform",
		Why: "outbound webhooks stop being delivered, so every customer system integrated with us silently stops receiving events",
	},
	{
		Name: "outbox-worker", Domain: "sending", Owner: "platform",
		Why: "the transactional outbox stops draining, so queued mail and events sit in the database and nothing errors",
	},
	{
		Name: "overage-reconciler", Domain: "revenue", Owner: "founder",
		Why: "metered overage stops being reconciled, so we either bill for usage that did not happen or give it away",
	},
	{
		Name: "partition-rotator", Domain: "database", Owner: "platform",
		Why: "table partitions stop rotating. New writes eventually have nowhere to land, and the failure arrives as a hard outage rather than a warning",
	},
	{
		Name: "predictive-recompute-daily", Domain: "ai", Owner: "platform",
		Why: "predictive scores stop being recomputed, so every model-driven decision runs on progressively older data",
	},
	{
		Name: "privacy-deletion-worker", Domain: "privacy", Owner: "legal",
		Why: "erasure requests are accepted and never executed. We would be telling data subjects their data is gone while still holding it",
	},
	{
		Name: "privacy-incident-clock-worker", Domain: "privacy", Owner: "legal",
		Why: "the breach-notification clock stops advancing, and that clock has a statutory deadline attached to it",
	},
	{
		Name: "privacy-overdue-worker", Domain: "privacy", Owner: "legal",
		Why: "overdue subject requests stop being flagged, so a missed statutory deadline is discovered by the regulator rather than by us",
	},
	{
		Name: "recharge-backfill-worker", Domain: "integrations", Owner: "platform",
		Why: "Recharge subscription data stops backfilling, so segments target subscription states that have since changed",
	},
	{
		Name: "referrals-congrats-sender", Domain: "growth", Owner: "growth",
		Why: "referral rewards stop being acknowledged, breaking the loop at the moment it is supposed to reinforce",
	},
	{
		Name: "referrals-verification-worker", Domain: "growth", Owner: "growth",
		Why: "referrals are never verified, so legitimate rewards never issue and fraudulent ones are never caught",
	},
	{
		Name: "replies-unmapped-metrics-ticker", Domain: "integrations", Owner: "platform",
		Why: "unmapped-reply metrics stop updating, hiding a growing pile of replies nobody is routing",
	},
	{
		Name: "reply-imap-poller", Domain: "integrations", Owner: "platform",
		Why: "inbound replies stop being collected, so customers' prospects reply into silence",
	},
	{
		Name: "reputation-alert-worker", Domain: "deliverability", Owner: "platform",
		Why: "reputation alerts stop firing, removing the earliest warning before a blocklisting",
	},
	{
		Name: "retention-sweeper", Domain: "database", Owner: "platform",
		Why: "data retention stops being enforced, so we hold personal data past the window we published and committed to",
	},
	{
		Name: "review_integrations.backfill_on_connect", Domain: "integrations", Owner: "platform",
		Why: "a newly connected review platform never backfills, so review-triggered campaigns have nothing to fire on",
	},
	{
		Name: "sandbox-flusher", Domain: "api", Owner: "platform",
		Why: "sandbox data is never flushed, so test data accumulates and eventually behaves like production data",
	},
	{
		Name: "scheduled-reports-worker", Domain: "data-platform", Owner: "platform",
		Why: "scheduled reports stop being generated, and a report that silently stops arriving is rarely chased quickly",
	},
	{
		Name: "scoring-worker", Domain: "ai", Owner: "platform",
		Why: "lead and engagement scores stop updating, so prioritisation runs on stale signal while looking current",
	},
	{
		Name: "segment-decay-worker", Domain: "flows", Owner: "platform",
		Why: "segment membership stops decaying, so people stay in audiences they no longer qualify for",
	},
	{
		Name: "segment-event-worker", Domain: "flows", Owner: "platform",
		Why: "segment membership stops reacting to events, so behavioural targeting silently freezes",
	},
	{
		Name: "segment-snapshot-worker", Domain: "flows", Owner: "platform",
		Why: "segment snapshots stop being taken, so campaign audiences are computed against stale membership",
	},
	{
		Name: "self-account-deletion-worker", Domain: "privacy", Owner: "legal",
		Why: "self-service account deletions never complete, leaving data we told the user was deleted",
	},
	{
		Name: "send-guard-loop", Domain: "sending", Owner: "platform",
		Why: "the send guard stops evaluating, which either halts sending or -- worse -- stops enforcing the limits that protect reputation",
	},
	{
		Name: "send-guard-stuck-recovery", Domain: "sending", Owner: "platform",
		Why: "sends stuck mid-flight are never recovered, so a crashed sender leaves recipients permanently in limbo",
	},
	{
		Name: "sending-deprovision-worker", Domain: "sending", Owner: "platform",
		Why: "deprovisioned sending identities stay active, so a tenant that should have stopped sending keeps sending",
	},
	{
		Name: "signin-alert", Domain: "identity", Owner: "security",
		Why: "sign-in alerts stop being sent, so account takeover loses its most direct detection path",
	},
	{
		Name: "smile-backfill-worker", Domain: "integrations", Owner: "platform",
		Why: "Smile loyalty data stops backfilling, so loyalty-based segments target stale point balances",
	},
	{
		Name: "sms-worker", Domain: "sending", Owner: "platform",
		Why: "queued SMS is never delivered, and unlike email nothing bounces to tell us",
	},
	{
		Name: "smtp-relay", Domain: "sending", Owner: "platform",
		Why: "the SMTP relay stops accepting or forwarding, breaking every customer sending through it",
	},
	{
		Name: "spam-trap-guard-worker", Domain: "deliverability", Owner: "platform",
		Why: "spam traps stop being screened out, and a single trap hit can blocklist the whole sending domain",
	},
	{
		Name: "status-poller", Domain: "trust", Owner: "platform",
		Why: "the status page stops reflecting reality, so during an incident we compound an outage with a credibility loss",
	},
	{
		Name: "sto-compute-backfill", Domain: "ai", Owner: "platform",
		Why: "send-time optimisation backfill stalls, so new subscribers never get a computed best hour",
	},
	{
		Name: "sto-compute-worker", Domain: "ai", Owner: "platform",
		Why: "send-time optimisation stops recomputing, so sends go out at times derived from months-old behaviour",
	},
	{
		Name: "sto-content-optimizer-trainer", Domain: "ai", Owner: "platform",
		Why: "the content bandit stops training, freezing exploration and locking in whichever variant happened to be ahead",
	},
	{
		Name: "sto-predictive-clv-worker", Domain: "ai", Owner: "platform",
		Why: "predicted lifetime value stops updating, so value-based segments drift from reality",
	},
	{
		Name: "sto-segment-materializer", Domain: "flows", Owner: "platform",
		Why: "optimisation segments stop materialising, so campaigns fall back to unoptimised audiences without saying so",
	},
	{
		Name: "streaming-export-worker", Domain: "data-platform", Owner: "platform",
		Why: "streaming exports stall, and the customer's warehouse quietly stops receiving new rows",
	},
	{
		Name: "subscriber-churn-scorer", Domain: "growth", Owner: "growth",
		Why: "churn scores freeze, so retention campaigns target a risk profile that is months out of date",
	},
	{
		Name: "subscriber-growth-snapshot-worker", Domain: "growth", Owner: "growth",
		Why: "growth snapshots stop, removing the series every growth decision is read from",
	},
	{
		Name: "subscriber-import-worker", Domain: "growth", Owner: "growth",
		Why: "subscriber imports never finish, so a customer's onboarding stalls at the step that decides whether they stay",
	},
	{
		Name: "subscriber-pii-coverage-worker", Domain: "privacy", Owner: "legal",
		Why: "PII coverage analysis stops, so we lose the map of where subject data actually lives before a DSAR needs it",
	},
	{
		Name: "subscription_integrations.backfill_on_connect", Domain: "integrations", Owner: "platform",
		Why: "a newly connected subscription platform never backfills, so lifecycle segments are wrong from day one",
	},
	{
		Name: "support_integrations.backfill_on_connect", Domain: "support", Owner: "support",
		Why: "a newly connected support tool never backfills, so support context is missing from the customer record",
	},
	{
		Name: "transactional-schedule-worker", Domain: "sending", Owner: "platform",
		Why: "scheduled transactional sends never fire, and transactional mail is the kind customers notice within minutes",
	},
	{
		Name: "trust-ops-health-aggregator", Domain: "trust", Owner: "platform",
		Why: "service health stops being aggregated, so the public status page shows the last thing it saw rather than what is true",
	},
	{
		Name: "trust-ops-stripe-retry-worker", Domain: "billing", Owner: "founder",
		Why: "failed Stripe operations stop being retried, so a customer paid and never got what they paid for",
	},
	{
		Name: "verification-cache-purge", Domain: "queues", Owner: "platform",
		Why: "the verification cache never expires, so stale verification verdicts are served indefinitely",
	},
	{
		Name: "verification-job-runner", Domain: "queues", Owner: "platform",
		Why: "email verification jobs never run, so imported lists are mailed unverified",
	},
	{
		Name: "web-push-retry", Domain: "webhooks", Owner: "platform",
		Why: "failed web-push deliveries are never retried, so browser notifications are silently dropped",
	},
	{
		Name: "webhook-alert-sender", Domain: "webhooks", Owner: "platform",
		Why: "webhook failure alerts stop reaching customers, so their broken integration stays broken without them knowing",
	},
	{
		Name: "webmention-parser-worker", Domain: "webhooks", Owner: "platform",
		Why: "webmentions stop being parsed, so inbound mentions never register",
	},
	{
		Name: "yotpo-backfill-worker", Domain: "integrations", Owner: "platform",
		Why: "Yotpo review data stops backfilling, so review-triggered campaigns fire on stale review state",
	},
}
