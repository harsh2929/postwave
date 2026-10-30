// SPDX-License-Identifier: AGPL-3.0-only
package notification_feed

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// The read path for the notification delivery ledgers (ECO-05).
//
// Four writers already recorded what happened to a notification and nothing
// could read any of it back:
//
//	notification_feed.suppressed        — the in-app channel withheld by preference
//	web_push_deliveries                 — webpush/deliveries.go + retry.go
//	mobile_push_deliveries              — mobilepush/sender.go, receipts.go, quiet_hours.go
//	notification_webhook_deliveries     — notifywebhook/recorder.go + retry.go
//
// So "suppression/failure is observable" was false in practice: a push that a
// browser vendor rate-limited, a native push withheld by quiet hours, an in-app
// notification the person's own preferences turned off, and a Slack destination
// that had been returning 500 for a week were all recorded, retried, and
// invisible. Nobody could answer "why didn't I get that?".
//
// This file answers it, from the identity the fanout already establishes: the
// notification_feed row id, which every channel carries.
//
// WHAT IS DELIBERATELY NOT HERE. `chat_delivery_log` is the fourth ledger and
// is NOT unioned in. It is not a per-person channel: it records the workspace's
// Slack/Discord/Teams *integration* posting, keyed by (provider,
// integration_id, outbox_event_id) with no user and no notification id, and it
// already has a read surface —
// `GET /api/v1/integrations/{slack,discord,teams}/{id}/deliveries`
// (chatdelivery.List, mounted in server/collaboration_integrations.go). Folding
// a workspace-wide integration log into one person's "what happened to my
// notifications" would answer a different question than the one asked.

// Channel names. These are the READ vocabulary — stable, client-facing, and
// deliberately not the table names.
const (
	ChannelInApp      = "in_app"
	ChannelWebPush    = "web_push"
	ChannelMobilePush = "mobile_push"
	ChannelWebhook    = "webhook"
)

// Outcome is the cross-channel normalization of four different status
// vocabularies. It exists because the whole point of this surface is to compare
// channels, and the channels disagree: web push says `sent`, native push says
// `accepted` for the same fact and reserves `delivered` for a confirmed
// receipt, the webhook says `sent`, and the feed row says nothing at all.
//
// The mapping refuses to overclaim. `accepted` means a provider took the
// message; only `delivered` means something confirmed it arrived. Collapsing
// those two would make the native channel's receipt tracking — the one channel
// that actually knows — indistinguishable from the channels that do not.
const (
	OutcomeSuppressed = "suppressed" // withheld on purpose; Reason says why
	OutcomeFailed     = "failed"     // attempted and rejected / expired / revoked
	OutcomePending    = "pending"    // queued, not yet attempted or awaiting retry
	OutcomeAccepted   = "accepted"   // a provider took it; arrival unconfirmed
	OutcomeDelivered  = "delivered"  // confirmed on the device / in the feed
)

var validOutcomes = map[string]bool{
	OutcomeSuppressed: true,
	OutcomeFailed:     true,
	OutcomePending:    true,
	OutcomeAccepted:   true,
	OutcomeDelivered:  true,
}

var validChannels = map[string]bool{
	ChannelInApp:      true,
	ChannelWebPush:    true,
	ChannelMobilePush: true,
	ChannelWebhook:    true,
}

// ChannelDelivery is one channel's record of one notification.
type ChannelDelivery struct {
	ID string `json:"id"`
	// NotificationID is the notification_feed row every channel mirrors. Empty
	// when a ledger row carries no linkable id — possible on web push, whose
	// senders may run without a feed row (see webpush.idempotencyKeyFor).
	NotificationID string `json:"notification_id,omitempty"`
	Channel        string `json:"channel"`
	// Status is the channel's OWN status, verbatim. Kept alongside Outcome so a
	// reader is never forced to trust this file's normalization when debugging
	// a specific channel.
	Status  string `json:"status"`
	Outcome string `json:"outcome"`
	// Reason is why it was suppressed or how it failed — 'quiet_hours',
	// 'Too Many Requests', 'DeviceNotRegistered', 'preference_in_app_off'.
	// Empty on success. URL-redacted (see redactReason).
	Reason    string `json:"reason,omitempty"`
	EventType string `json:"event_type,omitempty"`
	// Target distinguishes two records of the same channel without exposing a
	// credential: a salt-free digest of the push endpoint (which IS the
	// authorization to push to that browser), the device row id for native, the
	// payload kind for the webhook. Never the endpoint or the webhook URL.
	Target      string     `json:"target,omitempty"`
	Attempts    int        `json:"attempts"`
	NextRetryAt *time.Time `json:"next_retry_at,omitempty"`
	DeliveredAt *time.Time `json:"delivered_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// DeliveryOptions bounds one page of the cross-channel ledger.
type DeliveryOptions struct {
	// NotificationID restricts to one logical notification. Must be a uuid when
	// set; callers validate before calling.
	NotificationID string
	Channel        string
	Outcome        string
	Limit          int
	Cursor         string
}

// DeliveryPage is one page plus the keyset continuation.
type DeliveryPage struct {
	Items      []ChannelDelivery
	NextCursor string
}

// deliverySources unions the per-person ledgers into one shape.
//
// Every branch is filtered by tenant AND user inside the union rather than
// outside it: RLS already confines the rows to the tenant, but the read is
// per-person and pushing the predicate down is what lets each branch use its
// own (tenant_id, user_id, created_at DESC) index instead of scanning a ledger
// and discarding it.
//
// $1 tenant, $2 user, $3 notification id as TEXT (empty = every notification).
// Text rather than uuid because web push stores the id in a text column.
const deliverySources = `
SELECT nf.id,
       nf.id                                             AS notification_id,
       '` + ChannelInApp + `'::text                      AS channel,
       CASE WHEN nf.suppressed THEN 'suppressed' ELSE 'delivered' END AS status,
       -- The fanout writes suppressed=true for exactly one reason: the person's
       -- resolved preferences had the in-app channel off while another durable
       -- channel was on (notifyfanout.Dispatch). Naming it here is what turns
       -- "it never showed up" into "you turned it off".
       CASE WHEN nf.suppressed THEN 'preference_in_app_off' ELSE '' END AS reason,
       nf.event_type,
       ''::text                                          AS target,
       1                                                 AS attempts,
       NULL::timestamptz                                 AS next_retry_at,
       CASE WHEN nf.suppressed THEN NULL ELSE nf.created_at END AS delivered_at,
       nf.created_at,
       nf.created_at                                     AS updated_at
  FROM notification_feed nf
 WHERE nf.tenant_id = $1::uuid AND nf.user_id = $2::uuid
   AND ($3 = '' OR nf.id = $3::uuid)

UNION ALL

SELECT w.id,
       -- Web push carries the cross-channel id in entity_id (a text column, see
       -- webpush.recordAttempt). Guarded rather than blind-cast: a caller that
       -- built a Notification without a feed row leaves it empty, and one bad
       -- value must not fail the whole page.
       CASE WHEN w.entity_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            THEN w.entity_id::uuid END                   AS notification_id,
       '` + ChannelWebPush + `'::text                    AS channel,
       w.status,
       w.error_code                                      AS reason,
       w.event_type,
       -- The endpoint URL is the credential that authorises pushing to that
       -- browser. A digest distinguishes two browsers without shipping it.
       left(encode(sha256(convert_to(w.endpoint, 'UTF8')), 'hex'), 12) AS target,
       w.attempts,
       w.next_retry_at,
       w.accepted_at                                     AS delivered_at,
       w.created_at,
       w.updated_at
  FROM web_push_deliveries w
 WHERE w.tenant_id = $1::uuid AND w.user_id = $2::uuid
   AND ($3 = '' OR w.entity_id = $3)

UNION ALL

SELECT m.id,
       m.notification_id,
       '` + ChannelMobilePush + `'::text                 AS channel,
       m.status,
       COALESCE(m.error_code, '')                        AS reason,
       m.event_type,
       m.device_id::text                                 AS target,
       m.attempts,
       m.next_retry_at,
       m.delivered_at,
       m.created_at,
       m.updated_at
  FROM mobile_push_deliveries m
 WHERE m.tenant_id = $1::uuid AND m.user_id = $2::uuid
   AND ($3 = '' OR m.notification_id = $3::uuid)

UNION ALL

SELECT d.id,
       d.notification_id,
       '` + ChannelWebhook + `'::text                    AS channel,
       d.status,
       d.error                                           AS reason,
       d.event_type,
       d.kind                                            AS target,
       d.attempts,
       d.next_retry_at,
       d.delivered_at,
       d.created_at,
       d.updated_at
  FROM notification_webhook_deliveries d
 WHERE d.tenant_id = $1::uuid AND d.user_id = $2::uuid
   AND ($3 = '' OR d.notification_id = $3::uuid)
`

// outcomeExpr normalizes four status vocabularies into one. In SQL rather than
// Go so `?outcome=` can filter and paginate on the same value the response
// carries — a filter applied after the page was cut would silently return short
// pages and a cursor that skips rows.
const outcomeExpr = `
CASE
    WHEN c.status = 'suppressed'                     THEN '` + OutcomeSuppressed + `'
    WHEN c.status IN ('failed', 'expired', 'revoked') THEN '` + OutcomeFailed + `'
    WHEN c.status IN ('pending', 'queued')            THEN '` + OutcomePending + `'
    WHEN c.status = 'delivered'                       THEN '` + OutcomeDelivered + `'
    WHEN c.status IN ('sent', 'accepted')             THEN '` + OutcomeAccepted + `'
    ELSE 'unknown'
END`

// ListDeliveries returns one page of the acting user's cross-channel delivery
// records, newest first.
//
// Tenant-scoped through db.WithTenant so RLS fires on all four tables; every
// branch additionally pins user_id, so one person can only ever read their own
// deliveries even inside their own tenant.
func (r *Repo) ListDeliveries(ctx context.Context, tenantID, userID string, opts DeliveryOptions) (DeliveryPage, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	cursorAt, cursorID, err := decodeCursor(opts.Cursor)
	if err != nil {
		return DeliveryPage{}, err
	}
	var cursorTime any
	var cursorRow any
	if cursorID != "" {
		cursorTime = cursorAt
		cursorRow = cursorID
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return DeliveryPage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH channels AS (`+deliverySources+`), classified AS (
    SELECT c.id, c.notification_id, c.channel, c.status, `+outcomeExpr+` AS outcome,
           c.reason, c.event_type, c.target, c.attempts, c.next_retry_at,
           c.delivered_at, c.created_at, c.updated_at
      FROM channels c
)
SELECT id::text, COALESCE(notification_id::text, ''), channel, status, outcome,
       reason, event_type, target, attempts, next_retry_at, delivered_at,
       created_at, updated_at
  FROM classified
 WHERE ($4 = '' OR channel = $4)
   AND ($5 = '' OR outcome = $5)
   AND ($6::timestamptz IS NULL
        OR (created_at, id) < ($6::timestamptz, $7::uuid))
 ORDER BY created_at DESC, id DESC
 LIMIT $8`,
		tenantID, userID, opts.NotificationID, opts.Channel, opts.Outcome,
		cursorTime, cursorRow, limit+1)
	if err != nil {
		return DeliveryPage{}, err
	}
	defer rows.Close()

	out := []ChannelDelivery{}
	for rows.Next() {
		var it ChannelDelivery
		if err := rows.Scan(&it.ID, &it.NotificationID, &it.Channel, &it.Status,
			&it.Outcome, &it.Reason, &it.EventType, &it.Target, &it.Attempts,
			&it.NextRetryAt, &it.DeliveredAt, &it.CreatedAt, &it.UpdatedAt); err != nil {
			return DeliveryPage{}, err
		}
		it.Reason = redactReason(it.Reason)
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return DeliveryPage{}, err
	}
	page := DeliveryPage{}
	if len(out) > limit {
		out = out[:limit]
		last := out[len(out)-1]
		page.NextCursor = EncodeCursor(last.CreatedAt, last.ID)
	}
	page.Items = out
	return page, tx.Commit(ctx)
}

// urlInText matches an absolute URL anywhere inside free-form error text.
var urlInText = regexp.MustCompile(`(?i)[a-z][a-z0-9+.\-]*://[^\s"'<>]+`)

// redactReason strips URLs out of a stored failure reason before it leaves the
// server.
//
// The notification webhook records `postErr.Error()`, and a transport failure
// from net/http is a *url.Error whose message embeds the REQUEST URL — for the
// Slack destination that is `https://hooks.slack.com/services/T…/B…/<secret>`,
// where the path IS the credential. Returning it would take a secret that lives
// in one settings row and copy it into an HTTP response, a browser devtools
// pane, and every HAR file and support bundle downstream of that.
//
// The host survives, because "your Slack webhook host stopped answering" is the
// useful half and carries no secret. Everything after it does not.
func redactReason(reason string) string {
	if reason == "" || !strings.Contains(reason, "://") {
		return reason
	}
	return urlInText.ReplaceAllStringFunc(reason, func(raw string) string {
		// Trailing punctuation belongs to the sentence, not the URL.
		trailing := ""
		for len(raw) > 0 && strings.ContainsRune(`",.;:)]}`, rune(raw[len(raw)-1])) {
			trailing = string(raw[len(raw)-1]) + trailing
			raw = raw[:len(raw)-1]
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return "[redacted-url]" + trailing
		}
		if u.Path == "" && u.RawQuery == "" && u.User == nil {
			return u.Scheme + "://" + u.Host + trailing
		}
		return u.Scheme + "://" + u.Host + "/[redacted]" + trailing
	})
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

// The two routes below are registered by this package's own MountRoutes (see
// notification_feed.go) rather than by a second mount function: a read surface
// that has to be mounted separately is a read surface a later edit can forget
// to mount, which is the exact failure this whole file is fixing. Both live
// under /api/v1/notifications, which the route-capability generator already
// classifies session-only — these are one person's own delivery records, and no
// shared API key has a "me".

// ListDeliveries serves GET /api/v1/notifications/deliveries.
//
//	?channel=in_app|web_push|mobile_push|webhook
//	?outcome=suppressed|failed|pending|accepted|delivered
//	?notification_id=UUID
//	?limit=N        1..200 (default 50; larger clamps to 200)
//	?cursor=TOKEN   next_cursor from a previous page
func (d *Deps) ListDeliveries(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := d.actor(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	channel := strings.TrimSpace(query.Get("channel"))
	if channel != "" && !validChannels[channel] {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_channel",
			"channel must be one of in_app, web_push, mobile_push, webhook")
		return
	}
	outcome := strings.TrimSpace(query.Get("outcome"))
	if outcome != "" && !validOutcomes[outcome] {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_outcome",
			"outcome must be one of suppressed, failed, pending, accepted, delivered")
		return
	}
	// Validated here rather than cast in SQL: an unparseable id would otherwise
	// become a 500 from a failed uuid cast on a request that is simply wrong.
	notificationID := strings.TrimSpace(query.Get("notification_id"))
	if notificationID != "" && !validUUID(notificationID) {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_notification_id",
			"notification_id must be a uuid")
		return
	}
	limit, _ := strconv.Atoi(query.Get("limit"))
	page, err := d.Repo.ListDeliveries(r.Context(), tenantID, userID, DeliveryOptions{
		NotificationID: notificationID,
		Channel:        channel,
		Outcome:        outcome,
		Limit:          limit,
		Cursor:         query.Get("cursor"),
	})
	d.writeDeliveryPage(w, r, tenantID, page, err)
}

// NotificationDeliveries serves GET /api/v1/notifications/{id}/deliveries —
// every channel's record of ONE notification. This is the "why didn't I get
// that?" endpoint.
//
// 404 comes from an EMPTY result, not from a missing feed row. A delivery
// record deliberately outlives the notification it mirrors (migration 1885:
// "the evidence that we tried to tell someone must not disappear with the
// notification itself"), so gating on the feed row would delete exactly the
// history retention was told to keep. An id belonging to another user produces
// the same 404 as an id that never existed, so neither enumerates.
func (d *Deps) NotificationDeliveries(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := d.actor(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	if !validUUID(id) {
		httperror.Write(w, http.StatusNotFound, "not_found", "notification not found")
		return
	}
	page, err := d.Repo.ListDeliveries(r.Context(), tenantID, userID, DeliveryOptions{
		NotificationID: id,
		Limit:          maxListLimit,
	})
	if err != nil {
		d.writeDeliveryPage(w, r, tenantID, page, err)
		return
	}
	if len(page.Items) == 0 {
		httperror.Write(w, http.StatusNotFound, "not_found", "notification not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"notification_id": id,
		"items":           page.Items,
	})
}

func (d *Deps) writeDeliveryPage(
	w http.ResponseWriter, r *http.Request, tenantID string, page DeliveryPage, err error,
) {
	if err != nil {
		if errors.Is(err, ErrInvalidCursor) {
			httperror.Write(w, http.StatusUnprocessableEntity, "invalid_cursor",
				"cursor must be a next_cursor value returned by this endpoint")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	body := map[string]any{
		"items":    page.Items,
		"has_more": page.NextCursor != "",
	}
	if page.NextCursor != "" {
		body["next_cursor"] = page.NextCursor
	}
	writeJSON(w, http.StatusOK, body)
}
