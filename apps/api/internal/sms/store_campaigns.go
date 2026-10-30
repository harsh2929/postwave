// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// SMS campaign persistence: campaign CRUD and status transitions, recipient
// enqueueing and the worker claim/lease loop, sender throttle bookkeeping,
// scheduled-campaign discovery and campaign reporting.

// ListCampaigns returns SMS campaigns newest-first with keyset pagination on
// (created_at, id). limit is the page size (caller clamps via
// pagination.ReadParamsWithDefault); a non-empty next cursor is returned when
// more rows remain.
func (s *Store) ListCampaigns(ctx context.Context, tenantID string, limit int, cursor pagination.Cursor) ([]Campaign, string, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 limit+1; the keyset bound (when paging) takes $3/$4.
	args := []any{tenantID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (created_at, id) < ($3::timestamptz, $4::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, COALESCE(sender_profile_id::text, ''),
		       COALESCE(list_id::text, ''), name, body, COALESCE(media_url, ''),
		       status, scheduled_at, sent_at, stats, metadata, created_at, updated_at
		  FROM sms_campaigns
		 WHERE tenant_id = $1::uuid
		`+keyset+`
		 ORDER BY created_at DESC, id DESC
		 LIMIT $2`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Campaign{}
	for rows.Next() {
		item, err := scanCampaign(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.CreatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (s *Store) GetCampaign(ctx context.Context, tenantID, id string) (Campaign, error) {
	if !validCanonicalUUIDV4(id) {
		return Campaign{}, pgx.ErrNoRows
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Campaign{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, COALESCE(sender_profile_id::text, ''),
		       COALESCE(list_id::text, ''), name, body, COALESCE(media_url, ''),
		       status, scheduled_at, sent_at, stats, metadata, created_at, updated_at
		  FROM sms_campaigns
		 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanCampaign(row)
	if err != nil {
		return Campaign{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) CreateCampaign(ctx context.Context, tenantID string, in CampaignInput) (Campaign, error) {
	meta, err := validateCampaignInput(&in)
	if err != nil {
		return Campaign{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Campaign{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCampaignReferencesTx(ctx, tx, tenantID, in.SenderProfileID, in.ListID); err != nil {
		return Campaign{}, err
	}
	row := tx.QueryRow(ctx, `
		INSERT INTO sms_campaigns (
			tenant_id, sender_profile_id, list_id, name, body, media_url,
			status, scheduled_at, metadata
		) VALUES (
			$1::uuid, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, $4, $5, NULLIF($6, ''),
			$7, $8, $9::jsonb
		)
		RETURNING id::text, tenant_id::text, COALESCE(sender_profile_id::text, ''),
		          COALESCE(list_id::text, ''), name, body, COALESCE(media_url, ''),
		          status, scheduled_at, sent_at, stats, metadata, created_at, updated_at`,
		tenantID, in.SenderProfileID, in.ListID, in.Name, in.Body, in.MediaURL,
		in.Status, in.ScheduledAt, meta)
	out, err := scanCampaign(row)
	if err != nil {
		return Campaign{}, err
	}
	return out, tx.Commit(ctx)
}

// UpdateCampaign edits an existing SMS campaign's metadata in place (SMS-008).
// Guarded to WHERE status IN ('draft','scheduled','paused') so a sent/sending
// campaign can never be mutated. Returns ErrNoRows-mapped "not editable" when
// the id is unknown or the campaign has already been sent.
func (s *Store) UpdateCampaign(ctx context.Context, tenantID, id string, in CampaignInput) (Campaign, error) {
	if !validCanonicalUUIDV4(id) {
		return Campaign{}, pgx.ErrNoRows
	}
	meta, err := validateCampaignInput(&in)
	if err != nil {
		return Campaign{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Campaign{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCampaignReferencesTx(ctx, tx, tenantID, in.SenderProfileID, in.ListID); err != nil {
		return Campaign{}, err
	}
	row := tx.QueryRow(ctx, `
		UPDATE sms_campaigns SET
			sender_profile_id = NULLIF($3, '')::uuid,
			list_id           = NULLIF($4, '')::uuid,
			name              = $5,
			body              = $6,
			media_url         = NULLIF($7, ''),
			status            = $8,
			scheduled_at      = $9,
			metadata          = $10::jsonb,
			updated_at        = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		   AND status IN ('draft', 'scheduled', 'paused')
		RETURNING id::text, tenant_id::text, COALESCE(sender_profile_id::text, ''),
		          COALESCE(list_id::text, ''), name, body, COALESCE(media_url, ''),
		          status, scheduled_at, sent_at, stats, metadata, created_at, updated_at`,
		tenantID, id, in.SenderProfileID, in.ListID, in.Name, in.Body, in.MediaURL,
		in.Status, in.ScheduledAt, meta)
	out, err := scanCampaign(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Campaign{}, fmt.Errorf("campaign not found or already sent")
	}
	if err != nil {
		return Campaign{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) FinishCampaign(ctx context.Context, tenantID, id, status string, stats map[string]any) (Campaign, error) {
	if !oneOf(status, "sent", "failed", "paused") {
		return Campaign{}, fmt.Errorf("invalid terminal campaign status")
	}
	raw, err := json.Marshal(nilMap(stats))
	if err != nil {
		return Campaign{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Campaign{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		UPDATE sms_campaigns
		   SET status = $3,
		       sent_at = CASE WHEN $3 = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
		       stats = $4::jsonb,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		RETURNING id::text, tenant_id::text, COALESCE(sender_profile_id::text, ''),
		          COALESCE(list_id::text, ''), name, body, COALESCE(media_url, ''),
		          status, scheduled_at, sent_at, stats, metadata, created_at, updated_at`,
		tenantID, id, status, raw)
	out, err := scanCampaign(row)
	if err != nil {
		return Campaign{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) MarkCampaignSending(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE sms_campaigns
		   SET status = 'sending',
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		   AND status IN ('draft', 'scheduled', 'paused')`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("campaign is not sendable")
	}
	return tx.Commit(ctx)
}

// RequeueFailedRecipients resets a campaign's failed/undelivered recipients
// back to 'queued' for one more delivery attempt and re-arms the campaign so
// the drain worker picks them up (SMS-034). Only recipients who did NOT receive
// the message (status IN failed/undelivered) are re-queued — delivered/sent
// rows are never touched, so this cannot double-send. Returns the count
// re-queued.
func (s *Store) RequeueFailedRecipients(ctx context.Context, tenantID, campaignID string) (int, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE sms_campaign_recipients
		   SET status = 'queued',
		       error_code = NULL,
		       error_message = NULL,
		       next_attempt_at = now(),
		       leased_until = NULL,
		       lease_owner = NULL,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid
		   AND status IN ('failed', 'undelivered')`, tenantID, campaignID)
	if err != nil {
		return 0, err
	}
	n := int(tag.RowsAffected())
	if n > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE sms_campaigns
			   SET status = 'sending', updated_at = now()
			 WHERE tenant_id = $1::uuid
			   AND id = $2::uuid
			   AND status IN ('sent', 'sending', 'paused')`, tenantID, campaignID); err != nil {
			return 0, err
		}
	}
	return n, tx.Commit(ctx)
}

func (s *Store) UpdateCampaignStatus(ctx context.Context, tenantID, id, status string, scheduledAt *time.Time) (Campaign, error) {
	if !oneOf(status, "draft", "scheduled", "paused", "cancelled") {
		return Campaign{}, fmt.Errorf("invalid campaign status")
	}
	if status == "scheduled" && scheduledAt == nil {
		return Campaign{}, fmt.Errorf("scheduled_at is required")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Campaign{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		UPDATE sms_campaigns
		   SET status = $3,
		       scheduled_at = CASE WHEN $3 = 'scheduled' THEN $4 ELSE scheduled_at END,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		   AND status IN ('draft', 'scheduled', 'paused', 'sending')
		RETURNING id::text, tenant_id::text, COALESCE(sender_profile_id::text, ''),
		          COALESCE(list_id::text, ''), name, body, COALESCE(media_url, ''),
		          status, scheduled_at, sent_at, stats, metadata, created_at, updated_at`,
		tenantID, id, status, scheduledAt)
	out, err := scanCampaign(row)
	if err != nil {
		return Campaign{}, err
	}
	if status == "cancelled" {
		if _, err := tx.Exec(ctx, `
			UPDATE sms_campaign_recipients
			   SET status = 'cancelled',
			       updated_at = now()
			 WHERE tenant_id = $1::uuid
			   AND campaign_id = $2::uuid
			   AND status IN ('queued', 'sending')`, tenantID, id); err != nil {
			return Campaign{}, err
		}
	}
	return out, tx.Commit(ctx)
}

func (s *Store) ResumeCampaign(ctx context.Context, tenantID, id string) (Campaign, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Campaign{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var pending int
	if err := tx.QueryRow(ctx, `
		SELECT count(*)
		  FROM sms_campaign_recipients
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid
		   AND status = 'queued'`, tenantID, id).Scan(&pending); err != nil {
		return Campaign{}, err
	}
	nextStatus := "draft"
	if pending > 0 {
		nextStatus = "sending"
	}
	row := tx.QueryRow(ctx, `
		UPDATE sms_campaigns
		   SET status = $3,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		   AND status = 'paused'
		RETURNING id::text, tenant_id::text, COALESCE(sender_profile_id::text, ''),
		          COALESCE(list_id::text, ''), name, body, COALESCE(media_url, ''),
		          status, scheduled_at, sent_at, stats, metadata, created_at, updated_at`,
		tenantID, id, nextStatus)
	out, err := scanCampaign(row)
	if err != nil {
		return Campaign{}, err
	}
	return out, tx.Commit(ctx)
}

// CampaignRecipient is an opted-in list member plus the timing signals used
// by per-recipient send-time optimization (SMS-037). Timezone/BestSendHour are
// resolved from the linked subscriber and may be empty/nil for phone-only
// opt-ins with no subscriber profile — callers fall back accordingly.
type CampaignRecipient struct {
	Phone        string
	Timezone     string
	BestSendHour *int
}

func (s *Store) CampaignRecipients(ctx context.Context, tenantID, listID string, limit int) ([]CampaignRecipient, error) {
	if listID == "" {
		return nil, fmt.Errorf("campaign requires an sms list")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// LEFT JOIN so phone-only opt-ins (no subscriber_email link) still send;
	// they simply carry no tz/best-hour and fall back to global timing.
	query := `
		SELECT sub.phone_e164, COALESCE(p.timezone, ''), p.best_send_hour
		  FROM sms_subscriptions sub
		  LEFT JOIN subscribers p
		    ON p.tenant_id = sub.tenant_id
		   AND sub.subscriber_email IS NOT NULL
		   AND p.email = sub.subscriber_email
		 WHERE sub.tenant_id = $1::uuid
		   AND sub.list_id = $2::uuid
		   AND public.sms_subscription_send_eligible(
		     sub.tenant_id, sub.list_id, sub.phone_e164, sub.status,
		     sub.consent_source, sub.consent_text, sub.consent_at, sub.proof)
		 ORDER BY sub.consent_at NULLS LAST, sub.created_at`
	args := []any{tenantID, listID}
	if limit > 0 {
		query += " LIMIT $3"
		args = append(args, limit)
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CampaignRecipient{}
	for rows.Next() {
		var rec CampaignRecipient
		if err := rows.Scan(&rec.Phone, &rec.Timezone, &rec.BestSendHour); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// EnqueueRecipient inserts one queued recipient. nextAttempt is the earliest
// UTC instant the worker may pick the row: pass time.Now() for immediate
// (global) sends, or a per-recipient future instant for send-time
// optimization (SMS-037). The worker's ClaimQueuedRecipients filters on
// next_attempt_at <= now(), so a future stamp simply holds the row until then.
func (s *Store) EnqueueRecipient(ctx context.Context, tenantID string, campaign Campaign, phone, body string, segments int, linkTracking bool, metadata map[string]any, nextAttempt time.Time) (bool, error) {
	raw, err := json.Marshal(nilMap(metadata))
	if err != nil {
		return false, err
	}
	if nextAttempt.IsZero() {
		nextAttempt = time.Now().UTC()
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		INSERT INTO sms_campaign_recipients (
			tenant_id, campaign_id, sender_profile_id, list_id, phone_e164,
			body, media_url, segments, status, link_tracking, metadata, next_attempt_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
			$6, NULLIF($7, ''), $8, 'queued', $9, $10::jsonb, $11
		)
		ON CONFLICT (tenant_id, campaign_id, phone_e164) DO NOTHING`,
		tenantID, campaign.ID, campaign.SenderProfileID, campaign.ListID, phone,
		body, campaign.MediaURL, segments, linkTracking, raw, nextAttempt.UTC())
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, tx.Commit(ctx)
}

func (s *Store) ClaimQueuedRecipients(ctx context.Context, owner string, limit int) ([]QueuedRecipient, error) {
	if !s.SMSWorkerIdentityAvailable {
		return nil, ErrSMSWorkerIdentityUnavailable
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		WITH picked AS (
			SELECT r.id
			  FROM sms_campaign_recipients r
			  JOIN sms_campaigns c
			    ON c.tenant_id = r.tenant_id
			   AND c.id = r.campaign_id
			   AND c.status = 'sending'
			  JOIN sms_sender_profiles sp
			    ON sp.tenant_id = r.tenant_id
			   AND sp.id = r.sender_profile_id
			  LEFT JOIN sms_send_throttle_state t
			    ON t.tenant_id = r.tenant_id
			   AND t.sender_profile_id = r.sender_profile_id
			 WHERE r.status = 'queued'
			   AND r.next_attempt_at <= now()
			   AND (r.leased_until IS NULL OR r.leased_until < now())
			   AND COALESCE(LOWER(COALESCE(sp.metadata #>> '{sending,paused}', sp.metadata->>'paused')), 'false') NOT IN ('true', '1', 'yes', 'on')
			   AND COALESCE(t.suspended_until, '-infinity'::timestamptz) <= now()
			   AND COALESCE(t.next_available_at, '-infinity'::timestamptz) <= now()
			 ORDER BY COALESCE(t.next_available_at, '-infinity'::timestamptz), r.created_at ASC
			 LIMIT $1
			 FOR UPDATE OF r SKIP LOCKED
		)
		UPDATE sms_campaign_recipients r
		   SET status = 'sending',
		       attempts = attempts + 1,
		       lease_owner = $2,
		       leased_until = now() + interval '5 minutes',
		       updated_at = now()
		  FROM picked
		 WHERE r.id = picked.id
		RETURNING r.id::text, r.tenant_id::text, r.campaign_id::text,
		          r.sender_profile_id::text, r.list_id::text, r.phone_e164,
		          r.body, COALESCE(r.media_url, ''), r.segments, r.attempts,
		          r.link_tracking, r.metadata`, limit, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QueuedRecipient{}
	for rows.Next() {
		item, err := scanQueuedRecipient(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) ReserveSenderSendSlot(ctx context.Context, tenantID, senderID, provider string, delay, maxWait time.Duration) (SendSlotLease, error) {
	if delay < 0 {
		delay = 0
	}
	if maxWait <= 0 {
		maxWait = 2 * time.Second
	}
	now := time.Now().UTC()
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return SendSlotLease{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO sms_send_throttle_state (tenant_id, sender_profile_id, provider)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (tenant_id, sender_profile_id) DO NOTHING`,
		tenantID, senderID, defaulted(provider, ProviderTwilio))
	if err != nil {
		return SendSlotLease{}, err
	}
	var nextAvailable time.Time
	var suspendedUntil *time.Time
	var consecutiveFailures int
	err = tx.QueryRow(ctx, `
		SELECT next_available_at, suspended_until, consecutive_failures
		  FROM sms_send_throttle_state
		 WHERE tenant_id = $1::uuid
		   AND sender_profile_id = $2::uuid
		 FOR UPDATE`, tenantID, senderID).Scan(&nextAvailable, &suspendedUntil, &consecutiveFailures)
	if errors.Is(err, pgx.ErrNoRows) {
		return SendSlotLease{}, fmt.Errorf("sms throttle state missing after upsert")
	}
	if err != nil {
		return SendSlotLease{}, err
	}
	lease := SendSlotLease{WaitUntil: nextAvailable, ConsecutiveFailures: consecutiveFailures}
	if suspendedUntil != nil {
		lease.SuspendedUntil = *suspendedUntil
		if suspendedUntil.After(now) {
			return lease, tx.Commit(ctx)
		}
	}
	if nextAvailable.After(now.Add(maxWait)) {
		return lease, tx.Commit(ctx)
	}
	base := now
	if nextAvailable.After(base) {
		base = nextAvailable
	}
	next := base.Add(delay)
	_, err = tx.Exec(ctx, `
		UPDATE sms_send_throttle_state
		   SET provider = $3,
		       next_available_at = $4,
		       suspended_until = NULL,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND sender_profile_id = $2::uuid`,
		tenantID, senderID, defaulted(provider, ProviderTwilio), next)
	if err != nil {
		return SendSlotLease{}, err
	}
	lease.WaitUntil = base
	return lease, tx.Commit(ctx)
}

func (s *Store) RecordSenderThrottleResult(ctx context.Context, tenantID, senderID, provider, errCode, errMessage string, sendErr error) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO sms_send_throttle_state (tenant_id, sender_profile_id, provider)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (tenant_id, sender_profile_id) DO NOTHING`,
		tenantID, senderID, defaulted(provider, ProviderTwilio))
	if err != nil {
		return err
	}
	if sendErr == nil {
		_, err = tx.Exec(ctx, `
			UPDATE sms_send_throttle_state
			   SET provider = $3,
			       consecutive_failures = 0,
			       suspended_until = NULL,
			       last_error_code = NULL,
			       last_error_message = NULL,
			       last_success_at = now(),
			       updated_at = now()
			 WHERE tenant_id = $1::uuid
			   AND sender_profile_id = $2::uuid`,
			tenantID, senderID, defaulted(provider, ProviderTwilio))
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	var failures int
	err = tx.QueryRow(ctx, `
		SELECT consecutive_failures
		  FROM sms_send_throttle_state
		 WHERE tenant_id = $1::uuid
		   AND sender_profile_id = $2::uuid
		 FOR UPDATE`, tenantID, senderID).Scan(&failures)
	if err != nil {
		return err
	}
	failures++
	backoff := providerBackoffDelay(errCode, errMessage, failures)
	var suspended any
	if backoff > 0 {
		suspended = time.Now().UTC().Add(backoff)
	}
	_, err = tx.Exec(ctx, `
		UPDATE sms_send_throttle_state
		   SET provider = $3,
		       consecutive_failures = $4,
		       suspended_until = $5,
		       last_error_code = NULLIF($6, ''),
		       last_error_message = NULLIF($7, ''),
		       last_failure_at = now(),
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND sender_profile_id = $2::uuid`,
		tenantID, senderID, defaulted(provider, ProviderTwilio), failures, suspended, errCode, errMessage)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) SuspendSenderUntil(ctx context.Context, tenantID, senderID, provider string, until time.Time, errCode, errMessage string) error {
	if until.IsZero() || !until.After(time.Now().UTC()) {
		return nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO sms_send_throttle_state (
			tenant_id, sender_profile_id, provider, suspended_until,
			last_error_code, last_error_message, last_failure_at
		) VALUES (
			$1::uuid, $2::uuid, $3, $4, NULLIF($5, ''), NULLIF($6, ''), now()
		)
		ON CONFLICT (tenant_id, sender_profile_id) DO UPDATE SET
			provider = EXCLUDED.provider,
			suspended_until = GREATEST(
				COALESCE(sms_send_throttle_state.suspended_until, '-infinity'::timestamptz),
				EXCLUDED.suspended_until
			),
			last_error_code = EXCLUDED.last_error_code,
			last_error_message = EXCLUDED.last_error_message,
			last_failure_at = now(),
			updated_at = now()`,
		tenantID, senderID, defaulted(provider, ProviderTwilio), until, errCode, errMessage)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) CompleteQueuedRecipient(ctx context.Context, row QueuedRecipient, msg Message, result ProviderResult) error {
	tx, err := db.WithTenant(ctx, s.Pool, row.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE sms_campaign_recipients
		   SET status = 'sent',
		       provider_message_id = NULLIF($3, ''),
		       message_id = $4::uuid,
		       error_code = NULLIF($5, ''),
		       error_message = NULLIF($6, ''),
		       cost_micros = $7,
		       sent_at = now(),
		       lease_owner = NULL,
		       leased_until = NULL,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid`,
		row.TenantID, row.ID, result.MessageID, msg.ID, result.ErrorCode, result.ErrorMessage, result.PriceMicros)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RetryQueuedRecipient(ctx context.Context, row QueuedRecipient, errCode, errMessage string, maxAttempts int) error {
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	status := "queued"
	nextAttempt := time.Now().UTC().Add(time.Duration(row.Attempts) * time.Minute)
	if row.Attempts >= maxAttempts {
		status = "failed"
		nextAttempt = time.Now().UTC()
	}
	tx, err := db.WithTenant(ctx, s.Pool, row.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE sms_campaign_recipients
		   SET status = $3,
		       error_code = NULLIF($4, ''),
		       error_message = NULLIF($5, ''),
		       next_attempt_at = $6,
		       lease_owner = NULL,
		       leased_until = NULL,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid`,
		row.TenantID, row.ID, status, errCode, errMessage, nextAttempt)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RetryQueuedRecipientAt(ctx context.Context, row QueuedRecipient, errCode, errMessage string, nextAttempt time.Time) error {
	if nextAttempt.IsZero() {
		nextAttempt = time.Now().UTC().Add(time.Minute)
	}
	tx, err := db.WithTenant(ctx, s.Pool, row.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE sms_campaign_recipients
		   SET status = 'queued',
		       error_code = NULLIF($3, ''),
		       error_message = NULLIF($4, ''),
		       next_attempt_at = $5,
		       lease_owner = NULL,
		       leased_until = NULL,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid`,
		row.TenantID, row.ID, errCode, errMessage, nextAttempt)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) BlockQueuedRecipient(ctx context.Context, row QueuedRecipient, reason string) error {
	tx, err := db.WithTenant(ctx, s.Pool, row.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE sms_campaign_recipients
		   SET status = 'blocked',
		       gate_reason = NULLIF($3, ''),
		       lease_owner = NULL,
		       leased_until = NULL,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid`, row.TenantID, row.ID, reason)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) FindDueScheduledCampaigns(ctx context.Context, limit int) ([]Campaign, error) {
	if !s.SMSWorkerIdentityAvailable {
		return nil, ErrSMSWorkerIdentityUnavailable
	}
	if limit <= 0 || limit > 100 {
		limit = 16
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT c.id::text, c.tenant_id::text, COALESCE(c.sender_profile_id::text, ''),
		       COALESCE(c.list_id::text, ''), c.name, c.body, COALESCE(c.media_url, ''),
		       c.status, c.scheduled_at, c.sent_at, c.stats, c.metadata, c.created_at, c.updated_at
		  FROM sms_campaigns c
		  JOIN sms_sender_profiles sp
		    ON sp.tenant_id = c.tenant_id
		   AND sp.id = c.sender_profile_id
		 WHERE c.status = 'scheduled'
		   AND c.scheduled_at <= now()
		   AND COALESCE(LOWER(COALESCE(sp.metadata #>> '{sending,paused}', sp.metadata->>'paused')), 'false') NOT IN ('true', '1', 'yes', 'on')
		 ORDER BY c.scheduled_at ASC
		 LIMIT $1
		 FOR UPDATE OF c SKIP LOCKED`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Campaign{}
	for rows.Next() {
		item, err := scanCampaign(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) RefreshCampaignStats(ctx context.Context, tenantID, campaignID string) (Campaign, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Campaign{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	stats := map[string]any{}
	rows, err := tx.Query(ctx, `
		SELECT status, count(*), COALESCE(sum(segments), 0), COALESCE(sum(cost_micros), 0)
		  FROM sms_campaign_recipients
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid
		 GROUP BY status`, tenantID, campaignID)
	if err != nil {
		return Campaign{}, err
	}
	total := 0
	active := 0
	sent := 0
	for rows.Next() {
		var status string
		var count, segments int
		var cost int64
		if err := rows.Scan(&status, &count, &segments, &cost); err != nil {
			rows.Close()
			return Campaign{}, err
		}
		stats[status] = count
		total += count
		if status == "queued" || status == "sending" {
			active += count
		}
		if status == "sent" {
			sent += count
		}
		if status == "sent" {
			stats["segments"] = segments
			stats["cost_micros"] = cost
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Campaign{}, err
	}
	stats["recipients"] = total
	raw, err := json.Marshal(stats)
	if err != nil {
		return Campaign{}, err
	}
	finalStatus := ""
	if total > 0 && active == 0 {
		if sent > 0 {
			finalStatus = "sent"
		} else {
			finalStatus = "failed"
		}
	}
	row := tx.QueryRow(ctx, `
		UPDATE sms_campaigns
		   SET stats = $3::jsonb,
		       status = CASE WHEN $4 = '' THEN status ELSE $4 END,
		       sent_at = CASE WHEN $4 = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		RETURNING id::text, tenant_id::text, COALESCE(sender_profile_id::text, ''),
		          COALESCE(list_id::text, ''), name, body, COALESCE(media_url, ''),
		          status, scheduled_at, sent_at, stats, metadata, created_at, updated_at`,
		tenantID, campaignID, raw, finalStatus)
	out, err := scanCampaign(row)
	if err != nil {
		return Campaign{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) CampaignReport(ctx context.Context, tenantID, campaignID string) (CampaignReport, error) {
	campaign, err := s.GetCampaign(ctx, tenantID, campaignID)
	if err != nil {
		return CampaignReport{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return CampaignReport{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	report := CampaignReport{Campaign: campaign, StatusCounts: map[string]int{}}
	rows, err := tx.Query(ctx, `
		SELECT status, count(*), COALESCE(sum(segments), 0), COALESCE(sum(cost_micros), 0)
		  FROM sms_campaign_recipients
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid
		 GROUP BY status`, tenantID, campaignID)
	if err != nil {
		return CampaignReport{}, err
	}
	for rows.Next() {
		var status string
		var count, segments int
		var cost int64
		if err := rows.Scan(&status, &count, &segments, &cost); err != nil {
			rows.Close()
			return CampaignReport{}, err
		}
		report.StatusCounts[status] = count
		report.Recipients += count
		report.Segments += segments
		report.CostMicros += cost
		switch status {
		case "queued":
			report.Queued = count
		case "sending":
			report.Sending = count
		case "sent":
			report.Sent = count
		case "blocked":
			report.Blocked = count
		case "failed":
			report.Failed = count
		case "cancelled":
			report.Cancelled = count
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return CampaignReport{}, err
	}
	rows, err = tx.Query(ctx, `
		SELECT status, count(*)
		  FROM sms_messages
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid
		 GROUP BY status`, tenantID, campaignID)
	if err != nil {
		return CampaignReport{}, err
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return CampaignReport{}, err
		}
		switch status {
		case "delivered":
			report.Delivered = count
		case "undelivered":
			report.Undelivered = count
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return CampaignReport{}, err
	}
	if err := tx.QueryRow(ctx, `
		SELECT count(*), count(DISTINCT phone_e164)
		  FROM sms_link_clicks
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid`, tenantID, campaignID).Scan(&report.Clicks, &report.UniqueClickers); err != nil {
		return CampaignReport{}, err
	}
	rows, err = tx.Query(ctx, `
		SELECT url, count(*), count(DISTINCT phone_e164), max(clicked_at)
		  FROM sms_link_clicks
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid
		 GROUP BY url
		 ORDER BY count(*) DESC, max(clicked_at) DESC
		 LIMIT 10`, tenantID, campaignID)
	if err != nil {
		return CampaignReport{}, err
	}
	for rows.Next() {
		var item CampaignLinkClickSummary
		if err := rows.Scan(&item.URL, &item.Clicks, &item.UniqueClickers, &item.LastClickedAt); err != nil {
			rows.Close()
			return CampaignReport{}, err
		}
		report.LinkClicks = append(report.LinkClicks, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return CampaignReport{}, err
	}
	rows, err = tx.Query(ctx, `
		SELECT phone_e164, COALESCE(message_id::text, ''), url, clicked_at
		  FROM sms_link_clicks
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid
		 ORDER BY clicked_at DESC
		 LIMIT 25`, tenantID, campaignID)
	if err != nil {
		return CampaignReport{}, err
	}
	for rows.Next() {
		var item CampaignLinkClickEvent
		if err := rows.Scan(&item.PhoneE164, &item.MessageID, &item.URL, &item.ClickedAt); err != nil {
			rows.Close()
			return CampaignReport{}, err
		}
		report.RecentClicks = append(report.RecentClicks, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return CampaignReport{}, err
	}
	return report, tx.Commit(ctx)
}

// CampaignVariantStats aggregates per-variant send outcomes for an A/B
// campaign (SMS-036). Only recipients stamped with a variant label are
// counted; a non-A/B campaign returns an empty slice.
func (s *Store) CampaignVariantStats(ctx context.Context, tenantID, campaignID string) ([]CampaignVariantStat, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT metadata->>'variant',
		       count(*),
		       count(*) FILTER (WHERE status = 'sent'),
		       count(*) FILTER (WHERE status IN ('failed', 'undelivered')),
		       count(*) FILTER (WHERE status = 'blocked'),
		       COALESCE(sum(segments), 0),
		       COALESCE(sum(cost_micros), 0)
		  FROM sms_campaign_recipients
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid
		   AND COALESCE(metadata->>'variant', '') <> ''
		 GROUP BY metadata->>'variant'
		 ORDER BY metadata->>'variant'`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CampaignVariantStat{}
	for rows.Next() {
		var v CampaignVariantStat
		if err := rows.Scan(&v.Variant, &v.Total, &v.Sent, &v.Failed, &v.Blocked, &v.Segments, &v.CostMicros); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) CampaignReportRows(ctx context.Context, tenantID, campaignID, status string, limit int) ([]CampaignReportExportRow, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	if status == "" {
		status = "all"
	}
	if !oneOf(status, "all", "queued", "sending", "sent", "blocked", "failed", "cancelled", "delivered", "undelivered", "problems") {
		return nil, fmt.Errorf("unsupported report status filter")
	}
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT r.phone_e164, r.status, COALESCE(m.status, ''), r.attempts,
		       r.segments, r.cost_micros, COALESCE(r.provider_message_id, COALESCE(m.provider_message_id, '')),
		       COALESCE(r.error_code, COALESCE(m.error_code, '')),
		       COALESCE(r.error_message, COALESCE(m.error_message, '')),
		       r.created_at, r.updated_at, m.sent_at, m.delivered_at
		  FROM sms_campaign_recipients r
		  LEFT JOIN LATERAL (
			SELECT status, provider_message_id, error_code, error_message, sent_at, delivered_at, created_at
			  FROM sms_messages m
			 WHERE m.tenant_id = r.tenant_id
			   AND m.campaign_id = r.campaign_id
			   AND m.phone_e164 = r.phone_e164
			 ORDER BY m.created_at DESC
			 LIMIT 1
		  ) m ON true
		 WHERE r.tenant_id = $1::uuid
		   AND r.campaign_id = $2::uuid
		   AND (
		     $3 = 'all'
		     OR r.status = $3
		     OR COALESCE(m.status, '') = $3
		     OR (
		       $3 = 'problems'
		       AND (
		         r.status IN ('blocked', 'failed', 'cancelled')
		         OR COALESCE(m.status, '') IN ('failed', 'undelivered')
		       )
		     )
		   )
		 ORDER BY r.updated_at DESC
		 LIMIT $4`, tenantID, campaignID, status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CampaignReportExportRow{}
	for rows.Next() {
		var item CampaignReportExportRow
		if err := rows.Scan(&item.PhoneE164, &item.RecipientStatus, &item.MessageStatus,
			&item.Attempts, &item.Segments, &item.CostMicros, &item.ProviderMessageID,
			&item.ErrorCode, &item.ErrorMessage, &item.QueuedAt, &item.UpdatedAt,
			&item.SentAt, &item.DeliveredAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func scanCampaign(row scanner) (Campaign, error) {
	var out Campaign
	var statsRaw, metaRaw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.SenderProfileID, &out.ListID,
		&out.Name, &out.Body, &out.MediaURL, &out.Status, &out.ScheduledAt,
		&out.SentAt, &statsRaw, &metaRaw, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return Campaign{}, err
	}
	var err error
	out.Stats, err = decodeProjectionObject(statsRaw)
	if err != nil {
		return Campaign{}, err
	}
	out.Metadata, err = decodeProjectionObject(metaRaw)
	if err != nil || !validCampaignProjection(out) {
		return Campaign{}, errSMSProjectionOutsideContract
	}
	return out, nil
}

func validateCampaignInput(in *CampaignInput) ([]byte, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.Status = defaulted(strings.ToLower(strings.TrimSpace(in.Status)), "draft")
	in.SenderProfileID = strings.TrimSpace(in.SenderProfileID)
	in.ListID = strings.TrimSpace(in.ListID)
	in.MediaURL = strings.TrimSpace(in.MediaURL)
	invalid := func(message string) ([]byte, error) {
		return nil, fmt.Errorf("%w: %s", ErrInvalidCampaignInput, message)
	}
	if in.Name == "" || !validInboxText(in.Name, 1024) || len([]rune(in.Name)) > 256 {
		return invalid("name is outside the private campaign contract")
	}
	if !validSMSInboxBody(in.Body, false) {
		return invalid("body is outside the SMS body contract")
	}
	if in.MediaURL != "" && !validReplyMediaURL(in.MediaURL) {
		return invalid("media_url must be absolute HTTPS without credentials or fragments")
	}
	if in.SenderProfileID != "" && !validCanonicalUUIDV4(in.SenderProfileID) {
		return invalid("sender_profile_id must be a canonical lowercase UUIDv4")
	}
	if in.ListID != "" && !validCanonicalUUIDV4(in.ListID) {
		return invalid("list_id must be a canonical lowercase UUIDv4")
	}
	if !oneOf(in.Status, "draft", "scheduled", "paused") {
		return invalid("status must be draft, scheduled, or paused")
	}
	if in.Status == "scheduled" && (in.ScheduledAt == nil || !validProjectionTime(*in.ScheduledAt) || !in.ScheduledAt.After(time.Now())) {
		return invalid("scheduled_at must be a future contract timestamp")
	}
	meta, err := json.Marshal(nilMap(in.Metadata))
	if err != nil || len(meta) > 4096 {
		return invalid("metadata must be a JSON object no larger than 4096 bytes")
	}
	return meta, nil
}

func ensureCampaignReferencesTx(ctx context.Context, tx pgx.Tx, tenantID, senderID, listID string) error {
	var owned bool
	if senderID != "" {
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sms_sender_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid)`, tenantID, senderID).Scan(&owned); err != nil {
			return err
		}
		if !owned {
			return fmt.Errorf("%w: sender_profile_id does not belong to this tenant", ErrInvalidCampaignInput)
		}
	}
	if listID != "" {
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sms_lists WHERE tenant_id=$1::uuid AND id=$2::uuid)`, tenantID, listID).Scan(&owned); err != nil {
			return err
		}
		if !owned {
			return fmt.Errorf("%w: list_id does not belong to this tenant", ErrInvalidCampaignInput)
		}
	}
	return nil
}

func scanQueuedRecipient(row scanner) (QueuedRecipient, error) {
	var out QueuedRecipient
	var metaRaw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.CampaignID, &out.SenderProfileID,
		&out.ListID, &out.PhoneE164, &out.Body, &out.MediaURL, &out.Segments,
		&out.Attempts, &out.LinkTracking, &metaRaw); err != nil {
		return QueuedRecipient{}, err
	}
	out.Metadata = decodeMap(metaRaw)
	return out, nil
}
