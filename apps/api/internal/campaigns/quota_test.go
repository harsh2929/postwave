package campaigns

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/limits"
)

// The monthly_sends quota — the number the entire pricing ladder rests on — was
// checked and incremented ONLY on the single-recipient test-send handler
// (handlers.go:479/558). The bulk send path (queueCampaignCore →
// QueueAndStartCampaign) had zero references to limits, so a tenant capped at
// 2,000 sends could queue a 2,000,000-recipient campaign. This maps a plan-limit
// breach onto the queue path's error type so the bulk path can enforce it.
func TestQuotaExceededQueueError(t *testing.T) {
	t.Run("nil for a non-limit error", func(t *testing.T) {
		if qe := quotaExceededQueueError(errors.New("boom")); qe != nil {
			t.Fatalf("a generic error must not become a quota queueError: %+v", qe)
		}
	})

	t.Run("nil for no error", func(t *testing.T) {
		if qe := quotaExceededQueueError(nil); qe != nil {
			t.Fatal("nil error must map to nil")
		}
	})

	t.Run("402 with a structured body for a plan-limit breach", func(t *testing.T) {
		limErr := &limits.Error{
			Resource: limits.ResourceMonthlySends,
			Tier:     "studio",
			Limit:    2000,
			Current:  1990,
		}
		qe := quotaExceededQueueError(limErr)
		if qe == nil {
			t.Fatal("a limits.Error must map to a quota queueError")
		}
		if qe.Status != http.StatusPaymentRequired {
			t.Errorf("status = %d, want 402", qe.Status)
		}
		// Assert the WIRE contract, not the Go container. The body now carries
		// an entitlement.Denial rather than a hand-built map — the two packages
		// that built this envelope independently now share one constructor —
		// and what a client sees is the JSON, so that is what this checks.
		raw, err := json.Marshal(qe.Body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		var wire struct {
			Error struct {
				Code     string `json:"code"`
				Reason   string `json:"reason"`
				Resource string `json:"resource"`
				Tier     string `json:"tier"`
				Limit    *int64 `json:"limit"`
				Current  *int64 `json:"current"`
				Remedy   string `json:"remedy"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &wire); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if wire.Error.Code != "plan_limit_exceeded" {
			t.Errorf("code = %q, want plan_limit_exceeded", wire.Error.Code)
		}
		// The machine-readable class is what lets a client pick an affordance
		// instead of pattern-matching prose.
		if wire.Error.Reason != "plan" {
			t.Errorf("reason = %q, want plan", wire.Error.Reason)
		}
		if wire.Error.Remedy != "upgrade_plan" {
			t.Errorf("remedy = %q, want upgrade_plan", wire.Error.Remedy)
		}
		if wire.Error.Limit == nil || *wire.Error.Limit != 2000 ||
			wire.Error.Current == nil || *wire.Error.Current != 1990 {
			t.Errorf("limit/current not surfaced: %+v", wire.Error)
		}
	})

	t.Run("also unwraps a wrapped limits.Error", func(t *testing.T) {
		wrapped := errors.Join(errors.New("context"), &limits.Error{
			Resource: limits.ResourceMonthlySends, Tier: "pro", Limit: 500000, Current: 500000,
		})
		if qe := quotaExceededQueueError(wrapped); qe == nil {
			t.Fatal("a wrapped limits.Error must still be recognised")
		}
	})
}
