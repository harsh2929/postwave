// SPDX-License-Identifier: AGPL-3.0-only
//
// inbox.go — two-way SMS conversational inbox. Aggregates sms_messages
// (inbound + outbound) by phone number into per-conversation threads,
// and exposes a reply endpoint that reuses the existing send pipeline.
//
// Endpoints (mounted in handlers.go alongside the existing test-send):
//
//   GET  /api/v1/sms/conversations
//     One row per distinct phone_e164 with last-message preview,
//     unread count, oldest_unread_at. Cursor-paginated by
//     last_message_at DESC.
//
//   GET  /api/v1/sms/conversations/{phone}/messages
//     Reverse-chronological thread for a single phone. Cursor paginated.
//
//   POST /api/v1/sms/conversations/{phone}/reply
//     Send an outbound SMS to {phone}. Body: {sender_profile_id, body,
//     media_url?, metadata?}. Reuses the same gating that test-send
//     applies (suppression / subscription / quiet hours / rate
//     limit).
//
//   POST /api/v1/sms/conversations/{phone}/mark-read
//     Stamps a per-conversation read marker so the unread count drops
//     to zero in the next conversations list.

package sms

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ConversationSummary is one row in the inbox list.
//
// Refined SMS Inbox PRs 2-4: SnoozeUntil / ArchivedAt / AssigneeUserID
// surface the lifecycle stamps so the inbox row can show a snoozed-
// until pill or an archived chevron without a second per-row fetch.
type ConversationSummary struct {
	PhoneE164                       string     `json:"phoneE164"`
	LastMessagePreview              string     `json:"lastMessagePreview"`
	LastMessagePreviewOmittedReason string     `json:"lastMessagePreviewOmittedReason,omitempty"`
	LastMessageAt                   time.Time  `json:"lastMessageAt"`
	LastDirection                   string     `json:"lastDirection"` // "inbound" | "outbound"
	MessageCount                    int        `json:"messageCount"`
	UnreadCount                     int        `json:"unreadCount"`
	OldestUnreadAt                  *time.Time `json:"oldestUnreadAt,omitempty"`
	// SubscriberEmail is the email of the subscriber linked to this
	// phone via sms_subscriptions, if any. Optional — phones with no
	// linked subscriber still show up in the inbox (some inbound
	// messages come from non-subscribers, e.g. a STOP from a wrong
	// number).
	SubscriberEmail string     `json:"subscriberEmail,omitempty"`
	SnoozeUntil     *time.Time `json:"snoozeUntil,omitempty"`
	ArchivedAt      *time.Time `json:"archivedAt,omitempty"`
	AssigneeUserID  *string    `json:"assigneeUserId,omitempty"`
	// StateUpdatedAt is the optimistic-lock token for operator-managed
	// lifecycle state. It is separate from read_at so opening a thread cannot
	// invalidate an otherwise-current lifecycle decision.
	StateUpdatedAt *time.Time `json:"stateUpdatedAt,omitempty"`
	// IdentityAmbiguous is true when one phone is linked to more than one
	// distinct subscriber email. SubscriberEmail is omitted in that case.
	IdentityAmbiguous bool `json:"identityAmbiguous"`
}

// ConversationStatus restricts the page to active / snoozed / archived
// rows. Refined SMS Inbox PR 2. Defaults to Active so the unfiltered
// inbox skips snoozed + archived (the operator-zero workflow).
type ConversationStatus string

const (
	StatusActive   ConversationStatus = "active"
	StatusSnoozed  ConversationStatus = "snoozed"
	StatusArchived ConversationStatus = "archived"
	// StatusAny disables the lifecycle filter — used by the All-tab
	// view that wants every row regardless of state.
	StatusAny ConversationStatus = "any"
)

// ConversationsResponse wraps a page of conversations.
//
// Refined SMS Inbox PR 1: UnreadTotal + UnknownTotal are computed
// across the WHOLE inbox (not just the filtered page) so the filter
// chips in the UI can show accurate badge counts regardless of which
// filter is currently active.
type ConversationsResponse struct {
	TenantID      string                `json:"tenantId"`
	Conversations []ConversationSummary `json:"conversations"`
	// NextCursor is an encrypted, query-bound keyset. SnapshotAt is only a
	// database-clock `created_at` insertion cutoff for messages. It is not an
	// MVCC/repeatable-read snapshot: a transaction that commits late with an
	// older created_at may appear, and mutable read/tag/state/subscription rows
	// can change page membership/order and totals between requests.
	NextCursor string    `json:"nextCursor,omitempty"`
	SnapshotAt time.Time `json:"snapshotAt"`
	// UnreadTotal is the count of conversations with at least one
	// unread inbound message — tenant-wide, ignoring `filter` so the
	// "Unread (N)" chip badge is stable when you click into it.
	UnreadTotal int `json:"unreadTotal"`
	// UnknownTotal is the count of conversations whose phone has no
	// linked sms_subscriptions row with a subscriber_email.
	UnknownTotal int `json:"unknownTotal"`
	// TotalConversations is the inbox-wide count regardless of filter.
	TotalConversations int `json:"totalConversations"`
	// Refined SMS Inbox PR 2: per-status totals for the lifecycle chips.
	// All three count the tenant-wide population (ignoring `status`)
	// so the Active / Snoozed / Archived chips show stable badges.
	ActiveTotal   int `json:"activeTotal"`
	SnoozedTotal  int `json:"snoozedTotal"`
	ArchivedTotal int `json:"archivedTotal"`
}

// ConversationFilter restricts the conversation list. Refined PR 1.
type ConversationFilter string

const (
	FilterAll               ConversationFilter = "all"
	FilterUnread            ConversationFilter = "unread"
	FilterUnknownSubscriber ConversationFilter = "unknown"
)

// ConversationSort drives ORDER BY. Default is RecentFirst (matches
// the chat-app convention). OldestUnreadFirst is the inbox-triage
// view — find the message you haven't answered yet that's been
// waiting the longest.
type ConversationSort string

const (
	SortRecentFirst       ConversationSort = "recent"
	SortOldestUnreadFirst ConversationSort = "oldest_unread"
)

// ListConversations groups sms_messages by phone_e164 and returns
// one summary per conversation. Default order: last_message_at DESC.
//
// Refined SMS Inbox PR 1:
//   - filter restricts the returned page (all / unread / unknown)
//   - sort drives ORDER BY (recent / oldest_unread)
//   - UnreadTotal + UnknownTotal + TotalConversations are computed
//     across the whole inbox (ignoring `filter`) so the filter chips
//     can show stable badge counts that don't change when the active
//     chip switches.
//
// Implementation note: the GROUP BY happens server-side. We rely on
// the (tenant_id, phone_e164, created_at DESC) index from migration
// 0098 to keep the per-phone window scan cheap; the OUTER aggregate
// joins back to itself for the latest-row body preview.
func (s *Store) ListConversations(ctx context.Context, tenantID string, cursorKey []byte, cursor inboxCursorPosition, cursorBinding string, limit int, filter ConversationFilter, sort ConversationSort, status ConversationStatus, tag string) (ConversationsResponse, error) {
	if limit < 1 || limit > 200 || cursor.SnapshotAt.IsZero() {
		return ConversationsResponse{}, errors.New("invalid conversation page")
	}
	tag = strings.TrimSpace(tag)
	tx, err := db.WithTenantOptions(ctx, s.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ConversationsResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	args := []any{tenantID, cursor.SnapshotAt}
	addArg := func(value any) string {
		args = append(args, value)
		return "$" + strconv.Itoa(len(args))
	}
	where := ""
	switch filter {
	case FilterUnread:
		where += " AND e.unread_count > 0"
	case FilterUnknownSubscriber:
		where += " AND e.identity_count = 0"
	}
	switch status {
	case StatusActive:
		where += " AND e.archived_at IS NULL AND (e.snooze_until IS NULL OR e.snooze_until <= $2)"
	case StatusSnoozed:
		where += " AND e.archived_at IS NULL AND e.snooze_until > $2"
	case StatusArchived:
		where += " AND e.archived_at IS NOT NULL"
	}
	if tag != "" {
		where += " AND EXISTS (SELECT 1 FROM sms_conversation_tags ct WHERE ct.tenant_id = $1::uuid AND ct.phone_e164 = e.phone_e164 AND ct.tag = " + addArg(tag) + ")"
	}

	order := " ORDER BY e.last_at DESC, e.phone_e164 ASC"
	if cursor.KeyID != "" {
		keyPhone := addArg(cursor.KeyID)
		if sort == SortRecentFirst {
			keyAt := addArg(cursor.KeyAt)
			where += " AND (e.last_at < " + keyAt + " OR (e.last_at = " + keyAt + " AND e.phone_e164 > " + keyPhone + "))"
		} else {
			rank := addArg(cursor.Rank)
			if cursor.KeyAtNull {
				where += " AND (e.unread_rank > " + rank + " OR (e.unread_rank = " + rank + " AND e.oldest_unread_at IS NULL AND e.phone_e164 > " + keyPhone + "))"
			} else {
				keyAt := addArg(cursor.KeyAt)
				where += " AND (e.unread_rank > " + rank + " OR (e.unread_rank = " + rank + " AND (e.oldest_unread_at > " + keyAt + " OR e.oldest_unread_at IS NULL OR (e.oldest_unread_at = " + keyAt + " AND e.phone_e164 > " + keyPhone + "))))"
			}
		}
	}
	if sort == SortOldestUnreadFirst {
		order = " ORDER BY e.unread_rank ASC, e.oldest_unread_at ASC NULLS LAST, e.phone_e164 ASC"
	}
	limitArg := addArg(limit + 1)

	rows, err := tx.Query(ctx, `
WITH agg AS (
  SELECT phone_e164,
         MAX(created_at) AS last_at,
         COUNT(*)::int AS msg_count
    FROM sms_messages
   WHERE tenant_id = $1::uuid AND created_at <= $2
   GROUP BY phone_e164
), enriched AS (
  SELECT agg.phone_e164,
         COALESCE(latest.body, '') AS last_preview,
         agg.last_at,
         COALESCE(latest.direction, 'inbound') AS last_direction,
         agg.msg_count,
         COALESCE(unread.cnt, 0)::int AS unread_count,
         CASE WHEN COALESCE(unread.cnt, 0) > 0 THEN 0 ELSE 1 END AS unread_rank,
         unread.oldest_at AS oldest_unread_at,
         COALESCE(sub.subscriber_email, '') AS subscriber_email,
         COALESCE(sub.identity_count, 0)::int AS identity_count,
		 st.snooze_until, st.archived_at, st.assignee_user_id::text,
		 st.lifecycle_updated_at
    FROM agg
    LEFT JOIN sms_conversation_state st
      ON st.tenant_id = $1::uuid AND st.phone_e164 = agg.phone_e164
    LEFT JOIN LATERAL (
      SELECT body, direction
        FROM sms_messages
       WHERE tenant_id = $1::uuid AND phone_e164 = agg.phone_e164 AND created_at <= $2
       ORDER BY created_at DESC, id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT CASE WHEN COUNT(DISTINCT subscriber_email) = 1
                  THEN MIN(subscriber_email)::text ELSE '' END AS subscriber_email,
             COUNT(DISTINCT subscriber_email)::int AS identity_count
        FROM sms_subscriptions
       WHERE tenant_id = $1::uuid AND phone_e164 = agg.phone_e164 AND subscriber_email IS NOT NULL
    ) sub ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt, MIN(m2.created_at) AS oldest_at
        FROM sms_messages m2
       WHERE m2.tenant_id = $1::uuid AND m2.phone_e164 = agg.phone_e164
         AND m2.direction = 'inbound' AND m2.created_at <= $2
         AND NOT EXISTS (
           SELECT 1 FROM sms_message_read_receipts rr
            WHERE rr.tenant_id = m2.tenant_id AND rr.message_id = m2.id
              AND rr.read_at <= $2
         )
    ) unread ON true
)
SELECT e.phone_e164, e.last_preview, e.last_at, e.last_direction,
       e.msg_count, e.unread_count, e.unread_rank, e.oldest_unread_at,
       e.subscriber_email, e.identity_count > 1 AS identity_ambiguous,
       e.snooze_until, e.archived_at, e.assignee_user_id,
       e.lifecycle_updated_at
  FROM enriched e
 WHERE true`+where+order+` LIMIT `+limitArg, args...)
	if err != nil {
		return ConversationsResponse{}, err
	}
	out := ConversationsResponse{TenantID: tenantID, Conversations: []ConversationSummary{}, SnapshotAt: cursor.SnapshotAt}
	ranks := make([]int, 0, limit+1)
	for rows.Next() {
		var c ConversationSummary
		var rank int
		if err := rows.Scan(
			&c.PhoneE164, &c.LastMessagePreview, &c.LastMessageAt,
			&c.LastDirection, &c.MessageCount, &c.UnreadCount, &rank,
			&c.OldestUnreadAt, &c.SubscriberEmail, &c.IdentityAmbiguous, &c.SnoozeUntil,
			&c.ArchivedAt, &c.AssigneeUserID, &c.StateUpdatedAt,
		); err != nil {
			rows.Close()
			return ConversationsResponse{}, err
		}
		applyConversationPreviewContract(&c)
		if !validConversationSummaryProjection(c) {
			rows.Close()
			return ConversationsResponse{}, errSMSProjectionOutsideContract
		}
		out.Conversations = append(out.Conversations, c)
		ranks = append(ranks, rank)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ConversationsResponse{}, err
	}
	rows.Close()
	if len(out.Conversations) > limit {
		out.Conversations = out.Conversations[:limit]
		ranks = ranks[:limit]
		last := out.Conversations[len(out.Conversations)-1]
		position := inboxCursorPosition{
			SnapshotAt: cursor.SnapshotAt,
			KeyAt:      last.LastMessageAt,
			KeyID:      last.PhoneE164,
			Rank:       ranks[len(ranks)-1],
		}
		if sort == SortOldestUnreadFirst {
			position.KeyAtNull = last.OldestUnreadAt == nil
			if last.OldestUnreadAt != nil {
				position.KeyAt = *last.OldestUnreadAt
			}
		}
		out.NextCursor, err = encodeInboxCursor(cursorKey, tenantID, "conversations", cursorBinding, position)
		if err != nil {
			return ConversationsResponse{}, err
		}
	}

	if err := tx.QueryRow(ctx, `
WITH phones AS (
  SELECT DISTINCT phone_e164 FROM sms_messages
   WHERE tenant_id = $1::uuid AND created_at <= $2
), enriched AS (
  SELECT p.phone_e164,
         COALESCE(sub.identity_count, 0)::int AS identity_count,
         COALESCE(unread.cnt, 0)::int AS unread_count,
         st.snooze_until, st.archived_at
    FROM phones p
    LEFT JOIN sms_conversation_state st
      ON st.tenant_id = $1::uuid AND st.phone_e164 = p.phone_e164
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT subscriber_email)::int AS identity_count
        FROM sms_subscriptions
       WHERE tenant_id = $1::uuid AND phone_e164 = p.phone_e164 AND subscriber_email IS NOT NULL
    ) sub ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM sms_messages m
       WHERE m.tenant_id = $1::uuid AND m.phone_e164 = p.phone_e164
         AND m.direction = 'inbound' AND m.created_at <= $2
         AND NOT EXISTS (
           SELECT 1 FROM sms_message_read_receipts rr
            WHERE rr.tenant_id = m.tenant_id AND rr.message_id = m.id
              AND rr.read_at <= $2
         )
    ) unread ON true
)
SELECT COUNT(*)::int,
       COUNT(*) FILTER (WHERE unread_count > 0)::int,
       COUNT(*) FILTER (WHERE identity_count = 0)::int,
       COUNT(*) FILTER (WHERE archived_at IS NULL AND (snooze_until IS NULL OR snooze_until <= $2))::int,
       COUNT(*) FILTER (WHERE archived_at IS NULL AND snooze_until > $2)::int,
       COUNT(*) FILTER (WHERE archived_at IS NOT NULL)::int
  FROM enriched`, tenantID, cursor.SnapshotAt).Scan(
		&out.TotalConversations, &out.UnreadTotal, &out.UnknownTotal,
		&out.ActiveTotal, &out.SnoozedTotal, &out.ArchivedTotal,
	); err != nil {
		return ConversationsResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ConversationsResponse{}, err
	}
	return out, nil
}

func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "…"
}

func applyConversationPreviewContract(summary *ConversationSummary) {
	if summary == nil {
		return
	}
	if strings.TrimSpace(summary.LastMessagePreview) == "" {
		summary.LastMessagePreview = ""
		summary.LastMessagePreviewOmittedReason = "legacy_body_unavailable"
		return
	}
	if !validSMSInboxBody(summary.LastMessagePreview, false) {
		summary.LastMessagePreview = ""
		summary.LastMessagePreviewOmittedReason = "body_exceeds_inbox_limit"
		return
	}
	summary.LastMessagePreview = truncateRunes(summary.LastMessagePreview, 120)
}

func applyMessageBodyProjectionContract(message *Message) {
	if message == nil {
		return
	}
	if strings.TrimSpace(message.Body) == "" {
		message.Body = ""
		message.BodyOmittedReason = "legacy_body_unavailable"
		return
	}
	if !validSMSInboxBody(message.Body, false) {
		message.Body = ""
		message.BodyOmittedReason = "body_exceeds_inbox_limit"
	}
}

type ConversationMessagesResponse struct {
	TenantID   string    `json:"tenantId"`
	Messages   []Message `json:"messages"`
	NextCursor string    `json:"nextCursor,omitempty"`
	SnapshotAt time.Time `json:"snapshotAt"`
}

// ListConversationMessages returns a stable keyset page ordered by the exact
// (created_at,id) tuple. SnapshotAt is an application-created_at boundary;
// see the cursor contract tests for the intentionally narrower semantics.
func (s *Store) ListConversationMessages(ctx context.Context, tenantID, phoneE164 string, cursorKey []byte, cursor inboxCursorPosition, cursorBinding string, limit int) (ConversationMessagesResponse, error) {
	if limit < 1 || limit > 500 || cursor.SnapshotAt.IsZero() {
		return ConversationMessagesResponse{}, errors.New("invalid message page")
	}
	phone := normalizePhoneE164ForLookup(phoneE164)
	if phone == "" {
		return ConversationMessagesResponse{}, errors.New("phone_e164 required")
	}
	tx, err := db.WithTenantOptions(ctx, s.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ConversationMessagesResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, phone, cursor.SnapshotAt}
	whereExtra := " AND created_at <= $3"
	if cursor.KeyID != "" {
		args = append(args, cursor.KeyAt, cursor.KeyID)
		whereExtra += " AND (created_at < $4 OR (created_at = $4 AND id < $5::uuid))"
	}
	args = append(args, limit+1)
	limitIdx := strconv.Itoa(len(args))
	q := `
SELECT id::text, tenant_id::text, COALESCE(campaign_id::text,''),
       COALESCE(sender_profile_id::text,''), phone_e164, provider,
       COALESCE(provider_message_id,''), direction, body,
       COALESCE(media_url,''), segments, status,
       COALESCE(error_code,''), COALESCE(error_message,''),
       COALESCE(cost_micros, 0),
       sent_at, delivered_at, received_at, created_at,
       COALESCE(dispatch_state, '')
  FROM sms_messages
 WHERE tenant_id = $1::uuid AND phone_e164 = $2` + whereExtra + `
 ORDER BY created_at DESC, id DESC
 LIMIT $` + limitIdx
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return ConversationMessagesResponse{}, err
	}
	out := ConversationMessagesResponse{TenantID: tenantID, Messages: []Message{}, SnapshotAt: cursor.SnapshotAt}
	for rows.Next() {
		var m Message
		if err := rows.Scan(
			&m.ID, &m.TenantID, &m.CampaignID, &m.SenderProfileID,
			&m.PhoneE164, &m.Provider, &m.ProviderMessageID, &m.Direction,
			&m.Body, &m.MediaURL, &m.Segments, &m.Status,
			&m.ErrorCode, &m.ErrorMessage, &m.CostMicros,
			&m.SentAt, &m.DeliveredAt, &m.ReceivedAt, &m.CreatedAt,
			&m.DispatchState,
		); err != nil {
			rows.Close()
			return ConversationMessagesResponse{}, err
		}
		// Provider callback metadata/error_message are retained as restricted
		// evidence in the database, but are untrusted text and may contain bidi
		// controls, credentials, or an echoed request. The ordinary inbox emits
		// only a bounded provider code/category and never raw metadata.
		m.Metadata = nil
		applyMessageBodyProjectionContract(&m)
		m.ErrorCode = safeInboxProviderCode(m.ErrorCode)
		if m.ErrorCode != "" {
			m.ErrorMessage = "Delivery was not completed (provider code " + m.ErrorCode + ")."
		} else if oneOf(m.Status, "failed", "undelivered", "canceled") {
			m.ErrorMessage = "Delivery was not completed by the provider."
		} else {
			m.ErrorMessage = ""
		}
		if m.MediaURL != "" && !validReplyMediaURL(m.MediaURL) {
			m.MediaURL = ""
		}
		if !validMessageProjection(m) {
			rows.Close()
			return ConversationMessagesResponse{}, errSMSProjectionOutsideContract
		}
		out.Messages = append(out.Messages, m)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ConversationMessagesResponse{}, err
	}
	rows.Close()
	if len(out.Messages) > limit {
		out.Messages = out.Messages[:limit]
		last := out.Messages[len(out.Messages)-1]
		out.NextCursor, err = encodeInboxCursor(cursorKey, tenantID, "messages", cursorBinding, inboxCursorPosition{
			SnapshotAt: cursor.SnapshotAt,
			KeyAt:      last.CreatedAt,
			KeyID:      last.ID,
		})
		if err != nil {
			return ConversationMessagesResponse{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ConversationMessagesResponse{}, err
	}
	return out, nil
}

func safeInboxProviderCode(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 64 {
		return ""
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '_' || c == '-') {
			return ""
		}
	}
	return value
}

// ConversationContext is the subscriber-side metadata for one phone
// number. Refined SMS Inbox PR 1: powers the context strip at the
// top of the thread view so an operator knows who they're talking to
// + their consent posture before replying.
type ConversationContext struct {
	TenantID        string `json:"tenantId"`
	PhoneE164       string `json:"phoneE164"`
	SubscriberEmail string `json:"subscriberEmail,omitempty"`
	// ConsentStatus across all of this phone's sms_subscriptions rows.
	// "opted_in" if any list has it opted_in, else "opted_out" if any
	// has opted_out, else "pending" or "none" if no rows exist.
	ConsentStatus             string     `json:"consentStatus"`
	ConsentSource             string     `json:"consentSource,omitempty"`
	ConsentAt                 *time.Time `json:"consentAt,omitempty"`
	OptOutAt                  *time.Time `json:"optOutAt,omitempty"`
	ConsentMixed              bool       `json:"consentMixed"`
	IdentityAmbiguous         bool       `json:"identityAmbiguous"`
	ConsentEvidenceSufficient bool       `json:"consentEvidenceSufficient"`
	// SubscribedLists is the count of distinct lists this phone is
	// currently opted_in to. 0 when nobody has opted them in.
	SubscribedLists int `json:"subscribedLists"`
	// FirstSeenAt = the earliest sms_messages.created_at for this phone.
	FirstSeenAt *time.Time `json:"firstSeenAt,omitempty"`
	// TotalMessages = inbox-wide message count for this conversation
	// (inbound + outbound).
	TotalMessages int `json:"totalMessages"`
	// LastReadAt mirrors sms_conversation_state.read_at — useful for
	// the UI to show "marked read 2h ago".
	LastReadAt *time.Time `json:"lastReadAt,omitempty"`
	// Suppressions are phone-wide and authoritative regardless of list. Only
	// manual rows are reversible through the operator suppression endpoint.
	Suppressed            bool                       `json:"suppressed"`
	SuppressionReason     string                     `json:"suppressionReason,omitempty"`
	SuppressionReversible bool                       `json:"suppressionReversible"`
	HasInboundThread      bool                       `json:"hasInboundThread"`
	EligibleLists         []ConversationEligibleList `json:"eligibleLists"`
	// ReplyDispatchAvailable is a server-composition prerequisite, not a
	// substitute for the recipient-specific consent/suppression decision above.
	// Production remains held while durable financial reservation is absent.
	ReplyDispatchAvailable         bool   `json:"replyDispatchAvailable"`
	ReplyDispatchUnavailableReason string `json:"replyDispatchUnavailableReason,omitempty"`
}

type ConversationEligibleList struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Description   string     `json:"description"`
	ConsentSource string     `json:"consentSource,omitempty"`
	ConsentAt     *time.Time `json:"consentAt,omitempty"`
}

// GetConversationContext pulls subscriber + lifecycle metadata for one
// phone. Single query against sms_subscriptions (aggregated) plus a
// small lookup for first_seen + last_read. Empty phone returns 400 at
// the handler layer; callers here trust they got a valid normalized one.
func (s *Store) GetConversationContext(ctx context.Context, tenantID, phoneE164 string) (ConversationContext, error) {
	phone := normalizePhoneE164ForLookup(phoneE164)
	if phone == "" {
		return ConversationContext{}, errors.New("phone_e164 required")
	}
	tx, err := db.WithTenantOptions(ctx, s.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ConversationContext{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := ConversationContext{TenantID: tenantID, PhoneE164: phone, ConsentStatus: "none", EligibleLists: []ConversationEligibleList{}}

	// Select status/source/timestamps from one deterministic row. Never pair an
	// opted-in badge with evidence from another opted-out row, and omit identity
	// when one phone maps to multiple subscriber emails.
	var subEmail, consentSource, statusRaw string
	var consentAt, optOutAt *time.Time
	var listCount int
	var consentMixed, identityAmbiguous bool
	err = tx.QueryRow(ctx, `
WITH rows AS (
  SELECT id, subscriber_email,
         CASE
           WHEN public.sms_subscription_send_eligible(
             tenant_id, list_id, phone_e164, status,
             consent_source, consent_text, consent_at, proof) THEN 'opted_in'
           WHEN status = 'opted_in' THEN 'pending'
           ELSE status
         END AS status,
         consent_source, consent_text, consent_at, opt_out_at, proof, list_id, updated_at
    FROM sms_subscriptions
   WHERE tenant_id = $1::uuid
     AND phone_e164 = $2
)
SELECT
  COALESCE(CASE WHEN (SELECT COUNT(DISTINCT subscriber_email) FROM rows WHERE subscriber_email IS NOT NULL) = 1
                THEN (SELECT MIN(subscriber_email)::text FROM rows) END, ''),
  COALESCE((SELECT status FROM rows ORDER BY
              CASE status WHEN 'opted_in' THEN 0 WHEN 'opted_out' THEN 1 ELSE 2 END,
              COALESCE(consent_at, opt_out_at, updated_at) DESC, id DESC LIMIT 1), 'none'),
  COALESCE((SELECT consent_source FROM rows ORDER BY
              CASE status WHEN 'opted_in' THEN 0 WHEN 'opted_out' THEN 1 ELSE 2 END,
              COALESCE(consent_at, opt_out_at, updated_at) DESC, id DESC LIMIT 1), ''),
  (SELECT consent_at FROM rows ORDER BY
      CASE status WHEN 'opted_in' THEN 0 WHEN 'opted_out' THEN 1 ELSE 2 END,
      COALESCE(consent_at, opt_out_at, updated_at) DESC, id DESC LIMIT 1),
  (SELECT opt_out_at FROM rows ORDER BY
      CASE status WHEN 'opted_in' THEN 0 WHEN 'opted_out' THEN 1 ELSE 2 END,
      COALESCE(consent_at, opt_out_at, updated_at) DESC, id DESC LIMIT 1),
  (SELECT COUNT(*)::int FROM rows
    WHERE public.sms_subscription_send_eligible(
      $1::uuid, list_id, $2, status, consent_source, consent_text, consent_at, proof)),
  (SELECT COUNT(DISTINCT status) > 1 FROM rows),
  (SELECT COUNT(DISTINCT subscriber_email) > 1 FROM rows WHERE subscriber_email IS NOT NULL)
`, tenantID, phone).Scan(&subEmail, &statusRaw, &consentSource, &consentAt, &optOutAt, &listCount, &consentMixed, &identityAmbiguous)
	if err != nil {
		return ConversationContext{}, err
	}
	out.SubscriberEmail = subEmail
	out.ConsentStatus = statusRaw
	out.ConsentSource = consentSource
	out.ConsentAt = consentAt
	out.OptOutAt = optOutAt
	out.SubscribedLists = listCount
	out.ConsentMixed = consentMixed
	out.IdentityAmbiguous = identityAmbiguous
	out.ConsentEvidenceSufficient = listCount > 0

	// Message-side rollup: first_seen, total messages, last read marker.
	var firstSeen *time.Time
	var totalMsg, inboundMsg int
	if err := tx.QueryRow(ctx, `
SELECT MIN(created_at), COUNT(*)::int,
       COUNT(*) FILTER (WHERE direction = 'inbound')::int
  FROM sms_messages
 WHERE tenant_id = $1::uuid AND phone_e164 = $2
	`, tenantID, phone).Scan(&firstSeen, &totalMsg, &inboundMsg); err != nil {
		return ConversationContext{}, err
	}
	out.FirstSeenAt = firstSeen
	out.TotalMessages = totalMsg
	out.HasInboundThread = inboundMsg > 0
	var readAt *time.Time
	if err := tx.QueryRow(ctx, `
SELECT read_at FROM sms_conversation_state
 WHERE tenant_id = $1::uuid AND phone_e164 = $2
	`, tenantID, phone).Scan(&readAt); err == nil {
		out.LastReadAt = readAt
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ConversationContext{}, err
	}
	var suppressionReason, suppressionSource string
	if err := tx.QueryRow(ctx, `
SELECT reason, source FROM sms_suppressions
 WHERE tenant_id = $1::uuid AND phone_e164 = $2
   AND (expires_at IS NULL OR expires_at > clock_timestamp())
`, tenantID, phone).Scan(&suppressionReason, &suppressionSource); err == nil {
		out.Suppressed = true
		out.SuppressionReason = suppressionReason
		out.SuppressionReversible = suppressionReason == "manual" && suppressionSource == "manual"
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ConversationContext{}, err
	}
	rows, err := tx.Query(ctx, `
SELECT l.id::text, l.name, l.description, s.consent_source, s.consent_at
  FROM sms_subscriptions s
  JOIN sms_lists l ON l.tenant_id = s.tenant_id AND l.id = s.list_id
 WHERE s.tenant_id = $1::uuid AND s.phone_e164 = $2
   AND public.sms_subscription_send_eligible(
     s.tenant_id, s.list_id, s.phone_e164, s.status,
     s.consent_source, s.consent_text, s.consent_at, s.proof)
 ORDER BY s.consent_at DESC NULLS LAST, s.id DESC
`, tenantID, phone)
	if err != nil {
		return ConversationContext{}, err
	}
	for rows.Next() {
		var item ConversationEligibleList
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &item.ConsentSource, &item.ConsentAt); err != nil {
			rows.Close()
			return ConversationContext{}, err
		}
		if !validCanonicalUUIDV4(item.ID) || strings.TrimSpace(item.Name) != item.Name || item.Name == "" ||
			!validInboxText(item.Name, 256) || !validInboxText(item.Description, 2048) ||
			!oneOf(item.ConsentSource, "keyword", "form", "import", "api", "manual") ||
			item.ConsentAt == nil || !validProjectionTime(*item.ConsentAt) {
			rows.Close()
			return ConversationContext{}, errSMSProjectionOutsideContract
		}
		out.EligibleLists = append(out.EligibleLists, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ConversationContext{}, err
	}
	rows.Close()
	if !validConversationContextProjection(out) {
		return ConversationContext{}, errSMSProjectionOutsideContract
	}
	if err := tx.Commit(ctx); err != nil {
		return ConversationContext{}, err
	}
	return out, nil
}

// MarkConversationRead stamps sms_conversation_state.read_at to now()
// so the next ListConversations sees unread_count=0 for this phone.
// Idempotent (UPSERT with EXCLUDED.read_at = GREATEST(...)).
var ErrInvalidReadBoundary = errors.New("invalid SMS read boundary")

func (s *Store) MarkConversationRead(ctx context.Context, tenantID, phoneE164 string, messageIDs []string, auditMeta db.AuditMeta) (int, error) {
	phone := normalizePhoneE164ForLookup(phoneE164)
	if phone == "" || len(messageIDs) == 0 || len(messageIDs) > 500 {
		return 0, ErrInvalidReadBoundary
	}
	seen := make(map[string]struct{}, len(messageIDs))
	for _, id := range messageIDs {
		if !validCanonicalUUIDV4(id) {
			return 0, ErrInvalidReadBoundary
		}
		if _, duplicate := seen[id]; duplicate {
			return 0, ErrInvalidReadBoundary
		}
		seen[id] = struct{}{}
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var matched int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)::int
  FROM sms_messages
 WHERE tenant_id = $1::uuid AND phone_e164 = $2 AND direction = 'inbound'
   AND id = ANY($3::uuid[])`, tenantID, phone, messageIDs).Scan(&matched); err != nil {
		return 0, err
	}
	if matched != len(messageIDs) {
		return 0, ErrInvalidReadBoundary
	}
	tag, err := tx.Exec(ctx, `
INSERT INTO sms_message_read_receipts (tenant_id, message_id)
SELECT tenant_id, id
  FROM sms_messages
 WHERE tenant_id = $1::uuid AND phone_e164 = $2 AND direction = 'inbound'
   AND id = ANY($3::uuid[])
ON CONFLICT (tenant_id, message_id) DO NOTHING`, tenantID, phone, messageIDs)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO sms_conversation_state (tenant_id, phone_e164, read_at)
SELECT $1::uuid, $2, MAX(created_at)
  FROM sms_messages
 WHERE tenant_id = $1::uuid AND phone_e164 = $2 AND id = ANY($3::uuid[])
ON CONFLICT (tenant_id, phone_e164)
DO UPDATE SET read_at = GREATEST(sms_conversation_state.read_at, EXCLUDED.read_at)`,
		tenantID, phone, messageIDs); err != nil {
		return 0, err
	}
	if err := db.Audit(ctx, tx, auditMeta, "sms.inbox.mark_read", "sms_conversation", "", map[string]any{
		"route_template": "/api/v1/sms/conversations/{phone}/mark-read",
		"message_count":  len(messageIDs),
	}); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// normalizePhoneE164ForLookup applies the same US/Canada E.164 canonicalizer
// used by all SMS writers. Inbox paths must not admit a lookup string that a
// send or suppression writer would reject.
func normalizePhoneE164ForLookup(p string) string {
	phone, err := NormalizePhoneUSCA(p)
	if err != nil {
		return ""
	}
	return phone
}

func validateInboxQuery(q map[string][]string, allowed ...string) error {
	allow := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allow[key] = struct{}{}
	}
	for key, values := range q {
		if _, ok := allow[key]; !ok {
			return errors.New("unsupported query parameter: " + key)
		}
		if len(values) != 1 {
			return errors.New("query parameter must be supplied once: " + key)
		}
	}
	return nil
}

func parseInboxLimit(raw string, defaultLimit, maxLimit int) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return defaultLimit, nil
	}
	if raw != strings.TrimSpace(raw) {
		return 0, errors.New("invalid limit")
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > maxLimit {
		return 0, errors.New("invalid limit")
	}
	return limit, nil
}

func validInboxText(value string, maxRunes int) bool {
	if !utf8.ValidString(value) || len(value) > maxRunes*4 || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, r := range value {
		// Operator metadata is rendered in high-trust workflow chrome. Reject
		// control and invisible format/bidi characters rather than asking every
		// client to defend against spoofed tags, titles, and notes independently.
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// validCanonicalUUIDV4 pins private SMS wire identifiers to the exact form
// PostgreSQL emits for server-generated gen_random_uuid() values. Accepting
// UUID aliases/other versions in path or body inputs creates avoidable
// server/client drift and lets malformed identifiers reach ::uuid casts as
// internal errors.
func validCanonicalUUIDV4(value string) bool {
	if len(value) != 36 || value != strings.ToLower(value) {
		return false
	}
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value && parsed.Version() == 4 && parsed.Variant() == uuid.RFC4122
}

func writeInboxCursorError(w http.ResponseWriter, err error) {
	if errors.Is(err, errInboxCursorUnavailable) {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("cursor_unavailable", "inbox pagination is temporarily unavailable"))
		return
	}
	if errors.Is(err, errInboxCursorExpired) {
		writeJSON(w, http.StatusBadRequest, errEnv("cursor_expired", "cursor expired; restart pagination from the first page"))
		return
	}
	if errors.Is(err, errInboxCursorMismatch) {
		writeJSON(w, http.StatusBadRequest, errEnv("cursor_query_mismatch", "cursor does not belong to this query"))
		return
	}
	writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed or expired"))
}

func (d *Deps) inboxCursorKeys() [][]byte {
	keys := [][]byte{d.InboxCursorKey}
	if validInboxCursorKey(d.InboxCursorPreviousKey) {
		keys = append(keys, d.InboxCursorPreviousKey)
	}
	return keys
}

func (s *Store) InboxDatabaseNow(ctx context.Context, tenantID string) (time.Time, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var now time.Time
	if err := tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		return time.Time{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return time.Time{}, err
	}
	return now.UTC(), nil
}

// ---------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------

func prepareSMSPrivateResponse(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func protectSMSInboxResponse(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		prepareSMSPrivateResponse(w)
		next.ServeHTTP(w, r)
	})
}

// ProtectRoute42Responses stamps the complete Route42 compliance/settings
// families before API-key parsing, tenant resolution, authorization, or route
// handlers can return. The route-local protectSMSInboxResponse middleware stays
// mounted as defense in depth for standalone composition.
func ProtectRoute42Responses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isRoute42Path(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &route42ResponseWriter{ResponseWriter: w}
		prepareSMSPrivateResponse(protected)
		// jsonRecoverer is deliberately outside this root path guard. If an
		// inner layer weakens the headers and then panics before committing a
		// response, restamp during unwind so the outer recovered 500 remains
		// inside the same private/no-store boundary.
		defer prepareSMSPrivateResponse(w)
		next.ServeHTTP(protected, r)
	})
}

type route42ResponseWriter struct {
	http.ResponseWriter
}

func (w *route42ResponseWriter) WriteHeader(status int) {
	prepareSMSPrivateResponse(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func (w *route42ResponseWriter) Write(body []byte) (int, error) {
	prepareSMSPrivateResponse(w.ResponseWriter)
	return w.ResponseWriter.Write(body)
}

// FlushError is what http.ResponseController calls to flush. A flush commits
// the headers, so the private boundary is stamped first: a flush that reached
// net/http through Unwrap alone would skip it. The underlying writer's answer
// is returned as-is, so this claims no streaming capability it lacks.
func (w *route42ResponseWriter) FlushError() error {
	prepareSMSPrivateResponse(w.ResponseWriter)
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *route42ResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func isRoute42Path(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	for _, base := range [...]string{
		"/api/v1/sms/suppressions",
		"/api/v1/sms/quiet-hours",
		"/api/v1/sms/keyword-responses",
	} {
		if path == base || strings.HasPrefix(path, base+"/") {
			return true
		}
	}
	return false
}

// MountInboxRoutes wires the inbox endpoints with a route-local admin check
// as defence in depth. Reply is intentionally mounted only from
// MountIdempotentRoutes so a keyless request can never reach provider send.
func (d *Deps) MountInboxRoutes(r chi.Router) {
	admin := []func(http.Handler) http.Handler{protectSMSInboxResponse, apikeys.RequireExactTenantAdmin}
	r.With(admin...).Get("/api/v1/sms/conversations", d.ListConversations)
	r.With(admin...).Get("/api/v1/sms/conversations/{phone}/messages", d.ListConversationMessages)
	r.With(admin...).Get("/api/v1/sms/conversations/{phone}/context", d.GetConversationContext)
	r.With(admin...).Post("/api/v1/sms/conversations/{phone}/mark-read", d.MarkConversationRead)
}

// ListConversations handles GET /api/v1/sms/conversations.
//
// Refined SMS Inbox PR 1 query params:
//
//	filter = all | unread | unknown   (default all)
//	sort   = recent | oldest_unread   (default recent)
//
// Unknown query keys and enum values are rejected so filters, ordering, and
// cursor binding cannot silently diverge across clients.
func (d *Deps) ListConversations(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", "no tenant on context"))
		return
	}
	q := r.URL.Query()
	if err := validateInboxQuery(q, "cursor", "limit", "filter", "sort", "status", "tag"); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", err.Error()))
		return
	}
	limit, err := parseInboxLimit(q.Get("limit"), 50, 200)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be an integer between 1 and 200"))
		return
	}
	filter := ConversationFilter(defaulted(strings.TrimSpace(q.Get("filter")), string(FilterAll)))
	if filter != FilterAll && filter != FilterUnread && filter != FilterUnknownSubscriber {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_filter", "filter must be all, unread, or unknown"))
		return
	}
	sort := ConversationSort(defaulted(strings.TrimSpace(q.Get("sort")), string(SortRecentFirst)))
	if sort != SortRecentFirst && sort != SortOldestUnreadFirst {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_sort", "sort must be recent or oldest_unread"))
		return
	}

	// Refined SMS Inbox PR 2: status + tag query params. Default
	// status=active so the unfiltered inbox skips snoozed + archived
	// (operator-zero workflow).
	status := ConversationStatus(defaulted(strings.TrimSpace(q.Get("status")), string(StatusActive)))
	if status != StatusActive && status != StatusSnoozed && status != StatusArchived && status != StatusAny {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_status", "status must be active, snoozed, archived, or any"))
		return
	}
	tag := strings.TrimSpace(q.Get("tag"))
	if !validInboxText(tag, 80) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_tag", "tag must be at most 80 valid UTF-8 characters without controls"))
		return
	}
	binding := inboxCursorBinding(tenant.ID, "admin", string(filter), string(sort), string(status), tag)
	if !validInboxCursorKey(d.InboxCursorKey) {
		writeInboxCursorError(w, errInboxCursorUnavailable)
		return
	}
	dbNow, err := d.store().InboxDatabaseNow(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	cursor, err := decodeInboxCursor(d.inboxCursorKeys(), q.Get("cursor"), tenant.ID, "conversations", binding, dbNow)
	if err != nil {
		writeInboxCursorError(w, err)
		return
	}
	if cursor.KeyID != "" {
		normalized, phoneErr := NormalizePhoneUSCA(cursor.KeyID)
		if phoneErr != nil || normalized != cursor.KeyID || (!cursor.KeyAtNull && cursor.KeyAt.IsZero()) {
			writeInboxCursorError(w, errInboxInvalidCursor)
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	resp, err := d.store().ListConversations(ctx, tenant.ID, d.InboxCursorKey, cursor, binding, limit, filter, sort, status, tag)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.inbox.list", "/api/v1/sms/conversations", len(resp.Conversations), resp.SnapshotAt, resp.NextCursor != ""); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// ListConversationMessages handles GET /api/v1/sms/conversations/{phone}/messages.
func (d *Deps) ListConversationMessages(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", "no tenant on context"))
		return
	}
	phone := chi.URLParam(r, "phone")
	q := r.URL.Query()
	if err := validateInboxQuery(q, "cursor", "limit"); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", err.Error()))
		return
	}
	limit, err := parseInboxLimit(q.Get("limit"), 100, 500)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be an integer between 1 and 500"))
		return
	}
	normalizedPhone := normalizePhoneE164ForLookup(phone)
	if normalizedPhone == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_phone", "phone must be a valid US/Canada E.164 number"))
		return
	}
	binding := inboxCursorBinding(tenant.ID, "admin", normalizedPhone)
	if !validInboxCursorKey(d.InboxCursorKey) {
		writeInboxCursorError(w, errInboxCursorUnavailable)
		return
	}
	dbNow, err := d.store().InboxDatabaseNow(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	cursor, err := decodeInboxCursor(d.inboxCursorKeys(), q.Get("cursor"), tenant.ID, "messages", binding, dbNow)
	if err != nil {
		writeInboxCursorError(w, err)
		return
	}
	if cursor.KeyID != "" && !validCanonicalUUIDV4(cursor.KeyID) {
		writeInboxCursorError(w, errInboxInvalidCursor)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	resp, err := d.store().ListConversationMessages(ctx, tenant.ID, normalizedPhone, d.InboxCursorKey, cursor, binding, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.inbox.thread.read", "/api/v1/sms/conversations/{phone}/messages", len(resp.Messages), resp.SnapshotAt, resp.NextCursor != ""); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// ReplyConversation handles POST /api/v1/sms/conversations/{phone}/reply.
// Reuses SendInput so the gating + provider dispatch logic is shared
// with SendTest; the only difference is the route path embeds the
// recipient phone.
func (d *Deps) ReplyConversation(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", "no tenant on context"))
		return
	}
	if err := validateInboxQuery(r.URL.Query()); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", "SMS reply does not accept query parameters"))
		return
	}
	phone := normalizePhoneE164ForLookup(chi.URLParam(r, "phone"))
	if phone == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_phone", "phone required in URL"))
		return
	}
	if _, ok := requireReplyIdempotencyKey(w, r); !ok {
		return
	}
	storageKey, ok := idempotency.StorageKeyFromContext(r.Context())
	if !ok || !strings.HasPrefix(storageKey, "scope-v1:") {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("reply_idempotency_unavailable", "durable reply idempotency is unavailable"))
		return
	}
	requestHash, ok := idempotency.RequestHashFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("reply_idempotency_unavailable", "durable reply request identity is unavailable"))
		return
	}
	var input ReplyInput
	if err := httpbody.DecodeJSON(w, r, 64<<10, &input); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	input.SenderProfileID = strings.TrimSpace(input.SenderProfileID)
	input.ListID = strings.TrimSpace(input.ListID)
	input.MediaURL = strings.TrimSpace(input.MediaURL)
	if !validCanonicalUUIDV4(input.SenderProfileID) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_sender_profile_id", "sender_profile_id must be a canonical lowercase UUIDv4"))
		return
	}
	if input.ListID != "" && !validCanonicalUUIDV4(input.ListID) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_list_id", "list_id must be a canonical lowercase UUIDv4"))
		return
	}
	if !validSMSInboxBody(input.Body, false) {
		writeJSON(w, http.StatusBadRequest, errEnv("sms_body_outside_contract", "reply body must be non-empty valid UTF-8 within 16384 bytes and 4800 Unicode code points"))
		return
	}
	if input.MediaURL != "" && !validReplyMediaURL(input.MediaURL) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_media_url", "media_url must be an absolute HTTPS URL without credentials"))
		return
	}
	// Existing intent recovery precedes every mutable eligibility/capability
	// check. Consent/list/sender topology can legitimately change after a
	// provider effect; the same exact request must still recover its durable
	// current receipt without re-dispatching.
	existing, err := d.store().LoadReplyIntent(r.Context(), tenant.ID, storageKey, requestHash)
	if err == nil {
		writeExistingReplyIntent(w, existing)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		if writeReplyContractError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !smsDispatchSagaReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_reply_dispatch_release_held", "live SMS reply dispatch remains held until durable provider reconciliation and budget settlement are available"))
		return
	}
	if d.Provider == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_provider_unconfigured", "configure an SMS provider before sending"))
		return
	}
	if d.ReplyBudget == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_financial_reservation_unavailable", "live SMS replies remain held until credit reservation is available"))
		return
	}
	listID, err := d.store().ResolveReplyListID(r.Context(), tenant.ID, phone, input.ListID)
	if err != nil {
		if writeReplyContractError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	in := SendInput{
		SenderProfileID: input.SenderProfileID,
		ListID:          listID,
		To:              phone,
		Body:            input.Body,
		MediaURL:        input.MediaURL,
	}
	sender, err := d.store().GetSender(r.Context(), tenant.ID, in.SenderProfileID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !providerConfiguredForSender(d.Provider, sender) {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_sender_provider_unconfigured", "the selected sender provider transport is not configured"))
		return
	}
	intent, err := d.store().ReserveReplyIntent(r.Context(), tenant.ID, storageKey, requestHash, phone, in, sender.Provider, SegmentCount(in.Body))
	if err != nil {
		if writeReplyContractError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !intent.Created {
		writeExistingReplyIntent(w, intent)
		return
	}
	budget, err := d.ReplyBudget.ReserveReply(r.Context(), tenant.ID, intent.Message.ID, SegmentCount(in.Body))
	if err != nil {
		_ = d.store().MarkReplyIntentFailed(r.Context(), tenant.ID, intent.Message.ID, "budget_reservation_failed")
		if writeReplyContractError(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	// Reload sender immediately before the live gate. The earlier read selected
	// provider identity for the durable intent; it is not authorization to use
	// a sender that an administrator paused or suspended in the meantime.
	sender, err = d.store().GetSender(r.Context(), tenant.ID, in.SenderProfileID)
	if err != nil {
		_ = budget.Release(r.Context())
		_ = d.store().MarkReplyIntentFailed(r.Context(), tenant.ID, intent.Message.ID, "sender_recheck_failed")
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !providerConfiguredForSender(d.Provider, sender) {
		_ = budget.Release(r.Context())
		_ = d.store().MarkReplyIntentFailed(r.Context(), tenant.ID, intent.Message.ID, "sender_provider_unconfigured")
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_sender_provider_unconfigured", "the selected sender provider transport is not configured"))
		return
	}
	// Live re-check is deliberately the final policy read before provider
	// dispatch. Suppression/consent/quiet-hours changes win over the reserved
	// intent and budget.
	_, decision, err := d.store().Gate(r.Context(), tenant.ID, sender, in.ListID, in.To, in.Body, 1)
	if err != nil {
		_ = budget.Release(r.Context())
		_ = d.store().MarkReplyIntentFailed(r.Context(), tenant.ID, intent.Message.ID, "gate_unavailable")
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !decision.Allowed {
		_ = budget.Release(r.Context())
		_ = d.store().MarkReplyIntentFailed(r.Context(), tenant.ID, intent.Message.ID, "gate_"+decision.Reason)
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "reply_blocked", "message": "reply blocked by current SMS policy"}, "gate": decision})
		return
	}
	result, err := safeProviderSend(r.Context(), d.Provider, ProviderOutbound{
		Provider:            sender.Provider,
		To:                  phone,
		Body:                in.Body,
		MediaURL:            in.MediaURL,
		FromNumber:          sender.PhoneNumber,
		MessagingServiceSID: sender.MessagingServiceSID,
		StatusCallbackURL:   d.statusCallbackURL(sender.Provider, tenant.ID, sender.ID),
	})
	if err != nil {
		// A transport error, timeout, disconnect, panic, or malformed provider
		// response does not prove rejection: request bytes may already have been
		// accepted. Keep both the financial reservation and durable intent held,
		// return a non-retriable 202, and block every new key for this phone until
		// reconciliation. Explicit provider rejections can be classified later,
		// but must never be inferred from a generic Go error.
		result.Provider = defaulted(result.Provider, sender.Provider)
		result.Status = "unknown"
		_ = d.store().MarkReplyIntentReconciliation(r.Context(), tenant.ID, intent.Message.ID, result)
		receipt := ReplyProviderReceipt{Provider: result.Provider, ProviderMessageID: result.MessageID, Status: result.Status}
		writeJSON(w, http.StatusAccepted, ReplyReconciliationResponse{Disposition: "reconciliation_required", Code: "reply_reconciliation_required", IntentMessageID: intent.Message.ID, ProviderReceipt: receipt})
		return
	}
	normalizedStatus, statusOK := classifyProviderDeliveryStatus(result.Status)
	if !statusOK || normalizedStatus == "received" {
		// A successful HTTP response carrying an unknown/malformed state is not a
		// durable accepted receipt. Keep the intent and financial reservation in
		// reconciliation; never manufacture queued authority from unknown input.
		result.Status = "unknown"
		_ = d.store().MarkReplyIntentReconciliation(r.Context(), tenant.ID, intent.Message.ID, result)
		receipt := ReplyProviderReceipt{Provider: result.Provider, ProviderMessageID: result.MessageID, Status: result.Status}
		writeJSON(w, http.StatusAccepted, ReplyReconciliationResponse{Disposition: "reconciliation_required", Code: "reply_reconciliation_required", IntentMessageID: intent.Message.ID, ProviderReceipt: receipt})
		return
	}
	result.Status = normalizedStatus
	receipt := ReplyProviderReceipt{Provider: result.Provider, ProviderMessageID: result.MessageID, Status: defaulted(result.Status, "accepted")}
	if result.MessageID == "" || budget.Commit(r.Context(), result) != nil {
		_ = d.store().MarkReplyIntentReconciliation(r.Context(), tenant.ID, intent.Message.ID, result)
		writeJSON(w, http.StatusAccepted, ReplyReconciliationResponse{Disposition: "reconciliation_required", Code: "reply_reconciliation_required", IntentMessageID: intent.Message.ID, ProviderReceipt: receipt})
		return
	}
	message, err := d.store().FinalizeReplyIntent(r.Context(), tenant.ID, intent.Message.ID, result)
	if err != nil {
		_ = d.store().MarkReplyIntentReconciliation(r.Context(), tenant.ID, intent.Message.ID, result)
		writeJSON(w, http.StatusAccepted, ReplyReconciliationResponse{Disposition: "reconciliation_required", Code: "reply_reconciliation_required", IntentMessageID: intent.Message.ID, ProviderReceipt: receipt})
		return
	}
	writeJSON(w, http.StatusCreated, ReplyResponse{Disposition: "persisted", Message: minimizedReplyMessage(message), ProviderReceipt: receipt})
}

func writeExistingReplyIntent(w http.ResponseWriter, intent replyIntent) {
	receipt := ReplyProviderReceipt{Provider: intent.Message.Provider, ProviderMessageID: intent.Message.ProviderMessageID, Status: intent.Message.Status}
	switch intent.DispatchState {
	case "persisted":
		writeJSON(w, http.StatusCreated, ReplyResponse{Disposition: "persisted", Message: minimizedReplyMessage(intent.Message), ProviderReceipt: receipt})
	case "reserved", "reconciliation_required":
		writeJSON(w, http.StatusAccepted, ReplyReconciliationResponse{Disposition: "reconciliation_required", Code: "reply_reconciliation_required", IntentMessageID: intent.Message.ID, ProviderReceipt: receipt})
	default:
		writeJSON(w, http.StatusConflict, errEnv("reply_intent_terminal", "this Idempotency-Key belongs to a terminal reply attempt; use a new key only after reviewing its outcome"))
	}
}

func requireReplyIdempotencyKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	values := r.Header.Values(idempotency.HeaderName)
	if len(values) != 1 {
		writeJSON(w, http.StatusBadRequest, errEnv("idempotency_key_required", "Exactly one Idempotency-Key is required for an SMS reply."))
		return "", false
	}
	key := strings.TrimSpace(values[0])
	if key == "" || key != values[0] || len(key) > idempotency.MaxKeyLength || !utf8.ValidString(key) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_idempotency_key", "Idempotency-Key must be 1-255 valid UTF-8 bytes without surrounding whitespace or controls."))
		return "", false
	}
	for _, r := range key {
		if unicode.IsControl(r) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_idempotency_key", "Idempotency-Key must be 1-255 valid UTF-8 bytes without surrounding whitespace or controls."))
			return "", false
		}
	}
	return key, true
}

func validReplyMediaURL(raw string) bool {
	if len(raw) > 2048 || strings.ContainsAny(raw, "\r\n\x00") {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.IsAbs() && strings.EqualFold(u.Scheme, "https") && u.Host != "" && u.User == nil && u.Fragment == ""
}

func writeReplyContractError(w http.ResponseWriter, err error) bool {
	var contractErr *ReplyContractError
	if !errors.As(err, &contractErr) {
		return false
	}
	if contractErr.Status == http.StatusTooManyRequests {
		w.Header().Set("Retry-After", "60")
	}
	writeJSON(w, contractErr.Status, errEnv(contractErr.Code, contractErr.Message))
	return true
}

// GetConversationContext handles GET /api/v1/sms/conversations/{phone}/context.
//
// Refined SMS Inbox PR 1: powers the subscriber context strip + the
// consent posture badge in the thread header. Loaded lazily on
// thread-open so the conversations list response stays lean.
func (d *Deps) GetConversationContext(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", "no tenant on context"))
		return
	}
	phone := chi.URLParam(r, "phone")
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	resp, err := d.Store.GetConversationContext(ctx, tenant.ID, phone)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	resp.ReplyDispatchAvailable = smsDispatchSagaReleaseReady && d.Provider != nil && d.ReplyBudget != nil
	if resp.ReplyDispatchAvailable {
		resp.ReplyDispatchAvailable, err = d.hasConfiguredDispatchSender(ctx, tenant.ID)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
	}
	if !resp.ReplyDispatchAvailable {
		switch {
		case !smsDispatchSagaReleaseReady:
			resp.ReplyDispatchUnavailableReason = "sms_reply_dispatch_release_held"
		case d.ReplyBudget == nil:
			resp.ReplyDispatchUnavailableReason = "sms_financial_reservation_unavailable"
		default:
			resp.ReplyDispatchUnavailableReason = "sms_configured_sender_unavailable"
		}
	}
	if err := d.auditSMSInboxRead(r, "sms.inbox.context.read", "/api/v1/sms/conversations/{phone}/context", 1, time.Time{}, false); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// MarkConversationRead handles POST /api/v1/sms/conversations/{phone}/mark-read.
func (d *Deps) MarkConversationRead(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", "no tenant on context"))
		return
	}
	var input struct {
		MessageIDs []string `json:"message_ids"`
	}
	if err := httpbody.DecodeJSON(w, r, 32<<10, &input); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	phone := chi.URLParam(r, "phone")
	applied, err := d.Store.MarkConversationRead(r.Context(), tenant.ID, phone, input.MessageIDs, middleware.AuditMetaFromRequest(r))
	if errors.Is(err, ErrInvalidReadBoundary) {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("invalid_read_boundary", "message_ids must name unique inbound messages in this tenant conversation"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "applied": applied})
}
