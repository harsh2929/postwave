// SPDX-License-Identifier: AGPL-3.0-only
//
// repo.go — database CRUD for streaming_export_runs plus the helpers the
// worker needs to enumerate due streaming-export connections and read
// the event batch for a window.
package streaming_export

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// connectionRow is the minimal warehouse_connections shape this package
// reads: enough to know the destination + config for a streaming export.
type connectionRow struct {
	ID         string
	Name       string
	Provider   string
	Status     string
	Cadence    string
	Config     map[string]any
	LastCursor string
	Version    int64
}

// getConnection loads a streaming-export connection (RLS-scoped).
func (r *Repo) getConnection(ctx context.Context, tx pgx.Tx, tenantID, id string) (*connectionRow, error) {
	var c connectionRow
	var raw []byte
	err := tx.QueryRow(ctx, `
SELECT id::text, name, provider, status, cadence, config, last_cursor, version
  FROM warehouse_connections
 WHERE tenant_id = $1::uuid AND id = $2::uuid
	 LIMIT 1
	 FOR SHARE`, tenantID, id).Scan(&c.ID, &c.Name, &c.Provider, &c.Status, &c.Cadence, &raw, &c.LastCursor, &c.Version)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	c.Config = decodeMap(raw)
	if c.Provider != ProviderStreamingExport {
		return nil, ErrInvalidInput
	}
	return &c, nil
}

// ListDueConnections returns active streaming-export connections that
// have not shipped within the last hour (or never shipped), capped at
// limit. Cross-tenant safe only when called under a tenant-bound tx;
// here it is tenant-scoped.
func (r *Repo) ListDueConnections(ctx context.Context, tenantID string, now time.Time, limit int) ([]string, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT c.id::text, c.last_cursor
  FROM warehouse_connections c
 WHERE c.tenant_id = $1::uuid
   AND c.provider = $2
   AND c.status = 'active'
 ORDER BY c.updated_at ASC
 LIMIT 1000`, tenantID, ProviderStreamingExport)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	cutoff := now.UTC().Truncate(time.Hour)
	for rows.Next() {
		var id, rawCursor string
		if err := rows.Scan(&id, &rawCursor); err != nil {
			return nil, err
		}
		cursor, ok := parseStreamingCursor(rawCursor)
		if !ok || cursor.Cutoff.Before(cutoff) {
			out = append(out, id)
			if len(out) >= limit {
				break
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

type streamingCursor struct {
	Schema string    `json:"schema"`
	ID     int64     `json:"id"`
	Cutoff time.Time `json:"cutoff"`
}

func parseStreamingCursor(raw string) (streamingCursor, bool) {
	var out streamingCursor
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 512 || json.Unmarshal([]byte(raw), &out) != nil {
		return streamingCursor{}, false
	}
	if out.Schema != "streaming.v1" || out.ID < 0 || out.Cutoff.IsZero() {
		return streamingCursor{}, false
	}
	out.Cutoff = out.Cutoff.UTC()
	return out, true
}

func encodeStreamingCursor(cursor streamingCursor) (string, error) {
	cursor.Schema = "streaming.v1"
	cursor.Cutoff = cursor.Cutoff.UTC()
	if cursor.ID < 0 || cursor.Cutoff.IsZero() {
		return "", fmt.Errorf("invalid streaming cursor")
	}
	raw, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// nextStreamingCursor keeps an overflowed window anchored at its original
// lower bound while advancing only the event ID. Once the bounded batch is
// exhausted, it advances the cutoff to the completed window end. Keeping this
// transition pure makes the no-skip invariant independently testable.
func nextStreamingCursor(cursorFrom, cursorTo int64, windowStart, windowEnd time.Time, hasMore bool) (streamingCursor, error) {
	if cursorFrom < 0 || cursorTo < cursorFrom || windowStart.IsZero() || !windowStart.Before(windowEnd) {
		return streamingCursor{}, fmt.Errorf("invalid streaming cursor transition")
	}
	cutoff := windowEnd
	if hasMore {
		cutoff = windowStart
	}
	return streamingCursor{
		Schema: "streaming.v1",
		ID:     cursorTo,
		Cutoff: cutoff.UTC(),
	}, nil
}

// LastWindowEnd returns the most recent shipped window_end for a
// connection, or nil when nothing has shipped yet.
func (r *Repo) lastWindowEnd(ctx context.Context, tx pgx.Tx, tenantID, connectionID string) (*time.Time, error) {
	var ts *time.Time
	err := tx.QueryRow(ctx, `
SELECT max(window_end)
  FROM streaming_export_runs
 WHERE tenant_id = $1::uuid AND connection_id = $2::uuid
   AND status IN ('completed', 'empty') AND has_more = false`, tenantID, connectionID).Scan(&ts)
	if err != nil {
		return nil, err
	}
	return ts, nil
}

// fetchEventBatch reads up to batchSize subscriber events in
// [windowStart, windowEnd), joined with subscriber profile context.
// Tenant-bound via the tx GUC.
//
// When eventTypes is non-empty the batch is restricted to those
// subscriber_events.event_type values (the connection's configured
// field_filters), so a connection scoped to e.g. ["opened","clicked"]
// never ships other event types. An empty/nil eventTypes means "ship
// every type". The filter is passed as a bound text[] parameter
// (event_type = ANY($5)) so it is always parameterized — never
// string-interpolated.
func (r *Repo) fetchEventBatch(ctx context.Context, tx pgx.Tx, tenantID string, windowStart, windowEnd time.Time, batchSize int, eventTypes []string) ([]EventRow, error) {
	rows, _, err := r.fetchEventBatchAfter(ctx, tx, tenantID, windowStart, windowEnd, batchSize, eventTypes, 0, true)
	return rows, err
}

func (r *Repo) fetchEventBatchAfter(ctx context.Context, tx pgx.Tx, tenantID string, windowStart, windowEnd time.Time, batchSize int, eventTypes []string, cursorID int64, applyLowerBound bool) ([]EventRow, bool, error) {
	if batchSize <= 0 {
		batchSize = DefaultBatchSize
	}
	if batchSize > MaxBatchSize {
		batchSize = MaxBatchSize
	}
	rows, err := tx.Query(ctx, `
SELECT e.id,
       e.subscriber_email::text,
       e.event_type,
       COALESCE(e.campaign_id::text, ''),
       COALESCE(e.link_url, ''),
       e.at,
       COALESCE(s.status, ''),
       COALESCE(to_jsonb(s.tags), '[]'::jsonb),
       COALESCE(s.custom_fields, '{}'::jsonb)
  FROM subscriber_events e
  LEFT JOIN subscribers s
         ON s.tenant_id = e.tenant_id
        AND s.email = e.subscriber_email
 WHERE e.tenant_id = $1::uuid
	AND ($7::boolean = false OR e.at >= $2::timestamptz)
   AND e.at <  $3::timestamptz
	AND e.id > $6
   AND ($5::text[] IS NULL OR e.event_type = ANY($5::text[]))
	ORDER BY e.id ASC
	LIMIT $4`, tenantID, windowStart, windowEnd, batchSize+1, eventTypeFilterArg(eventTypes), cursorID, applyLowerBound)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := make([]EventRow, 0, 256)
	for rows.Next() {
		var er EventRow
		var at time.Time
		var tags, custom []byte
		if err := rows.Scan(&er.EventID, &er.SubscriberEmail, &er.EventType,
			&er.CampaignID, &er.LinkURL, &at, &er.SubscriberStatus, &tags, &custom); err != nil {
			return nil, false, err
		}
		er.TenantID = tenantID
		er.AtUnixMs = at.UnixMilli()
		er.Tags = string(tags)
		er.CustomFields = string(custom)
		out = append(out, er)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(out) > batchSize
	if hasMore {
		out = out[:batchSize]
	}
	return out, hasMore, nil
}

// eventTypeFilterArg returns the value bound to the event_type filter
// parameter: nil when no filters are configured (so the SQL predicate
// `$5::text[] IS NULL` short-circuits to "ship every type"), otherwise
// the list to match with `event_type = ANY($5)`. Passing a typed nil
// rather than the slice keeps the IS NULL branch reachable.
func eventTypeFilterArg(eventTypes []string) any {
	if len(eventTypes) == 0 {
		return nil
	}
	return eventTypes
}

// StreamingExportTenants enumerates the distinct tenant ids that own at
// least one active streaming-export connection. It runs cross-tenant
// under db.WithWorkerScope (the warehouse_connections worker_select gate
// from migration 1117), mirroring the audience-sync scheduler: the
// worker re-binds app.tenant_id per tenant before shipping, so every
// read/write still flows through tenant_isolation. Satisfies the
// worker's TenantLister interface.
func (r *Repo) StreamingExportTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT DISTINCT tenant_id::text
  FROM warehouse_connections
 WHERE provider = $1
   AND status = 'active'`, ProviderStreamingExport)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Read-only scan; deferred Rollback closes it.
	return out, nil
}

// beginRun inserts a 'running' streaming_export_runs row and returns it.
func (r *Repo) beginRun(ctx context.Context, tx pgx.Tx, tenantID, connectionID, format, compression string, windowStart, windowEnd time.Time, cursorFrom, cursorTo int64, hasMore bool) (*Run, error) {
	var run Run
	err := tx.QueryRow(ctx, `
INSERT INTO streaming_export_runs
       (tenant_id, connection_id, status, format, compression, window_start, window_end,
		cursor_from, cursor_to, has_more)
VALUES ($1::uuid, $2::uuid, 'running', $3, $4, $5, $6, $7, $8, $9)
RETURNING id::text, tenant_id::text, connection_id::text, status, format, compression,
          window_start, window_end, cursor_from, cursor_to, has_more,
		  rows_shipped, bytes_shipped, object_uri, error,
          started_at, completed_at, created_at`,
		tenantID, connectionID, format, compression, windowStart, windowEnd, cursorFrom, cursorTo, hasMore).Scan(
		&run.ID, &run.TenantID, &run.ConnectionID, &run.Status, &run.Format, &run.Compression,
		&run.WindowStart, &run.WindowEnd, &run.CursorFrom, &run.CursorTo, &run.HasMore,
		&run.RowsShipped, &run.BytesShipped, &run.ObjectURI,
		&run.Error, &run.StartedAt, &run.CompletedAt, &run.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &run, nil
}

// completeRun closes a run with shipment totals.
func (r *Repo) completeRun(ctx context.Context, tx pgx.Tx, tenantID, runID, status string, rows, bytesShipped int64, objectURI, errMsg string) (*Run, error) {
	const maxErr = 2000
	if len(errMsg) > maxErr {
		errMsg = errMsg[:maxErr] + "…"
	}
	var run Run
	err := tx.QueryRow(ctx, `
UPDATE streaming_export_runs
   SET status = $3, rows_shipped = $4, bytes_shipped = $5,
       object_uri = $6, error = $7, completed_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, connection_id::text, status, format, compression,
          window_start, window_end, cursor_from, cursor_to, has_more,
		  rows_shipped, bytes_shipped, object_uri, error,
          started_at, completed_at, created_at`,
		tenantID, runID, status, rows, bytesShipped, objectURI, errMsg).Scan(
		&run.ID, &run.TenantID, &run.ConnectionID, &run.Status, &run.Format, &run.Compression,
		&run.WindowStart, &run.WindowEnd, &run.CursorFrom, &run.CursorTo, &run.HasMore,
		&run.RowsShipped, &run.BytesShipped, &run.ObjectURI,
		&run.Error, &run.StartedAt, &run.CompletedAt, &run.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &run, nil
}

func (r *Repo) updateConnectionCursor(ctx context.Context, tx pgx.Tx, tenantID, connectionID, cursor string) error {
	if _, ok := parseStreamingCursor(cursor); !ok {
		return fmt.Errorf("invalid streaming cursor")
	}
	tag, err := tx.Exec(ctx, `
UPDATE warehouse_connections
   SET last_cursor = $3,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND provider = $4
   AND status = 'active'`, tenantID, connectionID, cursor, ProviderStreamingExport)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// ListRuns returns the recent runs for a connection, newest-first, plus
// the last-shipped-at timestamp (nil when nothing shipped).
func (r *Repo) ListRuns(ctx context.Context, tenantID, connectionID string, limit int) ([]Run, *time.Time, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// 404 unknown connection ids so the UI's not-found handling is honest.
	if _, err := r.getConnection(ctx, tx, tenantID, connectionID); err != nil {
		return nil, nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, connection_id::text, status, format, compression,
       window_start, window_end, cursor_from, cursor_to, has_more,
	   rows_shipped, bytes_shipped, object_uri, error,
       started_at, completed_at, created_at
  FROM streaming_export_runs
 WHERE tenant_id = $1::uuid AND connection_id = $2::uuid
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, connectionID, limit)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []Run{}
	var lastShipped *time.Time
	for rows.Next() {
		var run Run
		if err := rows.Scan(&run.ID, &run.TenantID, &run.ConnectionID, &run.Status,
			&run.Format, &run.Compression, &run.WindowStart, &run.WindowEnd,
			&run.CursorFrom, &run.CursorTo, &run.HasMore,
			&run.RowsShipped, &run.BytesShipped, &run.ObjectURI, &run.Error,
			&run.StartedAt, &run.CompletedAt, &run.CreatedAt); err != nil {
			return nil, nil, err
		}
		if (run.Status == "completed" || run.Status == "empty") && !run.HasMore && (lastShipped == nil || run.WindowEnd.After(*lastShipped)) {
			we := run.WindowEnd
			lastShipped = &we
		}
		out = append(out, run)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return out, lastShipped, tx.Commit(ctx)
}

func decodeMap(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}
