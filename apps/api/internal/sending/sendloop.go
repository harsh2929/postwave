// Send-loop guard — drains pending campaign_recipients while enforcing
// per-tenant rate + quiet-hours.
//
// Why this file exists: the marketing claim is "Sandbox · Budgets ·
// Approvals". Migration 0068 added tenant_sending_settings and
// tenant_send_rate_buckets, plus the campaign_recipients send queue. The
// existing campaigns.Send handler (campaigns/send.go) hands fan-out off
// to Listmonk's /api/campaigns endpoint — which means Listmonk dispatches
// without ever consulting our per-tenant settings. Until this guard
// landed, "max_sends_per_hour" was a UI knob with no teeth.
//
// Drain algorithm:
//
//  1. SELECT … FOR UPDATE SKIP LOCKED a batch of campaign_recipients rows
//     where status='pending' AND the parent campaign is status='sending',
//     atomically claim them as status='sending', then commit before any
//     network call. SKIP LOCKED gives us single-flight per row across
//     multiple gateway instances.
//
//  2. Evaluate quiet hours per recipient (subscriber timezone with tenant
//     fallback). A blocked recipient is reverted to pending so it remains
//     eligible after the quiet window closes.
//
//  3. Rate limit (per-tenant token bucket). Denied → immediately revert
//     the denied row and the unprocessed suffix of the claimed batch to
//     pending, then bail.
//
//     IMPORTANT semantic: the rate limiter counts ATTEMPTS (tokens
//     spent), not SUCCESSFUL sends. A token is consumed BEFORE the
//     Listmonk POST so a slow Listmonk can't let a burst leak past the
//     cap; if the send then errors we do NOT refund the token. Over
//     time, persistent upstream errors will visibly reduce throughput
//     vs the configured cap. Operators reading `max_sends_per_hour`
//     as "successful sends per hour" should be aware: it's
//     "attempts per hour, including bounces and Listmonk 5xx".
//
//  4. For each allowed row: send via ListmonkSender with a 10s timeout,
//     then buffer its sent/failed result. Flush all results and deferrals
//     in one tenant-scoped transaction.
//
// Idempotency on restart: a crash after the claim commit leaves a row in
// 'sending'. RecoverStuckSends returns sufficiently old claims to pending;
// retries preserve the campaign_recipient id as the upstream idempotency
// key. Delivery is therefore at-least-once unless the upstream edge honors
// that key.

package sending

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaigntransform"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
)

// SuppressionChecker is the slim interface the send loop depends on.
// Defined here (not in suppressions/) so tests can stub the check
// without pulling the full suppressions Store + database into the
// unit-test build. Production wiring passes a *suppressions.Store
// which satisfies this method via its existing Check signature.
type SuppressionChecker interface {
	Check(ctx context.Context, tenantID, email string) (bool, *SuppressionEntry, error)
}

// SuppressionEntry is the slim view the send loop reads from a
// suppression hit. Mirrors the subset of suppressions.Entry the loop
// cares about (the Reason, used for the metric label and the row's
// error tag). A separate type avoids an import cycle and keeps the
// sending package's surface independent of the suppressions package's
// schema details.
type SuppressionEntry struct {
	Reason string
}

// RateLimiter is the per-tenant send-rate gate consulted before every
// Listmonk dispatch in the drain loop. Both the legacy
// *PostgresRateLimiter and the production *TieredRateLimiter (Redis →
// LRU → optional Postgres) satisfy it. Returning allowed=false with a
// non-zero retryAt is a soft "try later"; the loop breaks out of the
// current batch but does not surface an error.
type RateLimiter interface {
	Try(ctx context.Context, tenantID string, n int) (bool, time.Time, error)
}

// UntrackedLinkSink records an untracked-link scan of a campaign body. The
// implementation (deliverability_control.Repo) scans + persists; defining the
// interface here keeps the sending package free of a deliverability_control
// import (cycle-safe). Best-effort: the send loop logs and ignores errors.
type UntrackedLinkSink interface {
	RecordUntrackedLinks(ctx context.Context, tenantID, campaignID, html string) error
}

// Guard is the send-loop guard. RunOnce drains a single batch for one
// tenant; Loop runs RunOnce across all tenants with pending recipients
// until ctx is cancelled.
type Guard struct {
	Pool     *db.Pool
	Listmonk ListmonkSender
	// Allowance is the tenant/month hard-cap authority for Moosewave-funded
	// delivery. Production sets RequireAllowance so an unavailable authority
	// releases the claimed suffix without crossing the provider boundary.
	Allowance        sendallowance.Gate
	RequireAllowance bool
	// AssuranceBound is the raw-MIME convergence path for recipients carrying
	// migration 1923's immutable assurance binding. A bound row is never sent
	// through Listmonk: when this dependency is nil it is withheld visibly.
	AssuranceBound AssuranceBoundDispatcher
	// RequireAssuranceBinding closes the legacy unbound branch in deterministic
	// block rollout. It protects pre-rollout rows and any secondary producer of
	// campaign_recipients: an unbound row is withheld rather than silently
	// escaping to Listmonk after the queue gate became mandatory.
	RequireAssuranceBinding bool
	RateLimit               RateLimiter
	QuietHours              *QuietHoursChecker
	Controls                EmailSendControls
	// Suppressions is a required commercial-send safety dependency. It is
	// consulted after claim and immediately before any Listmonk dispatch. The
	// bulk join at queue-
	// fill time SHOULD already have filtered the same population;
	// this check catches addresses that were suppressed AFTER the
	// queue filled but BEFORE the row was claimed (e.g. a hard bounce
	// on a sister campaign that lands while this campaign's batch is
	// in flight). Missing, unavailable, timed-out, or incomplete decisions
	// withhold the affected batch and release its claims for a later retry.
	Suppressions SuppressionChecker
	// Warmup, when set, caps the drain loop's per-tick sends to the
	// tenant's current day-N warmup limit. Audit (send-loop CRITICAL #2):
	// previously EnforceCap was only called at /send dispatch time,
	// not at drain time — a 50K-recipient campaign queued on day 1
	// would burn through all rows regardless of the day-1 cap of 50,
	// blowing IP reputation for that tenant's pool. Nil-safe: tests
	// + tenants not enrolled in warmup pass nil; the guard skips.
	Warmup WarmupTracker
	// DedicatedIP, when set, is consulted per-batch to resolve the
	// Listmonk `messenger` name for the tenant's active dedicated
	// IP pool. Nil-safe: tenants without dedicated IPs (the common
	// case) pass through with empty messenger = Listmonk default.
	// Audit (send-pipeline HIGH): the dedicated-IP admin surface
	// existed end-to-end but the drain loop never consulted it, so
	// "dedicated" was decorative.
	DedicatedIP *DedicatedIPRepo
	// UntrackedLinks, when set, records a per-campaign untracked-link scan
	// the first time a campaign's body is loaded in a send run. Nil-safe and
	// best-effort: a scan failure is logged and never affects the send.
	UntrackedLinks UntrackedLinkSink
	// ListUnsubscribe, when set, mints a per-recipient unsubscribe
	// URL + mailto target and attaches RFC 2369 + RFC 8058 headers
	// on each Listmonk /api/tx call. Nil-safe: when unset the guard
	// uses the legacy SendWithRouting path with no headers.
	// Required for Gmail/Yahoo bulk-sender compliance (>=5000/day).
	ListUnsubscribe *ListUnsubscribeBuilder
	// TrackingFilter looks up per-recipient open/click
	// tracking opt-outs at send time and surfaces them as outbound
	// headers so the engine can skip pixel injection / link-rewrite
	// for that recipient. A missing filter is an unknown consent decision, so
	// delivery continues with both tracking modes disabled. The header names
	// (X-Postwave-No-Open-Track / X-Postwave-No-Click-Track) require
	// explicit support from the independently operated engine or edge
	// adapter; an unmodified upstream deployment treats them as inert
	// metadata. A metric is emitted on every opt-out
	// so the consent surface is observable independent of engine
	// support.
	TrackingFilter TrackingPrefsLookup
	// ArchiveBar, when set, renders campaign-scoped archive/view-in-
	// browser tokens before per-recipient placeholders are applied.
	// Nil-safe: tokens remain literal when the renderer is not wired.
	ArchiveBar *ArchiveBarRenderer
	// PurposeConsent, when set, gates each commercial campaign
	// recipient on a configured consent purpose before dispatch.
	// PurposeConsentKey defaults to email_marketing.
	PurposeConsent    PurposeConsentLookup
	PurposeConsentKey string

	// VERPSecret and VERPDomain are the two halves of the signed reply
	// identity described in verp.go. BOTH must be set for anything to be
	// stamped; either alone is treated as unconfigured, because a domain with
	// no secret could only produce an unsigned address. VERPSecret must be the
	// same value the inbound replies.Matcher decodes with, and VERPDomain's MX
	// must route reply+*@<domain> into the inbound reply webhook — otherwise
	// the address is well-formed, correctly signed, and points nowhere.
	VERPSecret []byte
	VERPDomain string
	// VERPBounceDomain carries the SMTP envelope sender when set (PRD F05).
	//
	// A SEPARATE field from VERPDomain rather than a reuse, because the two
	// domains answer to different DNS. VERPDomain must have MX routing
	// reply+*@<domain> into the inbound webhook; VERPBounceDomain must have an
	// SPF record authorising this sender, since SPF authenticates MAIL FROM.
	// They are often the same domain — and a deployment that has done only one of
	// the two would otherwise silently get the other wrong.
	//
	// Empty leaves the envelope carrying the RFC822 From, which is what every
	// deployment did before F05 and remains the safe default.
	VERPBounceDomain string
	// VERPReplyToPolicy defaults to VERPReplyToWhenAbsent (zero value).
	VERPReplyToPolicy VERPReplyToPolicy

	Logger *slog.Logger

	// BatchSize bounds how many recipients RunOnce drains in one tx.
	// Defaults to 50.
	BatchSize int

	// LoopInterval is how long Loop sleeps between full-platform sweeps
	// when nothing was sent. Defaults to 5s. When sends were drained,
	// the next sweep runs immediately (no delay).
	LoopInterval time.Duration

	// SendCompleteNotifier, when set, is invoked fire-and-forget after
	// a campaign transitions from 'sending' to 'sent' (i.e. the last
	// pending recipient row of the campaign was just flipped to a
	// terminal state). Nil-safe: when unset the guard simply skips
	// the transition + email path. See send_complete.go for the
	// per-recipient gated email body.
	SendCompleteNotifier *SendCompleteNotifier
}

// guardLogger returns a non-nil slog.Logger so call sites don't need to
// nil-check on every log.
func (g *Guard) guardLogger() *slog.Logger {
	if g != nil && g.Logger != nil {
		return g.Logger
	}
	return slog.Default()
}

// batchSize returns the configured batch size or the default.
func (g *Guard) batchSize() int {
	if g.BatchSize <= 0 {
		return 50
	}
	return g.BatchSize
}

// loopInterval returns the configured loop interval or the default.
func (g *Guard) loopInterval() time.Duration {
	if g.LoopInterval <= 0 {
		return 5 * time.Second
	}
	return g.LoopInterval
}

// pendingRow is the in-batch shape for a single recipient claim.
type pendingRow struct {
	id      int64  // campaign_recipients.id (bigserial)
	cid     string // campaign uuid
	email   string
	vid     string // campaign_variants.id; empty for a non-A/B recipient
	binding AssuranceBinding
	// subscriberID is subscribers.id for this recipient's address, resolved
	// per batch by loadSubscriberIDs. campaign_recipients stores only
	// subscriber_email, so this is a join, not a column.
	//
	// It is deliberately NOT interchangeable with `id` above. `id` is a
	// per-campaign bigint queue row; this is the tenant-wide uuid every reply,
	// event and engagement surface keys on. The VERP token carries THIS one —
	// see internal/replies/match.go for why the choice is forced by the
	// decoder and by campaign_replies.subscriber_id's column type.
	//
	// Empty when the address has no subscriber row (a recipient queued from a
	// raw address list). Callers must treat that as "unknown subscriber", not
	// as an error.
	subscriberID string
}

func (g *Guard) hasRunDependencies() bool {
	return g.Pool != nil && g.Listmonk != nil && g.RateLimit != nil && g.QuietHours != nil
}

// RunOnce drains up to BatchSize pending recipients for tenantID. Returns
// the number of sends ATTEMPTED (success + hard failure both count) and
// any terminal error. Quiet-hours / rate-limit blocks are NOT terminal —
// they return (0, nil) so Loop can move on.
func (g *Guard) RunOnce(ctx context.Context, tenantID string) (int, error) {
	if g == nil {
		return 0, errors.New("sendloop: nil guard")
	}
	if g.Suppressions == nil {
		observeSuppressionDecisionUnavailable("unconfigured", 1)
		return 0, ErrSuppressionGateUnavailable
	}
	if !g.hasRunDependencies() {
		return 0, errors.New("sendloop: incomplete dependencies")
	}

	// Track iteration wall-clock for the duration histogram; the
	// last_success gauge is bumped only on the non-error return paths.
	iterStart := time.Now()

	paused, err := g.emailSendingPaused(ctx, tenantID)
	if err != nil {
		return 0, err
	}
	if paused {
		observeIteration(iterStart)
		return 0, nil
	}

	// 1. Quiet-hours config load. The per-row check happens AFTER
	//    the body lookup so each row evaluates against its
	//    subscriber's TZ (or falls back to the tenant tz when the
	//    subscriber has none). Audit (send-pipeline HIGH): the
	//    prior per-tenant gate skipped the entire batch any time
	//    the tenant TZ was in quiet hours, ignoring subscribers
	//    whose local time was NOT in quiet. Now: load tenant cfg
	//    once, evaluate per-row.
	quietCfg, qerr := g.QuietHours.LoadConfig(ctx, tenantID)
	if qerr != nil {
		return 0, fmt.Errorf("sendloop: quiet-hours config load: %w", qerr)
	}

	// 2. Atomic claim: flip up to BatchSize rows pending → sending in a
	//    short-lived tx, commit immediately. Audit finding (send-loop
	//    CRITICAL #1): the prior code held a batch tx across the
	//    Listmonk POSTs and relied on Listmonk-side dedup of the
	//    Idempotency-Key header. Listmonk's open-source /api/tx
	//    doesn't actually dedupe on that header, so a worker crash
	//    between Listmonk success and the local sent-flip rolled the
	//    row back to `pending` and the next pass re-sent.
	//
	//    The new flow:
	//      a) Claim → status='sending', claimed_at=now() (this tx)
	//      b) Listmonk POST (no tx held)
	//      c) Per-row update sending → sent/failed (fresh tx)
	//    On crash between (a) and (c), the row stays in 'sending'
	//    indefinitely. RecoverStuckSends (called from the worker
	//    loop) flips stuck rows back to 'pending' after a TTL so
	//    they retry. The retry hits Listmonk with the same
	//    Idempotency-Key — best-effort dedup at the upstream edge
	//    (Cloudflare / Listmonk reverse proxy) closes the window.
	// p4c-send-loop-tx-batching: claim + body-load + subscriber-TZ
	// lookup all share ONE tx (was previously two). The body/TZ reads
	// see the row UPDATE in the same snapshot and the claim becomes
	// durable on the single commit just before the Listmonk POSTs.
	claimTx, err := db.WithTenant(ctx, g.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = claimTx.Rollback(ctx) }()

	batch, err := g.claimBatch(ctx, claimTx)
	if err != nil {
		return 0, err
	}
	if len(batch) == 0 {
		// Nothing to do — release the claim tx (no-op write).
		_ = claimTx.Commit(ctx)
		observeIteration(iterStart)
		return 0, nil
	}

	// Body lookup + subscriber TZ lookup share the SAME tx as the
	// claim. Previously these ran in a second tenant-scoped tx that
	// added 30ms+ on top of the claim — pure waste since both reads
	// are RLS-safe under the same `app.tenant_id` GUC. Once both
	// queries return we commit so the (un-rollback-able) Listmonk
	// POSTs run with no DB tx held.
	bodies, berr := g.loadCampaignBodies(ctx, claimTx, tenantID, distinctCampaigns(batch))
	if berr != nil {
		return 0, fmt.Errorf("sendloop: load bodies: %w", berr)
	}
	emailsInBatch := distinctEmails(batch)
	subscriberTZs, _ := g.loadSubscriberTZs(ctx, claimTx, emailsInBatch)
	// Resolve subscribers.id for the batch while the tenant-scoped claim tx is
	// still open. Only the VERP identity reads it today, so the lookup is
	// skipped entirely when VERP is unconfigured rather than adding a query to
	// every deployment's send path for a value nothing consumes.
	subscriberIDs := map[string]string{}
	if g.verpConfigured() {
		subscriberIDs = g.loadSubscriberIDs(ctx, claimTx, emailsInBatch)
	}
	for index := range batch {
		batch[index].subscriberID = subscriberIDs[strings.ToLower(batch[index].email)]
	}
	if err := claimTx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("sendloop: commit claim+body: %w", err)
	}

	// Record a per-campaign untracked-link scan (KLV-14). Best-effort, after
	// the claim tx is committed so it never holds a lock on the send path; the
	// sink upserts once per (tenant, campaign) so re-scanning across batches is
	// a cheap no-op. Never blocks or fails the send.
	g.recordUntrackedLinks(ctx, tenantID, bodies)

	// Resolve the required suppression boundary before warmup accounting,
	// ancillary header/consent work, or rate-limit consumption. Production
	// adapters expose the bounded batch interface. A batch error or incomplete
	// decision map is an availability problem, not evidence that recipients are
	// clear: release every claim immediately so recovery can retry it. Keeping
	// this ahead of EnforceCap also prevents an unavailable safety store from
	// consuming the tenant's daily warmup allowance for messages never sent.
	suppressionDecisions, suppressionBatchOK, suppressionErr := g.prefetchSuppressionDecisions(
		ctx, tenantID, distinctEmails(batch),
	)
	if suppressionErr != nil {
		reason := suppressionUnavailableReason(suppressionErr)
		observeSuppressionDecisionUnavailable(reason, len(batch))
		g.guardLogger().Error("send loop: suppression decision unavailable; releasing claimed batch",
			"tenant_id", tenantID, "batch_size", len(batch), "reason", reason)
		return 0, g.releaseClaimedBatch(ctx, tenantID, batch, "suppression decision", suppressionErr)
	}

	// IP/domain blocklist containment is a distinct safety boundary from
	// recipient suppressions. Load the active tenant decisions once per batch.
	// An unavailable snapshot is not evidence that the sending infrastructure
	// is clear, so release every claim and retry later.
	blocklistSnapshot, blocklistErr := g.loadBlocklistGate(ctx, tenantID)
	if blocklistErr != nil {
		g.guardLogger().Error("send loop: blocklist containment unavailable; releasing claimed batch",
			"tenant_id", tenantID, "batch_size", len(batch), "error", blocklistErr)
		return 0, g.releaseClaimedBatch(ctx, tenantID, batch, "blocklist containment", blocklistErr)
	}

	// Warmup cap: if the tenant is enrolled in warmup, EnforceCap
	// returns how many of the claimed batch are allowed today. The
	// deferred slice is rolled back to 'pending' (claimed_at=NULL)
	// so it's eligible for the next tick / tomorrow. Without this,
	// a 50K-recipient day-1 campaign sends all 50K regardless of
	// the 50/day starting cap (audit send-loop CRITICAL #2).
	if g.Warmup != nil {
		batch = g.applyWarmupCap(ctx, tenantID, batch)
		if len(batch) == 0 {
			observeIteration(iterStart)
			return 0, nil
		}
	}

	// Resolve the Listmonk messenger for this tenant's active
	// dedicated-IP pool (empty for shared-pool tenants). Audit
	// (send-pipeline HIGH): one DB lookup per batch (not per row)
	// keeps the overhead bounded; the pool assignment changes on
	// human-timescale events (drain, retire) so per-batch caching
	// is more than fresh enough.
	dedicatedMessenger := g.resolveMessenger(ctx, tenantID, blocklistSnapshot)
	// Hybrid IP routing: when the tenant has a dedicated pool, load its routing
	// policy once per batch so the per-recipient send can split dedicated/shared
	// by basis points. Nil-safe: no policy ⇒ legacy all-dedicated routing.
	var ipRoutingPolicy *routingPolicy
	if dedicatedMessenger != "" {
		ipRoutingPolicy = g.loadRoutingPolicy(ctx, tenantID)
	}

	// Batch-prefetch the three per-recipient ancillary lookups
	// (list-unsubscribe headers / tracking opt-outs / purpose
	// consent) BEFORE entering the per-row drain loop. The prior
	// shape opened a 2s-budget tenant-tx inside the loop for EACH
	// concern on EACH recipient — a 50-row batch with all three
	// surfaces wired racked up 150 sequential DB round trips before
	// the first Listmonk POST (~440ms wall in the steady state).
	//
	// Batch errors fall back to the equivalent per-row lookup. List and
	// tracking metadata remain best-effort; purpose consent is fail-closed,
	// so a per-row consent error withholds that recipient.
	//
	// All three returned maps are keyed by lower-cased email; the
	// reader normalises pr.email the same way before lookup.
	listUnsubHeaders, listUnsubBatchOK := g.prefetchListUnsubHeaders(ctx, tenantID, emailsInBatch)
	trackingOptOuts, trackingBatchOK := g.prefetchTrackingOptOuts(ctx, tenantID, emailsInBatch)
	purposeKey := strings.TrimSpace(g.PurposeConsentKey)
	if purposeKey == "" {
		purposeKey = "email_marketing"
	}
	purposeAllowed, purposeBatchOK := g.prefetchPurposeConsent(ctx, tenantID, emailsInBatch, purposeKey)

	// 4. Drain. p4c-send-loop-tx-batching: per-row outcomes are
	//    buffered into `results` (sent | failed | skipped) and
	//    `revertIDs` (back to pending) and flushed via TWO bulk
	//    statements at the end of the batch — one UPDATE that
	//    addresses every terminal-state row by id, and one UPDATE
	//    that reverts the quiet-hours/single-row deferrals. The
	//    prior shape opened a fresh tenant-scoped tx per row (50+
	//    txs per batch in steady state). On batch crash, the rows
	//    stay in 'sending' on disk; RecoverStuckSends flips them
	//    back to 'pending' after the TTL and Listmonk's
	//    Idempotency-Key collapses any duplicate.
	results := make([]recipientResult, 0, len(batch))
	revertIDs := make([]int64, 0)
	flushResults := func() error {
		if err := g.bulkApplyResults(ctx, tenantID, results, revertIDs); err != nil {
			return err
		}
		results = results[:0]
		revertIDs = revertIDs[:0]
		return nil
	}

	attempted := 0
	for i, pr := range batch {
		body, ok := bodies[campaignBodyKey(pr.cid, pr.vid)]
		if !ok {
			// Campaign disappeared between claim and body load — flip
			// the row to failed so it doesn't loop forever.
			results = append(results, recipientResult{id: pr.id, status: "failed", errMsg: "campaign body missing"})
			observeRecipient("cancelled")
			continue
		}
		if blocklistSnapshot.blocksSender(body.fromEmail) {
			results = append(results, recipientResult{
				id: pr.id, status: "skipped", errMsg: "blocklist_domain_suppression",
			})
			observeRecipientSuppressed("blocklist_domain")
			continue
		}
		// Per-subscriber quiet-hours check. If the recipient's local
		// time is inside the quiet window, revert this single row
		// back to 'pending' so the next loop tick (or post-window
		// tick) re-claims it. Other rows in the batch whose
		// subscribers are NOT in quiet hours proceed normally.
		// Audit (send-pipeline HIGH): closes the cross-timezone gap
		// where a US-Eastern-tenant's quiet hours blocked global
		// sends regardless of subscriber TZ.
		if !g.QuietHours.AllowedWithConfig(quietCfg, subscriberTZs[strings.ToLower(pr.email)], time.Now()) {
			revertIDs = append(revertIDs, pr.id)
			observeQuietHoursDeferred(tenantID)
			continue
		}
		// Suppression check — required send-time second line of defence. The
		// queue-fill path SHOULD already have filtered this address
		// out; we re-check here to catch any race where suppression
		// landed between fill and claim (e.g. hard bounce from a
		// sister campaign currently in flight). A confirmed hit is a
		// policy skip, not a delivery failure, and consumes neither a
		// rate-limit token nor an "attempted" count. An unavailable scalar
		// lookup releases the current row and unprocessed suffix immediately.
		suppressed, hit, scerr := g.resolveRecipientSuppression(ctx, tenantID, pr, suppressionDecisions, suppressionBatchOK)
		if scerr != nil {
			observeSuppressionDecisionUnavailable("recipient_error", 1)
			g.guardLogger().Error("send loop: suppression decision unavailable; withholding recipient suffix",
				"tenant_id", tenantID, "campaign_id", pr.cid,
				"remaining_in_batch", len(batch)-i, "reason", "recipient_error")
			return attempted, g.releaseSuffixAndFlush(ctx, tenantID, batch[i:], results, revertIDs,
				"suppression check", "suppression", scerr)
		}
		if suppressed {
			reason := suppressionSkipReason(hit)
			results = append(results, recipientResult{id: pr.id, status: "skipped", errMsg: "suppressed:" + reason})
			observeRecipientSuppressed(reason)
			continue
		}
		ok, _, rlErr := g.RateLimit.Try(ctx, tenantID, 1)
		if rlErr != nil {
			// No external send happened for the current row or the
			// unprocessed suffix. Persist prior outcomes and release those
			// claims before surfacing the limiter failure; otherwise a
			// routine dependency error strands the entire batch in
			// 'sending' until the stuck-claim sweep.
			return attempted, g.releaseSuffixAndFlush(ctx, tenantID, batch[i:], results, revertIDs,
				"rate limit", "rate-limit", rlErr)
		}
		if !ok {
			g.guardLogger().Info("send loop: rate limit hit, deferring batch",
				"tenant_id", tenantID, "remaining_in_batch", len(batch)-i)
			observeRateLimitDenial()
			// The claim transaction covered the entire batch. No send was
			// attempted for this row or the suffix, so release every one
			// immediately rather than making normal rate limiting look like
			// a worker crash and waiting for the stuck-claim TTL.
			for _, deferred := range batch[i:] {
				revertIDs = append(revertIDs, deferred.id)
			}
			break
		}
		// Bound provider dispatch so a stuck upstream doesn't hold the
		// worker indefinitely. Legacy Listmonk keeps its 10-second window;
		// assurance-bound raw dispatch gets 30 seconds for frozen-evidence
		// reads, deterministic compilation, ledger fencing, and transport.
		// The row is already in
		// 'sending' status on disk — if we time out / crash, the
		// recovery sweep retries it after the stuck-claim TTL.
		//
		// Idempotency-Key = the campaign_recipients.id so the retry
		// reaches Listmonk with the same key. Listmonk's open-source
		// /api/tx does NOT dedupe on it (see audit), but any reverse
		// proxy / Cloudflare / future Listmonk version that DOES
		// dedupe will collapse the retry. Worst case: one duplicate
		// per stuck-claim retry, bounded by the sweep TTL.
		//
		// Per-recipient List-Unsubscribe + List-Unsubscribe-Post
		// headers are minted here (RFC 2369 + RFC 8058). When the
		// builder is wired we also render the {{ unsubscribe_url }}
		// placeholder in the legacy body so the in-body link points at the
		// same per-recipient token. A legacy row preserves the historical
		// send-without-header behavior after a mint failure; an assurance-
		// bound row is withheld because its raw runtime requires a verified
		// RFC 8058 HTTPS one-click contract.
		headers, renderedBody, boundUnsubscribeReady := g.recipientUnsubscribeHeaders(
			ctx, tenantID, pr, body, listUnsubHeaders, listUnsubBatchOK,
		)
		headers = g.applyRecipientTrackingPrefs(ctx, tenantID, pr, headers, trackingOptOuts, trackingBatchOK)
		if g.PurposeConsent != nil {
			allowed := g.recipientPurposeAllowed(ctx, tenantID, pr, purposeAllowed, purposeBatchOK, purposeKey)
			if !allowed {
				results = append(results, recipientResult{id: pr.id, status: "skipped", errMsg: "purpose_consent_denied:" + purposeKey})
				recipientsPurposeConsentDenied.WithLabelValues(purposeKey).Inc()
				observeRecipient("skipped")
				attempted++
				continue
			}
		}
		// Per-recipient messenger: a hybrid policy splits this recipient
		// dedicated/shared; without a policy this is the tenant's dedicated
		// messenger (or "" for shared-pool tenants) — unchanged behaviour.
		messenger := routeMessenger(ipRoutingPolicy, dedicatedMessenger, pr.email)
		var allowanceReservation sendallowance.Reservation
		if g.Allowance == nil {
			if g.RequireAllowance {
				return attempted, g.releaseSuffixAndFlush(ctx, tenantID, batch[i:], results, revertIDs,
					"managed send allowance", "allowance", sendallowance.ErrUnavailable)
			}
		} else {
			allowanceReservation, err = g.Allowance.Reserve(ctx, sendallowance.Request{
				TenantID: tenantID,
				Key:      fmt.Sprintf("campaign-recipient:%d", pr.id), Source: "campaign",
				SourceRef: fmt.Sprintf("campaign_recipients:%d", pr.id), RecipientIDs: []string{pr.email},
			})
			if err != nil {
				return attempted, g.releaseSuffixAndFlush(ctx, tenantID, batch[i:], results, revertIDs,
					"managed send allowance", "allowance", err)
			}
			// Commit immediately before the provider boundary. Ambiguous
			// transport outcomes remain counted; only a proved pre-dispatch
			// deferral is released below.
			if err := g.Allowance.Commit(ctx, allowanceReservation); err != nil {
				_ = g.Allowance.Release(context.WithoutCancel(ctx), allowanceReservation, "commit_failed")
				return attempted, g.releaseSuffixAndFlush(ctx, tenantID, batch[i:], results, revertIDs,
					"managed send allowance commit", "allowance", err)
			}
		}
		dispatchTimeout := 10 * time.Second
		if pr.binding.Any() {
			// The bound path performs tenant-scoped evidence reads, one bounded
			// object-integrity read, deterministic compilation, ledger fencing,
			// and the provider call. Keep the legacy provider-only timeout intact
			// while giving the certified convergence path a bounded runtime window.
			dispatchTimeout = 30 * time.Second
		}
		sendCtx, cancel := context.WithTimeout(ctx, dispatchTimeout)
		dispatch := g.dispatchPrepared(
			sendCtx, tenantID, pr, body, renderedBody, headers, messenger,
			boundUnsubscribeReady,
		)
		cancel()
		if dispatch.revert {
			if g.Allowance != nil {
				_ = g.Allowance.Release(context.WithoutCancel(ctx), allowanceReservation, "dispatch_deferred_before_provider")
			}
			revertIDs = append(revertIDs, pr.id)
			if dispatch.err != nil {
				g.guardLogger().Warn("send loop: assurance-bound dispatch dependency unavailable",
					"tenant_id", tenantID, "campaign_id", pr.cid,
					"reason", dispatch.errMsg, "error", dispatch.err)
			}
			continue
		}
		if !dispatch.externalEffectPossible && g.Allowance != nil {
			_ = g.Allowance.Release(context.WithoutCancel(ctx), allowanceReservation, "provider_not_crossed")
		}
		if dispatch.status == RecipientFailed {
			results = append(results, recipientResult{id: pr.id, status: RecipientFailed, errMsg: dispatch.errMsg})
			g.guardLogger().Warn("send loop: provider dispatch failed closed",
				"tenant_id", tenantID, "campaign_id", pr.cid,
				"assurance_bound", pr.binding.Any(), "reason", dispatch.errMsg)
			observeRecipient("failed")
			if dispatch.attempted {
				attempted++
			}
			continue
		}
		if dispatch.status != RecipientSent {
			results = append(results, recipientResult{id: pr.id, status: RecipientFailed, errMsg: boundReasonInvalidResult})
			observeRecipient("failed")
			attempted++
			continue
		}
		results = append(results, recipientResult{id: pr.id, status: RecipientSent})
		observeRecipient("sent")
		if dispatch.attempted {
			attempted++
		}
	}

	// p4c-send-loop-tx-batching: flush every buffered per-row outcome
	// (sent / failed / skipped + quiet-hours reverts) in ONE tenant-
	// scoped tx with two bulk UPDATEs. Previously this was N tenant
	// txs (one per row).
	if err := flushResults(); err != nil {
		return attempted, err
	}

	// Post-commit: bulk-check every campaign touched by this batch to
	// see whether any just transitioned from 'sending' to 'sent' (i.e.
	// no pending rows remain). The check has to live OUTSIDE the
	// claim+result txs because RLS on campaigns is permissive only
	// for the tenant; we open a fresh tenant-scoped tx that's short-
	// lived. p4c-send-loop-tx-batching: this used to be one tx per
	// distinct campaign in the batch — now one tx serves them all.
	g.maybeTransitionCampaignsSentBulk(ctx, tenantID, distinctCampaigns(batch))

	observeIteration(iterStart)
	return attempted, nil
}

// revertClaim flips a list of claimed (status='sending') rows back
// to 'pending', clearing claimed_at. Used by the warmup-cap path
// when EnforceCap permits fewer sends than we claimed: the prefix
// gets processed normally, the suffix is reverted so the next tick
// can re-claim it (subject to the next day's cap).
func (g *Guard) revertClaim(ctx context.Context, tenantID string, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := db.WithTenant(ctx, g.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_recipients
   SET status = 'pending', claimed_at = NULL
 WHERE id = ANY($1)
   AND status = 'sending'`, ids); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// recipientResult is the buffered shape of a per-row drain outcome.
// One entry is appended to the batch-local `results` slice for every
// row that reaches a terminal status (sent / failed / skipped) inside
// RunOnce; bulkApplyResults flushes the entire slice in a single tx.
//
// p4c-send-loop-tx-batching: replaces the prior per-row tenant-tx
// (one db.WithTenant + commit per row, ~50 txs per 50-row batch)
// with a single bulk UPDATE at the end of the batch.
//
// On worker crash between the Listmonk POST and the flush, rows
// remain in 'sending' status on disk; RecoverStuckSends flips them
// back to 'pending' after the stuck-claim TTL, and the
// Idempotency-Key (= campaign_recipients.id) collapses Listmonk
// duplicates at the upstream edge. Same recovery semantic the
// per-row commit shape already relied on for rows claimed but
// never POSTed (rate-limit deferral path).
type recipientResult struct {
	id     int64
	status string // "sent" | "failed" | "skipped"
	errMsg string // empty for "sent"
}

// bulkApplyResults flushes the buffered per-row outcomes + quiet-
// hours reverts in ONE tenant-scoped tx with at most three
// statements:
//
//  1. UPDATE campaign_recipients (status, sent_at, error, claimed_at)
//     using unnest($1,$2,$3) — one round trip for every terminal
//     status in the batch, regardless of count.
//  2. UPDATE campaign_recipient_send_at SET sent_at=now() for the
//     subset of ids whose status is 'sent', via the same join the
//     per-row path used.
//  3. UPDATE campaign_recipients SET status='pending', claimed_at=NULL
//     for the quiet-hours-deferred ids.
//
// Per-row result envelope shape is preserved bit-for-bit: status,
// sent_at, claimed_at, error columns all land on the same values
// they would have under the prior setRecipientResult.
func (g *Guard) bulkApplyResults(ctx context.Context, tenantID string, results []recipientResult, revertIDs []int64) error {
	if len(results) == 0 && len(revertIDs) == 0 {
		return nil
	}
	tx, err := db.WithTenant(ctx, g.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if len(results) > 0 {
		ids := make([]int64, len(results))
		statuses := make([]string, len(results))
		errs := make([]string, len(results))
		sentIDs := make([]int64, 0, len(results))
		for i, r := range results {
			ids[i] = r.id
			statuses[i] = r.status
			errs[i] = r.errMsg
			if r.status == "sent" {
				sentIDs = append(sentIDs, r.id)
			}
		}
		// Single UPDATE that addresses every terminal row in the batch.
		// unnest() turns the three parallel arrays into a virtual table
		// joined on id. NULLIF on the error column preserves the
		// per-row contract: empty error clears the column (the 'sent'
		// path), non-empty error sets it (the 'failed' / 'skipped' path).
		if _, err := tx.Exec(ctx, `
UPDATE campaign_recipients cr
   SET status     = u.status,
       sent_at    = CASE WHEN u.status = 'sent' THEN now() ELSE cr.sent_at END,
       claimed_at = NULL,
       error      = CASE WHEN u.status = 'sent' THEN NULL ELSE NULLIF(u.errmsg,'') END
  FROM unnest($1::bigint[], $2::text[], $3::text[]) AS u(id, status, errmsg)
 WHERE cr.id = u.id`, ids, statuses, errs); err != nil {
			return fmt.Errorf("sendloop: bulk result update: %w", err)
		}
		if len(sentIDs) > 0 {
			// Mirror the sent_at bump on campaign_recipient_send_at for
			// the subset of rows that reached 'sent'. The join keys are
			// identical to the per-row path; we just feed an array.
			if _, err := tx.Exec(ctx, `
UPDATE campaign_recipient_send_at psto
   SET sent_at = now()
  FROM campaign_recipients cr
 WHERE cr.id = ANY($1::bigint[])
   AND psto.tenant_id = cr.tenant_id
   AND psto.campaign_id = cr.campaign_id
   AND lower(psto.subscriber_email::text) = lower(cr.subscriber_email::text)`, sentIDs); err != nil {
				return fmt.Errorf("sendloop: bulk send_at bump: %w", err)
			}
		}
	}

	if len(revertIDs) > 0 {
		// Quiet-hours deferrals: flip back to pending so the next tick
		// re-claims them. Same shape as revertClaim, but no separate tx.
		if _, err := tx.Exec(ctx, `
UPDATE campaign_recipients
   SET status = 'pending', claimed_at = NULL
 WHERE id = ANY($1::bigint[])
   AND status = 'sending'`, revertIDs); err != nil {
			return fmt.Errorf("sendloop: bulk revert: %w", err)
		}
	}

	return tx.Commit(ctx)
}

// RecoverStuckSends flips rows that have been stuck in 'sending'
// status for longer than stuckTTL back to 'pending'. Called by the
// loop tick (and on worker boot) to recover from crashes between
// the claim commit and the result commit.
//
// The retry hits Listmonk with the same Idempotency-Key (derived
// from campaign_recipients.id, which is preserved across the
// pending→sending→pending→sending cycle), so any dedup layer at
// the Listmonk edge collapses it. Worst case: one duplicate per
// stuck row per recovery cycle.
//
// Returns the number of rows recovered. Cross-tenant operation —
// uses app.outbox_worker GUC, same pattern as outbox/worker.go.
func (g *Guard) RecoverStuckSends(ctx context.Context, stuckTTL time.Duration) (int, error) {
	if g == nil || g.Pool == nil {
		return 0, nil
	}
	// db.Pool is a pgxpool.Pool alias; use a single short-lived tx
	// for set_config + the UPDATE so the GUC is bound to the same
	// connection that runs the recovery query.
	tx, txErr := g.Pool.Begin(ctx)
	if txErr != nil {
		return 0, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return 0, err
	}
	tag, txErr := tx.Exec(ctx, `
UPDATE campaign_recipients
   SET status     = 'pending',
       claimed_at = NULL
 WHERE status     = 'sending'
   AND claimed_at < now() - ($1::int * INTERVAL '1 second')`,
		int(stuckTTL.Seconds()))
	if txErr != nil {
		return 0, txErr
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	n := int(tag.RowsAffected())
	if n > 0 {
		g.guardLogger().Warn("send loop: recovered stuck-sending rows",
			"count", n, "stuck_ttl_seconds", int(stuckTTL.Seconds()))
	}
	return n, nil
}

func (g *Guard) maybeTransitionCampaignsSentBulk(ctx context.Context, tenantID string, campaignIDs []string) {
	if len(campaignIDs) == 0 {
		return
	}
	logger := g.guardLogger()
	tx, txErr := db.WithTenant(ctx, g.Pool, tenantID)
	if txErr != nil {
		logger.Warn("send loop: bulk transition check: open tx",
			"tenant_id", tenantID, "err", txErr)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, txErr := tx.Query(ctx, `
SELECT
  c.id::text,
  c.status,
  COALESCE(c.name,'')                              AS name,
  COALESCE(c.subject,'')                           AS subject,
  COUNT(*) FILTER (WHERE cr.status = 'pending')    AS pending_ct,
  COUNT(*) FILTER (WHERE cr.status = 'sending')    AS sending_ct,
  COUNT(*) FILTER (WHERE cr.status = 'sent')       AS sent_ct,
  COUNT(*) FILTER (WHERE cr.status = 'failed')     AS failed_ct,
  COUNT(*) FILTER (WHERE cr.status = 'skipped')    AS skipped_ct,
  COUNT(*)                                          AS total_ct
FROM   campaigns c
LEFT   JOIN campaign_recipients cr ON cr.campaign_id = c.id
WHERE  c.id = ANY($1::uuid[])
GROUP  BY c.id, c.status, c.name, c.subject`, campaignIDs)
	if txErr != nil {
		logger.Warn("send loop: bulk transition scan",
			"tenant_id", tenantID, "err", txErr)
		return
	}
	type batchEvt struct {
		cid, name, subject       string
		sent, failed, skipped, n int
	}
	var toFlip []string
	var events []batchEvt
	for rows.Next() {
		var (
			cid, st, name, subj      string
			pendingCt, sendingCt     int
			sentCt, failedCt, skipCt int
			totalCt                  int
		)
		if err := rows.Scan(&cid, &st, &name, &subj, &pendingCt, &sendingCt, &sentCt, &failedCt, &skipCt, &totalCt); err != nil {
			logger.Debug("send loop: bulk transition row scan", "err", err)
			continue
		}
		if st != "sending" {
			continue
		}
		// Only transition when there are zero pending or in-flight recipients
		// AND at least one terminal (sent/failed/skipped) row — guards
		// against flipping an empty queue to 'sent' before fan-out has
		// filled the recipients table or while another worker owns a claim.
		if pendingCt != 0 || sendingCt != 0 || (sentCt+failedCt+skipCt) == 0 {
			continue
		}
		toFlip = append(toFlip, cid)
		events = append(events, batchEvt{cid: cid, name: name, subject: subj, sent: sentCt, failed: failedCt, skipped: skipCt, n: totalCt})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		logger.Warn("send loop: bulk transition iter",
			"tenant_id", tenantID, "err", err)
		return
	}
	if len(toFlip) == 0 {
		_ = tx.Commit(ctx)
		return
	}
	// Single bulk UPDATE flips every eligible campaign at once. The
	// RETURNING id set is what we notify on, so concurrent send-loop
	// instances that already flipped a subset don't double-fire the
	// notifier.
	flippedRows, txErr := tx.Query(ctx, `
UPDATE campaigns
   SET status = 'sent',
       -- Backstop for a campaign that reached 'sending' through a path that
       -- predates the stamp: content must stay frozen once it is 'sent'.
       started_at = COALESCE(started_at, now())
 WHERE id     = ANY($1::uuid[])
   AND status = 'sending'
RETURNING id::text`, toFlip)
	if txErr != nil {
		logger.Warn("send loop: bulk transition flip",
			"tenant_id", tenantID, "err", txErr)
		return
	}
	flipped := map[string]struct{}{}
	for flippedRows.Next() {
		var cid string
		if err := flippedRows.Scan(&cid); err != nil {
			continue
		}
		flipped[cid] = struct{}{}
	}
	flippedRows.Close()
	if err := tx.Commit(ctx); err != nil {
		logger.Warn("send loop: bulk transition commit",
			"tenant_id", tenantID, "err", err)
		return
	}
	for _, e := range events {
		if _, ok := flipped[e.cid]; !ok {
			continue
		}
		logger.Info("send loop: campaign transitioned to sent",
			"tenant_id", tenantID, "campaign_id", e.cid,
			"sent", e.sent, "failed", e.failed, "skipped", e.skipped)
		if g.SendCompleteNotifier != nil {
			notifier := g.SendCompleteNotifier
			payload := SendCompleteEvent{
				TenantID:     tenantID,
				CampaignID:   e.cid,
				CampaignName: e.name,
				Subject:      e.subject,
				Recipients:   e.n,
				Sent:         e.sent,
				Bounced:      e.failed, // failed = bounced/hard-fail in our taxonomy
				Suppressed:   e.skipped,
				SentAt:       time.Now().UTC(),
			}
			go func(ev SendCompleteEvent) {
				nctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if nerr := notifier.Notify(nctx, ev); nerr != nil {
					logger.Warn("send-complete notifier failed",
						"campaign_id", ev.CampaignID, "err", nerr.Error())
				}
			}(payload)
		}
	}
}

// Loop runs RunOnce in a loop across all tenants with pending recipients.
// Returns when ctx is cancelled. A returned error means Loop hit something
// it couldn't recover from (e.g. lost connection to Postgres) — the caller
// should log and exit; main.go's wiring already runs Loop in its own
// goroutine and just logs on exit.
func (g *Guard) Loop(ctx context.Context) error {
	if g == nil {
		return errors.New("sendloop: nil guard")
	}
	logger := g.guardLogger()
	logger.Info("send loop: starting",
		"batch_size", g.batchSize(),
		"interval", g.loopInterval())
	// A tenant at its monthly cap can retain a large pending campaign until a
	// plan change or period rollover. Keep that expected hard stop from becoming
	// a hot loop while other tenants are actively draining.
	allowanceRetryAt := make(map[string]time.Time)
	for {
		if err := ctx.Err(); err != nil {
			logger.Info("send loop: context cancelled, exiting")
			return nil
		}
		tenants, err := g.tenantsWithPendingWork(ctx)
		if err != nil {
			logger.Error("send loop: tenant scan failed", "error", err)
			// Sleep on error so we don't hot-loop a bad pool.
			if !sleepCtx(ctx, g.loopInterval()) {
				return nil
			}
			continue
		}
		now := time.Now()
		for tenantID, retryAt := range allowanceRetryAt {
			if !now.Before(retryAt) {
				delete(allowanceRetryAt, tenantID)
			}
		}
		var anySent int
		for _, tid := range tenants {
			if err := ctx.Err(); err != nil {
				return nil
			}
			if retryAt, blocked := allowanceRetryAt[tid]; blocked && now.Before(retryAt) {
				continue
			}
			n, rerr := g.RunOnce(ctx, tid)
			if rerr != nil {
				if errors.Is(rerr, sendallowance.ErrExhausted) {
					allowanceRetryAt[tid] = time.Now().Add(time.Minute)
				} else if errors.Is(rerr, sendallowance.ErrUnavailable) {
					allowanceRetryAt[tid] = time.Now().Add(g.loopInterval())
				}
				logger.Error("send loop: tenant drain failed",
					"tenant_id", tid, "cause", safeSendLoopErrorClass(rerr))
				continue
			}
			delete(allowanceRetryAt, tid)
			anySent += n
		}
		if anySent == 0 {
			if !sleepCtx(ctx, g.loopInterval()) {
				return nil
			}
		}
	}
}

// RunOnce errors may wrap database detail from recipient-scoped safety reads.
// Keep the worker log useful without attaching a raw address or rejected row.
func safeSendLoopErrorClass(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "context_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case errors.Is(err, ErrSuppressionBatchIncomplete):
		return "suppression_result_incomplete"
	case errors.Is(err, ErrSuppressionGateUnavailable):
		return "suppression_gate_unavailable"
	case errors.Is(err, sendallowance.ErrExhausted):
		return "managed_send_allowance_exhausted"
	case errors.Is(err, sendallowance.ErrUnavailable):
		return "managed_send_allowance_unavailable"
	default:
		return "persistence_or_internal"
	}
}

// tenantsWithPendingWork returns the distinct tenant_ids that have at
// least one pending campaign_recipients row whose parent campaign is in
// the 'sending' state. Cross-tenant scan via the outbox-worker GUC so
// RLS doesn't filter the result down.
func (g *Guard) tenantsWithPendingWork(ctx context.Context) ([]string, error) {
	tx, txErr := g.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	const q = `
SELECT DISTINCT cr.tenant_id::text
FROM   campaign_recipients cr
JOIN   campaigns c ON c.id = cr.campaign_id
LEFT JOIN campaign_recipient_send_at psto
       ON psto.tenant_id = cr.tenant_id
      AND psto.campaign_id = cr.campaign_id
      AND lower(psto.subscriber_email::text) = lower(cr.subscriber_email::text)
WHERE  cr.status = 'pending'
  AND  c.status  = 'sending'
  AND (
    psto.scheduled_send_at IS NULL
    OR psto.scheduled_send_at <= now()
    OR (
      c.per_recipient_optimize IS TRUE
      AND c.send_window_end IS NOT NULL
      AND c.send_window_end < now() - interval '5 minutes'
    )
  )
LIMIT  500`
	rows, txErr := tx.Query(ctx, q)
	if txErr != nil {
		return nil, txErr
	}
	defer rows.Close()
	out := make([]string, 0, 16)
	for rows.Next() {
		var tid string
		if err := rows.Scan(&tid); err != nil {
			return nil, err
		}
		out = append(out, tid)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// campaignBody is the per-campaign fanout body cached for a claimed batch.
type campaignBody struct {
	subject             string
	html                string
	previewText         string
	fromName            string
	fromEmail           string
	replyTo             string
	archiveSlug         string
	archivePublic       bool
	trackingSettingsRaw []byte
	deliverySettingsRaw []byte
}

// distinctCampaigns extracts unique campaign IDs from a batch.
func distinctCampaigns(batch []pendingRow) []string {
	seen := make(map[string]struct{}, len(batch))
	out := make([]string, 0, len(batch))
	for _, pr := range batch {
		if _, ok := seen[pr.cid]; ok {
			continue
		}
		seen[pr.cid] = struct{}{}
		out = append(out, pr.cid)
	}
	return out
}

func campaignBodyKey(campaignID, variantID string) string {
	if variantID == "" {
		return campaignID
	}
	return campaignID + ":" + variantID
}

func senderHeaders(fromName, fromEmail string) map[string]string {
	fromEmail = strings.TrimSpace(fromEmail)
	if fromEmail == "" {
		return nil
	}
	return map[string]string{
		"From": (&mail.Address{Name: strings.TrimSpace(fromName), Address: fromEmail}).String(),
	}
}

func campaignHeaders(body campaignBody) map[string]string {
	headers := senderHeaders(body.fromName, body.fromEmail)
	if replyTo := strings.TrimSpace(body.replyTo); replyTo != "" {
		if parsed, err := mail.ParseAddress(replyTo); err == nil {
			if headers == nil {
				headers = map[string]string{}
			}
			headers["Reply-To"] = parsed.String()
		}
	}
	var tracking map[string]any
	if json.Unmarshal(body.trackingSettingsRaw, &tracking) == nil {
		if enabled, configured := tracking["open_tracking"].(bool); configured && !enabled {
			if headers == nil {
				headers = map[string]string{}
			}
			headers["X-Postwave-No-Open-Track"] = "1"
		}
		if enabled, configured := tracking["click_tracking"].(bool); configured && !enabled {
			if headers == nil {
				headers = map[string]string{}
			}
			headers["X-Postwave-No-Click-Track"] = "1"
		}
	}
	return headers
}

const (
	tenantAttributionHeader   = "X-Postwave-Tenant"
	campaignAttributionHeader = "X-Postwave-Campaign"
)

// withProviderAttribution server-stamps ownership after all campaign
// configuration has been read. SES can include these original outbound
// headers inside its signed SNS event body, allowing feedback attribution
// without an unsafe recipient-email lookup. Callers cannot override either
// value.
func withProviderAttribution(headers map[string]string, tenantID, campaignID string) map[string]string {
	tenantID = strings.TrimSpace(tenantID)
	campaignID = strings.TrimSpace(campaignID)
	if tenantID == "" && campaignID == "" {
		return headers
	}
	if headers == nil {
		headers = map[string]string{}
	}
	if tenantID != "" {
		headers[tenantAttributionHeader] = tenantID
	}
	if campaignID != "" {
		headers[campaignAttributionHeader] = campaignID
	}
	return headers
}

// loadCampaignBodies fetches subject + body_html for each campaign id.
// Runs INSIDE the batch tx so RLS and isolation are consistent with the
// row claim.
func (g *Guard) loadCampaignBodies(ctx context.Context, tx pgx.Tx, tenantID string, ids []string) (map[string]campaignBody, error) {
	out := make(map[string]campaignBody, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	const q = `
SELECT c.id::text,
       '',
       COALESCE(c.subject, ''),
       COALESCE(c.body_html, ''),
	   COALESCE(c.preview_text, ''),
       COALESCE(c.from_name, ''),
       COALESCE(c.delivery_settings->>'from_email', ''),
	   COALESCE(c.reply_to, ''),
       COALESCE(c.archive_slug, ''),
       COALESCE(c.archive_public, false),
	   COALESCE(c.tracking_settings, '{}'::jsonb),
       COALESCE(c.delivery_settings, '{}'::jsonb)
FROM campaigns c
WHERE c.id = ANY($1::uuid[])
UNION ALL
SELECT c.id::text,
       v.id::text,
       COALESCE(NULLIF(v.subject, ''), c.subject, ''),
       COALESCE(NULLIF(v.body_html, ''), c.body_html, ''),
	   COALESCE(c.preview_text, ''),
       COALESCE(NULLIF(v.from_name, ''), c.from_name, ''),
       COALESCE(NULLIF(v.from_email, ''), c.delivery_settings->>'from_email', ''),
	   COALESCE(c.reply_to, ''),
       COALESCE(c.archive_slug, ''),
       COALESCE(c.archive_public, false),
	   COALESCE(c.tracking_settings, '{}'::jsonb),
       COALESCE(c.delivery_settings, '{}'::jsonb)
FROM campaigns c
JOIN campaign_variants v ON v.campaign_id = c.id
WHERE c.id = ANY($1::uuid[])`
	rows, err := tx.Query(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, variantID string
		var b campaignBody
		if err := rows.Scan(&id, &variantID, &b.subject, &b.html, &b.previewText, &b.fromName, &b.fromEmail, &b.replyTo, &b.archiveSlug, &b.archivePublic, &b.trackingSettingsRaw, &b.deliverySettingsRaw); err != nil {
			return nil, err
		}
		b.html = prepareCampaignHTML(b.html, b.previewText, b.trackingSettingsRaw)
		if g.ArchiveBar != nil {
			b.html = g.ArchiveBar.RenderForCampaign(ctx, tenantID, b.html, b.archiveSlug, b.archivePublic, b.deliverySettingsRaw)
		}
		out[campaignBodyKey(id, variantID)] = b
		if variantID == "" {
			out[id] = b
		}
	}
	return out, rows.Err()
}

func prepareCampaignHTML(body, previewText string, trackingSettingsRaw []byte) string {
	return campaigntransform.ApplyHTMLLegacy(body, previewText, trackingSettingsRaw).HTML
}

// resolveMessenger picks the Listmonk `messenger` name for the
// tenant's currently-active dedicated IP pool. Returns empty when
// the tenant has no DedicatedIP repo wired OR no active assignments
// — Listmonk then routes via its default messenger (shared pool).
//
// Selection: when a tenant has multiple active assignments, we pick
// deterministically by the lowest Assignment.ID so successive
// batches consistently land on the same IP (warmup ramps depend on
// per-IP volume continuity). A future round-robin / weighted
// distribution can plug in here without changing the call site.
//
// "draining" assignments are explicitly excluded — those are IPs
// the operator is rotating off; we shouldn't keep sending on them.
// Audit (send-pipeline HIGH).
func (g *Guard) resolveMessenger(ctx context.Context, tenantID string, gate blocklistGate) string {
	if g == nil || g.DedicatedIP == nil {
		return ""
	}
	assignments, err := g.DedicatedIP.ListActiveForTenant(ctx, tenantID)
	if err != nil || len(assignments) == 0 {
		return ""
	}
	// Pick the assignment with the lexicographically smallest ID
	// for deterministic single-IP routing per tenant. A multi-IP
	// tenant gets the same IP across batches, preserving the
	// warmup ramp.
	eligible := assignments[:0]
	for _, assignment := range assignments {
		if !gate.blocksIP(assignment.IP) {
			eligible = append(eligible, assignment)
		}
	}
	if len(eligible) == 0 {
		g.guardLogger().Warn("send loop: every active dedicated IP is blocklist-contained; using shared routing",
			"tenant_id", tenantID, "excluded_assignments", len(assignments))
		return ""
	}
	if len(eligible) != len(assignments) {
		g.guardLogger().Warn("send loop: blocklist-contained dedicated IP assignments excluded",
			"tenant_id", tenantID, "excluded_assignments", len(assignments)-len(eligible))
	}
	chosen := eligible[0]
	for _, a := range eligible[1:] {
		if a.ID < chosen.ID {
			chosen = a
		}
	}
	// Convention: Listmonk's config.toml registers a messenger
	// named "dedicated-<pool>" for each pool the operator
	// provisions. If chosen.Pool is empty (legacy single-IP
	// assignments may not set it), fall back to the IP-id-based
	// name. Operators wire the messengers to match.
	if chosen.Pool != "" {
		return "dedicated-" + chosen.Pool
	}
	return "dedicated-" + chosen.ID
}

// loadSubscriberTZs fetches the timezone column for each email in
// the batch. Returns a lowercased-email-to-tz map; missing rows or
// NULL timezone produce no entry in the map (caller falls back to
// the tenant tz). Audit (send-pipeline HIGH): per-subscriber quiet
// hours.
//
// p4c-send-loop-tx-batching: this now runs INSIDE the claim tx so
// the column-missing fail-soft path must NOT poison the surrounding
// transaction (which holds the row claims). We wrap the SELECT in a
// SAVEPOINT so a "column timezone does not exist" error rolls back
// only the sub-statement, leaving the claim UPDATE durable.
func (g *Guard) loadSubscriberTZs(ctx context.Context, tx pgx.Tx, emails []string) (map[string]string, error) {
	out := map[string]string{}
	if len(emails) == 0 {
		return out, nil
	}
	// Sub-tx so a missing-column error doesn't abort the enclosing
	// claim tx. The savepoint is named to avoid collisions with any
	// future Postgres-side reserved name.
	if _, err := tx.Exec(ctx, `SAVEPOINT sp_tz_load`); err != nil {
		// If we can't even open a savepoint, the tx is already aborted
		// — return early with the empty map. Caller falls back to the
		// tenant tz.
		return out, nil //nolint:nilerr
	}
	rows, err := tx.Query(ctx, `
SELECT lower(email::text), COALESCE(timezone, '')
  FROM subscribers
 WHERE lower(email::text) = ANY($1::text[])`, lowerSlice(emails))
	if err != nil {
		// Migration 0172 may not be applied yet; in that case the
		// column doesn't exist. Roll back the savepoint so the
		// enclosing claim tx stays alive, then return the empty map.
		_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT sp_tz_load`)
		return out, nil //nolint:nilerr // see above comment
	}
	for rows.Next() {
		var em, tz string
		if err := rows.Scan(&em, &tz); err != nil {
			rows.Close()
			_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT sp_tz_load`)
			return out, nil //nolint:nilerr
		}
		if tz != "" {
			out[em] = tz
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT sp_tz_load`)
		return out, nil //nolint:nilerr
	}
	_, _ = tx.Exec(ctx, `RELEASE SAVEPOINT sp_tz_load`)
	return out, nil
}

// loadSubscriberIDs resolves subscribers.id for each email in the batch,
// returning a lowercased-email-to-uuid map. A missing row produces no entry:
// campaign_recipients can hold an address that was never a subscriber, and
// that is a legitimate send, not an error.
//
// This is a separate statement from loadSubscriberTZs rather than an extra
// column on it on purpose. That query's savepoint exists to survive a MISSING
// `timezone` column (migration 0172 may not be applied), and folding a
// required lookup into a query designed to fail soft would make an absent
// subscriber id indistinguishable from an un-migrated column.
//
// Same savepoint discipline as its neighbour: this runs inside the claim tx,
// which holds the row claims, so no failure here may abort the enclosing
// transaction. RLS scopes `subscribers` to the tenant via the claim tx's
// app.tenant_id GUC, and (tenant_id, email) is unique, so at most one row per
// address is visible.
func (g *Guard) loadSubscriberIDs(ctx context.Context, tx pgx.Tx, emails []string) map[string]string {
	out := map[string]string{}
	if len(emails) == 0 {
		return out
	}
	if _, err := tx.Exec(ctx, `SAVEPOINT sp_subscriber_id_load`); err != nil {
		return out
	}
	rows, err := tx.Query(ctx, `
SELECT lower(email::text), id::text
  FROM subscribers
 WHERE lower(email::text) = ANY($1::text[])`, lowerSlice(emails))
	if err != nil {
		_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT sp_subscriber_id_load`)
		return out
	}
	for rows.Next() {
		var email, id string
		if err := rows.Scan(&email, &id); err != nil {
			rows.Close()
			_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT sp_subscriber_id_load`)
			return map[string]string{}
		}
		if id != "" {
			out[email] = id
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT sp_subscriber_id_load`)
		return map[string]string{}
	}
	_, _ = tx.Exec(ctx, `RELEASE SAVEPOINT sp_subscriber_id_load`)
	return out
}

func lowerSlice(in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = strings.ToLower(s)
	}
	return out
}

func distinctEmails(batch []pendingRow) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(batch))
	for _, pr := range batch {
		em := strings.ToLower(pr.email)
		if _, ok := seen[em]; ok {
			continue
		}
		seen[em] = struct{}{}
		out = append(out, em)
	}
	return out
}

// sleepCtx sleeps for d but returns false if ctx was cancelled mid-sleep.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// prefetchListUnsubHeaders mints per-recipient list-unsubscribe
// headers for the whole batch in a single tenant-scoped tx via the
// builder's HeadersBatch method. Returns (map, true) on success; on
// any error returns (nil, false) so the inner loop falls back to the
// per-row Headers() path (preserving the existing fail-soft contract:
// individual mint failures shouldn't blanket-block the batch).
//
// Audit context (p4c-send-loop-batched-lookups): previously the loop
// invoked Headers() per recipient, each opening its own 2s-budget
// context + db.WithTenant tx for the INSERT and a SECOND tx for the
// mailto SELECT - ~100 tenant txs per 50-row batch. The batched mint
// runs one INSERT-per-recipient inside ONE tx and one mailto SELECT.
func (g *Guard) prefetchListUnsubHeaders(ctx context.Context, tenantID string, emails []string) (map[string]map[string]string, bool) {
	if g == nil || g.ListUnsubscribe == nil || len(emails) == 0 {
		return nil, false
	}
	hctx, hcancel := context.WithTimeout(ctx, 10*time.Second)
	defer hcancel()
	out, err := g.ListUnsubscribe.HeadersBatch(hctx, tenantID, emails)
	if err != nil {
		g.guardLogger().Warn("send loop: list-unsubscribe batch mint failed; falling back to per-row",
			"tenant_id", tenantID, "batch_size", len(emails), "error", err)
		return nil, false
	}
	return out, true
}

// prefetchTrackingOptOuts type-asserts the TrackingFilter to the
// optional batch interface and resolves all recipients' opt-outs in a
// single query. A missing batch capability falls back to per-row Lookup(). A
// batch error instead returns fail-closed entries for the whole batch: retrying
// the same unavailable store once per recipient adds load and still cannot
// establish permission to track.
func (g *Guard) prefetchTrackingOptOuts(ctx context.Context, tenantID string, emails []string) (map[string]TrackingPrefsBatchEntry, bool) {
	if g == nil || len(emails) == 0 {
		return nil, false
	}
	if g.TrackingFilter == nil {
		g.guardLogger().Warn("send loop: tracking-prefs filter is not configured; delivering batch without tracking",
			"tenant_id", tenantID, "batch_size", len(emails))
		trackingDecisionUncertain.WithLabelValues("unconfigured").Add(float64(len(emails)))
		return failClosedTrackingEntries(emails), true
	}
	bl, ok := g.TrackingFilter.(TrackingPrefsBatchLookup)
	if !ok {
		return nil, false
	}
	tctx, tcancel := context.WithTimeout(ctx, 10*time.Second)
	defer tcancel()
	out, err := bl.LookupBatch(tctx, tenantID, emails)
	if err != nil {
		g.guardLogger().Warn("send loop: tracking-prefs batch lookup failed; delivering batch without tracking",
			"tenant_id", tenantID, "batch_size", len(emails), "error", err)
		trackingDecisionUncertain.WithLabelValues("batch").Add(float64(len(emails)))
		return failClosedTrackingEntries(emails), true
	}
	if out == nil {
		out = make(map[string]TrackingPrefsBatchEntry, len(emails))
	}
	missing := 0
	for _, email := range emails {
		key := strings.ToLower(strings.TrimSpace(email))
		if _, ok := out[key]; ok {
			continue
		}
		out[key] = TrackingPrefsBatchEntry{SkipOpen: true, SkipClick: true}
		missing++
	}
	if missing > 0 {
		g.guardLogger().Warn("send loop: tracking-prefs batch response incomplete; disabling tracking for missing decisions",
			"tenant_id", tenantID, "batch_size", len(emails), "missing", missing)
		trackingDecisionUncertain.WithLabelValues("batch_missing").Add(float64(missing))
	}
	return out, true
}

func failClosedTrackingEntries(emails []string) map[string]TrackingPrefsBatchEntry {
	out := make(map[string]TrackingPrefsBatchEntry, len(emails))
	for _, email := range emails {
		out[strings.ToLower(strings.TrimSpace(email))] = TrackingPrefsBatchEntry{
			SkipOpen: true, SkipClick: true,
		}
	}
	return out
}

// prefetchPurposeConsent type-asserts the PurposeConsent gate to the
// optional batch interface and resolves all recipients' consent in a
// single query. Falls back to per-row Allowed() when the lookup does
// not implement the batch surface OR when the batch call errors.
func (g *Guard) prefetchPurposeConsent(ctx context.Context, tenantID string, emails []string, purpose string) (map[string]bool, bool) {
	if g == nil || g.PurposeConsent == nil || len(emails) == 0 || purpose == "" {
		return nil, false
	}
	bl, ok := g.PurposeConsent.(PurposeConsentBatchLookup)
	if !ok {
		return nil, false
	}
	pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
	defer pcancel()
	out, err := bl.AllowedBatch(pctx, tenantID, emails, purpose)
	if err != nil {
		g.guardLogger().Warn("send loop: purpose-consent batch lookup failed; falling back to per-row",
			"tenant_id", tenantID, "batch_size", len(emails), "purpose", purpose, "error", err)
		return nil, false
	}
	return out, true
}
