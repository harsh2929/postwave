// SPDX-License-Identifier: AGPL-3.0-only
//
// webmention_worker.go — async Webmention parser worker stub for the
// cross-tenant editorial Recommendations Network (gap feature
// `archive-recommendations-network`, P2, XL).
//
// This is the worker side of the (Ghost-style) open-web variant. The
// HTTP receiver at `POST /api/public/webmention` (recommendations.go)
// accepts a {source, target} pair, returns 202 immediately, and queues
// the payload in `webmentions_inbox` with status='pending'. This worker
// drains that queue:
//
//   1. SELECT a batch of pending rows (the SKIP LOCKED pattern keeps
//      multiple replicas from clobbering each other on the same row).
//   2. For each row, fetch the source HTML, verify the target URL is
//      actually linked from the source (the Webmention spec REQUIRES
//      this — otherwise any external site could spam an inbox), and
//      parse h-card author info + microformats from the source.
//   3. Transition status to 'parsed' on success, 'rejected' on a
//      provable failure (target not linked, source unreachable after
//      retries, malformed HTML), or leave it 'pending' if the source
//      is transiently unavailable and try again on the next tick.
//   4. Bump counters on the open `webmention_parser_runs` row so a
//      /healthz tile can surface "last run 2m ago, processed 14, 2
//      promoted".
//
// The actual HTML fetch + h-card parsing is DEFERRED — see
// MIGRATION.md for the deferred-work register. The worker LOOP and
// run-row bookkeeping live here so the human engineer who picks this
// up has the skeleton in place.
//
// Inspired by 2026 SOTA: Substack (Recommendations Network),
// beehiiv (Top-4), Ghost (Webmention-based parser worker).

package archive

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// WebmentionWorker drains `webmentions_inbox` and parses queued
// payloads into a shape the operator can promote into a recommendation.
//
// The worker is platform-scoped (not per-tenant) — Webmention is a
// public-internet receiver and rows can land with tenant_id NULL when
// the target host doesn't match any tenant's archive_domain.
type WebmentionWorker struct {
	Pool   *db.Pool
	Logger *slog.Logger

	// BatchSize bounds the number of inbox rows pulled per tick. The
	// FOR UPDATE SKIP LOCKED query lets us run multiple replicas
	// concurrently without contention; each replica drains a disjoint
	// slice of the pending queue. Defaults to 25 when zero.
	BatchSize int

	// TickInterval bounds the worker's idle sleep. We poll the inbox
	// at this cadence; on a non-empty pull the worker bursts through
	// the batch before sleeping again. Defaults to 30s when zero.
	TickInterval time.Duration

	// Parser fetches and validates the source document. Production uses
	// the SSRF-guarded HTTP parser; leaving it nil prevents the worker from
	// starting rather than silently accumulating an unprocessed queue.
	Parser WebmentionParser
}

// WebmentionParser is the source-page parser seam. The real implementation
// fetches `source`, verifies `target` is linked, extracts h-card author
// info + the source-page title, and returns a structured result.
type WebmentionParser interface {
	Parse(ctx context.Context, source, target string) (WebmentionParseResult, error)
}

// WebmentionParseResult is what the parser returns to the worker.
type WebmentionParseResult struct {
	// LinkVerified is true iff the source HTML actually links the
	// target. The Webmention spec requires we reject rows where this
	// is false — otherwise any site could spam an inbox.
	LinkVerified bool
	// Title is the (truncated) <title> of the source page.
	Title string
	// AuthorName / AuthorURL are extracted from h-card microformats
	// when present; both empty when not.
	AuthorName string
	AuthorURL  string
}

// errParserDeferred marks transient fetch failures. The worker leaves those
// rows pending so a later tick can retry without losing the payload.
var errParserDeferred = errors.New("webmention worker: transient parser failure — leaving payload pending")

// NewWebmentionWorker returns a worker wired with the real SSRF-guarded
// parser (webmention_parser.go).
func NewWebmentionWorker(pool *db.Pool, logger *slog.Logger) *WebmentionWorker {
	return &WebmentionWorker{
		Pool:         pool,
		Logger:       logger,
		BatchSize:    25,
		TickInterval: 30 * time.Second,
		Parser:       newHTTPWebmentionParser(),
	}
}

// Run drives the worker loop until ctx is cancelled. Safe to spawn from
// multiple replicas — the SKIP LOCKED queue claim ensures disjoint work.
func (w *WebmentionWorker) Run(ctx context.Context) {
	if w.BatchSize <= 0 {
		w.BatchSize = 25
	}
	if w.TickInterval <= 0 {
		w.TickInterval = 30 * time.Second
	}
	if w.Parser == nil {
		w.logf("webmention_worker: parser is not configured; worker stopped")
		return
	}
	t := time.NewTicker(w.TickInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := w.Tick(ctx); err != nil {
				w.logf("webmention_worker: tick failed: %v", err)
			}
		}
	}
}

// Tick runs one parser pass. Exposed for tests + admin-triggered runs.
func (w *WebmentionWorker) Tick(ctx context.Context) error {
	runID, err := w.openRun(ctx)
	if err != nil {
		return fmt.Errorf("open run: %w", err)
	}
	scanned, ok, errs, promoted, lastErr := w.drainBatch(ctx)
	return w.closeRun(ctx, runID, scanned, ok, errs, promoted, lastErr)
}

// openRun INSERTs a `webmention_parser_runs` row with status='running'
// and returns its id. All worker tables are gated by the
// `app.outbox_worker` GUC — we use `db.WithWorkerScope` to bind it.
func (w *WebmentionWorker) openRun(ctx context.Context) (string, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO webmention_parser_runs (status)
VALUES ('running')
RETURNING id::text`).Scan(&id); err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

// closeRun stamps the final counters + status on the run row.
func (w *WebmentionWorker) closeRun(
	ctx context.Context,
	runID string,
	scanned, ok, errs, promoted int,
	lastErr string,
) error {
	status := "ok"
	switch {
	case errs > 0 && ok == 0 && promoted == 0:
		status = "failed"
	case errs > 0:
		status = "partial"
	}
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE webmention_parser_runs
   SET finished_at = now(),
       scanned     = $2,
       parsed_ok   = $3,
       parsed_err  = $4,
       promoted    = $5,
       status      = $6,
       last_error  = LEFT($7, 4096)
 WHERE id::text = $1`, runID, scanned, ok, errs, promoted, status, lastErr); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// drainBatch claims up to BatchSize pending inbox rows, asks the parser
// to handle each, and updates inbox status accordingly. Returns
// (scanned, parsed_ok, parsed_err, promoted, last_error).
//
// `promoted` is always 0 at this stage — promotion into
// `tenant_recommendations` is a separate operator-driven step (the
// slideover surfaces parsed rows; the operator clicks "promote").
// DEFERRED: an auto-promote rule for high-trust peers (rows where the
// source host already lives in `recommendation_network_peers`).
func (w *WebmentionWorker) drainBatch(ctx context.Context) (scanned, ok, errs, promoted int, lastErr string) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, 0, 0, 0, err.Error()
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// SKIP LOCKED so concurrent replicas drain disjoint slices.
	rows, err := tx.Query(ctx, `
SELECT id::text, source_url, target_url
  FROM webmentions_inbox
 WHERE status = 'pending'
 ORDER BY received_at ASC
 LIMIT $1
 FOR UPDATE SKIP LOCKED`, w.BatchSize)
	if err != nil {
		return 0, 0, 0, 0, err.Error()
	}
	type pending struct{ id, source, target string }
	var batch []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.source, &p.target); err != nil {
			rows.Close()
			return scanned, ok, errs, promoted, err.Error()
		}
		batch = append(batch, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return scanned, ok, errs, promoted, err.Error()
	}

	for _, p := range batch {
		scanned++
		res, perr := w.Parser.Parse(ctx, p.source, p.target)
		if errors.Is(perr, errParserDeferred) {
			// Transient source failure: leave the row pending so the next
			// tick can retry it without losing the inbound payload.
			continue
		}
		if perr != nil || !res.LinkVerified {
			errs++
			if perr != nil {
				lastErr = perr.Error()
			} else {
				lastErr = "link not verified on source"
			}
			if _, uerr := tx.Exec(ctx, `
UPDATE webmentions_inbox
   SET status = 'rejected', parsed_at = now()
 WHERE id::text = $1`, p.id); uerr != nil {
				return scanned, ok, errs, promoted, uerr.Error()
			}
			continue
		}
		ok++
		if _, uerr := tx.Exec(ctx, `
UPDATE webmentions_inbox
   SET status       = 'parsed',
       parsed_at    = now(),
       author_name  = LEFT($2, 200),
       author_url   = LEFT($3, 2048),
       source_title = LEFT($4, 200)
 WHERE id::text = $1`, p.id, res.AuthorName, res.AuthorURL, res.Title); uerr != nil {
			return scanned, ok, errs, promoted, uerr.Error()
		}
	}

	if cerr := tx.Commit(ctx); cerr != nil {
		return scanned, ok, errs, promoted, cerr.Error()
	}
	return scanned, ok, errs, promoted, lastErr
}

// logf is a thin wrapper that no-ops on a nil logger so tests that
// don't wire one don't have to construct a slog.Handler.
func (w *WebmentionWorker) logf(format string, args ...any) {
	if w.Logger == nil {
		return
	}
	w.Logger.Info(fmt.Sprintf(format, args...))
}

// DiscoverNetworkPeer is the (deferred) cross-tenant discovery hook.
// Given a host, fetch /.well-known/postwave-recommendations.json, verify
// signature/freshness, and upsert into recommendation_network_peers.
//
// DEFERRED: the actual fetch + manifest verification. Stub is here so
// the caller in webmention drainBatch + the (deferred) periodic
// discovery sweep can be wired against a stable signature.
//
// pgx.ErrNoRows is returned today so callers know the host is not (yet)
// an in-network peer — keeps the open-web outbound path the safe
// default for every recommendation rendered.
func (r *Repo) DiscoverNetworkPeer(ctx context.Context, host string) error {
	_ = ctx
	_ = host
	return pgx.ErrNoRows
}
