// SPDX-License-Identifier: AGPL-3.0-only
//
// gift_audit_emit_test.go — p1-audit-migrate: assert one audit row
// per mutation on gift_subscription.create / gift_subscription.cancel.
// Hook-driven so no DB is required. Critical regression guard:
// gift_subscription.create payload must NEVER contain the raw redemption
// token.
package paid_tiers

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type giftAuditRec struct {
	mu    sync.Mutex
	calls []giftAuditCall
}

type giftAuditCall struct {
	action     string
	resource   string
	resourceID string
	payload    map[string]any
}

func (r *giftAuditRec) hook() audit.EmitHook {
	return func(_ context.Context, _, action, resource, resourceID string, payload map[string]any) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls = append(r.calls, giftAuditCall{action, resource, resourceID, payload})
		return nil
	}
}

func installGiftRecorder(t *testing.T) *giftAuditRec {
	t.Helper()
	rec := &giftAuditRec{}
	audit.SetEmitHookForTest(rec.hook())
	t.Cleanup(func() { audit.SetEmitHookForTest(nil) })
	return rec
}

func giftTenantCtx() context.Context {
	return middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
}

func TestAuditEmit_GiftCreate(t *testing.T) {
	rec := installGiftRecorder(t)
	audit.EmitOrLog(giftTenantCtx(), nil, "gift_subscription.create", "gift_subscription", "gift-1",
		nil, map[string]any{
			"id":              "gift-1",
			"recipient_email": "recipient@example.com",
			"plan_id":         "plan-pro-annual",
			"duration_months": 12,
			"status":          "pending",
		}, nil)
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "gift_subscription.create" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	// Token-leak regression: the payload must not contain any
	// raw redemption token field.
	after, _ := rec.calls[0].payload["after"].(map[string]any)
	for k := range after {
		lk := strings.ToLower(k)
		if strings.Contains(lk, "token") || strings.Contains(lk, "secret") {
			t.Errorf("gift_subscription.create audit payload leaked sensitive key %q", k)
		}
	}
}

func TestAuditEmit_GiftCancel(t *testing.T) {
	rec := installGiftRecorder(t)
	audit.EmitOrLog(giftTenantCtx(), nil, "gift_subscription.cancel", "gift_subscription", "gift-1",
		nil, map[string]any{"id": "gift-1", "status": "canceled"},
		map[string]any{"reason": "purchaser refund"})
	if len(rec.calls) != 1 {
		t.Fatalf("emit count = %d", len(rec.calls))
	}
	if rec.calls[0].action != "gift_subscription.cancel" {
		t.Errorf("action = %q", rec.calls[0].action)
	}
	ctxBlock, _ := rec.calls[0].payload["context"].(map[string]any)
	if ctxBlock == nil || ctxBlock["reason"] != "purchaser refund" {
		t.Errorf("payload.context.reason = %v", ctxBlock["reason"])
	}
}
