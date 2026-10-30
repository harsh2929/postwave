// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import "context"

const (
	EventReferralPayoutPending     = "referral.payout.pending"
	EventReferralMilestoneUnlocked = "referral.milestone.unlocked"
)

// EventEmitter is wired by main.go to the outbound-webhooks event bus.
// It stays function-shaped so referrals does not import the events
// package or the outbound dispatcher.
type EventEmitter func(ctx context.Context, tenantID, eventType string, payload map[string]any)

func (emit EventEmitter) emit(ctx context.Context, tenantID, eventType string, payload map[string]any) {
	if emit == nil || tenantID == "" || eventType == "" {
		return
	}
	emit(ctx, tenantID, eventType, payload)
}
