// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/replies"
)

const (
	// recipientHealthNegativeWindow matches the email-health model's
	// recoverable hard/soft-bounce freshness. Complaints and terminal provider
	// verdicts are intentionally not subject to this window.
	recipientHealthNegativeWindow  = 30 * 24 * time.Hour
	recipientHealthPositiveWindow  = 90 * 24 * time.Hour
	recipientHealthFutureTolerance = 5 * time.Minute
	// Mirrors verification.VerificationEvidenceRetention without introducing a
	// sending -> verification package dependency. Read-time enforcement keeps a
	// janitor backlog from extending address-level verification retention.
	recipientHealthEvidenceRetention  = 365 * 24 * time.Hour
	recipientHealthProviderZeroBounce = "zerobounce"
	recipientHealthProviderKickbox    = "kickbox"
)

var ErrRecipientHealthGateUnavailable = fmt.Errorf("%w: recipient health unavailable", ErrSuppressionGateUnavailable)

// recipientHealthDecision is deliberately smaller than verification.EmailHealth.
// The send loop needs one question answered: is this address unsafe right now?
// Keeping the adapter local avoids a sending -> verification dependency and makes
// the provider-independent dispatch boundary straightforward to test.
type recipientHealthDecision struct {
	Blocked bool
	// Reason is a closed, non-PII code used by health-specific metrics.
	Reason string
	// SuppressionReason maps the decision onto the send loop's existing bounded
	// suppression taxonomy, preserving dashboard and queue-state compatibility.
	SuppressionReason string
}

// recipientHealthLookup returns a total map keyed by normalized email. Missing
// keys are an unavailable safety decision, never proof that an address is clear.
type recipientHealthLookup interface {
	Lookup(ctx context.Context, tenantID string, emails []string) (map[string]recipientHealthDecision, error)
}

// RecipientSafetyGate composes canonical consent/suppression enforcement with
// recipient verification health. The base suppression checker always runs first
// and remains authoritative. Health can only add a block; it can never turn an
// existing suppression into an eligible recipient.
//
// Production wiring installs this object as Guard.Suppressions. Consequently,
// the existing batch preflight and the scalar last-moment race check both cover
// terminal verification verdicts and recent negative health evidence.
type RecipientSafetyGate struct {
	Suppressions SuppressionChecker
	health       recipientHealthLookup
}

// NewRecipientSafetyGate wraps the production suppression converger with a
// tenant-RLS-scoped Postgres health lookup.
func NewRecipientSafetyGate(pool *db.Pool, suppressions SuppressionChecker) *RecipientSafetyGate {
	return &RecipientSafetyGate{
		Suppressions: suppressions,
		health: &postgresRecipientHealthLookup{
			Pool:           pool,
			NegativeWindow: recipientHealthNegativeWindow,
		},
	}
}

// RecipientSafetyGateForRollout returns the additive health wrapper when
// enabled and the exact canonical suppression checker when disabled. Keeping
// this choice in the sending package makes the emergency switch testable while
// guaranteeing it cannot bypass consent/unsubscribe enforcement.
func RecipientSafetyGateForRollout(pool *db.Pool, suppressions SuppressionChecker, enabled bool) SuppressionChecker {
	if !enabled {
		return suppressions
	}
	return NewRecipientSafetyGate(pool, suppressions)
}

// Check implements SuppressionChecker. It intentionally performs a fresh
// scalar health read after the canonical scalar suppression read, at the same
// last safe boundary immediately before rate-limit consumption and dispatch.
func (g *RecipientSafetyGate) Check(ctx context.Context, tenantID, email string) (bool, *SuppressionEntry, error) {
	if g == nil || g.Suppressions == nil || g.health == nil {
		return false, nil, ErrRecipientHealthGateUnavailable
	}
	suppressed, entry, err := g.Suppressions.Check(ctx, tenantID, email)
	if err != nil || suppressed {
		return suppressed, entry, err
	}
	key := normalizeSuppressionEmail(email)
	if key == "" {
		return false, nil, nil
	}
	decisions, err := g.health.Lookup(ctx, tenantID, []string{key})
	if err != nil {
		observeRecipientHealthGate("error")
		return false, nil, fmt.Errorf("recipient health lookup: %w", err)
	}
	decision, ok := decisions[key]
	if !ok {
		observeRecipientHealthGate("incomplete")
		return false, nil, fmt.Errorf("%w: recipient health omitted requested address", ErrSuppressionBatchIncomplete)
	}
	if !decision.Blocked {
		return false, nil, nil
	}
	observeRecipientHealthGate(decision.Reason)
	return true, &SuppressionEntry{Reason: decision.SuppressionReason}, nil
}

// CheckBatch implements SuppressionBatchChecker. Production's converger takes
// the fast batch branch; a scalar fallback retains correctness for narrower
// deployments without silently skipping canonical suppression enforcement.
func (g *RecipientSafetyGate) CheckBatch(ctx context.Context, tenantID string, emails []string) (map[string]SuppressionDecision, error) {
	if g == nil || g.Suppressions == nil || g.health == nil {
		return nil, ErrRecipientHealthGateUnavailable
	}
	normalized := normalizeSuppressionEmails(emails)
	out := make(map[string]SuppressionDecision, len(normalized))
	if len(normalized) == 0 {
		return out, nil
	}

	if batch, ok := g.Suppressions.(SuppressionBatchChecker); ok {
		decisions, err := batch.CheckBatch(ctx, tenantID, normalized)
		if err != nil {
			return nil, err
		}
		for _, email := range normalized {
			decision, present := decisions[email]
			if !present {
				return nil, fmt.Errorf("%w: canonical suppression omitted requested address", ErrSuppressionBatchIncomplete)
			}
			out[email] = decision
		}
	} else {
		for _, email := range normalized {
			suppressed, entry, err := g.Suppressions.Check(ctx, tenantID, email)
			if err != nil {
				return nil, err
			}
			out[email] = SuppressionDecision{Suppressed: suppressed, Entry: entry}
		}
	}

	clear := make([]string, 0, len(normalized))
	for _, email := range normalized {
		if !out[email].Suppressed {
			clear = append(clear, email)
		}
	}
	if len(clear) == 0 {
		return out, nil
	}

	health, err := g.health.Lookup(ctx, tenantID, clear)
	if err != nil {
		observeRecipientHealthGate("error")
		return nil, fmt.Errorf("recipient health batch lookup: %w", err)
	}
	for _, email := range clear {
		decision, present := health[email]
		if !present {
			observeRecipientHealthGate("incomplete")
			return nil, fmt.Errorf("%w: recipient health omitted requested address", ErrSuppressionBatchIncomplete)
		}
		if !decision.Blocked {
			continue
		}
		observeRecipientHealthGate(decision.Reason)
		out[email] = SuppressionDecision{
			Suppressed: true,
			Entry:      &SuppressionEntry{Reason: decision.SuppressionReason},
		}
	}
	return out, nil
}

type postgresRecipientHealthLookup struct {
	Pool           *db.Pool
	NegativeWindow time.Duration
	Now            func() time.Time
}

type healthSnapshotEvidence struct {
	Kind string    `json:"kind"`
	At   time.Time `json:"at"`
}

func (p *postgresRecipientHealthLookup) now() time.Time {
	if p != nil && p.Now != nil {
		return p.Now().UTC()
	}
	return time.Now().UTC()
}

func (p *postgresRecipientHealthLookup) negativeWindow() time.Duration {
	if p == nil || p.NegativeWindow <= 0 {
		return recipientHealthNegativeWindow
	}
	return p.NegativeWindow
}

// Lookup joins two tenant-scoped derived stores in one bounded query:
//
//   - verification_cache terminal statuses block after vendor-refresh expiry,
//     but never beyond the bounded address-evidence retention window;
//   - email_health_snapshots contributes terminal verification or complaint
//     evidence while the derived snapshot remains retained, and recoverable
//     hard/soft-bounce evidence only while it remains fresh and unretired by a
//     newer trusted positive.
//
// A bare grade=F/hard_stop snapshot is not enough. Consent and active
// suppressions are mutable policy state and are enforced by the canonical base
// checker; honoring their stale derived snapshot after removal would make a
// legitimate consent/suppression change impossible to recover from.
func (p *postgresRecipientHealthLookup) Lookup(ctx context.Context, tenantID string, emails []string) (map[string]recipientHealthDecision, error) {
	if p == nil || p.Pool == nil {
		return nil, ErrRecipientHealthGateUnavailable
	}
	normalized := normalizeSuppressionEmails(emails)
	out := make(map[string]recipientHealthDecision, len(normalized))
	for _, email := range normalized {
		out[email] = recipientHealthDecision{}
	}
	if len(normalized) == 0 {
		return out, nil
	}

	tx, err := db.WithTenant(ctx, p.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	now := p.now()
	retentionCutoff := now.Add(-recipientHealthEvidenceRetention)
	liveEvidence, err := loadLiveRecipientHealthEvidence(
		ctx, tx, tenantID, normalized,
		now.Add(-p.negativeWindow()), now.Add(-recipientHealthPositiveWindow),
		now.Add(recipientHealthFutureTolerance),
	)
	if err != nil {
		return nil, err
	}

	// Drive the join from the requested-address CTE. Besides keeping this to
	// one round trip on the scalar hot path, that guarantees an explicit row for
	// an address with no cached/snapshot evidence; omission is still verified
	// below so an accidental future SQL regression fails closed.
	rows, err := tx.Query(ctx, `
WITH requested(email) AS (
  SELECT DISTINCT unnest($2::text[])
)
SELECT requested.email,
       COALESCE(cache.status, ''), COALESCE(cache.provider, ''), cache.checked_at,
       COALESCE(health.verification_status, ''),
       COALESCE(health.verification_provider, ''),
       health.verification_checked_at,
       health.computed_at,
       COALESCE(health.evidence, '[]'::jsonb)
  FROM requested
  LEFT JOIN verification_cache cache
    ON cache.tenant_id = $1::uuid
   AND cache.email = requested.email
   AND cache.checked_at > $3
  LEFT JOIN email_health_snapshots health
    ON health.tenant_id = $1::uuid
   AND health.email = requested.email
   AND health.computed_at > $3`, tenantID, normalized, retentionCutoff)
	if err != nil {
		return nil, err
	}
	cutoff := now.Add(-p.negativeWindow())
	seen := make(map[string]struct{}, len(normalized))
	for rows.Next() {
		var (
			email                         string
			cacheStatus                   string
			cacheProvider                 string
			cacheCheckedAt                *time.Time
			snapshotVerificationStatus    string
			snapshotVerificationProvider  string
			snapshotVerificationCheckedAt *time.Time
			snapshotComputedAt            *time.Time
		)
		var rawEvidence []byte
		if err := rows.Scan(
			&email, &cacheStatus, &cacheProvider, &cacheCheckedAt,
			&snapshotVerificationStatus,
			&snapshotVerificationProvider,
			&snapshotVerificationCheckedAt, &snapshotComputedAt, &rawEvidence,
		); err != nil {
			rows.Close()
			return nil, err
		}
		email = normalizeSuppressionEmail(email)
		seen[email] = struct{}{}
		var evidence []healthSnapshotEvidence
		if len(rawEvidence) > 0 {
			if err := json.Unmarshal(rawEvidence, &evidence); err != nil {
				rows.Close()
				return nil, fmt.Errorf("decode recipient health evidence: %w", err)
			}
		}
		evidence = append(evidence, liveEvidence[email]...)
		if trustedRecipientHealthValidation(cacheStatus, cacheProvider, cacheCheckedAt) {
			evidence = append(evidence, healthSnapshotEvidence{Kind: "verification_valid", At: cacheCheckedAt.UTC()})
		}
		if trustedRecipientHealthValidation(
			snapshotVerificationStatus, snapshotVerificationProvider,
			snapshotVerificationCheckedAt,
		) {
			evidence = append(evidence, healthSnapshotEvidence{Kind: "verification_valid", At: snapshotVerificationCheckedAt.UTC()})
		}

		// A retained terminal cache row is already authoritative. Preserve it
		// rather than replacing a more-specific reason with snapshot evidence,
		// unless the durable snapshot contains a genuinely newer trusted
		// validation (for example after a stale background result arrived).
		if decision, blocked := terminalVerificationDecision(cacheStatus); blocked {
			if !trustedRecipientHealthValidation(
				snapshotVerificationStatus, snapshotVerificationProvider,
				snapshotVerificationCheckedAt,
			) || cacheCheckedAt == nil ||
				!snapshotVerificationCheckedAt.After(*cacheCheckedAt) {
				out[email] = decision
				continue
			}
		}
		if snapshotVerificationCheckedAt != nil && snapshotVerificationCheckedAt.After(retentionCutoff) {
			if decision, blocked := terminalVerificationDecision(snapshotVerificationStatus); blocked {
				// Only a newer successful mailbox validation retires retained
				// terminal evidence. Unknown/local ambiguity and catch-all are not
				// affirmative recovery signals and must never erase a known invalid,
				// trap, abuse, or do-not-mail verdict.
				if !trustedCacheRetiresTerminalSnapshot(
					cacheStatus, cacheProvider, cacheCheckedAt,
					snapshotVerificationCheckedAt,
				) {
					out[email] = decision
					continue
				}
			}
		}

		futureLimit := now.Add(recipientHealthFutureTolerance)
		if decision, blocked := hardEvidenceDecision(evidence, futureLimit); blocked {
			out[email] = decision
			continue
		}
		suppressionReason, blocked := recentRecoverableNegative(
			evidence, cutoff, now.Add(-recipientHealthPositiveWindow), futureLimit,
		)
		if blocked {
			out[email] = recipientHealthDecision{
				Blocked:           true,
				Reason:            "recent_negative",
				SuppressionReason: suppressionReason,
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, email := range normalized {
		if _, present := seen[email]; !present {
			return nil, fmt.Errorf("%w: recipient health query omitted requested address", ErrSuppressionBatchIncomplete)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func loadLiveRecipientHealthEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	emails []string,
	negativeCutoff time.Time,
	positiveCutoff time.Time,
	futureLimit time.Time,
) (map[string][]healthSnapshotEvidence, error) {
	out := make(map[string][]healthSnapshotEvidence, len(emails))
	rows, err := tx.Query(ctx, `
SELECT lower(event.subscriber_email::text), event.event_type,
       COALESCE(event.bounce_type, ''), max(event.at)
  FROM subscriber_events AS event
  LEFT JOIN subscriber_event_classification_shadow_v1 AS classification
    ON classification.tenant_id = event.tenant_id
   AND classification.subscriber_event_id = event.id
   AND classification.subscriber_event_at = event.at
	 WHERE event.tenant_id = $1::uuid
	   AND event.subscriber_email = ANY($2::citext[])
	   AND event.event_type IN ('clicked', 'delivered', 'bounced', 'complained')
	   AND (
	       event.event_type = 'complained' OR
	       (event.event_type = 'bounced' AND event.at >= $3) OR
	       (event.event_type IN ('clicked', 'delivered') AND event.at >= $4)
	   )
	   AND event.at <= $5
	   AND (event.event_type <> 'clicked' OR classification.human_signal IS TRUE)
	 GROUP BY lower(event.subscriber_email::text), event.event_type,
	          COALESCE(event.bounce_type, '')`, tenantID, emails,
		negativeCutoff, positiveCutoff, futureLimit)
	if err != nil {
		return nil, fmt.Errorf("load live recipient health events: %w", err)
	}
	for rows.Next() {
		var email, eventType, bounceType string
		var at time.Time
		if err := rows.Scan(&email, &eventType, &bounceType, &at); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan live recipient health event: %w", err)
		}
		kind := ""
		switch eventType {
		case "clicked":
			kind = "click"
		case "delivered":
			kind = "delivered"
		case "complained":
			kind = "complaint"
		case "bounced":
			switch bounceType {
			case "hard", "spam_trap":
				kind = "hard_bounce"
			case "soft":
				kind = "soft_bounce"
			default:
				kind = "ambiguous_negative"
			}
		}
		if kind != "" {
			email = normalizeSuppressionEmail(email)
			out[email] = append(out[email], healthSnapshotEvidence{Kind: kind, At: at.UTC()})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate live recipient health events: %w", err)
	}
	rows.Close()

	rows, err = tx.Query(ctx, `
SELECT lower(recipient_email::text), max(received_at)
  FROM campaign_replies
	 WHERE tenant_id = $1::uuid
	   AND lower(recipient_email::text) = ANY($2::text[])
	   AND received_at >= $3
	   AND received_at <= $4`+replies.HumanEngagementPredicate+`
	 GROUP BY lower(recipient_email::text)`, tenantID, emails, positiveCutoff, futureLimit)
	if err != nil {
		return nil, fmt.Errorf("load live recipient human replies: %w", err)
	}
	for rows.Next() {
		var email string
		var at time.Time
		if err := rows.Scan(&email, &at); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan live recipient human reply: %w", err)
		}
		email = normalizeSuppressionEmail(email)
		out[email] = append(out[email], healthSnapshotEvidence{Kind: "reply", At: at.UTC()})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate live recipient human replies: %w", err)
	}
	rows.Close()
	return out, nil
}

func trustedCacheRetiresTerminalSnapshot(
	status, provider string,
	cacheCheckedAt, snapshotCheckedAt *time.Time,
) bool {
	return trustedRecipientHealthValidation(status, provider, cacheCheckedAt) &&
		snapshotCheckedAt != nil &&
		cacheCheckedAt.After(*snapshotCheckedAt)
}

// trustedRecipientHealthValidation is deliberately exact. Persisted provider
// identifiers are a closed contract; trimming/case-folding a forged legacy
// value would allow it to retire terminal evidence.
func trustedRecipientHealthValidation(status, provider string, checkedAt *time.Time) bool {
	return status == "valid" && checkedAt != nil &&
		(provider == recipientHealthProviderZeroBounce || provider == recipientHealthProviderKickbox)
}

func terminalVerificationDecision(status string) (recipientHealthDecision, bool) {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "invalid":
		return recipientHealthDecision{Blocked: true, Reason: "verification_invalid", SuppressionReason: "invalid_email"}, true
	case "spamtrap":
		return recipientHealthDecision{Blocked: true, Reason: "verification_spamtrap", SuppressionReason: "spamtrap"}, true
	case "abuse":
		return recipientHealthDecision{Blocked: true, Reason: "verification_abuse", SuppressionReason: "invalid_email"}, true
	case "do_not_mail":
		return recipientHealthDecision{Blocked: true, Reason: "verification_do_not_mail", SuppressionReason: "invalid_email"}, true
	default:
		return recipientHealthDecision{}, false
	}
}

func hardEvidenceDecision(evidence []healthSnapshotEvidence, futureLimit time.Time) (recipientHealthDecision, bool) {
	for _, item := range evidence {
		if item.At.IsZero() || item.At.After(futureLimit) {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(item.Kind)) {
		case "complaint":
			return recipientHealthDecision{Blocked: true, Reason: "hard_complaint", SuppressionReason: "complaint"}, true
		}
	}
	return recipientHealthDecision{}, false
}

// recentRecoverableNegative returns the send-loop suppression taxonomy for the
// newest unretired historical bounce. Hard and soft bounces share the 30-day D
// window; a genuinely newer trusted provider validation, human-classified
// click, delivery, or human reply retires either one. Reserved vendor activity
// is advisory only. Equal timestamps stay fail-closed in favor of the negative.
func recentRecoverableNegative(
	evidence []healthSnapshotEvidence,
	negativeCutoff, positiveCutoff, futureLimit time.Time,
) (string, bool) {
	var latestNegative, latestPositive time.Time
	latestNegativeKind := ""
	for _, item := range evidence {
		if item.At.IsZero() || item.At.After(futureLimit) {
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(item.Kind))
		switch kind {
		case "hard_bounce", "soft_bounce", "ambiguous_negative":
			if !item.At.Before(negativeCutoff) &&
				(item.At.After(latestNegative) ||
					(item.At.Equal(latestNegative) && kind == "hard_bounce")) {
				latestNegative = item.At
				latestNegativeKind = kind
			}
		case "verification_valid", "reply", "click", "delivered":
			if !item.At.Before(positiveCutoff) && item.At.After(latestPositive) {
				latestPositive = item.At
			}
		}
	}
	if latestNegative.IsZero() || (!latestPositive.IsZero() && latestNegative.Before(latestPositive)) {
		return "", false
	}
	if latestNegativeKind == "hard_bounce" {
		return "hard_bounce", true
	}
	return "soft_bounce", true
}

var (
	_ SuppressionChecker      = (*RecipientSafetyGate)(nil)
	_ SuppressionBatchChecker = (*RecipientSafetyGate)(nil)
	_ recipientHealthLookup   = (*postgresRecipientHealthLookup)(nil)
)
