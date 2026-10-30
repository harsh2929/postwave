// SPDX-License-Identifier: AGPL-3.0-only
package budgets

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Middleware returns a chi middleware that enforces send budgets on routes
// likely to send mail. It runs after the apikey middleware so the API key id
// is on the context. Requests without an API key (cookie sessions) bypass.
//
// We deliberately only check ResourceSends here — dollar-budget enforcement
// is folded into the cost middleware so it can include the work the handler
// is about to perform.
func Middleware(c Checker) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			keyID := middleware.APIKeyIDFromContext(r.Context())
			if keyID == "" {
				next.ServeHTTP(w, r)
				return
			}
			if !routeChargesSend(r) {
				next.ServeHTTP(w, r)
				return
			}
			if err := Check(r.Context(), c, keyID, ResourceSends, 1); err != nil {
				if be, ok := IsBudgetExceeded(err); ok {
					writeExceeded(w, be)
					return
				}
				writeJSON(w, http.StatusInternalServerError, map[string]any{
					"error":   "budget_check_failed",
					"message": "an internal error occurred",
				})
				return
			}
			// Wrap w in a status-capturing recorder so the after-call
			// increment can be gated on a successful send. Audit
			// (cost-attribution HIGH #2): the prior code incremented
			// unconditionally — a handler returning 400/422/500 (bad
			// payload, Stripe error, validation) still burned a send
			// credit, blocking legitimate sends after enough failed
			// attempts.
			rec := &budgetStatusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)

			// Only charge on 2xx — the send was accepted by the
			// handler. 4xx/5xx means the handler rejected; do not
			// burn the budget.
			if rec.status < 200 || rec.status >= 300 {
				return
			}
			// Idempotency-replay skip: when the request carried an
			// Idempotency-Key AND the response was served from cache,
			// the original request already burned the budget. Avoid
			// double-charging on replay. Cost-attribution HIGH #1.
			if rec.status == http.StatusOK && r.Header.Get("Idempotency-Key") != "" {
				if rec.Header().Get(idempotency.InternalReplayHeaderName) == "1" {
					return
				}
			}
			b, err := c.LoadBudget(r.Context(), keyID)
			if err != nil || b == nil {
				return
			}
			_ = c.IncrementUsage(r.Context(), b, ResourceSends, 1, time.Now().UTC())
		})
	}
}

// budgetStatusRecorder wraps http.ResponseWriter to capture the
// status code so the budget-increment can be gated on success.
// Defaults to 200 if the handler never explicitly called WriteHeader
// (Go's http stdlib does this implicitly on first Write).
type budgetStatusRecorder struct {
	http.ResponseWriter
	status int
}

func (b *budgetStatusRecorder) WriteHeader(code int) {
	b.status = code
	b.ResponseWriter.WriteHeader(code)
}

func (b *budgetStatusRecorder) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.ResponseWriter.Write(p)
}

// Flush commits an implicit 200 like Write does and forwards through the
// writer chain.
func (b *budgetStatusRecorder) Flush() {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	_ = http.NewResponseController(b.ResponseWriter).Flush()
}

// Unwrap exposes the wrapped writer to http.ResponseController.
func (b *budgetStatusRecorder) Unwrap() http.ResponseWriter { return b.ResponseWriter }

// routeChargesSend is a coarse classifier: any POST that hits a campaign
// send/test-send surface or the transactional send endpoint counts.
// Conservative on purpose — adding to the list is cheap; over-counting is not.
func routeChargesSend(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	p := r.URL.Path
	switch {
	case strings.Contains(p, "/campaigns/") && strings.HasSuffix(p, "/send"):
		return true
	case strings.Contains(p, "/campaigns") && strings.HasSuffix(p, "/test-send"):
		return true
	case strings.Contains(p, "/transactional/send"):
		return true
	}
	return false
}

func writeExceeded(w http.ResponseWriter, be *BudgetExceededError) {
	retryAfter := int(time.Until(be.RetryAfter).Seconds())
	if retryAfter < 1 {
		retryAfter = 1
	}
	limit, current := int64(be.Limit), int64(be.Current)
	entitlement.Write(w, entitlement.Denial{
		Subject:           "api_key_budget",
		Reason:            entitlement.ReasonQuota,
		Code:              "budget_exhausted",
		Message:           "the API key budget is exhausted until its next usage window",
		Resource:          be.Resource,
		Limit:             &limit,
		Current:           &current,
		RetryAfterSeconds: retryAfter,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
