// SPDX-License-Identifier: AGPL-3.0-only
//
// automation_coupon.go — apps/api side of the coupon_assign flow node. The
// automation engine enqueues an automation.coupon_assign outbox row; this
// handler reserves/assigns a code from the named pool for the subscriber via
// the discounts Repo (which owns pool inventory + dedup). apps/api owns this
// because the automation engine has no discounts logic.

package discounts

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// AutomationCouponKind MUST stay equal to services/automation runtime.couponKind.
const AutomationCouponKind = "automation.coupon_assign"

// automationCouponPayload mirrors runtime.CouponAssignRequest.
type automationCouponPayload struct {
	PoolID          string `json:"pool_id"`
	SubscriberEmail string `json:"subscriber_email"`
	AutomationID    string `json:"automation_id"`
	NodeID          string `json:"node_id"`
}

// couponAssigner is the slice of *Repo this handler needs — narrowed to an
// interface so the ack-vs-retry branching is unit-testable with a fake. *Repo
// satisfies it.
type couponAssigner interface {
	AssignCoupon(ctx context.Context, tenantID, poolID string, in CouponAssignmentInput, now time.Time) (*CouponAssignmentResult, error)
}

// AutomationCouponHandler fulfils automation.coupon_assign outbox rows.
type AutomationCouponHandler struct {
	Repo   couponAssigner
	Logger *slog.Logger
	Now    func() time.Time
}

func (h *AutomationCouponHandler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now().UTC()
}

func (h *AutomationCouponHandler) log(msg, tenantID, eventID string, err error) {
	if h.Logger == nil {
		return
	}
	if err != nil {
		h.Logger.Warn(msg, "tenant_id", tenantID, "event_id", eventID, "err", err.Error())
	} else {
		h.Logger.Info(msg, "tenant_id", tenantID, "event_id", eventID)
	}
}

// Handle implements outbox.HandlerFunc for kind=automation.coupon_assign.
//
// Ack-vs-retry: a parse failure, missing pool/subscriber, or a TERMINAL
// discounts error (invalid input / pool not found / pool exhausted) is logged
// and acked — retrying can't change the outcome and would just DLQ. A quota
// refusal (ErrCouponQuotaExceeded) is terminal for the same reason and for a
// sharper one: the shape that hits a per-campaign bound is a replay loop, and a
// retry is another turn of it.  Any other
// (DB/transient) error returns so the worker backs off and retries. AssignCoupon
// is idempotent (an existing assignment for the same subscriber+context is
// returned, not duplicated), so a re-dispatch never double-allocates a code.
func (h *AutomationCouponHandler) Handle(ctx context.Context, ev outbox.Event) error {
	if h.Repo == nil {
		return errors.New("automation coupon: nil repo")
	}
	var p automationCouponPayload
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		h.log("automation coupon: bad payload, dropping", ev.TenantID, ev.ID, err)
		return nil
	}
	poolID := strings.TrimSpace(p.PoolID)
	email := strings.TrimSpace(p.SubscriberEmail)
	if poolID == "" || email == "" {
		h.log("automation coupon: missing pool_id or subscriber, dropping", ev.TenantID, ev.ID, nil)
		return nil
	}
	in := CouponAssignmentInput{
		SubscriberEmail: email,
		// Stable per-(automation,node) context so a re-delivered row dedups to
		// the same assignment rather than burning a second code.
		ContextKey: p.AutomationID + ":" + p.NodeID,
		Channel:    "automation",
		Surface:    "flow",
		Metadata: map[string]any{
			"automation_id":   p.AutomationID,
			"node_id":         p.NodeID,
			"outbox_event_id": ev.ID,
		},
	}
	if _, err := h.Repo.AssignCoupon(ctx, ev.TenantID, poolID, in, h.now()); err != nil {
		if errors.Is(err, ErrInvalidInput) || errors.Is(err, ErrNotFound) ||
			errors.Is(err, ErrCouponExhausted) || errors.Is(err, ErrCouponQuotaExceeded) {
			// Terminal — ack so it doesn't DLQ-loop. The subscriber simply
			// doesn't receive a code (pool empty / misconfigured node).
			h.log("automation coupon: terminal assignment failure, dropping", ev.TenantID, ev.ID, err)
			return nil
		}
		return err // transient (DB) — retry with backoff
	}
	h.log("automation coupon: assigned", ev.TenantID, ev.ID, nil)
	return nil
}
