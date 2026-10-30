// SPDX-License-Identifier: AGPL-3.0-only
//
// Package integration_backfill provides a provider-agnostic "drain to completion"
// loop layered on top of the per-connector single-page backfillers. Each
// connector exposes a one-page backfill (pull a page from the source, apply it,
// return the next cursor); historically the only driver was the manual
// POST /backfill endpoint, which advances exactly one page per call. Klaviyo's
// hallmark on-connect behaviour is different: the moment you connect a source it
// imports your trailing history automatically. Drain is that loop — it walks the
// connector's pages from a starting cursor until the source is exhausted, the
// page cap is hit, the context is cancelled, or a page errors. It holds no state
// and does no I/O itself, so it is exhaustively unit-testable with a fake page.
package integration_backfill

import (
	"context"
	"time"
)

// DefaultMaxPages bounds a single drain so a runaway/looping cursor can never
// spin forever. A connect-time backfill that needs more than this many pages
// will be finished by the ongoing incremental/scheduled sync.
const DefaultMaxPages = 200

// PageResult is the outcome of pulling+applying one backfill page.
type PageResult struct {
	// NextCursor is the watermark to resume from. Empty, or unchanged from the
	// cursor passed in, signals the source is exhausted.
	NextCursor string
	// Rows processed in this page. Zero signals the source is exhausted.
	Rows int
}

// PageFunc pulls and applies one page starting at cursor and returns the next
// cursor. It is the only thing Drain calls; a connector adapts its existing
// single-page backfill into this shape.
type PageFunc func(ctx context.Context, cursor string) (PageResult, error)

// Options bounds a drain.
type Options struct {
	StartCursor string
	// MaxPages caps the walk (defaults to DefaultMaxPages when <= 0).
	MaxPages int
	// PageDelay pauses between pages to stay under provider rate limits.
	PageDelay time.Duration
}

// StopReason explains why a drain ended.
type StopReason string

const (
	// StopExhausted: the source reported no more rows / the cursor stopped
	// advancing — the happy path, all available history imported.
	StopExhausted StopReason = "exhausted"
	// StopMaxPages: hit the page cap; more history may remain (the scheduled
	// sync will continue from FinalCursor).
	StopMaxPages StopReason = "max_pages"
	// StopError: a page returned an error; the drain stops at that point.
	StopError StopReason = "error"
	// StopCanceled: the context was cancelled (shutdown / timeout).
	StopCanceled StopReason = "canceled"
)

// Result is the aggregate outcome of a drain.
type Result struct {
	PagesRun    int
	RowsTotal   int
	FinalCursor string
	Stop        StopReason
	Err         error
}

// Drain repeatedly invokes page until the source is exhausted, the page cap is
// hit, the context is cancelled, or a page errors. It guarantees termination:
// a page that returns zero rows OR fails to advance the cursor ends the walk,
// so a stuck cursor cannot loop forever even below the page cap.
func Drain(ctx context.Context, opts Options, page PageFunc) Result {
	maxPages := opts.MaxPages
	if maxPages <= 0 {
		maxPages = DefaultMaxPages
	}
	cursor := opts.StartCursor
	res := Result{FinalCursor: cursor}
	for res.PagesRun < maxPages {
		if err := ctx.Err(); err != nil {
			res.Stop, res.Err = StopCanceled, err
			return res
		}
		pr, err := page(ctx, cursor)
		res.PagesRun++
		if err != nil {
			res.Stop, res.Err = StopError, err
			return res
		}
		res.RowsTotal += pr.Rows
		// Exhausted when the source reports no rows OR the cursor doesn't move
		// forward. Record the terminal cursor when the provider supplied one.
		if pr.Rows == 0 || pr.NextCursor == "" || pr.NextCursor == cursor {
			if pr.NextCursor != "" {
				res.FinalCursor = pr.NextCursor
			}
			res.Stop = StopExhausted
			return res
		}
		cursor = pr.NextCursor
		res.FinalCursor = cursor
		if opts.PageDelay > 0 && !sleep(ctx, opts.PageDelay) {
			res.Stop, res.Err = StopCanceled, ctx.Err()
			return res
		}
	}
	res.Stop = StopMaxPages
	return res
}

// sleep waits d or returns false if the context is cancelled first.
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
