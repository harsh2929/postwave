// SPDX-License-Identifier: AGPL-3.0-only
//
// worker.go — hourly batch loop for streaming exports.
//
// The worker enumerates active streaming-export connections whose next
// hourly window is due, reads the subscriber_events for that window
// (joined with profile context), encodes the batch as Parquet or Avro
// per the connection config, and ships it through the Storage interface.
// Each shipment is recorded in streaming_export_runs.
//
// The HTTP "ship now" handler reuses ShipConnection so a manual trigger
// and the scheduled tick share one code path.
package streaming_export

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Worker drives streaming-export shipments.
type Worker struct {
	Repo    *Repo
	Storage Storage
	Logger  *slog.Logger
	// Interval between ticks (defaults to 5 minutes; each tick ships any
	// windows that became due).
	Interval time.Duration
	// now is swappable in tests; defaults to time.Now.
	now func() time.Time
}

func (w *Worker) clock() time.Time {
	if w.now != nil {
		return w.now()
	}
	return time.Now().UTC()
}

// Run drives the worker until ctx is canceled. Enumeration is
// tenant-scoped per tick via the per-tenant streaming_export_runs RLS;
// callers in main.go iterate tenants (mirroring the audience-sync
// scheduler) — for now Run is a no-op skeleton when no TenantLister is
// wired, leaving the manual ShipConnection path fully functional.
func (w *Worker) Run(ctx context.Context, lister TenantLister) error {
	if w == nil || w.Repo == nil || w.Storage == nil {
		return errors.New("streaming_export worker: incomplete deps")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	logger := w.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("streaming_export worker: starting", "interval", interval.String())
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if lister != nil {
			if err := w.tick(ctx, lister); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("streaming_export tick failed", "err", err.Error())
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// TenantLister enumerates tenant ids with at least one active
// streaming-export connection. Implemented in main.go against the
// cross-tenant worker GUC; kept as an interface so this package stays
// pool-agnostic and testable.
type TenantLister interface {
	StreamingExportTenants(ctx context.Context) ([]string, error)
}

// tick ships any due windows across all eligible tenants.
func (w *Worker) tick(ctx context.Context, lister TenantLister) error {
	tenants, err := lister.StreamingExportTenants(ctx)
	if err != nil {
		return err
	}
	now := w.clock().UTC()
	for _, tenantID := range tenants {
		conns, err := w.Repo.ListDueConnections(ctx, tenantID, now, 50)
		if err != nil {
			if w.Logger != nil {
				w.Logger.Warn("streaming_export: list due failed", "tenant", tenantID, "err", err.Error())
			}
			continue
		}
		for _, connID := range conns {
			if _, err := w.ShipConnection(ctx, tenantID, connID, now); err != nil && w.Logger != nil {
				w.Logger.Warn("streaming_export: ship failed", "tenant", tenantID, "connection", connID, "err", err.Error())
			}
		}
	}
	return nil
}

// ShipConnection ships the next due hourly window for one connection. The
// window is [lastWindowEnd | now-1h, hourFloor(now)); a window with no
// events still records a 'empty' run so last-shipped-at advances.
func (w *Worker) ShipConnection(ctx context.Context, tenantID, connectionID string, now time.Time, expectedVersion ...int64) (*Run, error) {
	if w.Storage == nil {
		return nil, fmt.Errorf("%w: object storage not configured", ErrInvalidInput)
	}
	now = now.UTC()
	windowEnd := now.Truncate(time.Hour)

	tx, err := db.WithTenant(ctx, w.Repo.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Keep manual requests and every scheduler replica on one cursor owner.
	// The lock is transaction-scoped, so a crashed process cannot strand it.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenantID+":"+connectionID); err != nil {
		return nil, err
	}

	conn, err := w.Repo.getConnection(ctx, tx, tenantID, connectionID)
	if err != nil {
		return nil, err
	}
	if conn.Status != "active" {
		return nil, fmt.Errorf("%w: streaming export connection must be active", ErrInvalidInput)
	}
	if len(expectedVersion) > 0 {
		if expectedVersion[0] < 1 {
			return nil, fmt.Errorf("%w: expected_connection_version must be positive", ErrInvalidInput)
		}
		if conn.Version != expectedVersion[0] {
			return nil, ErrStale
		}
	}
	cfg := ParseConfig(conn.Config)
	windowStart := windowEnd.Add(-time.Hour)
	cursor, cursorOK := parseStreamingCursor(conn.LastCursor)
	if cursorOK {
		windowStart = cursor.Cutoff
	}
	if !windowStart.Before(windowEnd) {
		// Nothing new to ship — already caught up to the current hour.
		return nil, fmt.Errorf("%w: window already shipped", ErrInvalidInput)
	}
	cursorFrom := cursor.ID
	rows, hasMore, err := w.Repo.fetchEventBatchAfter(ctx, tx, tenantID, windowStart, windowEnd, cfg.BatchSize, cfg.EventTypes, cursorFrom, !cursorOK)
	if err != nil {
		return nil, err
	}
	cursorTo := cursorFrom
	if len(rows) > 0 {
		cursorTo = rows[len(rows)-1].EventID
	}
	run, err := w.Repo.beginRun(ctx, tx, tenantID, connectionID, cfg.Format, cfg.Compression, windowStart, windowEnd, cursorFrom, cursorTo, hasMore)
	if err != nil {
		return nil, err
	}
	nextCursor, err := nextStreamingCursor(cursorFrom, cursorTo, windowStart, windowEnd, hasMore)
	if err != nil {
		return w.failRun(ctx, tx, tenantID, run.ID, err)
	}
	encodedCursor, err := encodeStreamingCursor(nextCursor)
	if err != nil {
		return w.failRun(ctx, tx, tenantID, run.ID, err)
	}

	if len(rows) == 0 {
		out, err := w.Repo.completeRun(ctx, tx, tenantID, run.ID, "empty", 0, 0, "", "")
		if err != nil {
			return nil, err
		}
		if err := w.Repo.updateConnectionCursor(ctx, tx, tenantID, connectionID, encodedCursor); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return out, nil
	}

	body, contentType, ext, err := encodeBatch(cfg.Format, rows)
	if err != nil {
		return w.failRun(ctx, tx, tenantID, run.ID, err)
	}

	// Apply the connection's compression. Previously the setting was persisted
	// on the run but never applied, so the file shipped uncompressed while the
	// run row claimed (say) zstd. Compress errors fail the run rather than
	// silently shipping the wrong thing.
	body, compExt, err := Compress(body, cfg.Compression)
	if err != nil {
		return w.failRun(ctx, tx, tenantID, run.ID, err)
	}
	ext += compExt

	rest := ObjectKey(cfg.Prefix, tenantID, windowStart, run.ID, ext)
	key, err := w.Storage.Put(ctx, tenantID, rest, contentType, bytes.NewReader(body))
	if err != nil {
		return w.failRun(ctx, tx, tenantID, run.ID, fmt.Errorf("ship: %w", err))
	}
	uri := key
	if presigned, perr := w.Storage.PresignGet(ctx, tenantID, rest, 24*time.Hour); perr == nil && presigned != "" {
		uri = presigned
	}

	out, err := w.Repo.completeRun(ctx, tx, tenantID, run.ID, "completed", int64(len(rows)), int64(len(body)), uri, "")
	if err != nil {
		return nil, err
	}
	if err := w.Repo.updateConnectionCursor(ctx, tx, tenantID, connectionID, encodedCursor); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// failRun marks the run failed inside the same tx, commits, and returns
// the error so the caller surfaces it.
func (w *Worker) failRun(ctx context.Context, tx pgx.Tx, tenantID, runID string, cause error) (*Run, error) {
	_, _ = w.Repo.completeRun(ctx, tx, tenantID, runID, "failed", 0, 0, "", cause.Error())
	_ = tx.Commit(ctx)
	return nil, cause
}

// encodeBatch encodes rows in the requested format, returning the body,
// content type, and file extension.
func encodeBatch(format string, rows []EventRow) ([]byte, string, string, error) {
	switch format {
	case FormatAvro:
		body, err := EncodeAvro(rows)
		return body, AvroContentType, "avro", err
	default:
		body, err := EncodeParquet(rows)
		return body, ParquetContentType, "parquet", err
	}
}
