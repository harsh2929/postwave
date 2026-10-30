// SPDX-License-Identifier: AGPL-3.0-only
//
// cross_channel_timeline.go — GET
// /api/v1/subscribers/{id}/cross-channel-timeline?limit=&before=.
//
// Merges a subscriber's email events with their SMS history into one
// newest-first feed with keyset paging:
//
//   * email — campaign_report_events keyed by subscriber_email
//     (sent / delivered / opened / clicked / bounced / complained /
//     unsubscribed / conversion, verbatim event_type).
//   * sms   — sms_messages (outbound status transitions + inbound
//     'received') joined to the subscriber via sms_subscriptions /
//     sms_consent_events.subscriber_email → phone_e164 (subscribers
//     carries no phone column; the SMS tables key on E.164 numbers
//     and record the owning email on consent/subscription rows),
//     plus sms_consent_events themselves (granted / revoked / ...).
//
// Path note: /api/v1/subscribers/{id}/timeline already exists (the
// email-only drill-down in internal/subscribers — see timeline.go's
// UNION ALL). chi would silently shadow whichever of the two
// registered first, so the cross-channel feed lives at its own
// /cross-channel-timeline path instead of clobbering the existing
// surface.
//
// Paging is keyset on the event timestamp: pass the `at` of the last
// item as ?before= (RFC3339) to fetch the next page. We fetch
// limit+1 rows to compute has_more without a count query.

package analytics

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Page-size bounds for the cross-channel timeline.
const (
	defaultCrossTimelineLimit = 50
	maxCrossTimelineLimit     = 200
)

// errTimelineSubscriberNotFound is a typed sentinel so the handler
// can 404 without echoing raw db error text.
var errTimelineSubscriberNotFound = errors.New("analytics: subscriber not found")

// CrossChannelItem is one merged email/SMS timeline entry.
type CrossChannelItem struct {
	At         time.Time `json:"at"`
	Channel    string    `json:"channel"` // "email" | "sms"
	Type       string    `json:"type"`
	Label      string    `json:"label"`
	CampaignID string    `json:"campaign_id,omitempty"`
	Detail     string    `json:"detail,omitempty"`
}

// CrossChannelTimeline is the response envelope.
type CrossChannelTimeline struct {
	Items      []CrossChannelItem `json:"items"`
	HasMore    bool               `json:"has_more"`
	NextBefore string             `json:"next_before,omitempty"`
}

// crossChannelLabels maps channel+type to the human-readable label.
// Anything unmapped falls back to a generic "<Channel> <type>" so new
// event types degrade gracefully instead of erroring.
var crossChannelLabels = map[string]string{
	"email/sent":                 "Email sent",
	"email/delivered":            "Email delivered",
	"email/opened":               "Email opened",
	"email/clicked":              "Email link clicked",
	"email/bounced":              "Email bounced",
	"email/complained":           "Email marked as spam",
	"email/unsubscribed":         "Unsubscribed from email",
	"email/conversion":           "Email conversion",
	"sms/queued":                 "SMS queued",
	"sms/sent":                   "SMS sent",
	"sms/delivered":              "SMS delivered",
	"sms/failed":                 "SMS failed",
	"sms/undelivered":            "SMS undelivered",
	"sms/received":               "SMS reply received",
	"sms/consent_granted":        "SMS consent granted",
	"sms/consent_revoked":        "SMS consent revoked",
	"sms/consent_help_requested": "SMS help requested",
	"sms/consent_imported":       "SMS consent imported",
}

// timelineLabel resolves the display label for a channel+type pair.
// Pure — unit-tested.
func timelineLabel(channel, typ string) string {
	if l, ok := crossChannelLabels[channel+"/"+typ]; ok {
		return l
	}
	c := channel
	switch channel {
	case "email":
		c = "Email"
	case "sms":
		c = "SMS"
	}
	return strings.TrimSpace(c + " " + strings.ReplaceAll(typ, "_", " "))
}

// clampTimelineLimit normalizes ?limit= into [1, max]; <=0 falls back
// to the default. Pure — unit-tested.
func clampTimelineLimit(limit int) int {
	if limit <= 0 {
		return defaultCrossTimelineLimit
	}
	if limit > maxCrossTimelineLimit {
		return maxCrossTimelineLimit
	}
	return limit
}

// CrossChannelTimelineFor builds one page of the merged feed.
// idOrEmail accepts the subscriber UUID or the email itself; before
// (nil = from now) is the keyset cursor.
func (s *Service) CrossChannelTimelineFor(ctx context.Context, tenantID, idOrEmail string, before *time.Time, limit int) (*CrossChannelTimeline, error) {
	limit = clampTimelineLimit(limit)

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Resolve the subscriber first so a bad id is a clean 404, not an
	// empty feed.
	var email string
	err = tx.QueryRow(ctx, `
SELECT email::text
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))`,
		tenantID, idOrEmail).Scan(&email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errTimelineSubscriberNotFound
	}
	if err != nil {
		return nil, err
	}

	// One UNION ALL round-trip. The phones CTE resolves the
	// subscriber's E.164 numbers via the consent/subscription tables
	// (UNION dedupes); each branch is served by its
	// (tenant_id, <key>, at DESC)-shaped index. Detail is verbatim
	// stored data: clicked link_url for email, message body for SMS,
	// consent proof_text for consent events.
	rows, err := tx.Query(ctx, `
WITH phones AS (
  SELECT phone_e164 FROM sms_subscriptions
   WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
  UNION
  SELECT phone_e164 FROM sms_consent_events
   WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
),
merged AS (
  SELECT e.at,
         'email'::text AS channel,
         e.event_type  AS type,
         e.campaign_id::text AS campaign_id,
         COALESCE(e.link_url, '') AS detail
    FROM campaign_report_events e
   WHERE e.tenant_id = $1::uuid
     AND lower(e.subscriber_email::text) = lower($2)
  UNION ALL
  SELECT COALESCE(m.delivered_at, m.received_at, m.sent_at, m.created_at) AS at,
         'sms'::text AS channel,
         m.status    AS type,
         m.campaign_id::text AS campaign_id,
         m.body AS detail
    FROM sms_messages m
   WHERE m.tenant_id = $1::uuid
     AND m.phone_e164 IN (SELECT phone_e164 FROM phones)
  UNION ALL
  SELECT c.created_at AS at,
         'sms'::text AS channel,
         'consent_' || c.action AS type,
         NULL::text AS campaign_id,
         c.proof_text AS detail
    FROM sms_consent_events c
   WHERE c.tenant_id = $1::uuid
     AND (lower(c.subscriber_email::text) = lower($2)
          OR c.phone_e164 IN (SELECT phone_e164 FROM phones))
)
SELECT at, channel, type, COALESCE(campaign_id, ''), detail
  FROM merged
 WHERE ($3::timestamptz IS NULL OR at < $3::timestamptz)
 ORDER BY at DESC
 LIMIT $4::int`,
		tenantID, email, before, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []CrossChannelItem{}
	for rows.Next() {
		var it CrossChannelItem
		if err := rows.Scan(&it.At, &it.Channel, &it.Type, &it.CampaignID, &it.Detail); err != nil {
			return nil, err
		}
		it.At = it.At.UTC()
		it.Label = timelineLabel(it.Channel, it.Type)
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := &CrossChannelTimeline{Items: items}
	if len(items) > limit {
		out.Items = items[:limit]
		out.HasMore = true
		out.NextBefore = out.Items[limit-1].At.Format(time.RFC3339Nano)
	}
	return out, nil
}

// CrossChannelTimelineHandler GET
// /api/v1/subscribers/{id}/cross-channel-timeline?limit=&before=.
func (d *ExtendedDeps) CrossChannelTimelineHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	q := r.URL.Query()
	limit := 0
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeErr(w, http.StatusBadRequest, "bad_limit", "limit must be a positive integer")
			return
		}
		limit = n
	}
	var before *time.Time
	if raw := strings.TrimSpace(q.Get("before")); raw != "" {
		ts, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_before", "before must be an RFC3339 timestamp")
			return
		}
		before = &ts
	}
	out, err := d.Service.CrossChannelTimelineFor(r.Context(), t.ID, chi.URLParam(r, "id"), before, limit)
	if errors.Is(err, errTimelineSubscriberNotFound) {
		writeErr(w, http.StatusNotFound, "not_found", "subscriber not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}
