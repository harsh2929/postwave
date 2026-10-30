// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subscriberevents"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

// withTenantTx is a thin helper that opens a tenant-scoped tx and
// always rolls it back at the end — every MCP tool is read-only in
// v1, so commit semantics don't matter. Centralising the boilerplate
// here keeps each handler short.
func withTenantTx(ctx context.Context, d *Deps, fn func(tx pgx.Tx, tenantID string) (any, error)) (any, error) {
	t, ok := middleware.TenantFromContext(ctx)
	if !ok || t == nil {
		return nil, errors.New("mcp: no tenant in context")
	}
	tx, err := db.WithTenant(ctx, d.Pool, t.ID)
	if err != nil {
		return nil, fmt.Errorf("mcp: open tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return fn(tx, t.ID)
}

func withTenantWriteTx(ctx context.Context, d *Deps, fn func(tx pgx.Tx, tenantID string) (any, error)) (any, error) {
	t, ok := middleware.TenantFromContext(ctx)
	if !ok || t == nil {
		return nil, errors.New("mcp: no tenant in context")
	}
	tx, err := db.WithTenant(ctx, d.Pool, t.ID)
	if err != nil {
		return nil, fmt.Errorf("mcp: open tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := fn(tx, t.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("mcp: commit tx: %w", err)
	}
	return out, nil
}

// ---------------------------------------------------------------------
// listIssues
// ---------------------------------------------------------------------

type listIssuesInput struct {
	Limit  int    `json:"limit"`
	Status string `json:"status"`
	Cursor string `json:"cursor"`
}

type issueRow struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Subject    string     `json:"subject"`
	Status     string     `json:"status"`
	SentAt     *time.Time `json:"sent_at,omitempty"`
	CreatedAt  *time.Time `json:"created_at,omitempty"`
	Recipients int        `json:"recipients"`
}

func handleListIssues(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in listIssuesInput
	if len(args) > 0 {
		if err := json.Unmarshal(args, &in); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	if in.Limit <= 0 {
		in.Limit = 20
	}
	if in.Limit > 100 {
		in.Limit = 100
	}

	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		// The campaigns table doesn't necessarily have a recipients
		// counter column on every fork — we LEFT JOIN to whatever the
		// platform exposes via campaign_report_events (count of `sent`).
		// A tenant with no events yet returns 0, which is correct.
		// Ordered + paginated by the stable (created_at, id) keyset.
		argsv := []any{tenantID}
		where := ""
		if s := strings.TrimSpace(in.Status); s != "" {
			argsv = append(argsv, s)
			where += fmt.Sprintf(" AND c.status = $%d", len(argsv))
		}
		if cur, ok := decodeCursor(in.Cursor); ok {
			argsv = append(argsv, cur.CreatedAt, cur.ID)
			where += fmt.Sprintf(" AND (c.created_at, c.id) < ($%d::timestamptz, $%d::uuid)", len(argsv)-1, len(argsv))
		}
		q := `
SELECT c.id::text,
       COALESCE(c.name, ''),
       COALESCE(c.subject, ''),
       COALESCE(c.status, ''),
       c.sent_at,
       c.created_at,
       COALESCE((SELECT count(*)::int FROM campaign_report_events e
                  WHERE e.tenant_id = c.tenant_id
                    AND e.campaign_id = c.id
                    AND e.event_type = 'sent'), 0) AS recipients
  FROM campaigns c
 WHERE c.tenant_id = $1::uuid` + where + `
 ORDER BY c.created_at DESC, c.id DESC
 LIMIT ` + fmt.Sprintf("%d", in.Limit)

		rows, err := tx.Query(ctx, q, argsv...)
		if err != nil {
			return nil, fmt.Errorf("query campaigns: %w", err)
		}
		defer rows.Close()
		out := make([]issueRow, 0, in.Limit)
		var lastCreated *time.Time
		var lastID string
		for rows.Next() {
			var r issueRow
			var sentAt, createdAt *time.Time
			if err := rows.Scan(&r.ID, &r.Name, &r.Subject, &r.Status, &sentAt, &createdAt, &r.Recipients); err != nil {
				return nil, err
			}
			r.SentAt = sentAt
			r.CreatedAt = createdAt
			out = append(out, r)
			lastCreated, lastID = createdAt, r.ID
		}
		res := map[string]any{"issues": out, "count": len(out)}
		if len(out) == in.Limit && lastCreated != nil && lastID != "" {
			res["next_cursor"] = encodeCursor(listCursor{CreatedAt: *lastCreated, ID: lastID})
		}
		return res, nil
	})
}

// ---------------------------------------------------------------------
// getIssue
// ---------------------------------------------------------------------

type getIssueInput struct {
	ID string `json:"id"`
}

type issueDetail struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Subject    string     `json:"subject"`
	Status     string     `json:"status"`
	BodyHTML   string     `json:"body_html"`
	SentAt     *time.Time `json:"sent_at,omitempty"`
	CreatedAt  *time.Time `json:"created_at,omitempty"`
	Recipients int        `json:"recipients"`
	Opens      int        `json:"opens"`
	Clicks     int        `json:"clicks"`
}

const issueBodyTruncate = 4 * 1024 // 4 KiB to keep the LLM ctx small.

func handleGetIssue(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in getIssueInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if in.ID == "" {
		return nil, errors.New("id is required")
	}

	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		var d2 issueDetail
		var body string
		var sentAt, createdAt *time.Time
		err := tx.QueryRow(ctx, `
SELECT c.id::text,
       COALESCE(c.name, ''),
       COALESCE(c.subject, ''),
       COALESCE(c.status, ''),
       COALESCE(c.body_html, ''),
       c.sent_at,
       c.created_at
  FROM campaigns c
 WHERE c.tenant_id = $1::uuid AND c.id::text = $2`,
			tenantID, in.ID,
		).Scan(&d2.ID, &d2.Name, &d2.Subject, &d2.Status, &body, &sentAt, &createdAt)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, errors.New("campaign not found")
			}
			return nil, err
		}
		if len(body) > issueBodyTruncate {
			body = body[:issueBodyTruncate] + "\n…(truncated)"
		}
		d2.BodyHTML = body
		d2.SentAt = sentAt
		d2.CreatedAt = createdAt
		// Engagement counts. Fault-tolerant — if the events table
		// doesn't have a row for this campaign we leave zeros.
		_ = tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE event_type = 'sent')::int,
  count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened')::int,
  count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'clicked')::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2`,
			tenantID, in.ID,
		).Scan(&d2.Recipients, &d2.Opens, &d2.Clicks)
		return d2, nil
	})
}

// ---------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------

type getStatsInput struct {
	Window string `json:"window"`
}

type statsResult struct {
	Window        string  `json:"window"`
	Sent          int     `json:"sent"`
	Delivered     int     `json:"delivered"`
	UniqueOpens   int     `json:"unique_opens"`
	UniqueClicks  int     `json:"unique_clicks"`
	Unsubscribes  int     `json:"unsubscribes"`
	OpenRate      float64 `json:"open_rate"`
	ClickRate     float64 `json:"click_rate"`
	UnsubRate     float64 `json:"unsub_rate"`
	WindowStartAt string  `json:"window_start_at"`
}

func handleGetStats(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in getStatsInput
	if len(args) > 0 {
		if err := json.Unmarshal(args, &in); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	hours := 24 * 7
	switch in.Window {
	case "24h":
		hours = 24
	case "30d":
		hours = 24 * 30
	case "", "7d":
		hours = 24 * 7
	default:
		return nil, fmt.Errorf("invalid window %q (use 24h | 7d | 30d)", in.Window)
	}
	in.Window = fmtWindow(hours)

	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		windowStart := time.Now().UTC().Add(-time.Duration(hours) * time.Hour)
		var r statsResult
		r.Window = in.Window
		r.WindowStartAt = windowStart.Format(time.RFC3339)
		err := tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE event_type = 'sent')::int,
  count(*) FILTER (WHERE event_type = 'delivered')::int,
  count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened')::int,
  count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'clicked')::int,
  count(*) FILTER (WHERE event_type = 'unsubscribed')::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND at >= $2`,
			tenantID, windowStart,
		).Scan(&r.Sent, &r.Delivered, &r.UniqueOpens, &r.UniqueClicks, &r.Unsubscribes)
		if err != nil {
			// If campaign_report_events isn't populated yet (fresh
			// tenant) the SELECT still succeeds with zeros; only
			// real errors land here.
			return nil, fmt.Errorf("query stats: %w", err)
		}
		denom := r.Delivered
		if denom == 0 {
			denom = r.Sent
		}
		if denom > 0 {
			r.OpenRate = float64(r.UniqueOpens) / float64(denom)
			r.ClickRate = float64(r.UniqueClicks) / float64(denom)
			r.UnsubRate = float64(r.Unsubscribes) / float64(denom)
		}
		return r, nil
	})
}

func fmtWindow(hours int) string {
	switch {
	case hours <= 24:
		return "24h"
	case hours <= 24*7:
		return "7d"
	default:
		return "30d"
	}
}

// ---------------------------------------------------------------------
// searchSubscribers
// ---------------------------------------------------------------------

type searchSubsInput struct {
	Query  string `json:"query"`
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
}

type subscriberRow struct {
	ID        string     `json:"id"`
	Email     string     `json:"email"`
	Name      string     `json:"name,omitempty"`
	Status    string     `json:"status"`
	CreatedAt *time.Time `json:"created_at,omitempty"`
}

func handleSearchSubscribers(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in searchSubsInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	in.Query = strings.TrimSpace(in.Query)
	if len(in.Query) < 2 {
		return nil, errors.New("query must be at least 2 characters")
	}
	if in.Limit <= 0 {
		in.Limit = 25
	}
	if in.Limit > 50 {
		in.Limit = 50
	}

	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		// Keyset cursor on (created_at, id) so deep pages stay cheap and
		// never skip/duplicate rows as the set shifts.
		argsv := []any{tenantID, "%" + in.Query + "%"}
		keyset := ""
		if cur, ok := decodeCursor(in.Cursor); ok {
			argsv = append(argsv, cur.CreatedAt, cur.ID)
			keyset = fmt.Sprintf(" AND (created_at, id) < ($%d::timestamptz, $%d::uuid)", len(argsv)-1, len(argsv))
		}
		q := `
SELECT id::text,
       email::text,
       trim(concat_ws(' ', NULLIF(merge_fields->>'FNAME', ''), NULLIF(merge_fields->>'LNAME', ''))),
       COALESCE(status, ''),
       created_at
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (
        email::text ILIKE $2
        OR COALESCE(external_id, '') ILIKE $2
        OR COALESCE(merge_fields->>'FNAME', '') ILIKE $2
        OR COALESCE(merge_fields->>'LNAME', '') ILIKE $2
       )` + keyset + `
 ORDER BY created_at DESC, id DESC
 LIMIT ` + fmt.Sprintf("%d", in.Limit)
		rows, err := tx.Query(ctx, q, argsv...)
		if err != nil {
			return nil, fmt.Errorf("search subscribers: %w", err)
		}
		defer rows.Close()
		out := make([]subscriberRow, 0, in.Limit)
		var lastCreated *time.Time
		var lastID string
		for rows.Next() {
			var s subscriberRow
			var createdAt *time.Time
			if err := rows.Scan(&s.ID, &s.Email, &s.Name, &s.Status, &createdAt); err != nil {
				return nil, err
			}
			s.CreatedAt = createdAt
			out = append(out, s)
			lastCreated, lastID = createdAt, s.ID
		}
		res := map[string]any{"subscribers": out, "count": len(out)}
		// Only emit a cursor when the page was full (more may remain) and
		// we have a stable key for the last row.
		if len(out) == in.Limit && lastCreated != nil && lastID != "" {
			res["next_cursor"] = encodeCursor(listCursor{CreatedAt: *lastCreated, ID: lastID})
		}
		return res, nil
	})
}

// ---------------------------------------------------------------------
// getSubscriberProfile / subscriber write helpers
// ---------------------------------------------------------------------

type getSubscriberProfileInput struct {
	ID         string `json:"id"`
	EventLimit int    `json:"event_limit"`
}

func handleGetSubscriberProfile(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in getSubscriberProfileInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	in.ID = strings.TrimSpace(in.ID)
	if in.ID == "" {
		return nil, errors.New("id is required")
	}
	if in.EventLimit < 0 {
		in.EventLimit = 0
	}
	if in.EventLimit == 0 {
		in.EventLimit = 20
	}
	if in.EventLimit > 50 {
		in.EventLimit = 50
	}

	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		var (
			id, email, status, mailchimpStatus, externalID string
			mergeRaw, customRaw                            []byte
			tags                                           []string
			createdAt, updatedAt                           time.Time
		)
		if err := tx.QueryRow(ctx, `
SELECT id::text, email::text, status, mailchimp_status,
       COALESCE(external_id, ''), merge_fields, custom_fields,
       COALESCE(tags, ARRAY[]::text[]), created_at, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2) OR external_id = $2)`,
			tenantID, in.ID).Scan(&id, &email, &status, &mailchimpStatus, &externalID,
			&mergeRaw, &customRaw, &tags, &createdAt, &updatedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, errors.New("subscriber not found")
			}
			return nil, err
		}
		mergeFields := map[string]any{}
		customFields := map[string]any{}
		_ = json.Unmarshal(mergeRaw, &mergeFields)
		_ = json.Unmarshal(customRaw, &customFields)

		aliases, err := mcpLoadAliases(ctx, tx, tenantID, id)
		if err != nil {
			return nil, err
		}
		traits, err := mcpLoadTraits(ctx, tx, tenantID, id)
		if err != nil {
			return nil, err
		}
		lifecycle, err := mcpLoadLifecycle(ctx, tx, tenantID, id)
		if err != nil {
			return nil, err
		}
		events, err := mcpLoadSubscriberEvents(ctx, tx, tenantID, email, in.EventLimit)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"subscriber": map[string]any{
				"id":               id,
				"version":          httpcache.ConcurrencyToken("subscriber", id, updatedAt),
				"email":            email,
				"status":           status,
				"mailchimp_status": mailchimpStatus,
				"external_id":      externalID,
				"tags":             tags,
				"merge_fields":     mergeFields,
				"custom_fields":    customFields,
				"created_at":       createdAt,
				"updated_at":       updatedAt,
			},
			"aliases":         aliases,
			"computed_traits": traits,
			"lifecycle":       lifecycle,
			"recent_events":   events,
		}, nil
	})
}

type mcpSubscriberAliasInput struct {
	SubscriberID string   `json:"subscriber_id"`
	AliasType    string   `json:"alias_type"`
	AliasValue   string   `json:"alias_value"`
	Confidence   *float64 `json:"confidence"`
	Source       string   `json:"source"`
	Version      string   `json:"subscriber_version"`
}

func handleUpsertSubscriberAlias(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in mcpSubscriberAliasInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	in.SubscriberID = strings.TrimSpace(in.SubscriberID)
	in.AliasType = strings.ToLower(strings.TrimSpace(in.AliasType))
	in.AliasValue = strings.TrimSpace(in.AliasValue)
	in.Source = strings.TrimSpace(in.Source)
	in.Version = strings.TrimSpace(in.Version)
	if in.Source == "" {
		in.Source = "mcp"
	}
	if in.SubscriberID == "" || in.AliasValue == "" || in.Version == "" || in.Version == "*" || !validMCPAliasType(in.AliasType) {
		return nil, errors.New("subscriber_id, subscriber_version, valid non-contact alias_type, and alias_value are required")
	}
	confidence := 1.0
	if in.Confidence != nil {
		confidence = *in.Confidence
	}
	if confidence < 0 || confidence > 1 {
		return nil, errors.New("confidence must be between 0 and 1")
	}

	if d == nil || d.SubscriberRepo == nil {
		return nil, errors.New("subscriber alias service is not available")
	}
	tenant, ok := middleware.TenantFromContext(ctx)
	if !ok || tenant == nil {
		return nil, errors.New("mcp: no tenant in context")
	}
	meta, _ := middleware.AuditMetaFromContext(ctx)
	actorType, actorLabel := middleware.ActorFromContext(ctx)
	if meta.ActorType == "" {
		meta.ActorType = actorType
	}
	if meta.ActorLabel == "" {
		meta.ActorLabel = actorLabel
	}
	if meta.ActorLabel == "" {
		meta.ActorLabel = "mcp"
	}
	out, err := d.SubscriberRepo.UpsertAlias(ctx, tenant.ID, in.SubscriberID, subscribers.AliasInput{
		AliasType:  in.AliasType,
		AliasValue: in.AliasValue,
		Confidence: &confidence,
		Source:     in.Source,
		Provenance: map[string]any{"surface": "mcp"},
	}, in.Version, meta)
	if err != nil {
		return nil, safeMCPAliasMutationError(err)
	}
	return out, nil
}

type mcpSubscriberEventInput struct {
	SubscriberID  string         `json:"subscriber_id"`
	EventName     string         `json:"event_name"`
	Metadata      map[string]any `json:"metadata"`
	SourceEventID string         `json:"source_event_id"`
	OccurredAt    string         `json:"occurred_at"`
}

func handleRecordSubscriberEvent(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in mcpSubscriberEventInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	in.SubscriberID = strings.TrimSpace(in.SubscriberID)
	in.EventName = strings.TrimSpace(in.EventName)
	in.SourceEventID = strings.TrimSpace(in.SourceEventID)
	if in.SubscriberID == "" || in.EventName == "" {
		return nil, errors.New("subscriber_id and event_name are required")
	}
	if len(in.EventName) > 128 {
		return nil, errors.New("event_name exceeds 128 characters")
	}
	at := time.Now().UTC()
	if strings.TrimSpace(in.OccurredAt) != "" {
		parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(in.OccurredAt))
		if err != nil {
			return nil, fmt.Errorf("occurred_at must be RFC3339: %w", err)
		}
		at = parsed.UTC()
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	in.Metadata["event_name"] = in.EventName
	metaRaw, _ := json.Marshal(in.Metadata)

	return withTenantWriteTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		id, email, err := mcpResolveSubscriberIDEmail(ctx, tx, tenantID, in.SubscriberID)
		if err != nil {
			return nil, err
		}
		var eventID int64
		var eventAt time.Time
		var deduped bool
		if in.SourceEventID != "" {
			claim, claimErr := subscriberevents.ClaimDedupKey(ctx, tx, tenantID, "mcp", in.SourceEventID)
			if claimErr != nil {
				return nil, claimErr
			}
			if !claim.Claimed {
				eventID, eventAt, deduped = claim.ExistingID, claim.ExistingAt, true
			} else {
				err = tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, at, source, source_event_id, metadata)
VALUES ($1::uuid, $2, 'custom', $3, 'mcp', $4, $5::jsonb)
RETURNING id, at`,
					tenantID, email, at, in.SourceEventID, string(metaRaw)).Scan(&eventID, &eventAt)
				if err == nil {
					err = subscriberevents.BindDedupKey(ctx, tx, tenantID, "mcp", in.SourceEventID, eventID, eventAt)
				}
			}
		} else {
			err = tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, at, source, metadata)
VALUES ($1::uuid, $2, 'custom', $3, 'mcp', $4::jsonb)
RETURNING id, at, false`,
				tenantID, email, at, string(metaRaw)).Scan(&eventID, &eventAt, &deduped)
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"id":               eventID,
			"subscriber_id":    id,
			"subscriber_email": email,
			"event_type":       "custom",
			"event_name":       in.EventName,
			"source":           "mcp",
			"source_event_id":  in.SourceEventID,
			"at":               eventAt,
			"deduped":          deduped,
		}, nil
	})
}

func mcpResolveSubscriberID(ctx context.Context, tx pgx.Tx, tenantID, idOrEmail string) (string, error) {
	id, _, err := mcpResolveSubscriberIDEmail(ctx, tx, tenantID, idOrEmail)
	return id, err
}

func mcpResolveSubscriberIDEmail(ctx context.Context, tx pgx.Tx, tenantID, idOrEmail string) (string, string, error) {
	var id, email string
	err := tx.QueryRow(ctx, `
SELECT id::text, email::text
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2) OR external_id = $2)`,
		tenantID, strings.TrimSpace(idOrEmail)).Scan(&id, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", errors.New("subscriber not found")
	}
	return id, email, err
}

func mcpLoadAliases(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, `
SELECT jsonb_build_object(
    'id', id::text,
    'alias_type', alias_type,
    'alias_value', alias_value,
    'confidence', confidence,
    'source', source,
    'last_seen_at', last_seen_at
)
  FROM profile_aliases
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY alias_type, confidence DESC, last_seen_at DESC`, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanJSONObjects(rows)
}

func mcpLoadTraits(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, `
SELECT jsonb_build_object(
    'key', key,
    'value', value,
    'value_type', value_type,
    'source', source,
    'model_version', COALESCE(model_version, ''),
    'confidence', confidence,
    'drivers', drivers,
    'computed_at', computed_at
)
  FROM subscriber_computed_traits
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY key`, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanJSONObjects(rows)
}

func mcpLoadLifecycle(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string) (map[string]any, error) {
	out := map[string]any{"stage": "subscriber", "score": 3}
	var raw []byte
	err := tx.QueryRow(ctx, `
SELECT jsonb_build_object('stage', stage, 'score', score, 'updated_at', updated_at)
  FROM subscriber_lifecycle
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`,
		tenantID, subscriberID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &out)
	return out, nil
}

func mcpLoadSubscriberEvents(ctx context.Context, tx pgx.Tx, tenantID, email string, limit int) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, `
SELECT jsonb_build_object(
    'id', id,
    'event_type', event_type,
    'event_name', metadata->>'event_name',
    'campaign_id', COALESCE(campaign_id::text, ''),
    'source', COALESCE(source, ''),
    'source_event_id', COALESCE(source_event_id, ''),
    'at', at,
    'metadata', metadata
)
  FROM subscriber_events
 WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
 ORDER BY at DESC
 LIMIT `+fmt.Sprintf("%d", limit), tenantID, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanJSONObjects(rows)
}

func scanJSONObjects(rows pgx.Rows) ([]map[string]any, error) {
	out := []map[string]any{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		obj := map[string]any{}
		_ = json.Unmarshal(raw, &obj)
		out = append(out, obj)
	}
	return out, rows.Err()
}

func validMCPAliasType(v string) bool {
	switch v {
	case "external_id", "anonymous_id", "device_token", "push_token", "custom":
		return true
	default:
		return false
	}
}

func safeMCPAliasMutationError(err error) error {
	switch {
	case errors.Is(err, subscribers.ErrNotFound):
		return errors.New("subscriber not found")
	case errors.Is(err, subscribers.ErrPreconditionFailed):
		return errors.New("subscriber revision is stale; reload the profile and retry")
	case errors.Is(err, subscribers.ErrAliasOwnedByAnotherProfile):
		return errors.New("identity alias is already attached to another subscriber")
	case errors.Is(err, subscribers.ErrInvalidInput):
		return err
	default:
		return errors.New("subscriber alias mutation failed without committing")
	}
}

// ---------------------------------------------------------------------
// getSegmentBestSendTime
// ---------------------------------------------------------------------

type bestSendTimeInput struct {
	SegmentID string `json:"segment_id"`
}

type bestSendTimeResult struct {
	SegmentID      string  `json:"segment_id,omitempty"`
	BestHourUTC    int     `json:"best_hour_utc"`
	BestDayOfWeek  int     `json:"best_day_of_week"`
	OpenRateAtBest float64 `json:"open_rate_at_best"`
	SampleSize     int     `json:"sample_size"`
	Note           string  `json:"note,omitempty"`
}

func handleGetSegmentBestSendTime(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in bestSendTimeInput
	if len(args) > 0 {
		if err := json.Unmarshal(args, &in); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}

	segmentID := ""
	if in.SegmentID != "" {
		var err error
		segmentID, err = canonicalUUID(in.SegmentID, "segment_id")
		if err != nil {
			return nil, err
		}
	}

	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		// Pull a 90d engagement aggregate. When segment_id is supplied we
		// restrict to events from that segment's materialised members
		// (segment_subscribers, joined to subscribers on email); when it
		// is empty the $2 IS NULL branch computes across the whole tenant.
		// We deliberately fall back to a friendly note on insufficient
		// data rather than 0/0 — the LLM does better with explicit cues.
		var bestHour, bestDOW, sample int
		var openRate float64
		const q = `
WITH base AS (
  SELECT e.*,
         EXTRACT(hour FROM e.at AT TIME ZONE 'UTC')::int   AS hr,
         EXTRACT(dow  FROM e.at AT TIME ZONE 'UTC')::int   AS dow
    FROM campaign_report_events e
   WHERE e.tenant_id = $1::uuid
     AND e.at >= now() - interval '90 days'
     AND (
          $2::text IS NULL
          OR EXISTS (
               SELECT 1
                 FROM subscribers s
                 JOIN segment_subscribers ss
                   ON ss.tenant_id = s.tenant_id AND ss.subscriber_id = s.id
                WHERE s.tenant_id = e.tenant_id
                  AND lower(s.email::text) = lower(e.subscriber_email::text)
                  AND ss.segment_id::text = $2::text
          )
     )
), buckets AS (
  SELECT hr,
         dow,
         count(*) FILTER (WHERE event_type = 'sent')::int      AS sent,
         count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened')::int AS opens
    FROM base
   GROUP BY hr, dow
)
SELECT hr, dow,
       CASE WHEN sent > 0 THEN opens::float / sent ELSE 0 END AS open_rate,
       sent
  FROM buckets
 WHERE sent >= 50
 ORDER BY open_rate DESC, sent DESC
 LIMIT 1`
		var segArg any
		if segmentID != "" {
			segArg = segmentID
		}
		err := tx.QueryRow(ctx, q, tenantID, segArg).Scan(&bestHour, &bestDOW, &openRate, &sample)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("query best send time: %w", err)
		}
		res := bestSendTimeResult{
			SegmentID:      segmentID,
			BestHourUTC:    bestHour,
			BestDayOfWeek:  bestDOW,
			OpenRateAtBest: openRate,
			SampleSize:     sample,
		}
		if errors.Is(err, pgx.ErrNoRows) || sample == 0 {
			scope := "across the whole tenant"
			if segmentID != "" {
				scope = "for this segment (it may be empty, stale, or below the threshold)"
			}
			res.Note = "Not enough engagement data " + scope +
				" (need ≥50 sends per (dow, hour) bucket over 90d). Falling back to the platform default of Tue 10:00 UTC."
			res.BestHourUTC = 10
			res.BestDayOfWeek = 2
		}
		return res, nil
	})
}

// ---------------------------------------------------------------------
// getAudienceHeatmap
// ---------------------------------------------------------------------

type heatmapInput struct {
	Days int `json:"days"`
}

type heatmapResult struct {
	Days int            `json:"days"`
	Grid [7][24]int     `json:"grid"`       // bucket sample counts
	Rate [7][24]float64 `json:"open_rates"` // per-bucket open rate [0,1]
	Note string         `json:"note,omitempty"`
}

func scanHeatmapRows(rows pgx.Rows, res *heatmapResult) (bool, error) {
	anyEngagement := false
	for rows.Next() {
		var dow, hr, sent, opens int
		if err := rows.Scan(&dow, &hr, &sent, &opens); err != nil {
			return false, err
		}
		if dow < 0 || dow > 6 || hr < 0 || hr > 23 {
			continue
		}
		res.Grid[dow][hr] = sent
		if sent > 0 {
			res.Rate[dow][hr] = float64(opens) / float64(sent)
			anyEngagement = true
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate heatmap: %w", err)
	}
	return anyEngagement, nil
}

func handleGetAudienceHeatmap(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in heatmapInput
	if len(args) > 0 {
		if err := json.Unmarshal(args, &in); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	if in.Days <= 0 {
		in.Days = 90
	}
	if in.Days > 180 {
		in.Days = 180
	}

	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		res := heatmapResult{Days: in.Days}
		// Reduce in Go after pulling 7×24=168 rows max.
		windowStart := time.Now().UTC().Add(-time.Duration(in.Days) * 24 * time.Hour)
		rows, err := tx.Query(ctx, `
SELECT EXTRACT(dow  FROM at AT TIME ZONE 'UTC')::int AS dow,
       EXTRACT(hour FROM at AT TIME ZONE 'UTC')::int AS hr,
       count(*) FILTER (WHERE event_type = 'sent')::int   AS sent,
       count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened')::int AS opens
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND at >= $2
 GROUP BY 1, 2`,
			tenantID, windowStart,
		)
		if err != nil {
			return nil, fmt.Errorf("query heatmap: %w", err)
		}
		defer rows.Close()
		anyEngagement, err := scanHeatmapRows(rows, &res)
		if err != nil {
			return nil, err
		}
		if !anyEngagement {
			res.Note = "No engagement events recorded in the requested window."
		}
		return res, nil
	})
}
