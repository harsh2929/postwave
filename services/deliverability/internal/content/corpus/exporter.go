package corpus

// exporter.go — admin-only DB extractor that produces (text, isSpam)
// tuples from real send + outcome data for spam-scorer recalibration.
//
// IMPORTANT context for reviewers:
//   - `seedlist_outcomes` is created by migration 0105 and written by the
//     deliverability reportstore when DATABASE_URL is configured. Export()
//     remains permissive of the table being absent so older self-hosted
//     databases can still export suppression/reply-derived samples.
//
// Assumed schemas (documented here so the migration author has a
// concrete target):
//
//	CREATE TABLE seedlist_outcomes (
//	    id           bigserial PRIMARY KEY,
//	    tenant_id    uuid NOT NULL,
//	    campaign_id  uuid NOT NULL,
//	    variant_id   uuid,                  -- NULL when not A/B
//	    recipient_email citext NOT NULL,
//	    provider     text NOT NULL,         -- "gmail", "outlook_com", ...
//	    folder       text NOT NULL          -- "primary"|"promotions"|"spam"|"missing"|...
//	                 CHECK (folder IN ('primary','promotions','updates','social','spam','blocked','missing')),
//	    checked_at   timestamptz NOT NULL DEFAULT now()
//	);
//
//	-- subscriber_suppressions exists today (migration 0081), with reason
//	-- column. We treat reason='spam_complaint' as a direct user signal.
//
//	-- campaign_replies exists today (migration 0087). We mine the body
//	-- text for an "unsubscribe" signal as a soft spam vote.
//
//	-- email_events is the assumed sends table. We need (tenant_id,
//	-- campaign_id, recipient_email, subject, body_html, sent_at).
//	-- If the actual send-engine schema differs, swap the column
//	-- references in querySends below.
//
// Export does NOT enforce RLS — it sets app.tenant_id to NULL so the
// query runs as the privileged role. Callers must guarantee the pool
// is connected as `postwave_admin` (or another non-RLS-bound role) so
// "RESTRICTIVE" policies do not silently filter the results to zero.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Exporter pulls labeled samples from the operational database for
// scorer recalibration. Construct it with a privileged pool — RLS is
// intentionally bypassed (see package comment for why).
type Exporter struct {
	Pool *pgxpool.Pool

	// SpamFolderThreshold is the fraction of seedlist mailboxes that
	// must place a campaign in spam for it to count as spam-class.
	// Default 0.70. Setting too low hurts label quality; setting too
	// high yields too few examples.
	SpamFolderThreshold float64

	// PrimaryFolderThreshold is the matching threshold for ham-class.
	// Default 0.70.
	PrimaryFolderThreshold float64
}

// NewExporter wraps a pgxpool with sensible defaults.
func NewExporter(pool *pgxpool.Pool) *Exporter {
	if pool == nil {
		return nil
	}
	return &Exporter{
		Pool:                   pool,
		SpamFolderThreshold:    0.70,
		PrimaryFolderThreshold: 0.70,
	}
}

// Export returns Sample rows whose sample_at >= since. Strict labels
// only — gray-zone outcomes (mixed seedlist placements without a clear
// majority) are filtered server-side.
//
// Three sources contribute spam-class samples:
//  1. Seedlist outcomes where >= SpamFolderThreshold of mailboxes saw
//     the campaign in spam.
//  2. Subscriber-suppression rows where reason='spam_complaint'.
//  3. Campaign-replies whose body text contains 'unsubscribe' (a soft
//     vote — used only when the recipient also had no clicks/opens
//     in the same campaign).
//
// One source contributes ham-class samples:
//  1. Seedlist outcomes where >= PrimaryFolderThreshold of mailboxes
//     saw the campaign in primary, AND the campaign has zero
//     spam-complaints, AND has positive engagement (clicks > 0
//     OR replies > 0).
//
// All sources are aggregated per (tenant_id, campaign_id, variant_id,
// recipient_email) before labeling so a single campaign cannot dominate
// the corpus through duplicates.
func (e *Exporter) Export(ctx context.Context, since time.Time) ([]Sample, error) {
	if e == nil || e.Pool == nil {
		return nil, errors.New("corpus.Exporter: nil pool")
	}
	if e.SpamFolderThreshold <= 0 {
		e.SpamFolderThreshold = 0.70
	}
	if e.PrimaryFolderThreshold <= 0 {
		e.PrimaryFolderThreshold = 0.70
	}

	// Keep the transaction-local tenant reset and every dependent query in
	// one transaction. A standalone set_config(..., true) is cleared before
	// the next auto-commit query and therefore never established this scope.
	tx, err := e.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin export transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Bypass RLS by clearing the tenant_id setting. Caller is expected
	// to have connected as a privileged role; if they didn't, this
	// will silently return zero rows from RESTRICTIVE-policy tables.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '', true)`); err != nil {
		return nil, fmt.Errorf("clear tenant scope: %w", err)
	}

	out := make([]Sample, 0, 256)

	// 1. Seedlist-derived samples (both spam-class and ham-class).
	if rows, err := e.querySeedlistOutcomes(ctx, tx, since); err != nil {
		// We swallow "table does not exist" so a fresh DB without
		// seedlist_outcomes still yields rows from other sources.
		if !isUndefinedTable(err) {
			return nil, fmt.Errorf("seedlist outcomes: %w", err)
		}
	} else {
		out = append(out, rows...)
	}

	// 2. Suppressions with reason='spam_complaint'.
	if rows, err := e.querySpamComplaints(ctx, tx, since); err != nil {
		if !isUndefinedTable(err) {
			return nil, fmt.Errorf("spam complaints: %w", err)
		}
	} else {
		out = append(out, rows...)
	}

	// 3. Reply-as-unsubscribe soft signals.
	if rows, err := e.queryReplyUnsubscribes(ctx, tx, since); err != nil {
		if !isUndefinedTable(err) {
			return nil, fmt.Errorf("reply unsubs: %w", err)
		}
	} else {
		out = append(out, rows...)
	}

	return out, nil
}

// querySeedlistOutcomes pulls aggregated seedlist outcomes. The query
// joins seedlist_outcomes -> email_events to recover subject + body
// for the campaign-recipient pair. The window predicate is on
// email_events.sent_at, not seedlist_outcomes.checked_at, because the
// label train should be aligned with the sent content.
//
// Per (campaign_id, variant_id, recipient_email) we compute the
// fraction of seedlist mailboxes in spam vs primary. A pair is:
//   - spam-class if spam fraction >= SpamFolderThreshold
//   - ham-class  if primary fraction >= PrimaryFolderThreshold AND
//     there is at least one click or reply in the same scope AND
//     zero spam complaints
//
// All other pairs are dropped.
func (e *Exporter) querySeedlistOutcomes(ctx context.Context, conn pgx.Tx, since time.Time) ([]Sample, error) {
	const q = `
WITH placements AS (
    SELECT
        so.tenant_id,
        so.campaign_id,
        so.variant_id,
        so.recipient_email,
        SUM(CASE WHEN so.folder = 'spam'    THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS spam_frac,
        SUM(CASE WHEN so.folder = 'primary' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS primary_frac,
        COUNT(*) AS mailboxes
    FROM seedlist_outcomes so
    WHERE so.checked_at >= $1
    GROUP BY so.tenant_id, so.campaign_id, so.variant_id, so.recipient_email
),
engagement AS (
    SELECT
        tenant_id,
        campaign_id,
        variant_id,
        recipient_email,
        BOOL_OR(clicked OR replied) AS engaged,
        BOOL_OR(complained)         AS complained
    FROM (
        SELECT tenant_id, campaign_id, variant_id, recipient_email,
               (open_count > 0) AS opened,
               (click_count > 0) AS clicked,
               (reply_count > 0) AS replied,
               complained
          FROM email_events
         WHERE sent_at >= $1
    ) e
    GROUP BY tenant_id, campaign_id, variant_id, recipient_email
),
content AS (
    SELECT DISTINCT ON (tenant_id, campaign_id, variant_id, recipient_email)
        tenant_id, campaign_id, variant_id, recipient_email,
        subject, body_html, sent_at
      FROM email_events
     WHERE sent_at >= $1
     ORDER BY tenant_id, campaign_id, variant_id, recipient_email, sent_at DESC
)
SELECT
    c.subject,
    c.body_html,
    c.sent_at,
    p.spam_frac,
    p.primary_frac,
    COALESCE(en.engaged, FALSE),
    COALESCE(en.complained, FALSE)
FROM placements p
JOIN content c
  ON  c.tenant_id = p.tenant_id
  AND c.campaign_id = p.campaign_id
  AND c.recipient_email = p.recipient_email
  AND COALESCE(c.variant_id::text,'') = COALESCE(p.variant_id::text,'')
LEFT JOIN engagement en
  ON  en.tenant_id = p.tenant_id
  AND en.campaign_id = p.campaign_id
  AND en.recipient_email = p.recipient_email
  AND COALESCE(en.variant_id::text,'') = COALESCE(p.variant_id::text,'')
WHERE p.mailboxes >= 3
  AND (p.spam_frac >= $2 OR (p.primary_frac >= $3 AND COALESCE(en.engaged, FALSE) AND NOT COALESCE(en.complained, FALSE)))
`

	rows, err := conn.Query(ctx, q, since, e.SpamFolderThreshold, e.PrimaryFolderThreshold)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Sample
	for rows.Next() {
		var (
			subject, body string
			at            time.Time
			spamFrac      float64
			primaryFrac   float64
			engaged       bool
			complained    bool
		)
		if err := rows.Scan(&subject, &body, &at, &spamFrac, &primaryFrac, &engaged, &complained); err != nil {
			return nil, err
		}
		isSpam := spamFrac >= e.SpamFolderThreshold
		// belt-and-suspenders ham filter
		if !isSpam && (primaryFrac < e.PrimaryFolderThreshold || !engaged || complained) {
			continue
		}
		out = append(out, Sample{
			Text:     subject + "\n\n" + body,
			Subject:  subject,
			BodyHTML: body,
			IsSpam:   isSpam,
			Source:   "seedlist",
			SampleAt: at,
		})
	}
	return out, rows.Err()
}

// querySpamComplaints pulls subscriber_suppressions WHERE
// reason='spam_complaint'. The body is recovered by joining to
// email_events on (tenant_id, recipient_email) — the most recent send
// to that recipient before the complaint is the most likely culprit.
func (e *Exporter) querySpamComplaints(ctx context.Context, conn pgx.Tx, since time.Time) ([]Sample, error) {
	const q = `
WITH complaints AS (
    SELECT tenant_id, email AS recipient_email, created_at
      FROM subscriber_suppressions
     WHERE reason = 'spam_complaint'
       AND created_at >= $1
),
matched AS (
    SELECT DISTINCT ON (c.tenant_id, c.recipient_email)
        c.tenant_id, c.recipient_email, c.created_at AS complained_at,
        ev.subject, ev.body_html, ev.sent_at
      FROM complaints c
      JOIN email_events ev
        ON  ev.tenant_id = c.tenant_id
        AND ev.recipient_email = c.recipient_email
        AND ev.sent_at <= c.created_at
     ORDER BY c.tenant_id, c.recipient_email, ev.sent_at DESC
)
SELECT subject, body_html, complained_at FROM matched
`

	rows, err := conn.Query(ctx, q, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Sample
	for rows.Next() {
		var (
			subject, body string
			at            time.Time
		)
		if err := rows.Scan(&subject, &body, &at); err != nil {
			return nil, err
		}
		out = append(out, Sample{
			Text:     subject + "\n\n" + body,
			Subject:  subject,
			BodyHTML: body,
			IsSpam:   true,
			Source:   "user-marked-spam",
			SampleAt: at,
		})
	}
	return out, rows.Err()
}

// queryReplyUnsubscribes pulls campaign_replies where the body text
// contains "unsubscribe" (case-insensitive). This is a soft vote — a
// recipient asking to unsubscribe via reply is signaling the content
// did not belong in their inbox. We pair the reply back to the
// originating campaign for subject + body recovery.
func (e *Exporter) queryReplyUnsubscribes(ctx context.Context, conn pgx.Tx, since time.Time) ([]Sample, error) {
	const q = `
SELECT c.subject, c.body_html, r.received_at
  FROM campaign_replies r
  JOIN campaigns c
    ON c.id = r.campaign_id
   AND c.tenant_id = r.tenant_id
 WHERE r.received_at >= $1
   AND r.body_text ILIKE '%unsubscribe%'
`

	rows, err := conn.Query(ctx, q, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Sample
	for rows.Next() {
		var (
			subject string
			body    *string
			at      time.Time
		)
		if err := rows.Scan(&subject, &body, &at); err != nil {
			return nil, err
		}
		var bodyHTML string
		if body != nil {
			bodyHTML = *body
		}
		out = append(out, Sample{
			Text:     subject + "\n\n" + bodyHTML,
			Subject:  subject,
			BodyHTML: bodyHTML,
			IsSpam:   true,
			Source:   "reply-unsubscribe",
			SampleAt: at,
		})
	}
	return out, rows.Err()
}

// isUndefinedTable returns true when err is a pg "undefined_table"
// (42P01) error. The exporter swallows these so a fresh DB without
// seedlist_outcomes/email_events doesn't cause Export() to fail; the
// CLI/operator gets back the rows from whichever sources do exist.
func isUndefinedTable(err error) bool {
	if err == nil {
		return false
	}
	var pgerr *pgconn.PgError
	if errors.As(err, &pgerr) {
		return pgerr.Code == "42P01"
	}
	// Fallback: pgx wraps some errors without exposing the typed error.
	return strings.Contains(err.Error(), "42P01") ||
		strings.Contains(err.Error(), "does not exist")
}
