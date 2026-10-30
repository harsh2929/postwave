// SPDX-License-Identifier: AGPL-3.0-only
package middleware

import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// CostTotalReader is the read side of the per-request running total. The
// cost package's RunningTotalCents satisfies it without an import cycle:
// callers wire it in by passing the function directly.
type CostTotalReader func(ctx context.Context) int64

// CostWithRunningTotal lets callers seed the running-total cell on ctx.
type CostWithRunningTotal func(ctx context.Context) context.Context

// BudgetIncrementer is invoked at the end of the request with the running
// cost so the dollar-budget tally stays in sync with what we charged. Errors
// are intentionally swallowed — the response is already on the wire.
type BudgetIncrementer func(ctx context.Context, cents int64, at time.Time)

// CostHeaderMiddleware appends `X-Postwave-Cost-Cents` to every response by
// hooking WriteHeader. It also seeds the running-total cell on ctx (so any
// handler downstream can call cost.RecordFromContext) and, after the
// response is flushed, invokes the optional BudgetIncrementer so the
// dollar-budget repo sees the cost.
func CostHeaderMiddleware(
	withTotal CostWithRunningTotal,
	readTotal CostTotalReader,
	incBudget BudgetIncrementer,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := withTotal(r.Context())
			cw := &costWriter{ResponseWriter: w, ctx: ctx, readTotal: readTotal}
			next.ServeHTTP(cw, r.WithContext(ctx))
			cw.flushHeaderIfNeeded()
			if incBudget != nil {
				if c := readTotal(ctx); c > 0 {
					incBudget(ctx, c, time.Now().UTC())
				}
			}
		})
	}
}

// costWriter wraps the response writer so it can stamp X-Postwave-Cost-Cents
// at WriteHeader time. The header reflects the running total at the moment
// the status is written; later cost.Record calls within the handler will
// not retroactively update it (HTTP doesn't allow it), which is fine — the
// header is a "best-effort hint", the ledger is the source of truth.
type costWriter struct {
	http.ResponseWriter
	ctx       context.Context
	readTotal CostTotalReader
	mu        sync.Mutex
	wrote     bool
}

func (c *costWriter) WriteHeader(status int) {
	c.mu.Lock()
	if !c.wrote {
		c.wrote = true
		c.Header().Set("X-Postwave-Cost-Cents",
			strconv.FormatInt(c.readTotal(c.ctx), 10))
	}
	c.mu.Unlock()
	c.ResponseWriter.WriteHeader(status)
}

func (c *costWriter) Write(p []byte) (int, error) {
	if !c.wrote {
		c.WriteHeader(http.StatusOK)
	}
	return c.ResponseWriter.Write(p)
}

// Flush sends buffered bytes to the client. Every authenticated handler
// writes through this wrapper, so a streaming response's flushes must pass it:
// it stamps the cost header first (a flush commits the headers) and then
// forwards through the writer chain.
func (c *costWriter) Flush() {
	if !c.wrote {
		c.WriteHeader(http.StatusOK)
	}
	_ = http.NewResponseController(c.ResponseWriter).Flush()
}

// Unwrap exposes the wrapped writer to http.ResponseController, which is how
// a streaming handler lifts the server's write deadline.
func (c *costWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }

// flushHeaderIfNeeded handles handlers that returned without writing
// anything. Without this the header would never be set on a 200 with empty
// body that the chi recoverer / framework will eventually flush.
func (c *costWriter) flushHeaderIfNeeded() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.wrote {
		return
	}
	c.Header().Set("X-Postwave-Cost-Cents",
		strconv.FormatInt(c.readTotal(c.ctx), 10))
}
