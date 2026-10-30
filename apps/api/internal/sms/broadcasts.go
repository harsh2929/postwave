package sms

// broadcasts.go — SMS broadcast campaigns (roadmap: "SMS broadcasts —
// the composer is the missing 20%").
//
// A broadcast is the composer-facing object backed by migration 0388
// (sms_broadcasts). It expresses its audience the way email campaigns
// do (list / segment), extended to the SMS shape:
//
//   * list_ids   — one or more sms_lists; audience = union of
//     opted-in sms_subscriptions rows in those lists.
//   * segment_id — a saved segment; membership comes from the
//     segment_subscribers materialised cache (0279) and is linked to
//     SMS consent through sms_subscriptions.subscriber_email.
//   * tag        — subscribers.tags membership, linked to SMS consent
//     the same way.
//
// Exactly one audience dimension may be set.
//
// Execution rides the EXISTING send engine: sending a broadcast
// creates a shadow sms_campaigns row and enqueues the resolved,
// consent-valid, non-suppressed phones into sms_campaign_recipients.
// The 0098 queue worker then drains them through Store.Gate exactly
// like any campaign send — quiet hours become a temporal hold
// (error_code = 'quiet_hours', requeued for the window end),
// suppressions and consent revocations become hard blocks, and the
// per-sender throttle applies. There is no parallel sender.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	BroadcastStatusDraft     = "draft"
	BroadcastStatusScheduled = "scheduled"
	BroadcastStatusSending   = "sending"
	BroadcastStatusSent      = "sent"
	BroadcastStatusCancelled = "cancelled"

	// EnvBroadcastMaxRecipients caps the resolved audience size per
	// broadcast. Resolving above the cap fails with the typed
	// `audience_too_large` error instead of silently truncating.
	EnvBroadcastMaxRecipients     = "SMS_BROADCAST_MAX_RECIPIENTS"
	DefaultBroadcastMaxRecipients = 10000

	// broadcastCampaignMetaKey marks the shadow sms_campaigns row that
	// carries a broadcast through the send engine, so campaign listings
	// can exclude it and progress queries can trust the linkage.
	broadcastCampaignMetaKey = "sms_broadcast_id"
)

// Broadcast is the JSON shape served by /api/v1/sms/broadcasts.
type Broadcast struct {
	ID              string     `json:"id"`
	TenantID        string     `json:"tenant_id,omitempty"`
	SenderProfileID string     `json:"sender_profile_id,omitempty"`
	CampaignID      string     `json:"campaign_id,omitempty"`
	Name            string     `json:"name"`
	Body            string     `json:"body"`
	ListIDs         []string   `json:"list_ids"`
	SegmentID       string     `json:"segment_id,omitempty"`
	Tag             string     `json:"tag,omitempty"`
	Status          string     `json:"status"`
	ScheduledAt     *time.Time `json:"scheduled_at,omitempty"`
	SentCount       int        `json:"sent_count"`
	FailedCount     int        `json:"failed_count"`
	HeldCount       int        `json:"held_count"`
	// SegmentsPerMessage is the SMS segment estimate for the current
	// body (GSM-7 160/153, UCS-2 70/67 — the same SegmentCount the
	// gate uses), surfaced for cost awareness in the composer.
	SegmentsPerMessage int       `json:"segments_per_message"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

// HasAudience reports whether any audience dimension is set.
func (b Broadcast) HasAudience() bool {
	return len(b.ListIDs) > 0 || b.SegmentID != "" || b.Tag != ""
}

// BroadcastUpsert is the POST/PATCH body. Pointer fields distinguish
// "not sent" from zero values so PATCH only touches supplied fields.
type BroadcastUpsert struct {
	SenderProfileID *string    `json:"sender_profile_id"`
	Name            *string    `json:"name"`
	Body            *string    `json:"body"`
	ListIDs         *[]string  `json:"list_ids"`
	SegmentID       *string    `json:"segment_id"`
	Tag             *string    `json:"tag"`
	ScheduledAt     *time.Time `json:"scheduled_at"`
}

// BroadcastProgress is the GET .../{id}/progress shape.
type BroadcastProgress struct {
	Status string `json:"status"`
	Sent   int    `json:"sent"`
	Failed int    `json:"failed"`
	Held   int    `json:"held"`
	Total  int    `json:"total"`
}

// BroadcastSendResponse is returned by POST .../{id}/send.
type BroadcastSendResponse struct {
	Broadcast Broadcast         `json:"broadcast"`
	Progress  BroadcastProgress `json:"progress"`
	// Enqueued is the number of recipients queued by THIS call; a
	// replayed send (double-POST) reports 0 here while Progress.Total
	// still shows the full queue.
	Enqueued int `json:"enqueued"`
}

// BroadcastRecipient is one resolved audience member: a consent-valid,
// non-suppressed phone plus the sms_list that carries its opt-in (the
// per-row worker gate re-checks subscription status against that list
// at send time).
type BroadcastRecipient struct {
	PhoneE164 string
	ListID    string
}

// BroadcastError is the typed error surface for broadcast operations.
// Handlers map Code/Status straight into the standard error envelope.
type BroadcastError struct {
	Code    string
	Message string
	Status  int
}

func (e *BroadcastError) Error() string { return e.Message }

func broadcastErr(status int, code, message string) *BroadcastError {
	return &BroadcastError{Code: code, Message: message, Status: status}
}

func errBroadcastNotFound() *BroadcastError {
	return broadcastErr(http.StatusNotFound, "broadcast_not_found", "sms broadcast not found")
}

// ErrAudienceTooLarge builds the typed cap error.
func ErrAudienceTooLarge(cap int) *BroadcastError {
	return broadcastErr(http.StatusUnprocessableEntity, "audience_too_large",
		fmt.Sprintf("broadcast audience exceeds the per-broadcast cap of %d recipients (set %s to raise it)", cap, EnvBroadcastMaxRecipients))
}

// BroadcastMaxRecipients reads the per-broadcast audience cap from the
// environment, defaulting to DefaultBroadcastMaxRecipients.
func BroadcastMaxRecipients() int {
	raw := strings.TrimSpace(os.Getenv(EnvBroadcastMaxRecipients))
	if raw == "" {
		return DefaultBroadcastMaxRecipients
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return DefaultBroadcastMaxRecipients
	}
	return n
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// validUUID remains for legacy, non-wire campaign helpers. Private Route40
// broadcast inputs and projections use validCanonicalUUIDV4 below.
func validUUID(s string) bool { return uuidRe.MatchString(s) }

// normalizeBroadcastUpsert trims and validates the writable fields,
// returning typed 422 errors the handler can echo safely.
func normalizeBroadcastUpsert(in *BroadcastUpsert) error {
	if in.Name != nil {
		*in.Name = strings.TrimSpace(*in.Name)
		if *in.Name == "" || !validInboxText(*in.Name, 256) {
			return broadcastErr(http.StatusUnprocessableEntity, "invalid_name", "name must contain 1 to 256 safe Unicode code points")
		}
	}
	if in.Body != nil {
		*in.Body = strings.TrimSpace(*in.Body)
		if *in.Body != "" && !validSMSInboxBody(*in.Body, false) {
			return broadcastErr(http.StatusUnprocessableEntity, "sms_body_outside_contract", "body must be valid UTF-8 within 16384 bytes and 4800 Unicode code points")
		}
	}
	if in.SenderProfileID != nil {
		*in.SenderProfileID = strings.TrimSpace(*in.SenderProfileID)
		if *in.SenderProfileID != "" && !validCanonicalUUIDV4(*in.SenderProfileID) {
			return broadcastErr(http.StatusUnprocessableEntity, "invalid_sender", "sender_profile_id must be a canonical lowercase UUIDv4")
		}
	}
	if in.SegmentID != nil {
		*in.SegmentID = strings.TrimSpace(*in.SegmentID)
		if *in.SegmentID != "" && !validCanonicalUUIDV4(*in.SegmentID) {
			return broadcastErr(http.StatusUnprocessableEntity, "invalid_audience", "segment_id must be a canonical lowercase UUIDv4")
		}
	}
	if in.Tag != nil {
		*in.Tag = strings.TrimSpace(*in.Tag)
		if *in.Tag != "" && !validInboxText(*in.Tag, 64) {
			return broadcastErr(http.StatusUnprocessableEntity, "invalid_audience", "tag must contain at most 64 safe Unicode code points")
		}
	}
	if in.ListIDs != nil {
		cleaned := make([]string, 0, len(*in.ListIDs))
		seen := make(map[string]struct{}, len(*in.ListIDs))
		for _, id := range *in.ListIDs {
			id = strings.TrimSpace(id)
			if !validCanonicalUUIDV4(id) {
				return broadcastErr(http.StatusUnprocessableEntity, "invalid_audience", "list_ids entries must be canonical lowercase UUIDv4 values")
			}
			if _, duplicate := seen[id]; duplicate {
				return broadcastErr(http.StatusUnprocessableEntity, "invalid_audience", "list_ids entries must be unique")
			}
			seen[id] = struct{}{}
			cleaned = append(cleaned, id)
		}
		if len(cleaned) > 100 {
			return broadcastErr(http.StatusUnprocessableEntity, "invalid_audience", "list_ids may contain at most 100 values")
		}
		*in.ListIDs = cleaned
	}
	if in.Body != nil && SegmentCount(*in.Body) > 10 {
		return broadcastErr(http.StatusUnprocessableEntity, "too_many_segments", "body exceeds 10 SMS segments")
	}
	return nil
}

// validateBroadcastAudience enforces "exactly zero or one audience
// dimension" on the post-merge shape (email campaigns treat list and
// segment as mutually exclusive; broadcasts mirror that and add tag).
func validateBroadcastAudience(b Broadcast) error {
	dims := 0
	if len(b.ListIDs) > 0 {
		dims++
	}
	if b.SegmentID != "" {
		dims++
	}
	if b.Tag != "" {
		dims++
	}
	if dims > 1 {
		return broadcastErr(http.StatusUnprocessableEntity, "invalid_audience",
			"choose one audience: list_ids, segment_id, or tag")
	}
	return nil
}

func applyBroadcastUpsert(b *Broadcast, in BroadcastUpsert) {
	if in.SenderProfileID != nil {
		b.SenderProfileID = *in.SenderProfileID
	}
	if in.Name != nil {
		b.Name = *in.Name
	}
	if in.Body != nil {
		b.Body = *in.Body
	}
	if in.ListIDs != nil {
		b.ListIDs = *in.ListIDs
	}
	if in.SegmentID != nil {
		b.SegmentID = *in.SegmentID
	}
	if in.Tag != nil {
		b.Tag = *in.Tag
	}
	if in.ScheduledAt != nil {
		at := in.ScheduledAt.UTC()
		b.ScheduledAt = &at
	}
}

// ---------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------

const broadcastReturning = `
		RETURNING id::text, tenant_id::text,
		          COALESCE(sender_profile_id::text, ''),
		          COALESCE(campaign_id::text, ''),
		          name, body,
		          COALESCE(list_ids::text[], '{}'::text[]),
		          COALESCE(segment_id::text, ''), COALESCE(tag, ''),
		          status, scheduled_at,
		          sent_count, failed_count, held_count,
		          created_at, updated_at`

const broadcastSelect = `
		SELECT id::text, tenant_id::text,
		       COALESCE(sender_profile_id::text, ''),
		       COALESCE(campaign_id::text, ''),
		       name, body,
		       COALESCE(list_ids::text[], '{}'::text[]),
		       COALESCE(segment_id::text, ''), COALESCE(tag, ''),
		       status, scheduled_at,
		       sent_count, failed_count, held_count,
		       created_at, updated_at
		  FROM sms_broadcasts`

func scanBroadcast(row scanner) (Broadcast, error) {
	var out Broadcast
	if err := row.Scan(&out.ID, &out.TenantID, &out.SenderProfileID, &out.CampaignID,
		&out.Name, &out.Body, &out.ListIDs, &out.SegmentID, &out.Tag,
		&out.Status, &out.ScheduledAt,
		&out.SentCount, &out.FailedCount, &out.HeldCount,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return Broadcast{}, err
	}
	if out.ListIDs == nil {
		out.ListIDs = []string{}
	}
	out.SegmentsPerMessage = SegmentCount(out.Body)
	if !validBroadcastProjection(out) {
		return Broadcast{}, errSMSProjectionOutsideContract
	}
	return out, nil
}

type BroadcastsPage struct {
	Items      []Broadcast `json:"items"`
	NextCursor string      `json:"nextCursor,omitempty"`
	SnapshotAt time.Time   `json:"snapshotAt"`
}

func (s *Store) ListBroadcasts(ctx context.Context, tenantID string, cursorKey []byte, cursor inboxCursorPosition, binding string, limit int) (BroadcastsPage, error) {
	if limit < 1 || limit > 200 || cursor.SnapshotAt.IsZero() {
		return BroadcastsPage{}, errors.New("invalid broadcasts page")
	}
	tx, err := db.WithTenantOptions(ctx, s.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return BroadcastsPage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, cursor.SnapshotAt}
	keyset := ""
	if cursor.KeyID != "" {
		args = append(args, cursor.KeyAt, cursor.KeyID)
		keyset = " AND (created_at < $3 OR (created_at = $3 AND id < $4::uuid))"
	}
	args = append(args, limit+1)
	rows, err := tx.Query(ctx, broadcastSelect+`
		 WHERE tenant_id = $1::uuid AND created_at <= $2`+keyset+`
		 ORDER BY created_at DESC, id DESC
		 LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return BroadcastsPage{}, err
	}
	defer rows.Close()
	out := BroadcastsPage{Items: []Broadcast{}, SnapshotAt: cursor.SnapshotAt}
	for rows.Next() {
		item, err := scanBroadcast(rows)
		if err != nil {
			return BroadcastsPage{}, err
		}
		out.Items = append(out.Items, item)
	}
	if err := rows.Err(); err != nil {
		return BroadcastsPage{}, err
	}
	if len(out.Items) > limit {
		out.Items = out.Items[:limit]
		last := out.Items[len(out.Items)-1]
		out.NextCursor, err = encodeInboxCursor(cursorKey, tenantID, "broadcasts", binding, inboxCursorPosition{
			SnapshotAt: cursor.SnapshotAt,
			KeyAt:      last.CreatedAt,
			KeyID:      last.ID,
		})
		if err != nil {
			return BroadcastsPage{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return BroadcastsPage{}, err
	}
	return out, nil
}

func (s *Store) GetBroadcast(ctx context.Context, tenantID, id string) (Broadcast, error) {
	if !validUUID(strings.TrimSpace(id)) {
		return Broadcast{}, errBroadcastNotFound()
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Broadcast{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, broadcastSelect+`
		 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanBroadcast(row)
	if err != nil {
		if isNoRows(err) {
			return Broadcast{}, errBroadcastNotFound()
		}
		return Broadcast{}, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) CreateBroadcast(ctx context.Context, tenantID string, in BroadcastUpsert) (Broadcast, error) {
	if err := normalizeBroadcastUpsert(&in); err != nil {
		return Broadcast{}, err
	}
	var b Broadcast
	applyBroadcastUpsert(&b, in)
	if b.Name == "" {
		return Broadcast{}, broadcastErr(http.StatusUnprocessableEntity, "name_required", "broadcast name is required")
	}
	if err := validateBroadcastAudience(b); err != nil {
		return Broadcast{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Broadcast{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		INSERT INTO sms_broadcasts (
			tenant_id, sender_profile_id, name, body,
			list_ids, segment_id, tag, status, scheduled_at
		) VALUES (
			$1::uuid, NULLIF($2, '')::uuid, $3, $4,
			COALESCE($5::uuid[], '{}'::uuid[]), NULLIF($6, '')::uuid, NULLIF($7, ''),
			'draft', $8
		)`+broadcastReturning,
		tenantID, b.SenderProfileID, b.Name, b.Body,
		b.ListIDs, b.SegmentID, b.Tag, b.ScheduledAt)
	out, err := scanBroadcast(row)
	if err != nil {
		return Broadcast{}, err
	}
	return out, tx.Commit(ctx)
}

// UpdateBroadcast applies a partial PATCH. Only draft and scheduled
// broadcasts are editable; anything else returns the typed 409.
func (s *Store) UpdateBroadcast(ctx context.Context, tenantID, id string, in BroadcastUpsert) (Broadcast, error) {
	if err := normalizeBroadcastUpsert(&in); err != nil {
		return Broadcast{}, err
	}
	current, err := s.GetBroadcast(ctx, tenantID, id)
	if err != nil {
		return Broadcast{}, err
	}
	if !oneOf(current.Status, BroadcastStatusDraft, BroadcastStatusScheduled) {
		return Broadcast{}, broadcastErr(http.StatusConflict, "broadcast_not_editable",
			"only draft or scheduled broadcasts can be edited")
	}
	merged := current
	applyBroadcastUpsert(&merged, in)
	// The composer PATCH is a full-form replace and always sends
	// scheduled_at (a time OR explicit null to disarm). applyBroadcastUpsert
	// only copies it when non-nil, so a null was ignored and the OLD
	// schedule was written back — a broadcast the operator believed they
	// disarmed still fired at the stale time (GAP-4#4). Honor the explicit
	// value (including nil = clear) on update.
	merged.ScheduledAt = in.ScheduledAt
	if merged.Name == "" {
		return Broadcast{}, broadcastErr(http.StatusUnprocessableEntity, "name_required", "broadcast name is required")
	}
	if err := validateBroadcastAudience(merged); err != nil {
		return Broadcast{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Broadcast{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Status guard repeated in SQL so a concurrent send between the
	// read above and this write cannot edit a sending broadcast.
	row := tx.QueryRow(ctx, `
		UPDATE sms_broadcasts
		   SET sender_profile_id = NULLIF($3, '')::uuid,
		       name = $4,
		       body = $5,
		       list_ids = COALESCE($6::uuid[], '{}'::uuid[]),
		       segment_id = NULLIF($7, '')::uuid,
		       tag = NULLIF($8, ''),
		       scheduled_at = $9,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		   AND status IN ('draft', 'scheduled')`+broadcastReturning,
		tenantID, id, merged.SenderProfileID, merged.Name, merged.Body,
		merged.ListIDs, merged.SegmentID, merged.Tag, merged.ScheduledAt)
	out, err := scanBroadcast(row)
	if err != nil {
		if isNoRows(err) {
			return Broadcast{}, broadcastErr(http.StatusConflict, "broadcast_not_editable",
				"only draft or scheduled broadcasts can be edited")
		}
		return Broadcast{}, err
	}
	return out, tx.Commit(ctx)
}

// DeleteBroadcast removes a broadcast that is not actively sending.
func (s *Store) DeleteBroadcast(ctx context.Context, tenantID, id string) error {
	if !validUUID(strings.TrimSpace(id)) {
		return errBroadcastNotFound()
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		DELETE FROM sms_broadcasts
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		   AND status <> 'sending'`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM sms_broadcasts
				 WHERE tenant_id = $1::uuid AND id = $2::uuid
			)`, tenantID, id).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return broadcastErr(http.StatusConflict, "broadcast_sending",
				"a sending broadcast cannot be deleted; cancel it first")
		}
		return errBroadcastNotFound()
	}
	return tx.Commit(ctx)
}

// ResolveBroadcastAudience resolves the broadcast audience to
// consent-valid, non-suppressed, phone-bearing recipients:
//
//   - list_ids: opted-in sms_subscriptions rows in any of the lists.
//   - segment_id: subscribers in the materialised segment cache
//     (segment_subscribers, 0279) whose email links to an opted-in
//     sms_subscriptions row — that row is where phone + SMS consent
//     live (the inbound STOP/START path writes it).
//   - tag: subscribers carrying the tag, linked the same way.
//
// Active sms_suppressions rows (the inbound STOP path writes those)
// are excluded up front; the worker gate re-checks both suppression
// and subscription status per row at send time, so a STOP that lands
// mid-broadcast still blocks delivery.
//
// Phones are de-duplicated (one send per phone per broadcast); for a
// phone opted into several matching lists the earliest consent wins
// as its gate list. Results are capped at `limit` — callers pass
// cap+1 to detect audience_too_large.
func (s *Store) ResolveBroadcastAudience(ctx context.Context, tenantID string, b Broadcast, limit int) ([]BroadcastRecipient, error) {
	if !b.HasAudience() {
		return nil, broadcastErr(http.StatusUnprocessableEntity, "audience_required",
			"set list_ids, segment_id, or tag before sending")
	}
	if err := validateBroadcastAudience(b); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = DefaultBroadcastMaxRecipients + 1
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		WITH consented AS (
			SELECT DISTINCT ON (sub.phone_e164) sub.phone_e164, sub.list_id
			  FROM sms_subscriptions sub
			 WHERE sub.tenant_id = $1::uuid
			   AND public.sms_subscription_send_eligible(
			     sub.tenant_id, sub.list_id, sub.phone_e164, sub.status,
			     sub.consent_source, sub.consent_text, sub.consent_at, sub.proof)
			   AND (
			        (cardinality($2::uuid[]) > 0 AND sub.list_id = ANY($2::uuid[]))
			     OR ($3 <> '' AND sub.subscriber_email IS NOT NULL AND EXISTS (
			            SELECT 1
			              FROM segment_subscribers ss
			              JOIN subscribers p
			                ON p.tenant_id = ss.tenant_id
			               AND p.id = ss.subscriber_id
			             WHERE ss.tenant_id = sub.tenant_id
			               AND ss.segment_id = $3::uuid
			               AND p.email = sub.subscriber_email))
			     OR ($4 <> '' AND sub.subscriber_email IS NOT NULL AND EXISTS (
			            SELECT 1
			              FROM subscribers p
			             WHERE p.tenant_id = sub.tenant_id
			               AND p.email = sub.subscriber_email
			               AND $4 = ANY(p.tags)))
			   )
			 ORDER BY sub.phone_e164, sub.consent_at NULLS LAST, sub.created_at
		)
		SELECT c.phone_e164, c.list_id::text
		  FROM consented c
		 WHERE NOT EXISTS (
		        SELECT 1 FROM sms_suppressions sup
		         WHERE sup.tenant_id = $1::uuid
		           AND sup.phone_e164 = c.phone_e164
		           AND (sup.expires_at IS NULL OR sup.expires_at > now())
		 )
		 ORDER BY c.phone_e164
		 LIMIT $5`,
		tenantID, b.ListIDs, b.SegmentID, b.Tag, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BroadcastRecipient{}
	for rows.Next() {
		var item BroadcastRecipient
		if err := rows.Scan(&item.PhoneE164, &item.ListID); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ClaimBroadcastForSend atomically flips draft|scheduled → sending and
// ensures the shadow send-engine campaign exists. Exactly one caller
// wins the claim — a concurrent or replayed POST send observes
// claimed=false and must NOT enqueue. The shadow campaign id is also
// returned for the loser so progress can be read.
func (s *Store) ClaimBroadcastForSend(ctx context.Context, tenantID string, b Broadcast) (campaignID string, claimed bool, err error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var existing *string
	err = tx.QueryRow(ctx, `
		UPDATE sms_broadcasts
		   SET status = 'sending',
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		   AND status IN ('draft', 'scheduled')
		RETURNING campaign_id::text`, tenantID, b.ID).Scan(&existing)
	if err != nil {
		if isNoRows(err) {
			// Lost the claim (or already sent/cancelled): report the
			// linked campaign without enqueueing.
			var linked *string
			if qerr := tx.QueryRow(ctx, `
				SELECT campaign_id::text FROM sms_broadcasts
				 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
				tenantID, b.ID).Scan(&linked); qerr != nil {
				if isNoRows(qerr) {
					return "", false, errBroadcastNotFound()
				}
				return "", false, qerr
			}
			if linked != nil {
				campaignID = *linked
			}
			return campaignID, false, tx.Commit(ctx)
		}
		return "", false, err
	}
	if existing != nil && *existing != "" {
		return *existing, true, tx.Commit(ctx)
	}
	meta, err := json.Marshal(map[string]any{broadcastCampaignMetaKey: b.ID})
	if err != nil {
		return "", false, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO sms_campaigns (
			tenant_id, sender_profile_id, name, body, status, metadata
		) VALUES (
			$1::uuid, NULLIF($2, '')::uuid, $3, $4, 'sending', $5::jsonb
		)
		RETURNING id::text`,
		tenantID, b.SenderProfileID, "[broadcast] "+b.Name, b.Body, meta).Scan(&campaignID); err != nil {
		return "", false, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sms_broadcasts
		   SET campaign_id = $3::uuid, updated_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, b.ID, campaignID); err != nil {
		return "", false, err
	}
	return campaignID, true, tx.Commit(ctx)
}

// EnqueueBroadcastRecipients inserts the resolved audience into
// sms_campaign_recipients under the shadow campaign. The
// (tenant_id, campaign_id, phone_e164) unique key + ON CONFLICT DO
// NOTHING make the enqueue idempotent even if it is ever retried.
func (s *Store) EnqueueBroadcastRecipients(ctx context.Context, tenantID, campaignID, senderProfileID, broadcastID, body string, segments int, recipients []BroadcastRecipient) (int, error) {
	if len(recipients) == 0 {
		return 0, nil
	}
	meta, err := json.Marshal(map[string]any{
		"broadcast":              true,
		broadcastCampaignMetaKey: broadcastID,
	})
	if err != nil {
		return 0, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queued := 0
	for _, recipient := range recipients {
		tag, err := tx.Exec(ctx, `
			INSERT INTO sms_campaign_recipients (
				tenant_id, campaign_id, sender_profile_id, list_id, phone_e164,
				body, segments, status, link_tracking, metadata
			) VALUES (
				$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
				$6, $7, 'queued', false, $8::jsonb
			)
			ON CONFLICT (tenant_id, campaign_id, phone_e164) DO NOTHING`,
			tenantID, campaignID, senderProfileID, recipient.ListID, recipient.PhoneE164,
			body, segments, meta)
		if err != nil {
			return queued, err
		}
		if tag.RowsAffected() > 0 {
			queued++
		}
	}
	return queued, tx.Commit(ctx)
}

// MarkBroadcastScheduled flips draft|scheduled → scheduled (POST send
// with a future scheduled_at: honor the schedule instead of sending).
func (s *Store) MarkBroadcastScheduled(ctx context.Context, tenantID, id string) (Broadcast, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Broadcast{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		UPDATE sms_broadcasts
		   SET status = 'scheduled', updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		   AND status IN ('draft', 'scheduled')`+broadcastReturning, tenantID, id)
	out, err := scanBroadcast(row)
	if err != nil {
		if isNoRows(err) {
			return Broadcast{}, broadcastErr(http.StatusConflict, "broadcast_not_sendable",
				"broadcast is not in a schedulable state")
		}
		return Broadcast{}, err
	}
	return out, tx.Commit(ctx)
}

// CancelBroadcast cancels a draft, scheduled, or sending broadcast.
// For a sending broadcast the shadow campaign is cancelled too and any
// still-queued recipients (including quiet-hours holds) are marked
// cancelled so the worker never picks them up.
func (s *Store) CancelBroadcast(ctx context.Context, tenantID, id string) (Broadcast, error) {
	if !validUUID(strings.TrimSpace(id)) {
		return Broadcast{}, errBroadcastNotFound()
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Broadcast{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		UPDATE sms_broadcasts
		   SET status = 'cancelled', updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid
		   AND status IN ('draft', 'scheduled', 'sending')`+broadcastReturning, tenantID, id)
	out, err := scanBroadcast(row)
	if err != nil {
		if isNoRows(err) {
			var status string
			if qerr := tx.QueryRow(ctx, `
				SELECT status FROM sms_broadcasts
				 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
				tenantID, id).Scan(&status); qerr != nil {
				if isNoRows(qerr) {
					return Broadcast{}, errBroadcastNotFound()
				}
				return Broadcast{}, qerr
			}
			return Broadcast{}, broadcastErr(http.StatusConflict, "broadcast_not_cancellable",
				"a "+status+" broadcast cannot be cancelled")
		}
		return Broadcast{}, err
	}
	if out.CampaignID != "" {
		if _, err := tx.Exec(ctx, `
			UPDATE sms_campaigns
			   SET status = 'cancelled', updated_at = now()
			 WHERE tenant_id = $1::uuid
			   AND id = $2::uuid
			   AND status NOT IN ('sent', 'cancelled')`, tenantID, out.CampaignID); err != nil {
			return Broadcast{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE sms_campaign_recipients
			   SET status = 'cancelled', updated_at = now()
			 WHERE tenant_id = $1::uuid
			   AND campaign_id = $2::uuid
			   AND status = 'queued'`, tenantID, out.CampaignID); err != nil {
			return Broadcast{}, err
		}
	}
	return out, tx.Commit(ctx)
}

// SyncBroadcastProgress recomputes the denormalised counters from
// sms_campaign_recipients and finalizes sending → sent once nothing is
// pending. "held" = queued/sending rows the worker deferred for quiet
// hours (it requeues them with error_code = 'quiet_hours' and a
// next_attempt_at at the window end — GAP-LS-145 semantics).
func (s *Store) SyncBroadcastProgress(ctx context.Context, tenantID, id string) (Broadcast, BroadcastProgress, error) {
	b, err := s.GetBroadcast(ctx, tenantID, id)
	if err != nil {
		return Broadcast{}, BroadcastProgress{}, err
	}
	if b.CampaignID == "" {
		return b, BroadcastProgress{Status: b.Status}, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Broadcast{}, BroadcastProgress{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var sent, failed, held, pending, total int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(COUNT(*) FILTER (WHERE status = 'sent'), 0),
		       COALESCE(COUNT(*) FILTER (WHERE status IN ('failed', 'blocked')), 0),
		       COALESCE(COUNT(*) FILTER (WHERE status IN ('queued', 'sending') AND error_code = 'quiet_hours'), 0),
		       COALESCE(COUNT(*) FILTER (WHERE status IN ('queued', 'sending')), 0),
		       COUNT(*)
		  FROM sms_campaign_recipients
		 WHERE tenant_id = $1::uuid
		   AND campaign_id = $2::uuid`,
		tenantID, b.CampaignID).Scan(&sent, &failed, &held, &pending, &total); err != nil {
		return Broadcast{}, BroadcastProgress{}, err
	}
	nextStatus := b.Status
	if b.Status == BroadcastStatusSending && total > 0 && pending == 0 {
		nextStatus = BroadcastStatusSent
	}
	row := tx.QueryRow(ctx, `
		UPDATE sms_broadcasts
		   SET sent_count = $3,
		       failed_count = $4,
		       held_count = $5,
		       status = $6,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid
		   AND id = $2::uuid`+broadcastReturning,
		tenantID, id, sent, failed, held, nextStatus)
	out, err := scanBroadcast(row)
	if err != nil {
		if isNoRows(err) {
			return Broadcast{}, BroadcastProgress{}, errBroadcastNotFound()
		}
		return Broadcast{}, BroadcastProgress{}, err
	}
	progress := BroadcastProgress{
		Status: out.Status,
		Sent:   sent,
		Failed: failed,
		Held:   held,
		Total:  total,
	}
	return out, progress, tx.Commit(ctx)
}

// broadcastRef identifies a broadcast across tenants for a dedicated worker
// identity. Ordinary API-role discovery is release-held by migration 1982.
type broadcastRef struct {
	ID       string
	TenantID string
}

// FindDueScheduledBroadcasts returns scheduled broadcasts whose
// scheduled_at has passed. Cross-tenant worker scope.
func (s *Store) FindDueScheduledBroadcasts(ctx context.Context, limit int) ([]broadcastRef, error) {
	if limit <= 0 || limit > 100 {
		limit = 16
	}
	return s.broadcastRefs(ctx, `
		SELECT id::text, tenant_id::text
		  FROM sms_broadcasts
		 WHERE status = 'scheduled'
		   AND scheduled_at IS NOT NULL
		   AND scheduled_at <= now()
		 ORDER BY scheduled_at ASC
		 LIMIT $1`, limit)
}

// FindSendingBroadcasts returns broadcasts currently in 'sending' so
// the worker sweep can refresh counters and finalize completed ones.
func (s *Store) FindSendingBroadcasts(ctx context.Context, limit int) ([]broadcastRef, error) {
	if limit <= 0 || limit > 200 {
		limit = 32
	}
	return s.broadcastRefs(ctx, `
		SELECT id::text, tenant_id::text
		  FROM sms_broadcasts
		 WHERE status = 'sending'
		 ORDER BY updated_at ASC
		 LIMIT $1`, limit)
}

func (s *Store) broadcastRefs(ctx context.Context, query string, limit int) ([]broadcastRef, error) {
	if !s.SMSWorkerIdentityAvailable {
		return nil, ErrSMSWorkerIdentityUnavailable
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []broadcastRef{}
	for rows.Next() {
		var ref broadcastRef
		if err := rows.Scan(&ref.ID, &ref.TenantID); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// Send orchestration (shared by the HTTP handler and the worker sweep)
// ---------------------------------------------------------------------

type BroadcastBudgetReservation interface {
	Commit(context.Context) error
	Release(context.Context) error
}

type BroadcastBudgetReserver interface {
	ReserveBroadcast(ctx context.Context, tenantID, broadcastID string, worstCaseSegments int) (BroadcastBudgetReservation, error)
}

// sendBroadcast executes POST .../{id}/send semantics: honor a future
// scheduled_at (→ scheduled), otherwise resolve the audience, enforce
// the cap, claim the broadcast (idempotent — a double-POST or replay
// observes claimed=false and enqueues nothing), and enqueue every
// recipient into the existing send worker/gate path.
func (d *Deps) sendBroadcast(ctx context.Context, tenantID, id string, now time.Time) (BroadcastSendResponse, error) {
	if !smsDispatchSagaReleaseReady {
		return BroadcastSendResponse{}, broadcastErr(http.StatusServiceUnavailable, "sms_broadcast_dispatch_release_held",
			"broadcast scheduling and sending remain held until durable provider reconciliation and budget settlement are available")
	}
	store := d.store()
	if !store.SMSWorkerIdentityAvailable {
		return BroadcastSendResponse{}, broadcastErr(http.StatusServiceUnavailable, "sms_dispatch_worker_unavailable",
			"broadcast scheduling and sending remain held until the dedicated SMS worker identity is available")
	}
	b, err := store.GetBroadcast(ctx, tenantID, id)
	if err != nil {
		return BroadcastSendResponse{}, err
	}
	switch b.Status {
	case BroadcastStatusSending, BroadcastStatusSent:
		// Idempotent replay: report progress, enqueue nothing.
		updated, progress, err := store.SyncBroadcastProgress(ctx, tenantID, id)
		if err != nil {
			return BroadcastSendResponse{}, err
		}
		return BroadcastSendResponse{Broadcast: updated, Progress: progress}, nil
	case BroadcastStatusCancelled:
		return BroadcastSendResponse{}, broadcastErr(http.StatusConflict, "broadcast_not_sendable",
			"a cancelled broadcast cannot be sent")
	}
	if d.BroadcastBudget == nil {
		return BroadcastSendResponse{}, broadcastErr(http.StatusServiceUnavailable, "sms_financial_reservation_unavailable",
			"broadcast scheduling and sending remain held until durable SMS credit reservation is available")
	}
	if strings.TrimSpace(b.Body) == "" {
		return BroadcastSendResponse{}, broadcastErr(http.StatusUnprocessableEntity, "body_required",
			"broadcast body is required before sending")
	}
	if b.SenderProfileID == "" {
		return BroadcastSendResponse{}, broadcastErr(http.StatusUnprocessableEntity, "sender_required",
			"broadcast sender_profile_id is required before sending")
	}
	if !b.HasAudience() {
		return BroadcastSendResponse{}, broadcastErr(http.StatusUnprocessableEntity, "audience_required",
			"set list_ids, segment_id, or tag before sending")
	}
	sender, err := store.GetSender(ctx, tenantID, b.SenderProfileID)
	if err != nil {
		return BroadcastSendResponse{}, err
	}
	if !providerConfiguredForSender(d.Provider, sender) {
		return BroadcastSendResponse{}, broadcastErr(http.StatusServiceUnavailable, "sms_sender_provider_unconfigured",
			"the selected sender provider transport is not configured")
	}
	if SenderPaused(sender.Metadata) {
		return BroadcastSendResponse{}, broadcastErr(http.StatusConflict, "sender_paused",
			"sender is paused by kill switch")
	}
	maxRecipients := BroadcastMaxRecipients()
	recipients, err := store.ResolveBroadcastAudience(ctx, tenantID, b, maxRecipients+1)
	if err != nil {
		return BroadcastSendResponse{}, err
	}
	if len(recipients) > maxRecipients {
		return BroadcastSendResponse{}, ErrAudienceTooLarge(maxRecipients)
	}
	if len(recipients) == 0 {
		return BroadcastSendResponse{}, broadcastErr(http.StatusUnprocessableEntity, "no_consented_recipients",
			"no opted-in, non-suppressed recipients found for the broadcast audience")
	}
	segments := SegmentCount(b.Body)
	reservation, err := d.BroadcastBudget.ReserveBroadcast(ctx, tenantID, b.ID, segments*len(recipients))
	if err != nil {
		return BroadcastSendResponse{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = reservation.Release(context.Background())
		}
	}()
	if b.ScheduledAt != nil && b.ScheduledAt.After(now) {
		scheduled, err := store.MarkBroadcastScheduled(ctx, tenantID, id)
		if err != nil {
			return BroadcastSendResponse{}, err
		}
		if err := reservation.Commit(ctx); err != nil {
			return BroadcastSendResponse{}, err
		}
		committed = true
		return BroadcastSendResponse{
			Broadcast: scheduled,
			Progress:  BroadcastProgress{Status: scheduled.Status},
		}, nil
	}
	campaignID, claimed, err := store.ClaimBroadcastForSend(ctx, tenantID, b)
	if err != nil {
		return BroadcastSendResponse{}, err
	}
	enqueued := 0
	if claimed {
		enqueued, err = store.EnqueueBroadcastRecipients(ctx, tenantID, campaignID,
			b.SenderProfileID, b.ID, b.Body, segments, recipients)
		if err != nil {
			return BroadcastSendResponse{}, err
		}
	}
	if err := reservation.Commit(ctx); err != nil {
		return BroadcastSendResponse{}, err
	}
	committed = true
	updated, progress, err := store.SyncBroadcastProgress(ctx, tenantID, id)
	if err != nil {
		return BroadcastSendResponse{}, err
	}
	return BroadcastSendResponse{Broadcast: updated, Progress: progress, Enqueued: enqueued}, nil
}
