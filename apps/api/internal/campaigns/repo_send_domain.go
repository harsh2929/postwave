package campaigns

// Send-domain extensions on Repo: clone/enqueue (resend-to-non-openers),
// pause/resume/cancel transitions, recurrence config, recurrence
// candidate scan, and a per-batch pending-recipient peek for the
// sending worker.
//
// These methods read/write the X1+X2+X3 columns added by migration
// 0068_sending_domain.sql (parent_campaign_id, audience_*, send_at,
// recurrence_*) and the campaign_recipients table created in the same
// migration. They DO NOT touch main's existing Repo.scanCampaign /
// campaignColumns shape — that stays the canonical wide projection; this
// file uses its own narrow SendDomainCampaign struct so the two
// projections never fight.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrInvalidTransition is returned when SetStatus's `allowedFrom`
// predicate doesn't match the row's in-DB status (e.g. tried to pause a
// draft).
var ErrInvalidTransition = errors.New("campaigns: invalid status transition")

// SendDomainCampaign is the narrow projection used by the send-domain
// endpoints (clone, transition, recurrence). The wide Campaign struct in
// types.go covers the editor/listmonk-style payload; this one only
// carries fields the sending pipeline cares about.
type SendDomainCampaign struct {
	ID                string     `json:"id"`
	TenantID          string     `json:"tenant_id"`
	ParentCampaignID  *string    `json:"parent_campaign_id,omitempty"`
	Name              string     `json:"name"`
	Subject           string     `json:"subject,omitempty"`
	Status            string     `json:"status"`
	AudienceListID    *int64     `json:"audience_list_id,omitempty"`
	AudienceSegmentID *string    `json:"audience_segment_id,omitempty"`
	SendAt            *time.Time `json:"send_at,omitempty"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	FinishedAt        *time.Time `json:"finished_at,omitempty"`
	RecurrenceCron    *string    `json:"recurrence_cron,omitempty"`
	RecurrenceUntil   *time.Time `json:"recurrence_until,omitempty"`
	RecurrenceLastRun *time.Time `json:"recurrence_last_run,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

// RecurrenceCandidate is a parent campaign carrying a recurrence
// expression that the worker should evaluate.
type RecurrenceCandidate struct {
	ID              string
	TenantID        string
	Name            string
	Subject         string
	Cron            string
	Until           *time.Time
	LastRun         *time.Time
	AudienceListID  *int64
	AudienceSegment *string
}

const sendDomainCols = `
id::text, tenant_id::text,
COALESCE(parent_campaign_id::text, ''),
name, COALESCE(subject,''), status,
audience_list_id, COALESCE(audience_segment_id::text,''),
send_at, started_at, finished_at,
recurrence_cron, recurrence_until, recurrence_last_run,
created_at, updated_at`

func scanSendDomainCampaign(row pgx.Row) (*SendDomainCampaign, error) {
	var c SendDomainCampaign
	var parentID, subject, statusStr, audSeg string
	var listID *int64
	var sendAt, startedAt, finishedAt, recUntil, recLast *time.Time
	var recCron *string

	err := row.Scan(
		&c.ID, &c.TenantID, &parentID, &c.Name, &subject, &statusStr,
		&listID, &audSeg, &sendAt, &startedAt, &finishedAt,
		&recCron, &recUntil, &recLast, &c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if parentID != "" {
		c.ParentCampaignID = &parentID
	}
	c.Subject = subject
	c.Status = statusStr
	c.AudienceListID = listID
	if audSeg != "" {
		c.AudienceSegmentID = &audSeg
	}
	c.SendAt = sendAt
	c.StartedAt = startedAt
	c.FinishedAt = finishedAt
	c.RecurrenceCron = recCron
	c.RecurrenceUntil = recUntil
	c.RecurrenceLastRun = recLast
	return &c, nil
}

// CreateClone inserts a child campaign cloned from a parent (used by
// resend-to-non-openers). subject overrides the parent's subject when
// non-empty. Audience attributes are copied from the parent.
func (r *Repo) CreateClone(ctx context.Context, tenantID, parentID, subject string, sendAt *time.Time) (*SendDomainCampaign, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
INSERT INTO campaigns (tenant_id, parent_campaign_id, name, subject,
        status, audience_list_id, audience_segment_id, send_at)
SELECT $1::uuid, id, name || ' (resend)',
       COALESCE(NULLIF($3,''), subject),
       'scheduled', audience_list_id, audience_segment_id, $4
FROM campaigns
WHERE id = $2::uuid AND tenant_id = $1::uuid
RETURNING ` + sendDomainCols

	c, err := scanSendDomainCampaign(tx.QueryRow(ctx, q, tenantID, parentID, subject, sendAt))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// EnqueueRecipients inserts pending campaign_recipients rows for the
// given emails. Returns the number inserted.
func (r *Repo) EnqueueRecipients(ctx context.Context, tenantID, campaignID string, emails []string) (int, error) {
	if len(emails) == 0 {
		return 0, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
INSERT INTO campaign_recipients (campaign_id, tenant_id, subscriber_email, status)
VALUES ($1::uuid, $2::uuid, $3, 'pending')`
	n := 0
	for _, e := range emails {
		ct, err := tx.Exec(ctx, q, campaignID, tenantID, e)
		if err != nil {
			return n, fmt.Errorf("enqueue recipient %s: %w", e, err)
		}
		n += int(ct.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		return n, err
	}
	return n, nil
}

// NonOpenerEmails returns the distinct subscriber emails who received
// campaign campaignID but did NOT have an `opened` event for it. Driven
// off the campaign_recipients audit + subscriber_events log.
func (r *Repo) NonOpenerEmails(ctx context.Context, tenantID, campaignID string) ([]string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
SELECT DISTINCT cr.subscriber_email::text
FROM campaign_recipients cr
WHERE cr.campaign_id = $1::uuid
  AND cr.status = 'sent'
  AND NOT EXISTS (
    SELECT 1 FROM subscriber_events se
    WHERE se.campaign_id = $1::uuid
      AND se.subscriber_email = cr.subscriber_email
      AND se.event_type = 'opened'
  )`
	rows, err := tx.Query(ctx, q, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, err
		}
		out = append(out, email)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// SetStatus atomically transitions a campaign's status if its current
// status is in `allowedFrom`. On cancel, all pending recipients are
// flipped to 'cancelled' so the send loop drains.
func (r *Repo) SetStatus(ctx context.Context, tenantID, campaignID string, allowedFrom []string, next string) (*SendDomainCampaign, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
UPDATE campaigns
SET status = $3,
    -- Record the first entry into a dispatching status, monotonically. Resume
    -- (paused -> sending) reaches dispatch through here, and the content-freeze
    -- guard in Repo.Update reads started_at: without this stamp, a campaign
    -- resumed through SetStatus and paused again would read as "never
    -- dispatched" and its content would unfreeze between batches.
    started_at = CASE WHEN $3 IN ('sending', 'sent')
                      THEN COALESCE(started_at, now()) ELSE started_at END,
    updated_at = now()
WHERE id = $1::uuid
  AND status = ANY($2::text[])
RETURNING ` + sendDomainCols

	c, err := scanSendDomainCampaign(tx.QueryRow(ctx, q, campaignID, allowedFrom, next))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrInvalidTransition
		}
		return nil, err
	}
	if next == StatusCancelled {
		const cq = `UPDATE campaign_recipients
                    SET status='cancelled'
                    WHERE campaign_id = $1::uuid AND status='pending'`
		if _, err := tx.Exec(ctx, cq, campaignID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// SetRecurrence updates the recurrence_cron + recurrence_until columns.
// Pass empty cron to clear.
func (r *Repo) SetRecurrence(ctx context.Context, tenantID, campaignID, cron string, until *time.Time) (*SendDomainCampaign, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
UPDATE campaigns
SET recurrence_cron = NULLIF($2,''),
    recurrence_until = $3,
    updated_at = now()
WHERE id = $1::uuid AND tenant_id = $4::uuid
RETURNING ` + sendDomainCols
	c, err := scanSendDomainCampaign(tx.QueryRow(ctx, q, campaignID, cron, until, tenantID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// MarkRecurrenceRun stamps recurrence_last_run for the parent.
func (r *Repo) MarkRecurrenceRun(ctx context.Context, tenantID, campaignID string, at time.Time) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `UPDATE campaigns SET recurrence_last_run=$2, updated_at=now() WHERE id=$1::uuid`, campaignID, at)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListRecurrenceCandidates returns every campaign with a non-null
// recurrence_cron whose recurrence_until is in the future. Cross-tenant
// scan, intended for the nightly worker; bypasses RLS via the
// outbox_worker GUC pattern.
func (r *Repo) ListRecurrenceCandidates(ctx context.Context, asOf time.Time) ([]RecurrenceCandidate, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}

	const q = `
SELECT id::text, tenant_id::text, name, COALESCE(subject,''),
       recurrence_cron, recurrence_until, recurrence_last_run,
       audience_list_id, COALESCE(audience_segment_id::text, '')
FROM campaigns
WHERE recurrence_cron IS NOT NULL
  AND (recurrence_until IS NULL OR recurrence_until > $1)`
	rows, err := tx.Query(ctx, q, asOf)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []RecurrenceCandidate{}
	for rows.Next() {
		var rc RecurrenceCandidate
		var seg string
		if err := rows.Scan(&rc.ID, &rc.TenantID, &rc.Name, &rc.Subject,
			&rc.Cron, &rc.Until, &rc.LastRun, &rc.AudienceListID, &seg); err != nil {
			return nil, err
		}
		if seg != "" {
			rc.AudienceSegment = &seg
		}
		out = append(out, rc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// PendingBatch returns up to `limit` pending recipients for a campaign.
// Used by the sending worker; tests use it to validate the loop guard.
func (r *Repo) PendingBatch(ctx context.Context, tenantID, campaignID string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const q = `
SELECT cr.subscriber_email::text
FROM campaign_recipients cr
JOIN campaigns c ON c.id = cr.campaign_id
LEFT JOIN campaign_recipient_send_at psto
       ON psto.tenant_id = cr.tenant_id
      AND psto.campaign_id = cr.campaign_id
      AND lower(psto.subscriber_email::text) = lower(cr.subscriber_email::text)
WHERE cr.campaign_id = $1::uuid
  AND cr.status = 'pending'
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
LIMIT $2`
	rows, err := tx.Query(ctx, q, campaignID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
