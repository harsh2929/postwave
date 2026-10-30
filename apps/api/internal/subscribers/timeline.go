// Package subscribers — single-subscriber timeline aggregator.
//
// A subscriber's life is scattered across half a dozen tables today:
//   * subscribers          — created/imported markers (via metadata)
//   * campaign_recipients  — sent / bounced events
//   * subscriber_events    — opens / clicks / bounces / complaints / unsubs
//   * subscriber_suppressions — suppressed events
//   * email_suppressions   — legacy mailchimp-compat suppressions
//   * audit_log            — admin-driven mutations (tag ops, manual unsub)
//   * campaign_replies     — inbound replies (migration 0087)
//
// Timeline.Get unions them all into a single `[]TimelineEvent`, sorted
// newest-first, paginated via a `before` cursor. The query is one
// round-trip via `UNION ALL`. Stats are computed in a separate single-
// round-trip aggregate so the cursor doesn't bias them.
//
// Tables that don't exist yet are detected at runtime (via to_regclass)
// and gracefully omitted from the UNION — so a partially-applied
// migration set still returns a usable timeline rather than 500ing.
//
// Engagement score (0..1) blends three signals:
//   * recency  (50%) — exp(-days_since_last_active / 30)
//   * frequency (30%) — min(1, (opens+clicks)/sent_count)
//   * reply propensity (20%) — replied_count / sent_count
// See computeEngagement() for the exact formula and clamp behaviour.

package subscribers

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TimelineEvent is one row in the per-subscriber drill-down view.
type TimelineEvent struct {
	Type       string         `json:"type"`
	OccurredAt time.Time      `json:"occurred_at"`
	SubjectID  string         `json:"subject_id,omitempty"`
	Subject    string         `json:"subject,omitempty"`
	CampaignID string         `json:"campaign_id,omitempty"`
	Detail     map[string]any `json:"detail,omitempty"`
	Source     string         `json:"source"`
}

// TimelineStats is the unbounded-scope rollup shown above the timeline.
type TimelineStats struct {
	SentCount          int        `json:"sent_count"`
	OpenedCount        int        `json:"opened_count"`
	ClickedCount       int        `json:"clicked_count"`
	BouncedCount       int        `json:"bounced_count"`
	RepliedCount       int        `json:"replied_count"`
	OpenRate           float64    `json:"open_rate"`
	ClickRate          float64    `json:"click_rate"`
	EngagementScore    float64    `json:"engagement_score"`
	EngagementDaily30d []int      `json:"engagement_daily_30d"`
	SubscribedAt       time.Time  `json:"subscribed_at"`
	LastActiveAt       *time.Time `json:"last_active_at,omitempty"`
	CurrentStatus      string     `json:"current_status"`
}

type engagementDay struct {
	Day   time.Time
	Count int
}

// Pagination is the cursor envelope for the timeline endpoint.
type Pagination struct {
	Before     *time.Time `json:"before,omitempty"`
	NextCursor string     `json:"next_cursor,omitempty"`
	Limit      int        `json:"limit"`
	HasMore    bool       `json:"has_more"`
}

type timelineCursor struct {
	At        time.Time `json:"at"`
	Source    string    `json:"source"`
	Type      string    `json:"type"`
	SubjectID string    `json:"subject_id"`
}

// TimelineCategory is a closed, server-applied event filter. Filtering must
// happen before LIMIT/cursor evaluation; client-side filtering a page can show
// an empty view while matching events exist on older pages and makes has_more
// lie.
type TimelineCategory string

const (
	TimelineCategoryAll        TimelineCategory = "all"
	TimelineCategoryEngagement TimelineCategory = "engagement"
	TimelineCategoryDelivery   TimelineCategory = "delivery"
	TimelineCategoryConsent    TimelineCategory = "consent"
	TimelineCategoryProfile    TimelineCategory = "profile"
)

func ParseTimelineCategory(raw string) (TimelineCategory, error) {
	category := TimelineCategory(strings.ToLower(strings.TrimSpace(raw)))
	if category == "" {
		category = TimelineCategoryAll
	}
	switch category {
	case TimelineCategoryAll, TimelineCategoryEngagement, TimelineCategoryDelivery,
		TimelineCategoryConsent, TimelineCategoryProfile:
		return category, nil
	default:
		return "", errors.New("invalid timeline category")
	}
}

func timelineCategoryTypes(category TimelineCategory) []string {
	switch category {
	case TimelineCategoryEngagement:
		return []string{"opened", "clicked", "replied"}
	case TimelineCategoryDelivery:
		return []string{"sent", "delivered", "bounced", "failed", "deferred"}
	case TimelineCategoryConsent:
		return []string{"suppressed", "unsubscribed", "resubscribed", "complained", "consent_changed"}
	case TimelineCategoryProfile:
		return []string{
			"added", "tag_added", "tag_removed", "list_added", "list_removed",
			"lifecycle_stage_changed", "subscriber.updated", "subscriber.alias_changed",
			"subscriber.alias_deleted", "subscriber.email_added", "subscriber.email_updated",
			"subscriber.email_deleted",
		}
	default:
		return nil
	}
}

func encodeTimelineCursor(event TimelineEvent) string {
	raw, _ := json.Marshal(timelineCursor{
		At: event.OccurredAt, Source: event.Source, Type: event.Type, SubjectID: event.SubjectID,
	})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeTimelineCursor(value string) (*timelineCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, err
	}
	var cursor timelineCursor
	if err := json.Unmarshal(raw, &cursor); err != nil || cursor.At.IsZero() {
		return nil, errors.New("invalid timeline cursor")
	}
	return &cursor, nil
}

// Timeline is the response shape for GET /subscribers/{id}/timeline.
type Timeline struct {
	SubscriberID string          `json:"subscriber_id"`
	Email        string          `json:"email"`
	Stats        TimelineStats   `json:"stats"`
	Events       []TimelineEvent `json:"events"`
	Pagination   Pagination      `json:"pagination"`
}

// Default + max page sizes for the timeline endpoint.
const (
	defaultTimelineLimit = 50
	maxTimelineLimit     = 200
)

// Get builds a single-subscriber timeline + stats.
//
// `cursor` is the opaque composite position from the previous page;
// nil means "from now". `limit` is clamped to [1, maxTimelineLimit].
func (r *Repo) GetTimeline(ctx context.Context, tenantID, subscriberID string, cursor *timelineCursor, limit int) (*Timeline, error) {
	return r.GetTimelineFiltered(ctx, tenantID, subscriberID, cursor, limit, TimelineCategoryAll)
}

// GetTimelineFiltered returns one category-correct cursor page. GetTimeline is
// kept as the all-events compatibility entrypoint for internal callers.
func (r *Repo) GetTimelineFiltered(ctx context.Context, tenantID, subscriberID string, cursor *timelineCursor, limit int, category TimelineCategory) (*Timeline, error) {
	if limit <= 0 {
		limit = defaultTimelineLimit
	}
	if limit > maxTimelineLimit {
		limit = maxTimelineLimit
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Resolve subscriber → email + status + created_at. We accept
	//    either a Moosewave UUID or the email itself.
	var email, status string
	var createdAt time.Time
	row := tx.QueryRow(ctx, `
SELECT email::text, status, created_at
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))`, tenantID, subscriberID)
	if err := row.Scan(&email, &status, &createdAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("lookup subscriber: %w", err)
	}

	avail, err := detectTables(ctx, tx)
	if err != nil {
		return nil, err
	}

	events, err := loadTimelineEvents(ctx, tx, tenantID, email, cursor, limit+1, avail, category)
	if err != nil {
		return nil, fmt.Errorf("load events: %w", err)
	}

	stats, err := loadTimelineStats(ctx, tx, tenantID, email, status, createdAt, avail)
	if err != nil {
		return nil, fmt.Errorf("load stats: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	hasMore := len(events) > limit
	if hasMore {
		events = events[:limit]
	}
	pag := Pagination{Limit: limit, HasMore: hasMore}
	if cursor != nil {
		b := cursor.At
		pag.Before = &b
	}
	if hasMore && len(events) > 0 {
		pag.NextCursor = encodeTimelineCursor(events[len(events)-1])
	}

	return &Timeline{
		SubscriberID: subscriberID,
		Email:        email,
		Stats:        stats,
		Events:       events,
		Pagination:   pag,
	}, nil
}

// tableSet records which optional source tables exist in this database.
// Tables we hard-require (subscribers itself) are not included — those
// would be a deployment bug, not a graceful-degrade case.
type tableSet struct {
	subscriberEvents       bool
	campaignRecipients     bool
	campaignReplies        bool
	subscriberSuppressions bool
	emailSuppressions      bool
	auditLog               bool
	campaigns              bool
}

// detectTables checks each optional source table via to_regclass — a
// fast catalog lookup that returns NULL when the relation is missing.
// One round-trip rather than seven.
func detectTables(ctx context.Context, tx pgx.Tx) (tableSet, error) {
	var s tableSet
	row := tx.QueryRow(ctx, `
SELECT
  to_regclass('public.subscriber_events')         IS NOT NULL,
  to_regclass('public.campaign_recipients')       IS NOT NULL,
  to_regclass('public.campaign_replies')          IS NOT NULL,
  to_regclass('public.subscriber_suppressions')   IS NOT NULL,
  to_regclass('public.email_suppressions')        IS NOT NULL,
  to_regclass('public.audit_log')                 IS NOT NULL,
  to_regclass('public.campaigns')                 IS NOT NULL`)
	if err := row.Scan(
		&s.subscriberEvents,
		&s.campaignRecipients,
		&s.campaignReplies,
		&s.subscriberSuppressions,
		&s.emailSuppressions,
		&s.auditLog,
		&s.campaigns,
	); err != nil {
		return s, fmt.Errorf("detect tables: %w", err)
	}
	return s, nil
}

// loadTimelineEvents builds + executes the UNION ALL over every present
// source table. A LEFT JOIN onto campaigns hydrates the subject for any
// campaign-scoped rows.
//
// The query is shaped as:
//
//	SELECT type, occurred_at, subject_id, campaign_id, detail::jsonb, source
//	  FROM (
//	    <branch 1 — campaign_recipients sent>
//	    UNION ALL <branch 2 — campaign_recipients bounced>
//	    UNION ALL <branch 3 — subscriber_events>
//	    UNION ALL <branch 4 — subscriber_suppressions>
//	    UNION ALL <branch 5 — email_suppressions>
//	    UNION ALL <branch 6 — audit_log (subscriber-scoped actions)>
//	    UNION ALL <branch 7 — campaign_replies>
//	    UNION ALL <branch 8 — subscribers added/imported markers>
//	  ) t
//	 WHERE occurred_at < $before
//	 ORDER BY occurred_at DESC
//	 LIMIT $limit
//
// Each branch projects the same column shape so UNION ALL is type-safe.
// `detail` is jsonb so each branch can supply per-type fields without
// reshaping the outer query.
func loadTimelineEvents(ctx context.Context, tx pgx.Tx, tenantID, email string, cursor *timelineCursor, limit int, avail tableSet, category TimelineCategory) ([]TimelineEvent, error) {
	branches := []string{}

	if avail.campaignRecipients {
		// sent
		branches = append(branches, `
SELECT 'sent'::text                AS type,
       cr.sent_at                  AS occurred_at,
       cr.campaign_id::text         AS subject_id,
       cr.campaign_id::text         AS campaign_id,
       jsonb_build_object('status', cr.status) AS detail,
       'campaign_recipients'::text AS source
  FROM campaign_recipients cr
 WHERE cr.tenant_id = $1::uuid
   AND lower(cr.subscriber_email::text) = lower($2)
   AND cr.status = 'sent'
   AND cr.sent_at IS NOT NULL`)
		// bounced (failed)
		branches = append(branches, `
SELECT 'bounced'::text             AS type,
       COALESCE(cr.sent_at, now()) AS occurred_at,
       cr.campaign_id::text         AS subject_id,
       cr.campaign_id::text         AS campaign_id,
       jsonb_build_object('reason', COALESCE(cr.error, '')) AS detail,
       'campaign_recipients'::text AS source
  FROM campaign_recipients cr
 WHERE cr.tenant_id = $1::uuid
   AND lower(cr.subscriber_email::text) = lower($2)
   AND cr.status = 'failed'`)
	}

	if avail.subscriberEvents {
		branches = append(branches, `
SELECT se.event_type::text         AS type,
       se.at                       AS occurred_at,
       COALESCE(se.campaign_id::text, se.source_event_id, '') AS subject_id,
       se.campaign_id::text         AS campaign_id,
       jsonb_strip_nulls(jsonb_build_object(
         'link_url', NULLIF(se.link_url, ''),
         'user_agent', NULLIF(se.user_agent, ''),
         'previous_stage', NULLIF(se.metadata ->> 'previous_stage', ''),
         'stage', NULLIF(se.metadata ->> 'stage', ''),
         'score', CASE WHEN se.metadata ? 'score' THEN se.metadata -> 'score' END,
         'lifecycle_source', NULLIF(se.metadata ->> 'source', '')
       ))                          AS detail,
       'subscriber_events'::text   AS source
  FROM subscriber_events se
 WHERE se.tenant_id = $1::uuid
   AND lower(se.subscriber_email::text) = lower($2)`)
	}

	if avail.subscriberSuppressions {
		branches = append(branches, `
SELECT 'suppressed'::text          AS type,
       ss.created_at               AS occurred_at,
       ss.id::text                 AS subject_id,
       NULL::text                  AS campaign_id,
       jsonb_build_object('reason', ss.reason, 'source', ss.source) AS detail,
       'subscriber_suppressions'::text AS source
  FROM subscriber_suppressions ss
 WHERE ss.tenant_id = $1::uuid
   AND lower(ss.email::text) = lower($2)`)
	}

	if avail.emailSuppressions {
		branches = append(branches, `
SELECT 'suppressed'::text          AS type,
       es.suppressed_at            AS occurred_at,
       es.id::text                 AS subject_id,
       es.campaign_id::text         AS campaign_id,
       jsonb_build_object('reason', es.reason, 'source', es.source) AS detail,
       'email_suppressions'::text  AS source
  FROM email_suppressions es
 WHERE es.tenant_id = $1::uuid
   AND lower(es.email::text) = lower($2)`)
	}

	if avail.auditLog {
		// Audit-log rows tagged to this subscriber. We accept matches via
		// resource_id == subscriber id OR email, OR via metadata->'email'.
		// The action prefix tells us which type to surface.
		branches = append(branches, `
SELECT (CASE
          WHEN al.action LIKE '%tag.add%'        THEN 'tag_added'
          WHEN al.action LIKE '%tag.remove%'     THEN 'tag_removed'
          WHEN al.action LIKE '%list.add%'       THEN 'list_added'
          WHEN al.action LIKE '%list.remove%'    THEN 'list_removed'
          WHEN al.action LIKE '%unsubscribe%'    THEN 'unsubscribed'
          WHEN al.action LIKE '%resubscribe%'    THEN 'resubscribed'
          ELSE al.action
        END)::text                  AS type,
       al.at                        AS occurred_at,
       COALESCE(NULLIF(al.resource_id, ''), '') AS subject_id,
       NULL::text                   AS campaign_id,
       (al.metadata || jsonb_build_object('action', al.action)) AS detail,
       'audit_log'::text            AS source
  FROM audit_log al
 WHERE al.tenant_id = $1::uuid
   AND al.resource_type IN ('subscriber','subscribers')
   AND (
        lower(COALESCE(al.resource_id, '')) = lower($2)
        OR lower(COALESCE(al.metadata->>'email', '')) = lower($2)
   )`)
	}

	if avail.campaignReplies {
		branches = append(branches, `
SELECT 'replied'::text              AS type,
       rep.received_at              AS occurred_at,
       rep.id::text                 AS subject_id,
       rep.campaign_id::text         AS campaign_id,
       jsonb_strip_nulls(jsonb_build_object(
         'subject', NULLIF(rep.subject, ''),
         'snippet', NULLIF(rep.body_snippet, '')
       ))                           AS detail,
       'campaign_replies'::text     AS source
  FROM campaign_replies rep
 WHERE rep.tenant_id = $1::uuid
   AND lower(rep.recipient_email::text) = lower($2)`)
	}

	// Always-on: the subscriber row itself yields an "added" event. If
	// a custom_fields.imported_from key is set we also emit a typed
	// "imported_from_<source>" event at the same timestamp so the
	// drill-down can show provenance without an extra column.
	branches = append(branches, `
SELECT 'added'::text                AS type,
       s.created_at                 AS occurred_at,
       s.id::text                   AS subject_id,
       NULL::text                   AS campaign_id,
       jsonb_build_object('consent_source', s.consent_source) AS detail,
       'subscribers'::text          AS source
  FROM subscribers s
 WHERE s.tenant_id = $1::uuid
   AND lower(s.email::text) = lower($2)`)
	branches = append(branches, `
SELECT ('imported_from_' || (s.custom_fields->>'imported_from'))::text AS type,
       s.created_at                 AS occurred_at,
       s.id::text                   AS subject_id,
       NULL::text                   AS campaign_id,
       jsonb_build_object('source', s.custom_fields->>'imported_from') AS detail,
       'subscribers'::text          AS source
  FROM subscribers s
 WHERE s.tenant_id = $1::uuid
   AND lower(s.email::text) = lower($2)
   AND s.custom_fields ? 'imported_from'
   AND length(COALESCE(s.custom_fields->>'imported_from', '')) > 0`)

	if len(branches) == 0 {
		// Should not happen — the subscribers branch is always present.
		return []TimelineEvent{}, nil
	}

	inner := strings.Join(branches, "\nUNION ALL\n")
	args := []any{tenantID, email}
	where := make([]string, 0, 2)
	if types := timelineCategoryTypes(category); len(types) > 0 {
		args = append(args, types)
		where = append(where, fmt.Sprintf("t.type = ANY($%d::text[])", len(args)))
	}
	if cursor != nil {
		args = append(args, cursor.At, cursor.Source, cursor.Type, cursor.SubjectID)
		where = append(where, fmt.Sprintf(
			"(t.occurred_at, t.source, t.type, COALESCE(t.subject_id, '')) < ($%d, $%d, $%d, $%d)",
			len(args)-3, len(args)-2, len(args)-1, len(args),
		))
	}
	whereClause := ""
	if len(where) > 0 {
		whereClause = " WHERE " + strings.Join(where, " AND ")
	}
	args = append(args, limit)

	// LEFT JOIN campaigns to hydrate the subject (only if campaigns
	// exists — it's required by foreign keys but we still gate on it
	// to keep the query consistent with the rest of detectTables).
	subjectJoin := ""
	if avail.campaigns {
		subjectJoin = `
LEFT JOIN campaigns c ON c.tenant_id = $1::uuid
                     AND t.campaign_id IS NOT NULL
                     AND c.id::text = t.campaign_id`
	}

	sqlText := fmt.Sprintf(`
SELECT t.type, t.occurred_at, COALESCE(t.subject_id, ''),
       %s,
       COALESCE(t.campaign_id, ''),
       COALESCE(t.detail, '{}'::jsonb),
       t.source
  FROM (
%s
  ) t
%s
%s
 ORDER BY t.occurred_at DESC, t.source DESC, t.type DESC, COALESCE(t.subject_id, '') DESC
 LIMIT $%d`,
		coalesceSubject(avail.campaigns),
		inner,
		subjectJoin,
		whereClause,
		len(args))

	rows, err := tx.Query(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []TimelineEvent{}
	for rows.Next() {
		var ev TimelineEvent
		var subjectID, subject, campaignID string
		var detailRaw []byte
		if err := rows.Scan(&ev.Type, &ev.OccurredAt, &subjectID, &subject, &campaignID, &detailRaw, &ev.Source); err != nil {
			return nil, err
		}
		ev.SubjectID = subjectID
		ev.Subject = subject
		ev.CampaignID = campaignID
		if len(detailRaw) > 0 {
			m := map[string]any{}
			if err := json.Unmarshal(detailRaw, &m); err == nil && len(m) > 0 {
				ev.Detail = m
			}
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

// coalesceSubject picks the right SELECT expression for the campaign
// subject — when campaigns isn't present we fall back to the empty
// string so the column count of the outer SELECT is stable.
func coalesceSubject(hasCampaigns bool) string {
	if hasCampaigns {
		return "COALESCE(c.subject, '')"
	}
	return "''::text"
}

// loadTimelineStats computes the unbounded-scope rollup. Single round-
// trip: we run one aggregate query per available table source and
// stitch them together in Go. The cost is dominated by the
// subscriber_events scan, which is indexed on (tenant_id, email).
func loadTimelineStats(ctx context.Context, tx pgx.Tx, tenantID, email, status string, createdAt time.Time, avail tableSet) (TimelineStats, error) {
	stats := TimelineStats{
		SubscribedAt:  createdAt,
		CurrentStatus: mapCurrentStatus(status),
	}

	if avail.campaignRecipients {
		var sent, bounced int
		var lastSent sql.NullTime
		row := tx.QueryRow(ctx, `
SELECT
  COUNT(*) FILTER (WHERE status = 'sent'),
  COUNT(*) FILTER (WHERE status = 'failed'),
  MAX(sent_at) FILTER (WHERE status = 'sent')
  FROM campaign_recipients
 WHERE tenant_id = $1::uuid
   AND lower(subscriber_email::text) = lower($2)`, tenantID, email)
		if err := row.Scan(&sent, &bounced, &lastSent); err != nil {
			return stats, fmt.Errorf("recipients agg: %w", err)
		}
		stats.SentCount = sent
		stats.BouncedCount = bounced
		if lastSent.Valid {
			t := lastSent.Time
			if stats.LastActiveAt == nil || t.After(*stats.LastActiveAt) {
				stats.LastActiveAt = &t
			}
		}
	}

	if avail.subscriberEvents {
		var opens, clicks int
		var bouncedFromEvents int
		var lastEvent sql.NullTime
		row := tx.QueryRow(ctx, `
SELECT
  COUNT(*) FILTER (WHERE event_type = 'opened'),
  COUNT(*) FILTER (WHERE event_type = 'clicked'),
  COUNT(*) FILTER (WHERE event_type = 'bounced'),
  MAX(at) FILTER (
    WHERE event_type IN (
      'opened', 'clicked', 'replied', 'campaign_opened', 'campaign_clicked'
    )
  )
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND lower(subscriber_email::text) = lower($2)`, tenantID, email)
		if err := row.Scan(&opens, &clicks, &bouncedFromEvents, &lastEvent); err != nil {
			return stats, fmt.Errorf("events agg: %w", err)
		}
		stats.OpenedCount = opens
		stats.ClickedCount = clicks
		// Prefer the more granular bounced count from subscriber_events
		// when campaign_recipients didn't see one. This handles tenants
		// whose providers wire bounces to the engagement webhook only.
		if stats.BouncedCount == 0 {
			stats.BouncedCount = bouncedFromEvents
		}
		if lastEvent.Valid {
			t := lastEvent.Time
			if stats.LastActiveAt == nil || t.After(*stats.LastActiveAt) {
				stats.LastActiveAt = &t
			}
		}

		now := time.Now().UTC()
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		start := today.AddDate(0, 0, -29)
		end := today.AddDate(0, 0, 1)
		rows, err := tx.Query(ctx, `
SELECT date_trunc('day', at AT TIME ZONE 'UTC') AS day, COUNT(*)::int
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND lower(subscriber_email::text) = lower($2)
   AND event_type IN ('opened', 'clicked', 'campaign_opened', 'campaign_clicked')
   AND at >= $3
   AND at < $4
 GROUP BY day
 ORDER BY day ASC`, tenantID, email, start, end)
		if err != nil {
			return stats, fmt.Errorf("engagement daily agg: %w", err)
		}
		days := make([]engagementDay, 0, 30)
		for rows.Next() {
			var day engagementDay
			if err := rows.Scan(&day.Day, &day.Count); err != nil {
				rows.Close()
				return stats, fmt.Errorf("engagement daily scan: %w", err)
			}
			days = append(days, day)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return stats, fmt.Errorf("engagement daily rows: %w", err)
		}
		rows.Close()
		stats.EngagementDaily30d = buildEngagementDaily30d(now, days)
	}

	if avail.campaignReplies {
		var replied int
		var lastReply sql.NullTime
		row := tx.QueryRow(ctx, `
SELECT COUNT(*), MAX(received_at)
  FROM campaign_replies
 WHERE tenant_id = $1::uuid
   AND lower(recipient_email::text) = lower($2)`, tenantID, email)
		if err := row.Scan(&replied, &lastReply); err != nil {
			return stats, fmt.Errorf("replies agg: %w", err)
		}
		stats.RepliedCount = replied
		if lastReply.Valid {
			t := lastReply.Time
			if stats.LastActiveAt == nil || t.After(*stats.LastActiveAt) {
				stats.LastActiveAt = &t
			}
		}
	}

	if stats.SentCount > 0 {
		stats.OpenRate = float64(stats.OpenedCount) / float64(stats.SentCount)
		stats.ClickRate = float64(stats.ClickedCount) / float64(stats.SentCount)
	}
	stats.EngagementScore = computeEngagement(stats, time.Now())

	return stats, nil
}

// buildEngagementDaily30d maps UTC aggregate rows into an oldest-to-newest
// fixed 30-day series. Rows outside the window are ignored defensively.
func buildEngagementDaily30d(now time.Time, rows []engagementDay) []int {
	now = now.UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	start := today.AddDate(0, 0, -29)
	result := make([]int, 30)
	for _, row := range rows {
		day := row.Day.UTC()
		day = time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
		index := int(day.Sub(start) / (24 * time.Hour))
		if index >= 0 && index < len(result) && row.Count > 0 {
			result[index] += row.Count
		}
	}
	return result
}

// mapCurrentStatus normalises the subscribers.status column into the
// drill-down's vocabulary (active | unconfirmed | unsubscribed | suppressed | bounced).
func mapCurrentStatus(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case StatusEnabled:
		return "active"
	case StatusUnconfirmed:
		return "unconfirmed"
	case StatusDisabled, "unsubscribed":
		return "unsubscribed"
	case StatusBlocklisted:
		return "suppressed"
	case "bounced":
		return "bounced"
	default:
		return "active"
	}
}

// computeEngagement collapses the rollup into a 0..1 engagement score.
//
// Formula (all components clamped to [0,1] before blending):
//
//	score = 0.5 * recency + 0.3 * frequency + 0.2 * reply
//	  recency   = exp(-days_since_last_active / 30)
//	  frequency = min(1, (opens+clicks) / sent_count)   when sent_count >= 1
//	  reply     = min(1, replied_count / sent_count)    when sent_count >= 1
//
// Missing signals contribute 0 (e.g. no LastActiveAt → recency=0,
// SentCount=0 → frequency=0 and reply=0). The final value is clamped
// to [0,1] so callers can render it as a 0..100% gauge.
//
// Sample: SentCount=10, OpenedCount=4, ClickedCount=2, RepliedCount=1,
// LastActiveAt=now()-3d
//
//	recency   = exp(-3/30) = exp(-0.1) ≈ 0.9048
//	frequency = (4+2)/10              = 0.6
//	reply     = 1/10                  = 0.1
//	score     = 0.5*0.9048 + 0.3*0.6 + 0.2*0.1
//	          = 0.4524    + 0.18    + 0.02
//	          ≈ 0.6524
func computeEngagement(s TimelineStats, now time.Time) float64 {
	var recency, frequency, reply float64

	if s.LastActiveAt != nil {
		days := now.Sub(*s.LastActiveAt).Hours() / 24
		if days < 0 {
			days = 0
		}
		recency = math.Exp(-days / 30.0)
	}
	if s.SentCount >= 1 {
		frequency = float64(s.OpenedCount+s.ClickedCount) / float64(s.SentCount)
		if frequency > 1 {
			frequency = 1
		}
		reply = float64(s.RepliedCount) / float64(s.SentCount)
		if reply > 1 {
			reply = 1
		}
	}

	score := 0.5*recency + 0.3*frequency + 0.2*reply
	if score < 0 {
		score = 0
	}
	if score > 1 {
		score = 1
	}
	// Round to 4 decimals so JSON stays compact.
	return math.Round(score*10000) / 10000
}
