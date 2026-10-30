// SPDX-License-Identifier: AGPL-3.0-only

package ueba

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// BaselineWorker computes per-actor baselines once per UTC day.
//
// Pulls audit_log rows from the last 30 days, groups by
// (tenant_id, actor_label, actor_type), and computes:
//
//   - typical_hours      — hour-of-day histogram
//   - typical_ips        — top-5 /16 CIDR prefixes
//   - typical_actions    — top-10 actions by count
//   - mean_actions_per_day — rolling mean over the lookback window
//
// Then runs the peer-group k-means on each tenant's cohort to assign
// cluster_id. All writes go through the audit_ueba_worker GUC so the
// worker can write rows across tenants in a single tx without setting
// app.tenant_id.
type BaselineWorker struct {
	Pool QueryablePool
	// LookbackDays bounds the historical window. Default 30.
	LookbackDays int
	// PeerGroup is the peer-grouping detector instance used to assign
	// cluster_ids during baseline computation. nil → skip clustering.
	PeerGroup *PeerGroupDetector
}

// QueryablePool is the narrow surface BaselineWorker needs against
// pgxpool.Pool. Decoupled so unit tests can pass a fake without
// spinning a real Postgres.
type QueryablePool interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// computeBaselines walks audit_log rows over the lookback window and
// produces one Baseline per (tenant_id, actor_label, actor_type).
// Exported via the worker; pure function so it's unit-testable from
// AuditEvent slices.
func computeBaselines(events []AuditEvent, day time.Time, lookbackDays int) []Baseline {
	if lookbackDays <= 0 {
		lookbackDays = 30
	}
	groups := map[string]*Baseline{}
	groupActions := map[string]map[string]int{}
	groupHours := map[string]map[int]int{}
	groupIPs := map[string]map[string]int{}
	for _, ev := range events {
		if ev.ActorLabel == "" {
			continue
		}
		key := ev.TenantID + "\x00" + ev.ActorLabel + "\x00" + ev.ActorType
		_, ok := groups[key]
		if !ok {
			b := &Baseline{
				TenantID:   ev.TenantID,
				ActorLabel: ev.ActorLabel,
				ActorType:  ev.ActorType,
				Day:        day,
			}
			groups[key] = b
			groupActions[key] = map[string]int{}
			groupHours[key] = map[int]int{}
			groupIPs[key] = map[string]int{}
		}
		groupActions[key][ev.Action]++
		groupHours[key][ev.At.UTC().Hour()]++
		if pfx := ipSlash16Prefix(ev.IP); pfx != "" {
			groupIPs[key][pfx]++
		}
	}
	out := make([]Baseline, 0, len(groups))
	for key, b := range groups {
		b.TypicalActions = topKMapInt(groupActions[key], 10)
		b.TypicalHours = groupHours[key]
		b.TypicalIPs = topKStringByCount(groupIPs[key], 5)
		total := 0
		for _, c := range b.TypicalActions {
			total += c
		}
		b.MeanActionsPerDay = float64(total) / float64(lookbackDays)
		out = append(out, *b)
	}
	// Stable order so test fixtures stay deterministic.
	sort.Slice(out, func(i, j int) bool {
		if out[i].TenantID != out[j].TenantID {
			return out[i].TenantID < out[j].TenantID
		}
		if out[i].ActorLabel != out[j].ActorLabel {
			return out[i].ActorLabel < out[j].ActorLabel
		}
		return out[i].ActorType < out[j].ActorType
	})
	return out
}

// computeHourlyWindow exposed for tests + worker_test.go. Picks the
// top-3 contiguous hours from a baseline's TypicalHours.
func computeHourlyWindow(hours map[int]int) (peakStart, peakEnd int) {
	if len(hours) == 0 {
		return 9, 17
	}
	var bestSum, bestStart int
	for s := 0; s < 24; s++ {
		sum := hours[s] + hours[(s+1)%24] + hours[(s+2)%24]
		if sum > bestSum {
			bestSum = sum
			bestStart = s
		}
	}
	return bestStart, (bestStart + 2) % 24
}

// computeIpClusters returns the top-N /16 prefixes by frequency.
// Public-style helper used by both baseline_worker and tests.
func computeIpClusters(ips map[string]int, n int) []string {
	return topKStringByCount(ips, n)
}

// computeActionFrequency mirrors the baseline projection but is
// exposed as a standalone helper for the worker_test.go fixture.
func computeActionFrequency(events []AuditEvent) map[string]int {
	out := map[string]int{}
	for _, e := range events {
		out[e.Action]++
	}
	return out
}

func ipSlash16Prefix(ip string) string {
	parts := strings.SplitN(ip, ".", 3)
	if len(parts) < 2 {
		return ""
	}
	return parts[0] + "." + parts[1]
}

func topKMapInt(m map[string]int, k int) map[string]int {
	type kv struct {
		k string
		v int
	}
	pairs := make([]kv, 0, len(m))
	for kk, vv := range m {
		pairs = append(pairs, kv{kk, vv})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].v != pairs[j].v {
			return pairs[i].v > pairs[j].v
		}
		return pairs[i].k < pairs[j].k
	})
	if k > len(pairs) {
		k = len(pairs)
	}
	out := map[string]int{}
	for i := 0; i < k; i++ {
		out[pairs[i].k] = pairs[i].v
	}
	return out
}

func topKStringByCount(m map[string]int, k int) []string {
	type kv struct {
		k string
		v int
	}
	pairs := make([]kv, 0, len(m))
	for kk, vv := range m {
		pairs = append(pairs, kv{kk, vv})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].v != pairs[j].v {
			return pairs[i].v > pairs[j].v
		}
		return pairs[i].k < pairs[j].k
	})
	if k > len(pairs) {
		k = len(pairs)
	}
	out := make([]string, k)
	for i := 0; i < k; i++ {
		out[i] = pairs[i].k
	}
	return out
}

// Run executes one baseline-computation pass over the pool. Worker
// callers should invoke this once per UTC day; the unique-key on
// (tenant_id, actor_label, actor_type, day) makes the upsert
// idempotent for retries.
func (bw *BaselineWorker) Run(ctx context.Context, today time.Time) error {
	if bw == nil || bw.Pool == nil {
		return fmt.Errorf("ueba.BaselineWorker: missing pool")
	}
	lookback := bw.LookbackDays
	if lookback <= 0 {
		lookback = 30
	}
	tx, err := bw.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.audit_ueba_worker', 'true', true)`); err != nil {
		return fmt.Errorf("guc set: %w", err)
	}
	cutoff := today.AddDate(0, 0, -lookback)
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, action,
       COALESCE(actor_type, '') AS actor_type,
       COALESCE(actor_label, '') AS actor_label,
       COALESCE(ip::text, '') AS ip,
       COALESCE(created_at, now()) AS at
  FROM audit_log
 WHERE created_at >= $1
   AND actor_label IS NOT NULL`, cutoff)
	if err != nil {
		return fmt.Errorf("scan audit_log: %w", err)
	}
	var events []AuditEvent
	for rows.Next() {
		var ev AuditEvent
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.Action, &ev.ActorType, &ev.ActorLabel, &ev.IP, &ev.At); err != nil {
			rows.Close()
			return fmt.Errorf("row scan: %w", err)
		}
		events = append(events, ev)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("rows err: %w", err)
	}
	baselines := computeBaselines(events, today, lookback)

	// Per-tenant peer-group clustering.
	if bw.PeerGroup != nil {
		byTenant := map[string][]Baseline{}
		for _, b := range baselines {
			byTenant[b.TenantID] = append(byTenant[b.TenantID], b)
		}
		baselines = baselines[:0]
		dayKey := today.UTC().Format("2006-01-02")
		for tid, cohort := range byTenant {
			clustered := bw.PeerGroup.ClusterCohort(cohort, tid+"-"+dayKey)
			baselines = append(baselines, clustered...)
		}
	}

	for _, b := range baselines {
		hoursJSON, _ := json.Marshal(b.TypicalHours)
		ipsJSON, _ := json.Marshal(b.TypicalIPs)
		actionsJSON, _ := json.Marshal(b.TypicalActions)
		_, err := tx.Exec(ctx, `
INSERT INTO audit_user_baselines
    (tenant_id, actor_label, actor_type, day, typical_hours, typical_ips, typical_actions, mean_actions_per_day, cluster_id)
VALUES
    ($1::uuid, $2, $3, $4::date, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
ON CONFLICT (tenant_id, actor_label, actor_type, day) DO UPDATE
   SET typical_hours = EXCLUDED.typical_hours,
       typical_ips = EXCLUDED.typical_ips,
       typical_actions = EXCLUDED.typical_actions,
       mean_actions_per_day = EXCLUDED.mean_actions_per_day,
       cluster_id = EXCLUDED.cluster_id,
       updated_at = now()`,
			b.TenantID, b.ActorLabel, b.ActorType, b.Day, string(hoursJSON), string(ipsJSON), string(actionsJSON), b.MeanActionsPerDay, b.ClusterID)
		if err != nil {
			return fmt.Errorf("upsert baseline: %w", err)
		}
	}
	return tx.Commit(ctx)
}
