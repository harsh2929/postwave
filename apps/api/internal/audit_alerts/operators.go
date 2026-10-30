// SPDX-License-Identifier: AGPL-3.0-only
//
// operators.go — operator_kind evaluation for audit_alert_rules.
//
// Each operator inspects the candidate audit_log row in the context
// of the per-tenant history and returns (fire bool, reason string).
// The reason flows into the channel envelope so the SOC ticket body
// includes "5 events in 5 minutes" rather than just the matched row.

package audit_alerts

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// operatorDecision is the result of evaluating a rule against an
// audit_log row. Reason is human-prose meant for the ticket body.
type operatorDecision struct {
	Fire   bool
	Reason string
}

// evaluateOperator dispatches on operator_kind. Glob rules fall
// through to the legacy match path (matchesRule) — the operator is
// considered satisfied if matchesRule returned true. The non-glob
// operators additionally consult the audit_log for window/baseline
// state.
//
// For unknown operator_kind values the rule is conservatively dropped
// (Fire=false) so a misconfigured rule cannot DoS the worker.
func evaluateOperator(
	ctx context.Context,
	pool *db.Pool,
	tenantID, actionGlob, actorLabel string,
	operatorKind string,
	operatorConfig map[string]any,
	rowAt time.Time,
) operatorDecision {
	switch operatorKind {
	case "", "glob":
		// Glob rules use the upstream matchesRule path; reaching
		// this function means matchesRule already returned true.
		return operatorDecision{Fire: true, Reason: "action matched glob: " + actionGlob}

	case "threshold_window":
		count, windowMin, groupBy := parseThresholdWindow(operatorConfig)
		if count <= 0 || windowMin <= 0 {
			return operatorDecision{Fire: false, Reason: "invalid threshold_window config"}
		}
		// Cap window to 1 day to bound the scan.
		if windowMin > 1440 {
			windowMin = 1440
		}
		observed, err := countWindow(ctx, pool, tenantID,
			actionGlob, groupBy, actorLabel, windowMin, rowAt)
		if err != nil {
			return operatorDecision{Fire: false,
				Reason: "threshold_window query failed: " + err.Error()}
		}
		if observed < count {
			return operatorDecision{Fire: false,
				Reason: fmt.Sprintf("threshold not met (%d/%d in %dm)",
					observed, count, windowMin)}
		}
		return operatorDecision{Fire: true,
			Reason: fmt.Sprintf("threshold met: %d events in %dm (>= %d)",
				observed, windowMin, count)}

	case "rate_deviation":
		deviationPct, baselineDays := parseRateDeviation(operatorConfig)
		if deviationPct <= 0 || baselineDays <= 0 {
			return operatorDecision{Fire: false,
				Reason: "invalid rate_deviation config"}
		}
		current, baseline, err := rateAndBaseline(ctx, pool, tenantID,
			actionGlob, baselineDays, rowAt)
		if err != nil {
			return operatorDecision{Fire: false,
				Reason: "rate_deviation query failed: " + err.Error()}
		}
		if baseline <= 0 {
			// Insufficient history; do not fire to avoid noise on
			// brand-new tenants.
			return operatorDecision{Fire: false,
				Reason: "insufficient baseline history"}
		}
		dev := ((current - baseline) / baseline) * 100.0
		if dev < deviationPct {
			return operatorDecision{Fire: false,
				Reason: fmt.Sprintf("deviation %.1f%% < %.1f%%", dev, deviationPct)}
		}
		return operatorDecision{Fire: true,
			Reason: fmt.Sprintf("rate %.2f/min %0.1f%% above %d-day baseline %.2f/min",
				current, dev, baselineDays, baseline)}

	case "outlier":
		kind, _ := operatorConfig["kind"].(string)
		kind = strings.TrimSpace(kind)
		switch kind {
		case "off_hours":
			// 22:00–06:00 UTC is "off hours". Cheapest heuristic
			// available without per-tenant calendar config.
			h := rowAt.UTC().Hour()
			if h >= 22 || h < 6 {
				return operatorDecision{Fire: true,
					Reason: fmt.Sprintf("off-hours event at %02d:00 UTC", h)}
			}
			return operatorDecision{Fire: false, Reason: "within business hours"}
		case "impossible_travel":
			// Requires geo enrichment in audit_log.metadata.geo.cc.
			// We approximate: fire when the same actor_label produced
			// events from 2+ distinct geo.cc values within the last
			// hour.
			ok, reason, err := impossibleTravel(ctx, pool, tenantID, actorLabel, rowAt)
			if err != nil {
				return operatorDecision{Fire: false,
					Reason: "impossible_travel query failed: " + err.Error()}
			}
			return operatorDecision{Fire: ok, Reason: reason}
		case "escalation_chain":
			// Fire when the same actor produced a privilege-escalation
			// action followed by a sensitive read/write within 5min.
			ok, reason, err := escalationChain(ctx, pool, tenantID, actorLabel, rowAt)
			if err != nil {
				return operatorDecision{Fire: false,
					Reason: "escalation_chain query failed: " + err.Error()}
			}
			return operatorDecision{Fire: ok, Reason: reason}
		default:
			return operatorDecision{Fire: false,
				Reason: "unknown outlier kind: " + kind}
		}
	}
	return operatorDecision{Fire: false, Reason: "unknown operator_kind"}
}

// parseThresholdWindow extracts (count, window_min, group_by) from
// the operator_config JSON; tolerates float-typed numbers from JSON.
func parseThresholdWindow(c map[string]any) (count int, windowMin int, groupBy string) {
	count = asInt(c["count"])
	windowMin = asInt(c["window_min"])
	groupBy, _ = c["group_by"].(string)
	return
}

func parseRateDeviation(c map[string]any) (deviationPct float64, baselineDays int) {
	deviationPct = asFloat(c["deviation_pct"])
	baselineDays = asInt(c["baseline_days"])
	return
}

func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return 0
}

func asFloat(v any) float64 {
	switch n := v.(type) {
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case float64:
		return n
	}
	return 0
}

// countWindow counts events matching the action glob (and optional
// group_by=actor_label) within [rowAt - windowMin, rowAt].
func countWindow(
	ctx context.Context, pool *db.Pool, tenantID string,
	actionGlob, groupBy, actorLabel string,
	windowMin int, rowAt time.Time,
) (int, error) {
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	likePattern := globToLike(actionGlob)
	var n int
	if strings.EqualFold(groupBy, "actor_label") && actorLabel != "" {
		err = tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid
   AND at >= $2 AND at <= $3
   AND action LIKE $4
   AND COALESCE(actor_label,'') = $5`,
			tenantID, rowAt.Add(-time.Duration(windowMin)*time.Minute), rowAt,
			likePattern, actorLabel).Scan(&n)
	} else {
		err = tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid
   AND at >= $2 AND at <= $3
   AND action LIKE $4`,
			tenantID, rowAt.Add(-time.Duration(windowMin)*time.Minute), rowAt,
			likePattern).Scan(&n)
	}
	return n, err
}

// rateAndBaseline returns (current_per_minute_last_5min,
// avg_per_minute_over_last_baselineDays).
func rateAndBaseline(
	ctx context.Context, pool *db.Pool, tenantID string,
	actionGlob string, baselineDays int, rowAt time.Time,
) (current, baseline float64, err error) {
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	likePattern := globToLike(actionGlob)
	// Current rate: events in the last 5 minutes / 5.
	var curCount int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid
   AND at >= $2 AND at <= $3
   AND action LIKE $4`,
		tenantID, rowAt.Add(-5*time.Minute), rowAt, likePattern).Scan(&curCount); err != nil {
		return 0, 0, err
	}
	current = float64(curCount) / 5.0
	// Baseline: events in the prior baselineDays / minutes_in_window.
	var baseCount int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid
   AND at >= $2 AND at < $3
   AND action LIKE $4`,
		tenantID, rowAt.AddDate(0, 0, -baselineDays), rowAt.Add(-5*time.Minute),
		likePattern).Scan(&baseCount); err != nil {
		return 0, 0, err
	}
	baselineMinutes := float64(baselineDays * 24 * 60)
	if baselineMinutes <= 0 {
		return current, 0, nil
	}
	baseline = float64(baseCount) / baselineMinutes
	return current, baseline, nil
}

// impossibleTravel fires when the actor produced events from two or
// more distinct geo.cc within the last hour. We rely on metadata.geo.cc
// (best-effort enrichment from the audit ingest path).
func impossibleTravel(
	ctx context.Context, pool *db.Pool, tenantID, actorLabel string, rowAt time.Time,
) (bool, string, error) {
	if actorLabel == "" {
		return false, "no actor_label", nil
	}
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		return false, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT DISTINCT COALESCE(metadata->'geo'->>'cc','') FROM audit_log
 WHERE tenant_id = $1::uuid
   AND actor_label = $2
   AND at >= $3 AND at <= $4
 LIMIT 5`,
		tenantID, actorLabel, rowAt.Add(-time.Hour), rowAt)
	if err != nil {
		return false, "", err
	}
	defer rows.Close()
	seen := []string{}
	for rows.Next() {
		var cc string
		if err := rows.Scan(&cc); err != nil {
			return false, "", err
		}
		if cc != "" {
			seen = append(seen, cc)
		}
	}
	if len(seen) >= 2 {
		return true, "impossible travel: " + strings.Join(seen, ","), nil
	}
	return false, "single geo region", nil
}

// escalationChain fires when the actor performed a *.grant or
// rbac.elevate action followed by a sensitive_* action within 5min.
func escalationChain(
	ctx context.Context, pool *db.Pool, tenantID, actorLabel string, rowAt time.Time,
) (bool, string, error) {
	if actorLabel == "" {
		return false, "no actor_label", nil
	}
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		return false, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid
   AND actor_label = $2
   AND at >= $3 AND at <= $4
   AND (action LIKE '%.grant' OR action LIKE 'rbac.elevate%' OR action LIKE 'impersonation.%')`,
		tenantID, actorLabel, rowAt.Add(-5*time.Minute), rowAt).Scan(&n); err != nil {
		return false, "", err
	}
	if n > 0 {
		return true, fmt.Sprintf("escalation chain: %d privilege event(s) within 5m", n), nil
	}
	return false, "no escalation in window", nil
}

// globToLike converts a shell-glob to a SQL LIKE pattern. Supports
// only '*'; underscores in the source pattern are escaped.
func globToLike(glob string) string {
	if glob == "" || glob == "*" {
		return "%"
	}
	out := strings.Builder{}
	for _, r := range glob {
		switch r {
		case '*':
			out.WriteRune('%')
		case '_', '%':
			out.WriteRune('\\')
			out.WriteRune(r)
		default:
			out.WriteRune(r)
		}
	}
	return out.String()
}
