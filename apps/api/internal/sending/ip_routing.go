// SPDX-License-Identifier: AGPL-3.0-only
//
// ip_routing.go enforces hybrid dedicated/shared IP routing in the send drain
// loop. The dedicated-IP admin surface + ip_warmup_routing_policies storage
// existed, but the loop never read the policy: any active dedicated assignment
// sent the WHOLE tenant's traffic dedicated (all-or-nothing). This adds the
// per-recipient split the warmup ramp needs, while staying nil-safe — a tenant
// with no active policy keeps the exact prior behaviour.
package sending

import (
	"context"
	"hash/crc32"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// routingPolicy is the subset of ip_warmup_routing_policies the send loop needs.
type routingPolicy struct {
	Strategy    string // shared_only | hybrid | dedicated_only
	DedicatedBP int    // dedicated share in basis points [0,10000], hybrid only
}

// loadRoutingPolicy reads the tenant's active routing policy. Nil-safe: any
// error or no active row returns nil, so the caller falls back to the legacy
// all-or-nothing routing (zero behaviour change for policy-less tenants).
func (g *Guard) loadRoutingPolicy(ctx context.Context, tenantID string) *routingPolicy {
	if g == nil || g.Pool == nil {
		return nil
	}
	tx, err := db.WithTenant(ctx, g.Pool, tenantID)
	if err != nil {
		return nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p routingPolicy
	if err := tx.QueryRow(ctx, `
SELECT strategy, dedicated_percentage_bp
FROM ip_warmup_routing_policies
WHERE tenant_id = $1::uuid AND status = 'active'
LIMIT 1`, tenantID).Scan(&p.Strategy, &p.DedicatedBP); err != nil {
		return nil
	}
	_ = tx.Commit(ctx)
	return &p
}

// routeMessenger decides one recipient's Listmonk messenger given the tenant's
// dedicated messenger ("" if no dedicated IP) and routing policy (nil if none).
//
//   - no dedicated IP            → "" (shared / Listmonk default)
//   - no active policy           → dedicated messenger (legacy all-or-nothing)
//   - shared_only                → "" (shared)
//   - dedicated_only             → dedicated messenger
//   - hybrid                     → deterministic per-recipient split: a stable
//     hash of the email is bucketed into [0,10000); below the dedicated basis
//     points goes dedicated, the rest shared. Same email always routes the same
//     way, so a recipient's IP reputation stays consistent across sends.
func routeMessenger(policy *routingPolicy, dedicatedMessenger, email string) string {
	if dedicatedMessenger == "" {
		return ""
	}
	if policy == nil {
		return dedicatedMessenger
	}
	switch policy.Strategy {
	case "shared_only":
		return ""
	case "dedicated_only":
		return dedicatedMessenger
	case "hybrid":
		if emailBucketBP(email) < policy.DedicatedBP {
			return dedicatedMessenger
		}
		return ""
	default:
		// Unknown strategy: preserve the legacy dedicated routing.
		return dedicatedMessenger
	}
}

// emailBucketBP maps an email deterministically into a basis-point bucket
// [0,10000). Lower-cased so address-case variants route identically.
func emailBucketBP(email string) int {
	return int(crc32.ChecksumIEEE([]byte(strings.ToLower(strings.TrimSpace(email)))) % 10000)
}
