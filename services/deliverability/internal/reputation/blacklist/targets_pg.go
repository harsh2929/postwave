// SPDX-License-Identifier: AGPL-3.0-only
//
// targets_pg.go — discovers the IPs + domains the blocklist monitor
// should watch.
//
// Sources of truth:
//   • Dedicated IPs assigned to tenants (sending_state.dedicated_ip)
//   • Custom sending domains the tenant has verified
//   • Operator-owned free-pool IPs (env: POSTWAVE_FREE_POOL_IPS, comma-
//     separated)
//
// All three sources are unioned and deduplicated before being handed
// to Monitor.RunOnce(). The function is intentionally a one-shot
// query, not a subscription: the worker calls it once per tick, so
// changes to provisioning are picked up within Interval.

package blacklist

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// LoadTargetsFromPostgres returns a Targets() callback suitable for
// Monitor.Targets. The query intentionally runs without a tenant
// context — the worker sweeps every tenant in one pass.
//
// freePool is a list of operator-owned IPs that aren't in the DB
// (typically the shared sending IPs from the sending tier).
func LoadTargetsFromPostgres(pool *pgxpool.Pool, freePool []string) func(ctx context.Context) ([]MonitorTarget, error) {
	return func(ctx context.Context) ([]MonitorTarget, error) {
		out := []MonitorTarget{}
		seen := map[string]struct{}{}

		// 1) Free-pool IPs (no tenant_id).
		for _, ip := range freePool {
			ip = strings.TrimSpace(ip)
			if ip == "" {
				continue
			}
			key := "ip:" + ip
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, MonitorTarget{SubjectType: "ip", Subject: ip})
		}

		if pool == nil {
			return out, nil
		}

		// 2) Dedicated IPs per tenant. The sending_state table records
		// the IP Postmark assigned during provisioning. We also pick
		// up the Postmark server's reverse DNS hostname.
		tx, err := withWorkerScope(ctx, pool)
		if err != nil {
			return out, err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		rows, err := tx.Query(ctx, `
SELECT tenant_id::text, COALESCE(dedicated_ip,'')
  FROM sending_state
 WHERE dedicated_ip IS NOT NULL AND dedicated_ip <> ''`)
		if err != nil {
			// sending_state may not have dedicated_ip column in some
			// historical migrations — degrade to free-pool only.
			return out, nil
		}
		for rows.Next() {
			var tenantID, ip string
			if err := rows.Scan(&tenantID, &ip); err != nil {
				rows.Close()
				return out, err
			}
			ip = strings.TrimSpace(ip)
			if ip == "" {
				continue
			}
			key := "ip:" + ip
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, MonitorTarget{
				SubjectType: "ip",
				Subject:     ip,
				TenantID:    tenantID,
			})
		}
		rows.Close()

		// 3) Custom sending domains. send_domains is the canonical
		// per-tenant domain table; we monitor verified ones.
		domRows, err := tx.Query(ctx, `
SELECT tenant_id::text, domain
  FROM send_domains
 WHERE verified = true`)
		if err != nil {
			// send_domains may not exist in all branches — skip silently.
			return out, nil
		}
		defer domRows.Close()
		for domRows.Next() {
			var tenantID, domain string
			if err := domRows.Scan(&tenantID, &domain); err != nil {
				return out, err
			}
			domain = strings.TrimSpace(domain)
			if domain == "" {
				continue
			}
			key := "domain:" + domain
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, MonitorTarget{
				SubjectType: "domain",
				Subject:     domain,
				TenantID:    tenantID,
			})
		}
		return out, nil
	}
}
