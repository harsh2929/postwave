// SPDX-License-Identifier: AGPL-3.0-only
package integration_backfill

import (
	"context"
	"errors"
	"testing"
	"time"
)

// pager fakes a paginated source: cursors "", "p1", "p2", ... each returning
// `rowsPerPage` rows, until `pages` have been served, after which it reports
// exhaustion (0 rows, unchanged cursor).
func pager(pages, rowsPerPage int) (PageFunc, *int) {
	calls := 0
	served := 0
	fn := func(_ context.Context, cursor string) (PageResult, error) {
		calls++
		if served >= pages {
			return PageResult{NextCursor: cursor, Rows: 0}, nil
		}
		served++
		return PageResult{NextCursor: "p" + itoa(served), Rows: rowsPerPage}, nil
	}
	return fn, &calls
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func TestDrainWalksEveryPageToExhaustion(t *testing.T) {
	page, calls := pager(3, 10)
	res := Drain(context.Background(), Options{}, page)
	if res.Stop != StopExhausted {
		t.Fatalf("stop=%q want exhausted", res.Stop)
	}
	if res.RowsTotal != 30 {
		t.Fatalf("rows=%d want 30", res.RowsTotal)
	}
	// 3 productive pages + 1 terminal empty page that signals the end.
	if *calls != 4 || res.PagesRun != 4 {
		t.Fatalf("calls=%d pagesRun=%d want 4/4", *calls, res.PagesRun)
	}
}

func TestDrainStopsOnEmptyFirstPage(t *testing.T) {
	page, _ := pager(0, 0)
	res := Drain(context.Background(), Options{}, page)
	if res.Stop != StopExhausted || res.PagesRun != 1 || res.RowsTotal != 0 {
		t.Fatalf("a source with no history should be one empty page: %+v", res)
	}
}

func TestDrainHonorsMaxPages(t *testing.T) {
	// Infinite source: always returns rows and a fresh cursor.
	n := 0
	page := func(_ context.Context, _ string) (PageResult, error) {
		n++
		return PageResult{NextCursor: "c" + itoa(n), Rows: 5}, nil
	}
	res := Drain(context.Background(), Options{MaxPages: 4}, page)
	if res.Stop != StopMaxPages {
		t.Fatalf("stop=%q want max_pages", res.Stop)
	}
	if res.PagesRun != 4 || res.RowsTotal != 20 {
		t.Fatalf("pagesRun=%d rows=%d want 4/20", res.PagesRun, res.RowsTotal)
	}
}

func TestDrainStopsWhenCursorDoesNotAdvance(t *testing.T) {
	// A misbehaving provider that returns rows but never moves the cursor must
	// not loop forever — the unchanged cursor ends the walk.
	page := func(_ context.Context, _ string) (PageResult, error) {
		return PageResult{NextCursor: "stuck", Rows: 7}, nil
	}
	res := Drain(context.Background(), Options{StartCursor: "stuck"}, page)
	if res.Stop != StopExhausted || res.PagesRun != 1 {
		t.Fatalf("stuck cursor must terminate after one page: %+v", res)
	}
}

func TestDrainSurfacesPageError(t *testing.T) {
	boom := errors.New("provider 500")
	page := func(_ context.Context, _ string) (PageResult, error) {
		return PageResult{}, boom
	}
	res := Drain(context.Background(), Options{}, page)
	if res.Stop != StopError || !errors.Is(res.Err, boom) {
		t.Fatalf("expected the page error surfaced: %+v", res)
	}
}

func TestDrainStopsOnCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	page := func(_ context.Context, _ string) (PageResult, error) {
		return PageResult{NextCursor: "x", Rows: 1}, nil
	}
	res := Drain(ctx, Options{}, page)
	if res.Stop != StopCanceled {
		t.Fatalf("stop=%q want canceled", res.Stop)
	}
	if res.PagesRun != 0 {
		t.Fatalf("a pre-cancelled context must not pull any page: %+v", res)
	}
}

func TestDrainPageDelayRespectsCancel(t *testing.T) {
	// One page succeeds, then the delay is interrupted by cancellation before
	// the second page — drain ends as canceled having run exactly one page.
	ctx, cancel := context.WithCancel(context.Background())
	page := func(_ context.Context, _ string) (PageResult, error) {
		cancel() // cancel during the post-page delay
		return PageResult{NextCursor: "next", Rows: 1}, nil
	}
	res := Drain(ctx, Options{PageDelay: time.Hour}, page)
	if res.Stop != StopCanceled || res.PagesRun != 1 {
		t.Fatalf("delay should abort on cancel after one page: %+v", res)
	}
}
