// SPDX-License-Identifier: AGPL-3.0-only

// Send-loop guard — per-batch and per-recipient helpers behind RunOnce.
//
// RunOnce reads top-to-bottom as the pipeline it is (pause check → claim →
// gates → warmup → prefetch → drain → flush); the bodies of its stages live
// here so each can be read, tested and reasoned about on its own. Nothing in
// this file changes the order, texts or outcomes RunOnce has always produced.

package sending

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// emailSendingPaused consults the tenant email kill switch. It reports
// paused=true (after logging the reason) when the tenant is paused, and
// false without any lookup when no controls are wired.
func (g *Guard) emailSendingPaused(ctx context.Context, tenantID string) (bool, error) {
	if g.Controls == nil {
		return false, nil
	}
	paused, reason, err := g.Controls.EmailSendingPaused(ctx, tenantID)
	if err != nil {
		return false, fmt.Errorf("sendloop: email control check: %w", err)
	}
	if !paused {
		return false, nil
	}
	if reason == "" {
		reason = "tenant kill switch active"
	}
	g.guardLogger().Info("send loop: tenant email sending paused",
		"tenant_id", tenantID, "reason", reason)
	return true, nil
}

// claimBatch atomically flips up to BatchSize pending rows to 'sending' inside
// claimTx and scans them into the in-batch shape. The tx is the caller's: the
// claim becomes durable on the caller's single commit just before the provider
// POSTs (see the RunOnce commentary on p4c-send-loop-tx-batching).
func (g *Guard) claimBatch(ctx context.Context, claimTx pgx.Tx) ([]pendingRow, error) {
	const claim = `
WITH candidates AS (
  SELECT cr.id
    FROM campaign_recipients cr
    JOIN campaigns c ON c.id = cr.campaign_id
    LEFT JOIN campaign_recipient_send_at psto
      ON psto.tenant_id = cr.tenant_id
     AND psto.campaign_id = cr.campaign_id
     AND lower(psto.subscriber_email::text) = lower(cr.subscriber_email::text)
   WHERE cr.status = 'pending'
     AND c.status  = 'sending'
     AND (
       psto.scheduled_send_at IS NULL
       OR psto.scheduled_send_at <= now()
       OR (
         c.per_recipient_optimize IS TRUE
         AND c.send_window_end IS NOT NULL
         AND c.send_window_end < now() - interval '5 minutes'
       )
     )
   ORDER BY psto.scheduled_send_at NULLS FIRST, cr.id
   FOR UPDATE OF cr SKIP LOCKED
   LIMIT $1
)
UPDATE campaign_recipients cr
   SET status     = 'sending',
       claimed_at = now()
  FROM candidates
 WHERE cr.id = candidates.id
RETURNING cr.id, cr.campaign_id::text, cr.subscriber_email::text,
	      COALESCE(cr.variant_id::text, ''),
	      COALESCE(cr.content_revision_id::text, ''),
	      COALESCE(cr.send_plan_id::text, ''),
	      COALESCE(cr.assurance_run_id::text, ''),
	      COALESCE(cr.assurance_attempt_count, 0),
	      COALESCE(cr.assurance_artifact_set_hash, ''),
	      COALESCE(cr.assurance_source_hash, ''),
	      COALESCE(cr.assurance_plan_hash, ''),
	      COALESCE(cr.assurance_gate_decision, ''),
	      COALESCE(cr.assurance_override_ids::text[], ARRAY[]::text[]),
	      cr.assurance_bound_at`
	rows, err := claimTx.Query(ctx, claim, g.batchSize())
	if err != nil {
		return nil, fmt.Errorf("sendloop: claim batch: %w", err)
	}
	batch := make([]pendingRow, 0, g.batchSize())
	for rows.Next() {
		var pr pendingRow
		if err := rows.Scan(
			&pr.id, &pr.cid, &pr.email, &pr.vid,
			&pr.binding.ContentRevisionID, &pr.binding.SendPlanID,
			&pr.binding.RunID, &pr.binding.RunAttempt,
			&pr.binding.ArtifactSetHash, &pr.binding.SourceHash,
			&pr.binding.PlanHash, &pr.binding.GateDecision,
			&pr.binding.OverrideIDs, &pr.binding.BoundAt,
		); err != nil {
			rows.Close()
			return nil, fmt.Errorf("sendloop: scan row: %w", err)
		}
		batch = append(batch, pr)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sendloop: rows err: %w", err)
	}
	return batch, nil
}

// recordUntrackedLinks records a per-campaign untracked-link scan (KLV-14).
// Best-effort, after the claim tx is committed so it never holds a lock on the
// send path; the sink upserts once per (tenant, campaign) so re-scanning across
// batches is a cheap no-op. Never blocks or fails the send.
func (g *Guard) recordUntrackedLinks(ctx context.Context, tenantID string, bodies map[string]campaignBody) {
	if g.UntrackedLinks == nil {
		return
	}
	for cid, body := range bodies {
		if err := g.UntrackedLinks.RecordUntrackedLinks(ctx, tenantID, cid, body.html); err != nil {
			g.guardLogger().Warn("sendloop: untracked-link scan failed",
				"tenant_id", tenantID, "campaign_id", cid, "error", err.Error())
		}
	}
}

// suppressionUnavailableReason maps a batch suppression-gate failure to the
// metric label RunOnce records before releasing the batch.
func suppressionUnavailableReason(err error) string {
	if errors.Is(err, ErrSuppressionGateUnavailable) {
		return "unconfigured"
	}
	if errors.Is(err, ErrSuppressionBatchIncomplete) {
		return "batch_incomplete"
	}
	return "batch_error"
}

// releaseClaimedBatch reverts every claimed row in batch to 'pending' after a
// batch-level safety gate (suppression decisions, blocklist containment)
// could not be evaluated, and returns the gate failure wrapped under label —
// joined with the revert failure when the release itself fails.
func (g *Guard) releaseClaimedBatch(ctx context.Context, tenantID string, batch []pendingRow, label string, cause error) error {
	ids := make([]int64, 0, len(batch))
	for _, claimed := range batch {
		ids = append(ids, claimed.id)
	}
	wrapped := fmt.Errorf("sendloop: %s: %w", label, cause)
	if revertErr := g.revertClaim(ctx, tenantID, ids); revertErr != nil {
		return errors.Join(
			wrapped,
			fmt.Errorf("sendloop: release after %s failure: %w", label, revertErr),
		)
	}
	return wrapped
}

// applyWarmupCap trims batch to today's warmup allowance. EnforceCap returns
// how many of the claimed rows are allowed today; the deferred suffix is
// rolled back to 'pending' (claimed_at=NULL) so it's eligible for the next
// tick / tomorrow. Without this, a 50K-recipient day-1 campaign sends all 50K
// regardless of the 50/day starting cap (audit send-loop CRITICAL #2). An
// EnforceCap failure is logged and defaults to no cap.
func (g *Guard) applyWarmupCap(ctx context.Context, tenantID string, batch []pendingRow) []pendingRow {
	allowed, deferred, werr := EnforceCap(ctx, g.Warmup, tenantID, len(batch), time.Now())
	if werr != nil {
		g.guardLogger().Warn("send loop: warmup EnforceCap failed; defaulting to no cap",
			"tenant_id", tenantID, "error", werr)
		return batch
	}
	if deferred <= 0 {
		return batch
	}
	// Take only the prefix of `allowed` rows from batch.
	deferIDs := make([]int64, 0, deferred)
	for i := allowed; i < len(batch); i++ {
		deferIDs = append(deferIDs, batch[i].id)
	}
	if uerr := g.revertClaim(ctx, tenantID, deferIDs); uerr != nil {
		g.guardLogger().Warn("send loop: warmup revert failed",
			"tenant_id", tenantID, "deferred", deferred, "error", uerr)
	}
	observeWarmupDeferred(tenantID, deferred)
	return batch[:allowed]
}

// resolveRecipientSuppression is the send-time second line of defence for one
// recipient. It starts from the batch decision when the batch surface answered,
// then revalidates every batch-clear address with the scalar lookup at the last
// safe boundary before a rate token is consumed: a batch snapshot can become
// stale while earlier recipients make network calls. Confirmed batch hits need
// no second read. This intentionally keeps the scalar query for clear
// recipients — removing it would reopen the queue-to-send race the guard exists
// to close, especially for the tail of a slow 50-row batch.
func (g *Guard) resolveRecipientSuppression(
	ctx context.Context,
	tenantID string,
	pr pendingRow,
	decisions map[string]SuppressionDecision,
	batchOK bool,
) (bool, *SuppressionEntry, error) {
	var suppressed bool
	var hit *SuppressionEntry
	if batchOK {
		decision := decisions[normalizeSuppressionEmail(pr.email)]
		suppressed, hit = decision.Suppressed, decision.Entry
	}
	if !batchOK || !suppressed {
		sctx, scancel := context.WithTimeout(ctx, 2*time.Second)
		var scerr error
		suppressed, hit, scerr = lookupSuppression(sctx, g.Suppressions, tenantID, pr.email)
		scancel()
		if scerr != nil {
			return false, nil, scerr
		}
	}
	return suppressed, hit, nil
}

// suppressionSkipReason is the reason label recorded on a suppressed
// recipient's skip row and metric.
func suppressionSkipReason(hit *SuppressionEntry) string {
	if hit != nil && strings.TrimSpace(hit.Reason) != "" {
		return hit.Reason
	}
	return "unknown"
}

// releaseSuffixAndFlush persists the buffered per-row outcomes and releases
// the unprocessed suffix of the batch (the current row included) back to
// 'pending' in one bulk flush, then returns cause wrapped under label. No
// external send happened for any row in suffix; surfacing the dependency
// failure without this flush would strand the batch in 'sending' until the
// stuck-claim sweep. A flush failure is joined to the cause under flushLabel.
func (g *Guard) releaseSuffixAndFlush(
	ctx context.Context,
	tenantID string,
	suffix []pendingRow,
	results []recipientResult,
	revertIDs []int64,
	label, flushLabel string,
	cause error,
) error {
	for _, deferred := range suffix {
		revertIDs = append(revertIDs, deferred.id)
	}
	wrapped := fmt.Errorf("sendloop: %s: %w", label, cause)
	if flushErr := g.bulkApplyResults(ctx, tenantID, results, revertIDs); flushErr != nil {
		return errors.Join(
			wrapped,
			fmt.Errorf("sendloop: flush after %s error: %w", flushLabel, flushErr),
		)
	}
	return wrapped
}

// recipientUnsubscribeHeaders mints the per-recipient List-Unsubscribe +
// List-Unsubscribe-Post headers (RFC 2369 + RFC 8058) on top of the campaign
// headers and renders the {{ unsubscribe_url }} placeholder in the legacy body
// so the in-body link points at the same per-recipient token. It reports
// whether an assurance-bound row may dispatch: a legacy row preserves the
// historical send-without-header behavior after a mint failure, while a bound
// row is withheld because its raw runtime requires a verified RFC 8058 HTTPS
// one-click contract.
func (g *Guard) recipientUnsubscribeHeaders(
	ctx context.Context,
	tenantID string,
	pr pendingRow,
	body campaignBody,
	listUnsubHeaders map[string]map[string]string,
	listUnsubBatchOK bool,
) (headers map[string]string, renderedBody string, boundUnsubscribeReady bool) {
	headers = withProviderAttribution(campaignHeaders(body), tenantID, pr.cid)
	renderedBody = body.html
	boundUnsubscribeReady = g.ListUnsubscribe != nil
	emKey := strings.ToLower(pr.email)
	if g.ListUnsubscribe != nil {
		var h map[string]string
		if listUnsubBatchOK {
			// Prefetched in one batched tx above; map lookup is
			// O(1). A missing key means the email was empty or
			// the builder is misconfigured (PublicBaseURL empty),
			// matching the (nil, nil) shape of the per-row path.
			h = listUnsubHeaders[emKey]
		} else {
			hctx, hcancel := context.WithTimeout(ctx, 2*time.Second)
			hh, herr := g.ListUnsubscribe.Headers(hctx, tenantID, pr.email)
			hcancel()
			if herr != nil {
				boundUnsubscribeReady = false
				g.guardLogger().Warn("send loop: list-unsubscribe header mint failed; sending without",
					"tenant_id", tenantID, "campaign_id", pr.cid, "error", herr)
			}
			h = hh
		}
		if h == nil {
			boundUnsubscribeReady = false
		}
		if h != nil {
			for key, value := range h {
				if headers == nil {
					headers = map[string]string{}
				}
				headers[key] = value
			}
			// Best-effort: extract the https URL from the
			// "List-Unsubscribe" value (which has the form
			// "<url>, <mailto:...>"); fall back to a fresh
			// mint if we couldn't.
			if rendered, ok := extractFirstURL(h["List-Unsubscribe"]); ok {
				renderedBody = RenderUnsubscribePlaceholder(
					body.html,
					preferenceCenterURL(rendered),
				)
			}
		}
	}
	return headers, renderedBody, boundUnsubscribeReady
}

// applyRecipientTrackingPrefs resolves one recipient's open/click tracking
// opt-outs and stamps them as outbound headers. A consent-store hiccup must
// never block delivery, but uncertainty must not enable surveillance: both
// open and click tracking are suppressed on lookup failure, on a missing batch
// entry, and when no filter is wired.
func (g *Guard) applyRecipientTrackingPrefs(
	ctx context.Context,
	tenantID string,
	pr pendingRow,
	headers map[string]string,
	trackingOptOuts map[string]TrackingPrefsBatchEntry,
	trackingBatchOK bool,
) map[string]string {
	emKey := strings.ToLower(pr.email)
	var skipOpen, skipClick bool
	if trackingBatchOK {
		entry, ok := trackingOptOuts[emKey]
		if !ok {
			// A successful-but-incomplete batch response is still an
			// unknown decision. Never interpret a missing key as consent.
			skipOpen, skipClick = true, true
			trackingDecisionUncertain.WithLabelValues("batch_missing").Inc()
		} else {
			skipOpen = entry.SkipOpen
			skipClick = entry.SkipClick
		}
	} else if g.TrackingFilter != nil {
		tctx, tcancel := context.WithTimeout(ctx, 2*time.Second)
		so, sc, terr := g.TrackingFilter.Lookup(tctx, tenantID, pr.email)
		tcancel()
		if terr != nil {
			g.guardLogger().Warn("send loop: tracking-prefs lookup failed; delivering without tracking",
				"tenant_id", tenantID, "campaign_id", pr.cid, "error", terr)
			skipOpen, skipClick = true, true
			trackingDecisionUncertain.WithLabelValues("recipient").Inc()
		} else {
			skipOpen, skipClick = so, sc
		}
	} else {
		skipOpen, skipClick = true, true
		trackingDecisionUncertain.WithLabelValues("unconfigured").Inc()
	}
	if skipOpen || skipClick {
		headers = applyTrackingPrefsHeaders(headers, skipOpen, skipClick)
	}
	return headers
}

// recipientPurposeAllowed gates one recipient on the configured consent
// purpose. The batch map defaults to "not consented" when the email is absent
// — mirroring the per-row Allowed shape where IsConsentedForPurpose returns
// false for missing subscriber rows (NULL → false); the batch reader only
// populates entries for rows that exist. A per-row lookup failure withholds
// the recipient fail-closed.
func (g *Guard) recipientPurposeAllowed(
	ctx context.Context,
	tenantID string,
	pr pendingRow,
	purposeAllowed map[string]bool,
	purposeBatchOK bool,
	purposeKey string,
) bool {
	if purposeBatchOK {
		return purposeAllowed[strings.ToLower(pr.email)]
	}
	pctx, pcancel := context.WithTimeout(ctx, 2*time.Second)
	a, perr := lookupPurposeConsent(pctx, g.PurposeConsent, tenantID, pr.email, purposeKey)
	pcancel()
	if perr != nil {
		g.guardLogger().Warn("send loop: purpose consent lookup failed; withholding fail-closed",
			"tenant_id", tenantID, "campaign_id", pr.cid, "purpose", purposeKey, "error", perr)
		return false
	}
	return a
}
